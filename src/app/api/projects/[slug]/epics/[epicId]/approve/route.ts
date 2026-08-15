import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { epicStandaloneBlockers, standaloneBlockers } from "@/lib/epic-graph";
import { refreshAllIssues } from "@/lib/beads/issues";
import { beads, type Bead } from "@/lib/beads/bd";
import { contractGaps, formatContractGaps } from "@/lib/beads/contract";
import { formatStructureViolations, structureGaps } from "@/lib/beads/structure";
import { nudgeSync } from "@/lib/beads/sync-nudge";
import { conflictBody, ownerOf, withClaimLock } from "@/lib/beads/claim";
import { applyProposal, ProposalApplyError } from "@/lib/gardener/apply";
import { isProposalBead } from "@/lib/gardener/detections";
import { enqueueExecuteEpic, enqueueExecuteEpicIfAbsent } from "@/lib/jobs/service";
import { resolveOperator } from "@/lib/operator";
import type { Project } from "@/lib/types";
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
 */
async function readApprovalBody(
  request: Request,
): Promise<{ steal: boolean; immediate: boolean; immediateExplicit: boolean }> {
  try {
    const body = (await request.json()) as { steal?: unknown; immediate?: unknown };
    return {
      steal: body?.steal === true,
      immediate: body?.immediate !== false,
      immediateExplicit: body?.immediate === true,
    };
  } catch {
    return { steal: false, immediate: true, immediateExplicit: false };
  }
}

