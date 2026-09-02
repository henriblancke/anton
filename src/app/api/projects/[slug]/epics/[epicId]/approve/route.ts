import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { humanGates } from "@/lib/approval-gate";
import { epicStandaloneBlockers, standaloneBlockers } from "@/lib/epic-graph";
import { refreshAllIssues } from "@/lib/beads/issues";
import { beads, type Bead } from "@/lib/beads/bd";
import { contractGaps, formatContractGaps } from "@/lib/beads/contract";
import { formatStructureViolations, structureGaps } from "@/lib/beads/structure";
import { nudgeSync } from "@/lib/beads/sync-nudge";
import { conflictBody, ownerOf, stealRefused } from "@/lib/beads/claim";
import { approveAndClaim, unwindApproveClaim } from "@/lib/beads/approve-claim";
import { applyProposal, ProposalApplyError } from "@/lib/gardener/apply";
import { isProposalBead } from "@/lib/gardener/detections";
import { getBoardPickerPlan, isPlanStale, stampBoard } from "@/lib/board-picker-plan";
import { getDb } from "@/lib/db";
import { enqueueExecuteEpic, enqueueExecuteEpicIfAbsent } from "@/lib/jobs/service";
import { systemClock } from "@/lib/jobs/queue";
import { resolveOperator } from "@/lib/operator";
import {
  activeDeferrals,
  declinedPicks,
  pickerTrackRecord,
  recordPickerAccept,
  withdrawPickerAccept,
} from "@/lib/picker-veto";
import {
  getProjectSettings,
  resolvePickerAutonomy,
  resolvePickerPolicy,
} from "@/lib/projects";
import { isScheduleEnabled } from "@/lib/schedules";
import type { ApprovalRunOutcome, Project } from "@/lib/types";
import { contractGatedBeads, deriveStage, runTickets } from "@/lib/ticket-view";
import { STAGES } from "@/lib/types";
import { notFoundResponse, withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Read the optional approval body. `steal` takes over a teammate's reservation (unchanged); `immediate`
 * is the run-directly choice (anton-d8i4): only an explicit `immediate: false` queues for optimal usage
 * (paced by the budget governor) — anything else, including a missing/invalid body, runs now (bypass
 * the governor's weekly/daytime pacing; the session-headroom floor still applies). Immediate is the
 * default because approval predates the flag as the run trigger: bodyless callers (e.g. the ticket
 * dialog's "Approve & run"/"Force run") promise an immediate run, so pacing is strictly opt-in. Only
 * meaningful on a project with `budgetAware` on; on others the governor never runs, so both choices
 * execute now.
 *
 * `immediateExplicit` is true only when the body ASKS for an immediate run (`immediate: true`), not
 * when the field is merely absent. The take-over enqueue keys off it instead of `immediate`: the UI's
 * Take over button posts `{ steal: true }` with no `immediate` field, and a pure ownership transfer
 * must not promote a teammate's paced ("Queue for optimal usage") job to an immediate `bypassBudget`
 * run the operator never requested.
 *
 * `release` is the Up Next lane's one-click start (anton-d2h6 / R3.5). It changes NOTHING about what
 * this route does — a release is exactly this approval, with the same contract gate, structure gate,
 * blocker check, auto-claim and enqueue — and only adds what release MEANS that approve does not: the
 * target was anton's pick and the operator agreed with it, so the choice is recorded as an accept.
 * The flag ASKS for that record; whether the target really was a live pick is re-derived server-side
 * (see {@link reserveRelease}), because a client cannot be the witness to its own evidence.
 *
 * `planId` rides with it: the plan GENERATION the operator was looking at, exactly as the veto route
 * takes one (PR #212 review). The client is not trusted to say the target was a pick, but it IS the
 * only witness to WHICH decision it was answering — a later pass can have re-picked the same bead
 * since the card was drawn, and an accept resolved from the newer generation would credit the picker
 * with an agreement to a pick nobody was shown.
 */
async function readApprovalBody(request: Request): Promise<{
  steal: boolean;
  immediate: boolean;
  immediateExplicit: boolean;
  release: boolean;
  planId?: string;
}> {
  try {
    const body = (await request.json()) as {
      steal?: unknown;
      immediate?: unknown;
      release?: unknown;
      planId?: unknown;
    };
    const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
    return {
      steal: body?.steal === true,
      immediate: body?.immediate !== false,
      immediateExplicit: body?.immediate === true,
      release: body?.release === true,
      ...(planId && planId.length <= 120 ? { planId } : {}),
    };
  } catch {
    return { steal: false, immediate: true, immediateExplicit: false, release: false };
  }
}

/**
 * Record the operator's ACCEPT of the picker's pick — the half of a release that an ordinary approve
 * has no reason to write (anton-d2h6).
 *
 * WHICH pick is answered comes from the client — the generation it had on screen — and is honoured
 * only while the recorded plan is still that generation, exactly as the veto route binds its own
 * verdict (PR #212 review). Its rank and rule are then read off that plan, never off the request: a
 * client-supplied rank could name any decision. A release that names a generation a later pass has
 * replaced records NOTHING — the pick it agreed with no longer exists, and crediting the picker with
 * an accept of the newer one would put an agreement to an unseen decision into the evidence base.
 * A release that names no generation at all falls back to the recorded plan, which is every caller
 * that predates the field.
 *
 * And the pick must still BE one (PR #212 review). The flag is a client's claim that this target was
 * anton's pick, so a stale lane, a retried request, or any direct caller can set it on a target the
 * picker never offered — and an accept counts as evidence in `pickerTrackRecord`, which earned
 * autonomy reads to decide whether the picker may ever be armed. Recording an unvalidated flag would
 * let the record claim the operator agreed with a decision they were never shown. So the server
 * re-derives the very predicate the `[Release]` button is drawn from (`board.ts` → `isPickerPick`):
 * the picker is armed AND at a level that offers its picks, the plan carries this target as an
 * entry, the board and policy have not moved past that plan, and the operator has not since vetoed
 * it. Anything else releases exactly as an
 * approve does and records nothing — the run is the operator's to have, the evidence is not.
 *
 * Judged against `board` — the pre-write snapshot this request already read — not a fresh one: the
 * approval's own label and claim would otherwise invalidate the very plan they are answering.
 *
 * RESERVED BEFORE THE RUN, not recorded after it (PR #212 review). The accept and the veto are the
 * two answers to one pick, and only the store can settle which lands — so the release must take its
 * answer before it enqueues, or a veto posted from another tab slips into the window the enqueue
 * holds open and declines a pick whose run is already starting. Answering first collapses that
 * window: the loser is told it lost by a decision that was already durable.
 *
 * The price of reserving early is a run that then fails to start, and an accept for a run that never
 * started is evidence of nothing — so this hands back the row id and the caller withdraws it in
 * exactly that case ({@link withdrawPickerAccept}).
 *
 * Best-effort, like the enqueue that follows it: the approval has already landed, so a write to
 * anton.db that falls over must not fail a release the operator already got. The accept is evidence
 * about the picker, never a gate on the run — which is also why every failure here fails CLOSED,
 * recording nothing rather than an accept it could not stand behind.
 *
 * The deferral read below is the cheap guard, not the decisive one: a veto still being written is
 * invisible to it. `recordPickerAccept` re-asks the question holding the write lock, so at most one
 * of the two verdicts ever lands on a pick (PR #212 review).
 *
 * @returns the id of the accept this request filed, or undefined when it recorded nothing.
 */
async function reserveRelease(
  projectId: string,
  beadId: string,
  board: Bead[],
  displayedPlanId?: string,
): Promise<string | undefined> {
  try {
    const db = getDb();
    const [plan, armed, settings, record, deferrals] = await Promise.all([
      getBoardPickerPlan(db, projectId),
      isScheduleEnabled(projectId, "board-picker"),
      getProjectSettings(db, projectId),
      pickerTrackRecord(db, projectId),
      activeDeferrals(db, projectId, new Date()),
    ]);
    const policy = resolvePickerPolicy(settings);
    const skip = (why: string) => {
      console.warn(`[approve] release of ${beadId} recorded no accept: ${why}`);
      return undefined;
    };
    const entry = plan?.entries.find((e) => e.beadId === beadId);
    if (!armed) return skip("the picker is disarmed");
    // The level, beside the schedule, because the board gates the button on both (PR #218 review):
    // `propose` ranks and offers nothing (R3.5), so a flag arriving from a tab opened before the
    // level changed answers a pick this project never put in front of anyone.
    if (resolvePickerAutonomy(settings, record) === "propose") {
      return skip("the picker is at propose — it offers no picks to answer");
    }
    if (!plan || !entry) return skip("no recorded plan picks this target");
    if (displayedPlanId !== undefined && plan.planId !== displayedPlanId) {
      return skip("a later pass replaced the plan generation the operator answered");
    }
    if (deferrals.has(beadId)) return skip("the operator vetoed this pick");
    // Keyed on the plan id the entry above came from, so this asks whether THIS generation has been
    // vetoed — including the pick whose hold lapsed with no pass to rewrite the plan (isPlanStale).
    const declined = await declinedPicks(db, projectId, plan.planId);
    if (isPlanStale(plan, stampBoard(board, Date.now(), policy), deferrals, declined)) {
      return skip("the plan that picked it is no longer the decision anton stands behind");
    }
    // The store settles a veto that landed while this request was in flight — the deferral read above
    // cannot see one still being written — so ask it what happened rather than assume the accept did.
    const outcome = await recordPickerAccept(db, systemClock, {
      projectId,
      beadId,
      ...(entry.rule ? { rule: entry.rule } : {}),
      rank: entry.rank,
      ...(plan.planId ? { planId: plan.planId } : {}),
    });
    if (outcome.recorded) return outcome.id;
    // A duplicate is the SAME accept restated (a double-click, a retry): the standing row is not this
    // request's to withdraw, so it reports nothing reserved.
    return skip(
      outcome.reason === "vetoed"
        ? "the operator vetoed this pick first"
        : "this pick already carries the operator's accept",
    );
  } catch (err) {
    console.error(`[approve] failed to record the picker accept for ${beadId}`, err);
    return undefined;
  }
}

/**
 * HTTP status per apply failure: the caller's mistake, the board's, or ours. `unsettled` is ours too
 * — the move is on the board and only its proposal could not be closed, and the error text is what
 * tells the operator that approving it again settles it.
 */
const APPLY_STATUS = { unusable: 422, refused: 409, failed: 500, unsettled: 500 } as const;

/**
 * What the under-lock guard can refuse an approval for — the two verdicts that can only be taken
 * against the board as of the write: the target is not (or is no longer) a run target, or a steal's
 * victim started their run while this approval was in flight.
 */
type ApproveRefusal = { notRunTarget: string } | { moved: string };

/**
 * Why this bead is not something approval may enqueue, or undefined when it is a run target. Reuses
 * the same `beads.isRunTarget` gate execute-epic enforces (a shared helper, no duplicated type
 * logic) so the route and the runner agree on what "runnable" means, and names WHICH of the three
 * ways it fails so the operator is told what to approve instead.
 *
 * One function because this question is asked TWICE per approval — once off the pre-lock board read,
 * once again under the claim lock (see the swap below) — and the two answers must read identically.
 */
function notRunTargetReason(target: Bead, board: Bead[]): string | undefined {
  if (beads.isRunTarget(target, board)) return undefined;
  const id = target.id;
  if (beads.isContainer(target, board)) {
    // Approval is a per-PR gate, so it must never be offered on a bead whose approval would
    // launch one PR per feature under it (design 2026-07-26: "Approval stays per feature").
    return `${id} is a container epic, not a run target — approve one of its features instead; each feature is its own run and its own PR`;
  }
  const parent = beads.parentOf(target);
  const type = target.issue_type ?? "unknown";
  if ((type === "task" || type === "bug") && parent) {
    return `${id} is a child ticket of ${parent} — approve its epic ${parent} instead; a child runs via its epic's PR, not on its own`;
  }
  return `${id} is not runnable: type "${type}" — only a feature, a parentless task/bug, or an epic with no feature children can be approved to run`;
}

/**
 * Approve a gardener proposal: apply its board move and close it (anton-1t3n). Never enqueues a run
 * and never writes the `approved` label — a proposal is a decision, and the decision IS the move.
 *
 * A failure answers with the reason the apply refused and leaves the proposal OPEN with that reason
 * noted on the bead, so the operator finds the same explanation whether they look at the toast or at
 * the ticket. `refused` in particular is the ordinary case: a proposal filed last night describes a
 * board that has since moved, and the honest answer is to say what changed, not to force the move.
 */
async function applyProposalResponse(
  project: Project,
  proposal: Bead,
  board: Bead[],
): Promise<NextResponse> {
  try {
    const applied = await applyProposal(project.repoPath, proposal, board, "approval");
    // The move landed locally; propagate it like every other operator write (immediate coalesced
    // push + the durable backstop), off the response path.
    nudgeSync({ id: project.id, repoPath: project.repoPath }, "approve");
    return NextResponse.json({ applied });
  } catch (err) {
    // A failed apply is not an untouched board: `applyProposal` attaches the reason to the proposal
    // as a note (and a partial move may have been rolled back), so it propagates like the success
    // path — otherwise the explanation the operator is promised stays on this machine while their
    // teammates see a proposal that silently never moved. The nudge coalesces per repo and dedupes
    // its backstop job, so a failure that happened to write nothing costs a no-op push.
    nudgeSync({ id: project.id, repoPath: project.repoPath }, "approve");
    if (err instanceof ProposalApplyError) {
      return NextResponse.json(
        { error: err.message, proposal: proposal.id },
        { status: APPLY_STATUS[err.failure] },
      );
    }
    // Not a decision this module made — a bd read/write that broke outside the apply's own guards.
    console.error(`[approve] applying proposal ${proposal.id} failed`, err);
    const message = err instanceof Error ? err.message : "Failed to apply the proposal";
    return NextResponse.json({ error: message, proposal: proposal.id }, { status: 500 });
  }
}

export const POST = withProject<{ slug: string; epicId: string }>(async (request, { project, params }) => {
  const { epicId } = params;

  // Gate approval on readiness: approving enqueues execute-epic immediately, so an epic with open
  // blockers must not be startable before its blocker completes. Locate it across stages first.
  // Force a fresh bead read first — this mutating gate must not decide readiness from a warm board
  // snapshot (up to ISSUE_SNAPSHOT_MAX_AGE_MS stale), which could miss a just-added cross-epic
  // `blocks` edge and approve a still-blocked epic.
  // The fresh read returns the loaded beads, so reuse them for the runnability gate below rather than
  // issuing a second `bd list`. Crucially, `refreshAllIssues` goes through `loadAllIssues`, which
  // falls back to separate open/closed reads where `--status all` fails; calling `beads.list` directly
  // here would skip that fallback and 500 the whole approval in exactly the scenario the board handles.
  const allBeads = await refreshAllIssues(project.repoPath);

  // Validate the target is actually runnable *before* touching labels or enqueuing. Approval is the
  // run trigger, so labeling-and-enqueuing a bead that execute-epic will only poison-park is a false
  // green: the operator sees "approved" but no run ever reaches a PR. Reuse the same isRunTarget gate
  // execute-epic enforces (a shared helper, no duplicated type logic) so the route and the runner
  // agree on what "runnable" means. Read beads fresh (matching execute-epic's `--status all` load) so
  // a missing bead is distinguishable from a found-but-not-runnable one, and the message stays honest.
  const target = allBeads.find((b) => b.id === epicId);
  if (!target) {
    return notFoundResponse(`Ticket ${epicId} not found on the board`);
  }

  // A gardener PROPOSAL is approved, not run (anton-1t3n). It is shaped as a parentless task, so
  // every gate below would happily pass it through to `enqueueExecuteEpic` — which would dispatch an
  // agent to "implement" a decision whose whole content is a board move anton can apply itself. So
  // the branch sits here, ahead of the label and the enqueue: approving one applies its move through
  // the beads seam and closes it, and nothing about the run path is reached.
  if (isProposalBead(target)) {
    return applyProposalResponse(project, target, allBeads);
  }

  // Cheap refusal first, off the read above — most non-run-targets never get near the lock. The
  // verdict is re-taken under the lock before anything is written, because this read cannot hold.
  const notRunnable = notRunTargetReason(target, allBeads);
  if (notRunnable) {
    return NextResponse.json({ error: notRunnable }, { status: 422 });
  }

  // The bead contract, judged over the SAME set execute-epic gates on — the target plus every
  // ticket the run will dispatch — not the target alone. A conformant epic with one unshaped child
  // would otherwise be labeled `approved` and answered "running" here, then poison-parked by the
  // runner before it does any work: exactly the false green this gate exists to prevent. The ticket
  // set comes from the shared `runTickets`/`groupsChildren` pair the runner uses, so route and
  // runner never disagree about what the target contains. Resume-skipped beads are dropped through
  // the runner's own predicate (`contractGatedBeads`, shared) rather than an approximation of it,
  // which is also what leaves Force-run recovery of a failed/closed PR reachable on a legacy target
  // written before the contract: that run re-opens the PR and dispatches no agent, in either shape
  // — a standalone target already carrying stage:in-review, or a grouped one whose children are all
  // closed — so gating it would 422 the one action that recovers it, forcing the operator to invent
  // criteria for work that is already written. Judged off the same forced fresh read as the gate
  // above, so a bead repaired a moment ago approves. The refusal itself is deferred until we know
  // this request will start work — see the gate below.
  const children = runTickets(allBeads, epicId);
  const contractGated = contractGatedBeads(target, children);

  // Builds off the snapshot the refresh above just populated — a board rebuild, not a bd read. The
  // route needs it for the epic-graph blocker rollup and for the item shape it answers with.
  const board = await getBoard(project);
  const epic = STAGES.map((stage) => board.columns[stage].find((e) => e.id === epicId)).find(
    Boolean,
  );
  // A standalone task/bug (epic-of-one) lives in `standalone`, not `columns`, so it carries no
  // epic-graph readiness — but it can still hold cross-item `blocks` edges. It must be found here
  // or a valid run target 404s, and it must be gated on its own open blockers below. Every feature
  // — nested or parentless — is a board CARD since anton-aul8 re-keyed getBoard off run targets, so
  // it resolves in `columns` above and carries the epic-graph rollup's readiness.
  const standalone = epic
    ? undefined
    : STAGES.map((stage) => board.standalone[stage].find((e) => e.id === epicId)).find(Boolean);
  if (!epic && !standalone) {
    return notFoundResponse("Run target not found");
  }
  // Settle ownership BEFORE the open-blocker readiness gate below. Approval is the run trigger and
  // normally enqueues execute-epic immediately, so a target with open blockers must not be approved.
  // But a pure ownership take-over — stealing an already-approved backlog target — only reassigns the
  // reservation and enqueues nothing (the take-over gate at the end suppresses the run). It starts no
  // work, so the blocker gate that guards a fresh approval must NOT reject it: a target that gained a
  // blocker AFTER its original approval has to stay transferable to a new owner, not sit stranded with
  // the old one until the blocker closes (the UI offers Take over on exactly these approved backlog
  // targets — claim-control.tsx `canTakeOver`). So read ownership here and derive the take-over first,
  // then let the gate skip it.
  //
  // Ownership comes off `target` — the bead the forced fresh read above already loaded — rather than
  // a second `bd show`: the board build in between reuses that same snapshot, so nothing bd-visible
  // happens between the two and the extra spawn would re-read identical state. A teammate claiming
  // after this read is caught where it matters anyway: the CAS below re-reads under the claim lock
  // and loses to them (409) instead of overwriting their reservation.
  const operator = await resolveOperator();
  const owner = ownerOf(target);
  // Read before the approve below, which would otherwise make every request look like a re-approve.
  // See the enqueue gate at the end for what this distinguishes.
  const wasApproved = beads.isApproved(target);
  const { steal, immediate, immediateExplicit, release, planId } = await readApprovalBody(request);
  // A pure take-over reassigns the reservation and nothing more (the enqueue gate at the end skips its
  // run), so it bypasses the blocker gate — but never the steal-validity checks below, which still
  // confine it to a backlog target with a resolvable operator identity. Mirrors the enqueue-suppression
  // condition computed identically at the end.
  const takeOver = wasApproved && steal && !!owner && owner !== operator;

  // Open blockers for the run target, derived off the fresh `allBeads` read above. For an epic that's
  // the epic-graph rollup (epic→epic + cross-epic child blocks) PLUS any parentless standalone
  // (task/bug) prerequisite the rollup DROPS (epicStandaloneBlockers) — otherwise an epic that
  // depends on an open standalone item would read ready. For a standalone target the rollup never
  // carries it, so derive from its own `blocks` edges. Two consumers below: the standalone half of
  // the readiness gate (a fresh approval enqueues immediately, so a still-blocked target must be
  // rejected before we label + enqueue work `bd ready` would keep blocked), and the refusal message,
  // which names what the operator is waiting on.
  const openBlockers = epic
    ? [...epic.blockedBy, ...epicStandaloneBlockers(allBeads, epicId)]
    : standaloneBlockers(allBeads, epicId);
  // Whether this request can actually start work. `openBlockers` is a target-level roll-up: it fires
  // on ANY open blocker under the target, so one gated tail child made the whole run unapprovable
  // while its independent siblings sat idle (issue #58). The rollup's per-child verdict answers the
  // question that actually matters — is there a ticket this run could dispatch right now — so a
  // partially-gated target approves and runs its ready children, and only a target with ZERO of them
  // is refused. A standalone task/bug (epic-of-one) carries no such verdict and has no children to
  // be partial about: it stays gated on its own open blockers.
  const runnable = epic ? epic.childReadiness !== "blocked" : openBlockers.length === 0;
  // A pure take-over bypasses this gate — it only reassigns the reservation and enqueues no run that
  // would start blocked work (see the enqueue gate at the end) — so a target that gained a blocker
  // AFTER its original approval stays transferable to a new owner rather than stranded with the old.
  if (!takeOver && !runnable) {
    const message =
      openBlockers.length > 0
        ? epic
          ? `Epic is blocked by ${openBlockers.join(", ")}`
          : `${epicId} is blocked by ${openBlockers.join(", ")}`
        : `${epicId} is blocked: every ticket it would run is held by an open blocker`;
    return NextResponse.json({ error: message }, { status: 409 });
  }

  // The bead contract, enforced where every run target passes (anton-j9zs). Approve is the run
  // trigger AND already a validation site, so a target the runner would only poison-park is refused
  // here instead — the operator gets the missing section named while they're still looking at the
  // bead, not a parked job later. Only BLOCKING gaps refuse: a ticket with no Acceptance (or an epic
  // with no Success Criteria) gives the agent no definition of done and self-review no rubric, so
  // the work is unrunnable. Advisory gaps ride along in the 200 body — they degrade a run without
  // stopping it, and blocking approval on them would gate the board on prose.
  //
  // Gated on the request actually STARTING work, which is why it sits after the take-over
  // derivation rather than up with the runnability check. A pure take-over of a blocked target
  // enqueues nothing (the enqueue gate at the end skips it) — it only moves the reservation — so
  // refusing it on a contract gap would strand an approved target with its previous owner over a
  // section no run of ours is about to read. The condition mirrors that enqueue gate exactly: a
  // non-take-over always enqueues (an unrunnable one already 409'd above), a take-over only when the
  // target has work it can actually start.
  const willEnqueue = !takeOver || runnable;
  const blocking = willEnqueue ? contractGaps(contractGated, "blocking") : [];
  if (blocking.length > 0) {
    return NextResponse.json(
      {
        error: `${epicId} does not meet the bead contract: ${formatContractGaps(blocking)}`,
        sections: blocking.flatMap((g) => g.violations.map((v) => v.section)),
      },
      { status: 422 },
    );
  }
  // The tier taxonomy, enforced beside the contract (anton-tier-invariants). Same shape, different
  // question: the contract judges what is INSIDE a bead, this judges where the bead HANGS. Only a
  // dead bead refuses — one `beads.isRunTarget` will never admit and no ticket sweep reaches, so
  // approving this target would enqueue a run that silently skips it and leave it on the board
  // looking like queued work forever.
  //
  // Scoped to this target's SUBTREE, never the whole board: a stray chore three branches away is not
  // this feature's fault and must not strand it. That scope is deliberately narrow, and it means this
  // gate is a BACKSTOP, not the primary check — a nested feature is caught here, while a ticket
  // stranded under a container epic is not (the container can't be approved at all, so no request
  // ever reaches this line carrying it). `anton board-check` judges the whole board and is what
  // `/shape` runs before it hands a tree over; this catches what survives to a run trigger.
  //
  // One call, both severities: the refusal below and the advisory further down are the same subtree
  // read, and asking twice would walk the whole board twice.
  const structural = willEnqueue
    ? structureGaps(epicId, allBeads)
    : { blocking: [], advisory: [] };
  if (structural.blocking.length > 0) {
    return NextResponse.json(
      {
        error: `${epicId} breaks the tier structure: ${formatStructureViolations(structural.blocking)}`,
        rules: structural.blocking.map((v) => v.rule),
      },
      { status: 422 },
    );
  }
  // Reported, never enforced. Computed over the same dispatch set the gate above judges, so a thin
  // child is heard here too rather than only in the runner's log. One line PER BEAD, each naming
  // its own id: across a whole ticket set, bare messages leave the operator no way to tell which
  // bead is thin. Gated on `willEnqueue` for the same reason the refusal is: a pure take-over of a
  // blocked target starts no run, so warnings about the spec no run is about to read would tell the
  // operator a run is degraded when none began.
  //
  // Tier advisories ride the same channel: a feature with no epic or no tickets runs fine, so it is
  // heard, never enforced.
  const advisory = willEnqueue
    ? [
        ...contractGaps(contractGated, "advisory").map((gap) => formatContractGaps([gap])),
        ...structural.advisory.map((v) => formatStructureViolations([v])),
      ]
    : [];

  // What this run will cost the OPERATOR, on the same advisory channel (anton-qfso.2): every bead in
  // the dispatch set labelled `agent:human` is a point the run reaches and then holds, waiting for a
  // person. Never a refusal — human work is real, shaped, approved work — but it is the one cost the
  // operator can only weigh before starting. Same `willEnqueue` gate as the advisory above, so a
  // take-over that starts no run promises no gates either.
  //
  // Derived under the lock from the SAME locked board as `humanTarget`, not from the pre-lock
  // `contractGated`: a child gaining or losing `agent:human` in that window changes which gates the
  // run actually arms, and the executor reloads the board and gates off the label as of the write.
  // Answering from the stale set would omit a stop the run will hold at, or promise a stop for work
  // an agent will just do (PR #214 review).
  let humanWork: string[] = [];
  // The one case where "anton runs the rest" is a lie (PR #214 review): when the TARGET itself
  // carries the label, execute-epic poisons it before dispatching a single child, so the run the
  // operator just triggered never starts. Reported separately from the gate lines because the two
  // ask for different things — hold-and-resume versus do-it-yourself, no run pending.
  //
  // Read off the TARGET's own label, never off the gate lines: `contractGatedBeads` empties on the
  // two recovery shapes — a grouped target whose children are all closed, and a standalone target
  // already in review — and both still hit the target-level poison when re-run. Conditioning this on
  // a non-empty dispatch set would answer those with silence about the one thing that decides the
  // outcome (PR #214 review).
  //
  // Filled from the LOCKED read below, not from the pre-lock `target`: the label can be added or
  // removed in the window between them, and the executor acts on the label as of the write. Deciding
  // it here would announce a started run for a target that is already poison, or promise silence
  // about a run that in fact never starts (PR #214 review).
  let humanTarget = false;

  // Whether the `approved` label would be OURS to take back if the sequence then falls over — off
  // the LOCKED read, not the pre-lock one, because that is the state the write is made against. A
  // target somebody already approved keeps its label through the unwind (PR #218 review).
  let wroteLabel = false;

  // Enforce the claim as a soft-lock at the run trigger, from the fresh ownership read above.
  if (owner && owner !== operator) {
    // Claimed by someone else → approving would silently run a teammate's reservation. Require an
    // explicit steal to take it over, mirroring the claim route's 409.
    if (!steal) {
      return stealRefused(
        `${epicId} is claimed by ${owner} — pass { steal: true } to approve and take it over`,
        owner,
      );
    }
    // A steal only moves the reservation; it does not stop a run already executing under the current
    // owner. The `takeOver` gate below suppresses a *second* enqueue but never halts the first, so
    // reassigning an implementing/in-review target would strand that live run under a new owner —
    // exactly the takeover the runtime is mid-flight on. Only a backlog target (approved-but-unstarted,
    // or never started) is safe to take over. This mirrors the UI, which offers Take over solely on
    // backlog targets (claim-control.tsx `canTakeOver`); enforce that boundary here so a direct request
    // can't bypass it. Derive from the fresh `target` read above.
    const stage = deriveStage(target);
    if (stage !== "backlog") {
      return stealRefused(
        `${epicId} is claimed by ${owner} and is already ${stage} — its run is in progress, so it can't be taken over; wait for it to finish or have ${owner} release it`,
        owner,
        stage,
      );
    }
    // Steal requested, but no operator identity resolves (no ANTON_OPERATOR, no global git user.name),
    // so we can't reassign the target. Approving anyway would enqueue a run under the teammate's
    // reservation while leaving them as assignee — a half-steal that breaks the soft-lock the response
    // text and DESIGN.md promise. Reject until an operator identity is set to take ownership.
    if (!operator) {
      return stealRefused(
        `${epicId} is claimed by ${owner} — set ANTON_OPERATOR (or git user.name) to identify who is taking it over before approving`,
        owner,
      );
    }
  }
  // Re-check the board shape, auto-claim, then approve — all under the bead's claim-write lock.
  //
  // The shape re-check: every gate above judged a read taken before the lock existed, so the lock is
  // also what makes the run-target verdict hold through the write. See the body.
  //
  // The claim: an unclaimed target (or one being stolen) gets assigned to the approver so the
  // reservation is set BEFORE the runtime execution-claim, closing the gap where a teammate could
  // claim between approve and the runner. It's conditional on the assignee still being `owner` —
  // the value the steal gate above decided from. `bd assign` is an unconditional assignee update,
  // so the re-read alone doesn't close the window: a teammate claiming between that read and this
  // write would have their fresh reservation overwritten without `{ steal: true }`. Losing the swap
  // means ownership moved after we checked, so the approval must not proceed on a stale decision —
  // 409 and let the operator re-decide against the state as it now is. Re-approving one you already
  // own swaps owner→owner: no write, just a verification that it's still yours.
  //
  // The lock has to span the label too, not just the swap. The `approved` label is what locks the
  // reservation (the claim route refuses to touch an approved target), so between a bare swap and
  // an unlocked `beads.approve` a teammate's steal would still be legal — it would land on a target
  // that isn't approved *yet*, and this request would then approve and enqueue a run under their
  // reservation, which they never approved. Holding the lock through the label leaves no such
  // window: a concurrent steal either lands first (and this swap 409s) or finds the target approved
  // and is refused.
  //
  // With no operator identity (no ANTON_OPERATOR, no git user.name) there's no one to assign, so
  // the swap is owner→owner: a verified no-op that still takes the lock and still serializes the
  // label against concurrent claims.
  //
  // The sequence itself lives in `beads/approve-claim.ts` — shared with the board-picker's apply
  // step, which is the second writer of this label and must not rebuild the ordering above. What
  // stays here is what is this route's: which re-checks the locked board has to survive.
  const swap = await approveAndClaim<ApproveRefusal>({
    repoPath: project.repoPath,
    beadId: epicId,
    expectedOwner: owner,
    nextOwner: operator ?? owner,
    guard: (locked, lockedBoard) => {
      // Re-take the run-target verdict HERE, under the lock. The pre-lock gate answered from a read
      // taken before every gate below it ran, and the Add-work commit (lib/backlog.ts
      // `createDraftFeature`) attaches a feature child while holding THIS SAME per-bead lock. Without
      // this the two orders are asymmetric: the feature landing first turns a standalone run target
      // into a container behind the pre-lock gate's back, and we would label it `approved` and
      // enqueue a run that execute-epic's own `isRunTarget` gate only poison-parks — a false green,
      // the exact failure the pre-lock gate exists to prevent. Under the lock the shape cannot move
      // between this verdict and the `approved` write, so the two writes are genuinely ordered:
      // either the feature lands first and this refuses, or approval lands first and
      // `createDraftFeature`'s own re-check refuses the draft.
      const refusal = notRunTargetReason(locked, lockedBoard);
      if (refusal) return { notRunTarget: refusal };

      wroteLabel = !beads.isApproved(locked);

      // The human-work report, taken off the same locked read the approval writes against — see the
      // declarations above for why the pre-lock read is not good enough. The child gates are
      // re-derived through the same `runTickets`/`contractGatedBeads` pair the pre-lock gate used, so
      // the lines describe the board the run is about to consume rather than the one that passed it.
      humanTarget = willEnqueue && beads.isHumanWork(locked);
      humanWork = willEnqueue
        ? humanGates(contractGatedBeads(locked, runTickets(lockedBoard, epicId)))
        : [];

      // Re-derive the stage HERE too — not only from the pre-lock `target` read above. On a steal
      // (owner !== operator) the pre-lock stage gate can pass on a backlog snapshot, then the
      // original owner's runner starts in the window before this CAS: it moves the bead to
      // in_progress/stage:implementing but leaves the assignee as the old owner, so `cas(owner, …)`
      // (which matches on assignee alone) would still succeed and reassign a *live* run to the
      // approver — the exact implementing/in-review takeover the pre-lock gate rejects. Reading the
      // stage inside the lock makes a run that started in that window lose the swap instead. A
      // self-owned re-approve (owner === operator, e.g. Force run on an implementing epic) is
      // deliberately excluded: it's the operator asking to re-run their own target, not a takeover.
      if (owner && owner !== operator) {
        const lockedStage = deriveStage(locked);
        if (lockedStage !== "backlog") return { moved: lockedStage };
      }
      return undefined;
    },
  });
  if ("vanished" in swap) {
    return notFoundResponse(`Ticket ${epicId} not found on the board`);
  }
  if ("refused" in swap) {
    const refusal = swap.refused;
    if ("moved" in refusal) {
      return stealRefused(
        `${epicId} is claimed by ${owner} and is already ${refusal.moved} — its run started while this approval was in flight, so it can't be taken over; wait for it to finish or have ${owner} release it`,
        owner,
        refusal.moved,
      );
    }
    return NextResponse.json({ error: refusal.notRunTarget }, { status: 422 });
  }
  // The claim write fell over ambiguously (PR #218 review): `bd assign` can commit and then throw or
  // time out, so a 500 alone could leave the target reserved by an approver whose request reported
  // nothing changed. approve-claim re-reads and hands the reservation back under the lock; only what
  // it could not take off is the operator's to clear.
  if ("claimFailed" in swap) {
    const error = swap.stranded
      ? `${epicId} could not be approved, and the claim this request took could not be handed ` +
        `back — it is left assigned to ${operator ?? owner}; clear its assignee by hand. ` +
        swap.claimFailed
      : `${epicId} could not be approved — nothing was changed. ${swap.claimFailed}`;
    // Published either way (PR #218 review). Both halves of this branch left local-only writes: the
    // hand-back that worked, or the reservation it could not take off. An unpublished stranded claim
    // reads as FREE on every other machine until a later heartbeat — so the target this response
    // says is held stays claimable by a picker pass elsewhere, which is the second run the claim
    // exists to prevent. The nudge coalesces per repo, so the no-op case costs an idle push.
    nudgeSync({ id: project.id, repoPath: project.repoPath }, "approve");
    return NextResponse.json({ error }, { status: 500 });
  }
  // The claim landed and the label did not (PR #218 review). The CAS has already moved the assignee,
  // so failing the request here would leave the target reserved by an approver who never approved
  // it — claimed-looking work with no approval and no run. Take this request's writes back, then
  // report the failure the operator can retry.
  if ("approveFailed" in swap) {
    // Through the shared unwind, not a bare hand-back: `bd update --add-label` can commit and THEN
    // throw or time out, so releasing the claim alone would publish an approved, unassigned target —
    // the exact shape a picker pass or a worker starts on — while this response says nothing was
    // changed (PR #218 review). The unwind re-reads the bead and removes only an approval this
    // request introduced, and a label that will not come off keeps its claim rather than arming the
    // target.
    //
    // The compensation's own verdict decides the message: reporting "nothing was changed" over
    // writes that are still standing would leave the operator with a target that reads as taken or
    // approved, has no run, and never comes back on a picker pass.
    const leftover = await unwindApproveClaim({
      repoPath: project.repoPath,
      beadId: epicId,
      owner: operator ?? owner,
      restoreTo: owner,
      wroteLabel,
      wroteClaim: swap.swap.wrote,
    });
    const error =
      leftover === "approval"
        ? `${epicId} could not be approved, and the approval this request wrote could not be ` +
          `removed — it is left approved and assigned to ${operator ?? owner}; unapprove it by ` +
          `hand. ${swap.approveFailed}`
        : leftover === "claim"
          ? `${epicId} could not be approved, and the claim this request took could not be handed ` +
            `back — it is left assigned to ${operator ?? owner}; clear its assignee by hand. ` +
            swap.approveFailed
          : `${epicId} could not be approved — nothing was changed. ${swap.approveFailed}`;
    // Same reason as the claim-failure branch above: the unwind is itself a board write, and what it
    // could not take back is a partial write standing. Neither reaches another machine until it is
    // published (PR #218 review).
    nudgeSync({ id: project.id, repoPath: project.repoPath }, "approve");
    return NextResponse.json({ error }, { status: 500 });
  }
  if (!swap.ok) return NextResponse.json(conflictBody(epicId, swap.owner), { status: 409 });

  // A release is this approval plus its answer to the picker (anton-d2h6), and the answer is taken
  // BEFORE the run rather than after it (PR #212 review). The accept and the veto are two answers to
  // one decision, settled in the store under its write lock — so whichever the operator's other tab
  // posts, it resolves against a verdict that is already durable instead of into the window the
  // enqueue would otherwise hold open. Only a release that loses the CLAIM race records nothing at
  // all, which is why this sits after the swap and not before it.
  //
  // The evidence rule is unchanged — no accept for a run that never started — and is now kept by
  // withdrawing the reservation below rather than by waiting for the enqueue's verdict.
  // Whether the target was a PICK at all is re-derived server-side, off the pre-write snapshot.
  const acceptId = release ? await reserveRelease(project.id, epicId, allBeads, planId) : undefined;

  // Approval is the trigger: enqueue the autonomous execute-epic run (DESIGN.md §2/§7). Two paths:
  //
  // 1. A normal approval / re-approve (NOT a take-over) enqueues via the active-dedupe. This is the
  //    operator asking for a run: both epic-detail run buttons post here with no body (Force run on
  //    an implementing epic, Run epic elsewhere — epic-detail-view.tsx), as does re-approving a
  //    target whose enqueue previously failed. Gating those on `wasApproved` would report success
  //    with no `jobId` and leave an approved epic unrunnable from the UI. The dedupe covers the
  //    double-click case; a cross-machine force-run is not deduped (anton-jz1).
  //
  // 2. An owner-changing take-over enqueues ONLY when this instance has no job covering the epic yet
  //    (enqueueExecuteEpicIfAbsent, active + resumable statuses; a terminal `done` row does NOT
  //    count, so a machine that previously finished this epic still enqueues afresh). Jobs are
  //    machine-local (README/DESIGN §"Ephemeral"), so stealing an already-approved target from
  //    operator A leaves A's queued/paused job on A's instance — and execute-epic's ownership gate
  //    makes A's job poison itself once it sees the epic reassigned to B. Without a local job the
  //    approved work would strand under the new owner with nothing runnable (anton-i71 review,
  //    PR #39). A same-instance take-over instead finds its existing (queued/running/parked/failed)
  //    job and reuses it (returns no new id), so a parked prior run stays resumable rather than
  //    shadowed by a duplicate.
  //
  //    Skip the take-over enqueue when the target has nothing it can start: a take-over bypasses the
  //    readiness gate above (to stay transferable), but starting fully blocked work is exactly what
  //    that gate prevents — the runner would only park it. The operator force-runs it once the
  //    blocker clears, matching a fresh approval's own refusal.
  //
  // Best-effort — approving must still succeed even if the runner enqueue hiccups.
  // The autonomy master-switch (anton-y3l) gates at *claim* in the runner instead, so with autonomy
  // off the job waits `queued` and re-enabling resumes it.
  // `takeOver` was derived above (identical condition) so the blocker gate could skip a pure take-over.
  // Run-directly (anton-d8i4): the operator's "Approve" (immediate) vs "Queue" choice rides into the
  // enqueue as `bypassBudget`, so the governor paces a Queue but not an Approve. Inert on a project
  // without budget-aware execution — the governor never runs there.
  // The take-over branch keys off `immediateExplicit`, not the immediate DEFAULT: Take over posts
  // `{ steal: true }` with no `immediate` field, and a pure ownership transfer must preserve the
  // existing pacing choice — a defaulted `bypassBudget: true` would promote a covering paced job
  // (or enqueue a fresh bypass one) and silently override the operator's Queue decision.
  //
  // A missing `jobId` is NOT one outcome (PR #212): both enqueues withhold an id on purpose when a
  // run already covers the epic — `enqueueExecuteEpic` when the shared board shows one live on
  // another machine (anton-jz1), `enqueueExecuteEpicIfAbsent` when this instance already holds one.
  // Reporting all three as "nothing started" tells the operator to retry a target that is running,
  // so `run` names which it was and only a thrown enqueue reads as a failure.
  let jobId: string | undefined;
  let run: ApprovalRunOutcome = "none";
  try {
    if (!takeOver) {
      jobId = await enqueueExecuteEpic(project.id, epicId, { bypassBudget: immediate });
      run = jobId ? "started" : "elsewhere";
    } else if (willEnqueue) {
      jobId = await enqueueExecuteEpicIfAbsent(project.id, epicId, { bypassBudget: immediateExplicit });
      run = jobId ? "started" : "covered";
    }
  } catch (err) {
    run = "failed";
    console.error(`[approve] failed to enqueue execute-epic for ${epicId}`, err);
  }

  // No run, no accept: the reservation above is taken back when nothing ended up covering the
  // target, because an accept for a run that never started would be evidence of nothing and earned
  // autonomy reads these counts to decide whether the picker may ever be armed. A run live on
  // another machine KEEPS it — the operator accepted the pick and the work is running, which is what
  // the accept records; only a failed or suppressed enqueue leaves nothing to answer for.
  //
  // Withdrawing also REPLAYS a veto that lost only to this reservation (PR #212 review): that
  // operator was told the target was already running, and with no run there is nothing left for
  // their decline to contradict — so the store files it rather than letting the failed release
  // swallow it.
  if (acceptId && run !== "started" && run !== "elsewhere") {
    await withdrawPickerAccept(getDb(), acceptId, systemClock)
      .then((replayed) => {
        if (replayed) {
          console.warn(
            `[approve] ${epicId} started no run, so the veto that lost to its reservation was recorded after all`,
          );
        }
      })
      .catch((err: unknown) => {
        console.error(`[approve] failed to withdraw the picker accept for ${epicId}`, err);
      });
  }

  // Fire-and-forget: the approve write already landed locally and the run enqueues off that local
  // state, so don't block the response on a `bd dolt pull/commit/push` a slow/unreachable remote
  // could stall. nudgeSync fires the immediate push AND enqueues the durable sync-push backstop
  // (anton-nowq), so a stuck remote becomes a visible parked job rather than a silently-lost approve.
  nudgeSync({ id: project.id, repoPath: project.repoPath }, "approve");

  // Read-after-write, without the read: the approval changed exactly two fields on the target — the
  // `approved` label this route just wrote, and the assignee the CAS verified with its own post-write
  // read — so patch those onto the board item instead of paying a forced cold `bd list` plus a second
  // board rebuild to read back state we already hold. Answering off the stale-tolerant board alone
  // would echo the pre-write values (ClaimControl would keep showing the previous owner), which is
  // what the patch supplies. Everything else on the board is unchanged by an approve, and the write
  // flagged the snapshot pendingWrite, so the client's next poll blocks on a fresh read regardless.
  // `epic` is kept alongside `item` for the existing epic-card client.
  // `advisory` carries the contract gaps that did NOT refuse the approval — the run is starting
  // despite them, so the operator hears about them once, here, rather than never. Empty when this
  // request enqueued nothing (a pure take-over of a blocked target): no run, nothing degraded.
  // `humanGates` rides the same channel and is OMITTED when the run stops for nobody, so the common
  // case adds nothing to the body and the client has nothing to say. `humanTarget` marks the shape
  // of that report: gates on a running target hold it, a human target starts no run at all.
  //
  // The gate lines are withheld when the enqueue THREW (PR #214 review): they describe a run that
  // reaches each ticket and holds there, and with no run enqueued that is a promise about something
  // that does not exist — contradicting the failure the same response reports. `elsewhere` and
  // `covered` keep them: a run does cover the target, it is just not a new one. `humanTarget` is
  // unaffected — "no agent-run starts" is true of a poisoned target however the enqueue went.
  const written = { approved: true, assignee: swap.bead.assignee ?? null };
  const reported = {
    jobId,
    run,
    advisory,
    ...(humanWork.length > 0 && run !== "failed" ? { humanGates: humanWork } : {}),
    ...(humanTarget ? { humanTarget: true } : {}),
  };
  if (epic) {
    const updatedEpic = { ...epic, ...written };
    return NextResponse.json({ epic: updatedEpic, item: updatedEpic, ...reported });
  }
  if (standalone) {
    return NextResponse.json({ item: { ...standalone, ...written }, ...reported });
  }
  return notFoundResponse("Run target not found");
});