/** HTTP status per apply failure: the caller's mistake, the board's, or ours. */
const APPLY_STATUS = { unusable: 422, refused: 409, failed: 500 } as const;

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

  if (!beads.isRunTarget(target, allBeads)) {
    const parent = beads.parentOf(target);
    const type = target.issue_type ?? "unknown";
    let reason: string;
    if (beads.isContainer(target, allBeads)) {
      // Approval is a per-PR gate, so it must never be offered on a bead whose approval would
      // launch one PR per feature under it (design 2026-07-26: "Approval stays per feature").
      reason = `${epicId} is a container epic, not a run target — approve one of its features instead; each feature is its own run and its own PR`;
    } else if ((type === "task" || type === "bug") && parent) {
      reason = `${epicId} is a child ticket of ${parent} — approve its epic ${parent} instead; a child runs via its epic's PR, not on its own`;
    } else {
      reason = `${epicId} is not runnable: type "${type}" — only a feature, a parentless task/bug, or an epic with no feature children can be approved to run`;
    }
    return NextResponse.json({ error: reason }, { status: 422 });
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
  const { steal, immediate, immediateExplicit } = await readApprovalBody(request);
  // A pure take-over reassigns the reservation and nothing more (the enqueue gate at the end skips its
  // run), so it bypasses the blocker gate — but never the steal-validity checks below, which still
  // confine it to a backlog target with a resolvable operator identity. Mirrors the enqueue-suppression
  // condition computed identically at the end.
  const takeOver = wasApproved && steal && !!owner && owner !== operator;

  // Open blockers for the run target, derived off the fresh `allBeads` read above. For an epic that's
  // the epic-graph rollup (epic→epic + cross-epic child blocks) PLUS any parentless standalone
  // (task/bug) prerequisite the rollup DROPS (epicStandaloneBlockers) — otherwise an epic that
  // depends on an open standalone item would read ready. For a standalone target the rollup never
  // carries it, so derive from its own `blocks` edges. Two consumers below: the readiness gate (a
  // fresh approval enqueues immediately, so a still-blocked target must be rejected before we
  // label + enqueue work `bd ready` would keep blocked), and the take-over enqueue at the end (which
  // only fires when nothing is open).
  const openBlockers = epic
    ? [...epic.blockedBy, ...epicStandaloneBlockers(allBeads, epicId)]
    : standaloneBlockers(allBeads, epicId);
  // A pure take-over bypasses this gate — it only reassigns the reservation and enqueues no run that
  // would start blocked work (see the enqueue gate at the end) — so a target that gained a blocker
  // AFTER its original approval stays transferable to a new owner rather than stranded with the old.
  if (!takeOver && openBlockers.length > 0) {
    const message = epic
      ? `Epic is blocked by ${openBlockers.join(", ")}`
      : `${epicId} is blocked by ${openBlockers.join(", ")}`;
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
  // non-take-over always enqueues (a blocked one already 409'd above), a take-over only when
  // nothing is open.
  const willEnqueue = !takeOver || openBlockers.length === 0;
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

  // Enforce the claim as a soft-lock at the run trigger, from the fresh ownership read above.
  if (owner && owner !== operator) {
    // Claimed by someone else → approving would silently run a teammate's reservation. Require an
    // explicit steal to take it over, mirroring the claim route's 409.
    if (!steal) {
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} — pass { steal: true } to approve and take it over`,
          owner,
        },
        { status: 409 },
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
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} and is already ${stage} — its run is in progress, so it can't be taken over; wait for it to finish or have ${owner} release it`,
          owner,
          stage,
        },
        { status: 409 },
      );
    }
    // Steal requested, but no operator identity resolves (no ANTON_OPERATOR, no global git user.name),
    // so we can't reassign the target. Approving anyway would enqueue a run under the teammate's
    // reservation while leaving them as assignee — a half-steal that breaks the soft-lock the response
    // text and DESIGN.md promise. Reject until an operator identity is set to take ownership.
    if (!operator) {
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} — set ANTON_OPERATOR (or git user.name) to identify who is taking it over before approving`,
          owner,
        },
        { status: 409 },
      );
    }
  }
  // Auto-claim, then approve, both under the bead's claim-write lock.
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
  const swap = await withClaimLock(project.repoPath, epicId, async (cas) => {
    // Re-derive the stage HERE, under the lock — not only from the pre-lock `target` read above.
    // On a steal (owner !== operator) the pre-lock stage gate can pass on a backlog snapshot, then
    // the original owner's runner starts in the window before this CAS: it moves the bead to
    // in_progress/stage:implementing but leaves the assignee as the old owner, so `cas(owner, …)`
    // (which matches on assignee alone) would still succeed and reassign a *live* run to the
    // approver — the exact implementing/in-review takeover the pre-lock gate rejects. Reading the
    // stage inside the lock makes a run that started in that window lose the swap instead. A
    // self-owned re-approve (owner === operator, e.g. Force run on an implementing epic) is
    // deliberately excluded: it's the operator asking to re-run their own target, not a takeover.
    let locked: Bead | undefined;
    if (owner && owner !== operator) {
      locked = await beads.show(project.repoPath, epicId);
      const lockedStage = locked ? deriveStage(locked) : undefined;
      if (lockedStage && lockedStage !== "backlog") return { moved: lockedStage } as const;
    }
    // Hand the stage gate's read to the CAS: it needs the assignee as of this lock, which is exactly
    // what `locked` holds — re-reading it would be a second `bd show` of a bead nothing can move.
    const result = await cas(owner, operator ?? owner, locked);
    if (result.ok) await beads.approve(project.repoPath, epicId);
    return result;
  });
  if ("moved" in swap) {
    return NextResponse.json(
      {
        error: `${epicId} is claimed by ${owner} and is already ${swap.moved} — its run started while this approval was in flight, so it can't be taken over; wait for it to finish or have ${owner} release it`,
        owner,
        stage: swap.moved,
      },
      { status: 409 },
    );
  }
  if (!swap.ok) return NextResponse.json(conflictBody(epicId, swap.owner), { status: 409 });

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
  //    Skip the take-over enqueue when the target is currently blocked: a take-over bypasses the
  //    readiness gate above (to stay transferable), but starting blocked work is exactly what that
  //    gate prevents — the runner would only park it. The operator force-runs it once the blocker
  //    clears, matching a fresh approval's own blocker rejection.
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
  let jobId: string | undefined;
  try {
    if (!takeOver) {
      jobId = await enqueueExecuteEpic(project.id, epicId, { bypassBudget: immediate });
    } else if (willEnqueue) {
      jobId = await enqueueExecuteEpicIfAbsent(project.id, epicId, { bypassBudget: immediateExplicit });
    }
  } catch (err) {
    console.error(`[approve] failed to enqueue execute-epic for ${epicId}`, err);
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
  const written = { approved: true, assignee: swap.bead.assignee ?? null };
  if (epic) {
    const updatedEpic = { ...epic, ...written };
    return NextResponse.json({ epic: updatedEpic, item: updatedEpic, jobId, advisory });
  }
  if (standalone) {
    return NextResponse.json({ item: { ...standalone, ...written }, jobId, advisory });
  }
  return notFoundResponse("Run target not found");
});
