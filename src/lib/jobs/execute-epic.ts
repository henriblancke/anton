/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then per ticket run
 * `claude` (with the ticket's agent prompt) → run tests → commit; when all tickets are done, open
 * ONE PR via `gh` and move the epic to in-review. Idempotent/resumable — a re-run (crash, quota
 * backoff) skips tickets already closed and reuses the existing worktree. See DESIGN.md §4/§7.
 */
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { ownerOf } from "../beads/claim";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "../epic-graph";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { commitAll, openPullRequest, resolveFreshBase } from "../git/ops";
import { createWorktree, removeWorktree } from "../git/worktree";
import {
  getProjectById,
  getProjectSettings,
  resolveVerifyGates,
  type ProjectSettings,
} from "../projects";
import { resolveOperator } from "../operator";
import {
  createRun,
  findOpenRunForEpic,
  updateRun,
} from "../runs";
import { appendSessionLog, createSession, endSession, sessionLogPath } from "../sessions";
import { buildPrTitle } from "./pr-title";
import { isUsageLimitError } from "./errors";
import { runVerifyGates } from "./shell";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
}

export interface ExecuteEpicDeps {
  db: AntonDb;
  clock?: Clock;
  /** Override the branch prefix (default "anton"). */
  branchPrefix?: string;
}

/** Build the runner handler bound to a db/clock. Register it as the "execute-epic" handler. */
export function makeExecuteEpicHandler(deps: ExecuteEpicDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";

  return async function executeEpic(ctx: JobContext): Promise<void> {
    const { projectId, epicBeadId } = ctx.payload as ExecuteEpicPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonEpic(`project ${projectId} not found`);

    const repo = project.repoPath;
    const settings = await getProjectSettings(db, projectId);

    // Load the run target + (for an epic) its tickets from beads (the source of truth). A target
    // is an epic OR a parentless task/bug run as an epic-of-one (isRunTarget). Distinguish the two
    // non-runnable cases so the poison message is honest: a bead that WAS found but isn't a valid
    // target must not read "not found" (that sends the operator hunting for a missing bead).
    const all = await beads.list(repo, ["--status", "all"]);
    const target = all.find((b) => b.id === epicBeadId);
    if (!target) throw new PoisonEpic(`bead ${epicBeadId} not found on the board`);
    if (!beads.isRunTarget(target)) {
      const parent = (target.parent ?? target.parent_id) as string | undefined;
      throw new PoisonEpic(
        `bead ${epicBeadId} is not runnable: type "${target.issue_type ?? "unknown"}"` +
          (parent ? ` with parent ${parent}` : "") +
          ` — only an epic or a parentless task/bug can be run`,
      );
    }
    if (!beads.isApproved(target)) {
      throw new PoisonEpic(`target ${epicBeadId} is not approved — refusing to execute`);
    }

    // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
    // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
    // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a
    // blocker that's no longer done. An epic's blockers come from the epic-graph rollup; a
    // standalone task/bug (epic-of-one) never appears there, so derive its blockers from its own
    // `blocks` edges. Either way, derive from the fresh `all` read above and PARK if a blocker is
    // open — starting still-blocked work would violate the sequence. Recoverable: once the
    // blocker completes, resuming the parked job re-reads beads and passes this gate.
    // An epic also inherits any open standalone (parentless task/bug) prerequisite that the
    // epic-graph rollup drops (epicStandaloneBlockers) — the same gap the approve route closes.
    const blockers = beads.isEpic(target)
      ? [
          ...(computeEpicGraph(all).epics.find((n) => n.id === epicBeadId)?.blockedBy ?? []),
          ...epicStandaloneBlockers(all, epicBeadId),
        ]
      : standaloneBlockers(all, epicBeadId);
    if (blockers.length > 0) {
      throw new PoisonEpic(
        `${epicBeadId} is blocked by ${blockers.join(", ")} — refusing to execute; ` +
          `resume the run once the blocker(s) complete`,
      );
    }

    // An epic runs all its children into one PR; a standalone task/bug IS its own single ticket
    // (an epic-of-one). The rest of the pipeline — worktree, per-ticket claude→tests→commit→close,
    // one PR — is identical either way, so the standalone case is just a one-element ticket list.
    const standaloneRun = !beads.isEpic(target);
    const tickets = standaloneRun ? [target] : childrenOf(all, epicBeadId);
    if (tickets.length === 0) throw new PoisonEpic(`epic ${epicBeadId} has no tickets`);

    // Branches keep the `prefix/id` slash (git convention); only the worktree *path* segment is
    // sanitized (in worktreePathFor). Bead ids are already filesystem-/ref-safe.
    const branch = `${branchPrefix}/${epicBeadId}`;

    // Resume an open run or start a new one.
    const existing = await findOpenRunForEpic(db, projectId, epicBeadId);
    const runId = existing?.id ?? randomUUID();
    if (!existing) {
      await createRun(db, clock, {
        id: runId,
        projectId,
        epicBeadId,
        branch,
        model: settings.model,
        status: "running",
      });
    } else {
      await updateRun(db, clock, runId, { status: "running", error: null });
    }

    try {
      // A standalone target that already committed on a prior attempt carries stage:in-review and
      // is skipped straight to the PR step below — its agent never runs again on this resume. Both
      // the allowlist gate here and the ticket loop share this "won't run" predicate so neither
      // acts on a resume marker: gating on a since-disabled agent would park a retry that only has
      // the (agent-free) PR step left to do.
      const inReview = LABELS.stage("in-review");
      const isResumeSkipped = (t: Bead) =>
        t.status === "closed" || (standaloneRun && (t.labels?.includes(inReview) ?? false));

      // 0. Dispatch honors the active-agents allowlist (anton-dm7). PARK, don't skip: running
      // the ticket with the default agent would silently produce work the operator disabled the
      // specialist for, and skipping it would open the epic's single PR incomplete. Parking is
      // recoverable — the operator enables the agent (Settings → Agents) or relabels the ticket,
      // then resumes; tickets and settings are re-read on every attempt. Checked before any
      // claim/worktree/session work so a run never half-executes into a config problem.
      const inactive = inactiveAgentTickets(
        tickets.filter((t) => !isResumeSkipped(t)),
        settings.agents,
      );
      if (inactive.length > 0) {
        throw new PoisonEpic(
          `epic ${epicBeadId} needs agents disabled in this project's settings: ` +
            inactive.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
            ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
        );
      }

      // 1. Warm worktree (idempotent — reused on resume). Branch off the FRESHEST base
      // (anton-x3o): resolveFreshBase fetches origin/<base> and returns `origin/<base>` so a run
      // whose local base is stale still starts at the remote tip; it's best-effort and falls back
      // to the local base offline. On resume this is moot — createWorktree short-circuits to the
      // existing worktree, so the base is never re-applied mid-run. Note the PR `base` below stays
      // the plain branch name (gh needs a branch, not a remote-tracking ref).
      const baseBranch = settings.baseBranch ?? project.defaultBranch;
      const worktree = await createWorktree({
        repoPath: repo,
        branch,
        baseBranch: await resolveFreshBase(repo, baseBranch),
        warm: true,
      });
      await updateRun(db, clock, runId, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        attempts: ctx.attempt,
      });
      await ctx.heartbeat();

      // 2. Assert this process still owns the epic, THEN claim it for the human operator (idempotent).
      //    An approved-but-unstarted (backlog) target can be TAKEN OVER — reassigned to another
      //    operator via the approve route's steal — after this run was queued but before it leased the
      //    epic (a queued or autonomy-paused job). The take-over enqueues a fresh run on the NEW
      //    owner's instance, but the jobs table is machine-local: THIS stale job still sits on the
      //    ORIGINAL operator's instance. Running it now would execute under the new owner's
      //    reservation — the exact "run under someone else's claim" state the soft-lock
      //    forbids (DESIGN.md §Soft-lock). So gate on ownership FIRST — like the ticket-claim hard gate
      //    in runTicket — AND make the claim itself hard (below): a steal landing between this read and
      //    the claim is caught by `bd update --claim` refusing to reassign, not swallowed by `safe`.
      //    Re-read the owner here (not from the job-start snapshot): the worktree warm
      //    above is several ops wide, so ownership settles against current state, mirroring the approve
      //    route re-reading the assignee at its own run trigger. PARK (not fail) on a mismatch —
      //    recoverable, it stops the stale run without stomping the new owner, and the current owner
      //    approving afresh enqueues a run under their identity on their instance. A runner with no
      //    operator identity can't assert ownership, so it falls through to the prior best-effort claim.
      const operator = await resolveOperator();
      const currentOwner = ownerOf(await beads.show(repo, epicBeadId));
      if (operator && currentOwner && currentOwner !== operator) {
        throw new PoisonEpic(
          `${epicBeadId} is reserved by ${currentOwner}, not ${operator} — it was taken over after ` +
            `this run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} ` +
            `as ${currentOwner} to start a run under the current owner.`,
        );
      }
      if (operator) {
        // Fold the ownership gate INTO the claim so a take-over that lands in the window between the
        // read above and this write can't slip through. `bd update --claim` refuses to reassign a
        // bead a different operator now holds, so it — not the stale pre-read — is the operation that
        // actually observes a racing steal. That refusal MUST stop the run (like runTicket's ticket
        // hard gate), never be swallowed by `safe`: swallowing would tag and execute the epic under
        // the new owner's reservation, the exact state the soft-lock forbids. On the NORMAL path the
        // approve route already pre-assigned this same operator (approve/route.ts `cas(owner, operator)`),
        // so this is a same-actor re-claim — and `bd update --claim` is idempotent for the same actor
        // ("idempotent if already claimed by you" per its own help; verified on bd 1.0.4), so it
        // succeeds and the run proceeds. Same story on resume, so a retry re-claims cleanly. A claim
        // only FAILS when a DIFFERENT operator now holds the bead — the take-over handled below.
        try {
          await beads.claim(repo, epicBeadId, operator);
        } catch (e) {
          // A claim failure has two very different causes and only one warrants poisoning. Re-read the
          // owner to tell them apart: if a DIFFERENT operator now holds the epic, this is a confirmed
          // take-over — retrying is pointless, so poison (human must re-approve as the current owner).
          // But `bd update --claim` also throws on transient failures (a Dolt lock, a CLI timeout) with
          // NO ownership change; poisoning those would park a valid approved epic that a retry would
          // claim cleanly. Treat that class as a normal retryable error — the same call runTicket's
          // hard gate makes — so the runner retries instead of parking. A racing steal is still caught:
          // either this re-read sees it, or the pre-read gate above does on the next attempt. If the
          // re-read ITSELF fails we can't confirm a take-over, so fall through to the retryable path.
          const ownerNow = await beads
            .show(repo, epicBeadId)
            .then(ownerOf)
            .catch(() => undefined);
          if (ownerNow && ownerNow !== operator) {
            throw new PoisonEpic(
              `${epicBeadId} is reserved by ${ownerNow}, not ${operator} — it was taken over after this ` +
                `run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} as ` +
                `${ownerNow} to start a run under the current owner. ` +
                `(${e instanceof Error ? e.message : String(e)})`,
            );
          }
          throw new Error(
            `${epicBeadId} could not be claimed for ${operator} — the beads DB is locked or the claim ` +
              `command failed transiently; retrying. ` +
              `(${e instanceof Error ? e.message : String(e)})`,
          );
        }
      } else if (currentOwner) {
        // No operator identity, but the epic is owned by someone. We can't assert we ARE that
        // owner, and a best-effort `safe` claim would swallow bd's refusal to reassign a foreign
        // bead — tagging and running the epic under the current owner's reservation, the exact
        // state the soft-lock forbids (DESIGN.md §Soft-lock). So mirror the pre-read gate above
        // and PARK: this is an older queued approved-but-unassigned job on an instance without
        // ANTON_OPERATOR/global user.name, and another operator took the epic over before the
        // lease. Poison (recoverable) — a human must re-approve as the current owner to enqueue a
        // run under their identity. Retrying is pointless: this runner still can't assert ownership.
        throw new PoisonEpic(
          `${epicBeadId} is reserved by ${currentOwner}, but this runner has no operator identity ` +
            `(set ANTON_OPERATOR or the global git user.name) to assert ownership — refusing to ` +
            `run under another operator's claim. Approve ${epicBeadId} as ${currentOwner} to start ` +
            `a run under the current owner.`,
        );
      } else {
        // No operator identity AND the epic is unowned → nobody's reservation to stomp, so keep
        // the prior best-effort claim (bd falls back to its own actor resolution).
        await safe(() => beads.claim(repo, epicBeadId, operator));
      }
      await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("implementing")]));
      void beads
        .sync(repo)
        .catch((e) => console.error(`[execute-epic] claim sync failed for ${epicBeadId}`, e));

      // 3. Per ticket: claude → tests → commit → (close | in-review). Skip work that already
      //    landed on a prior attempt. A closed ticket is done — an epic's children close as they
      //    commit, and any resumed run skips them. A standalone target is NEVER closed here (its
      //    close is a merge-time concern, below): the moment its single ticket commits, runTicket
      //    moves it to stage:in-review instead — that label is both the board's "in review" state
      //    and the persisted resume marker, so a retry after a failed PR step skips straight to
      //    the PR step here rather than re-running claude/tests/commit on already-committed work.
      for (const ticket of orderTickets(tickets, all)) {
        if (ticket.status === "closed") continue;
        if (standaloneRun && (ticket.labels?.includes(inReview) ?? false)) {
          // Resume after a failed PR step: this ticket already committed and moved to in-review on
          // a prior attempt. Step 2 above re-tagged the target stage:implementing (it can't tell a
          // fresh run from a resume), and runTicket — the only standalone path that clears
          // implementing — is being skipped here. Clear it now so the ticket doesn't carry BOTH
          // stage labels into merge-finalize, which strips only in-review and would otherwise leave
          // a stale implementing label (making a reopened bead derive as in-progress).
          await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
          continue;
        }
        await runTicket({
          db,
          clock,
          ctx,
          projectId,
          repo,
          runId,
          worktreePath: worktree.path,
          ticket,
          settings,
          operator,
          closeOnDone: !standaloneRun,
        });
        await ctx.heartbeat();
      }

      // 4. All tickets done → open one PR, stamp the PR ref, and (for an epic) move it to
      //    in-review. A standalone target is NOT closed here: like an epic it stays OPEN, tagged
      //    stage:in-review (runTicket already applied that on commit), carrying its PR ref until
      //    the PR actually MERGES — at which point review-fix's merge-finalize path closes it.
      //    Closing it now would derive it as Done on the board while its PR is still open and drop
      //    it out of review-fix's in-review sweep (which is what keeps a standalone PR in the
      //    automated review/finalization path).
      const pr = await openPullRequest({
        repoPath: repo,
        branch: worktree.branch,
        base: baseBranch,
        title: buildPrTitle(target, epicBeadId, settings.conventionalCommits),
        body: prBody(target, tickets),
      });
      await safe(() => beads.setExternalRef(repo, epicBeadId, pr.ref));
      if (!standaloneRun) {
        await safe(() => beads.tag(repo, epicBeadId, [inReview]));
        await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
      }

      // 5. Finalize run + clean up the worktree (the branch/PR carry the work now).
      await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
      await safe(() => removeWorktree(worktree));
    } catch (e) {
      // Quota → park the run (job reschedules); anything else → the run failed (job retries/parks).
      if (isUsageLimitError(e)) {
        await updateRun(db, clock, runId, { status: "parked", error: "usage-limit" });
      } else {
        await updateRun(db, clock, runId, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
          endedAt: clock.now(),
        });
      }
      throw e; // let the runner apply job-level durability
    } finally {
      // Every bd write above (claims, closes, stage labels, PR ref) must reach the remote even
      // when the run failed mid-way. Logged, not thrown: a push failure must not mask the run's
      // own error or fail a run whose real work (branch + PR) already landed.
      await beads
        .sync(repo)
        .catch((e) => console.error(`[execute-epic] beads dolt sync failed for ${epicBeadId}`, e));
    }
  };
}

/** One ticket: session → claude → tests → commit → close. */
async function runTicket(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  repo: string;
  runId: string;
  worktreePath: string;
  ticket: Bead;
  settings: ProjectSettings;
  operator?: string;
  /** Close the bead in beads once its work is committed. False for a standalone (epic-of-one)
   * target, which is never closed by execute-epic: it stays open + stage:in-review + PR ref until
   * its PR merges (review-fix's merge-finalize path closes it). On commit, a false value instead
   * moves the bead to stage:in-review — the resume marker + board state. Defaults to true (an
   * epic's children close as their work lands). */
  closeOnDone?: boolean;
}): Promise<void> {
  const { db, clock, ctx, projectId, repo, runId, worktreePath, ticket, settings, operator } =
    args;
  const closeOnDone = args.closeOnDone ?? true;

  // Claim the ticket for the operator as a HARD GATE before doing any work. On a shared board
  // the claim is the cross-operator coordination primitive (anton-live-sync R6): a failure here
  // means the ticket was already claimed by another operator (e.g. after a heartbeat pull) or the
  // local Dolt DB is locked. In either case we must NOT run Claude on a ticket this process does
  // not own — and must NOT fall through to the failure path below, which would clear the real
  // owner's claim. Claiming is idempotent for the same actor, so a resume re-claims cleanly. A
  // conflict aborts the run before any session/worktree work; the job retries and either skips the
  // now-closed ticket (already-closed check in the caller) or reclaims one whose owner released it.
  try {
    await beads.claim(repo, ticket.id, operator);
  } catch (e) {
    throw new Error(
      `refusing to execute ${ticket.id}: could not claim it for ${operator ?? "this operator"} ` +
        `— already claimed by another operator, or the beads DB is locked ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  // Announce the stage + nudge a sync so the claim reaches teammates within a heartbeat
  // (fire-and-forget; the end-of-run sync is the backstop).
  await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("implementing")]));
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));

  const agentTag = labelValue(ticket.labels, "agent");
  // Compose the system prompt: locked base contract + agent-tag prompt + operator seed. The base
  // is mandatory (buildExecutionSystemPrompt throws if src/prompts/system-base.md is missing).
  const agentPrompt = await loadAgentPrompt(agentTag, { projectDir: worktreePath });
  const appendSystemPrompt = await buildExecutionSystemPrompt({
    agentPrompt,
    seedPrompt: settings.seedPrompt,
  });

  const sessionId = randomUUID();
  const logPath = sessionLogPath(sessionId);
  await createSession(db, clock, {
    id: sessionId,
    projectId,
    runId,
    kind: "execute",
    beadId: ticket.id,
    logPath,
  });
  await updateRun(db, clock, runId, { ticketBeadId: ticket.id, agentTag: agentTag ?? null });

  const onEvent = (e: ClaudeEvent) => {
    const line = e.text ? `[${e.type}] ${e.text}\n` : `[${e.type}]\n`;
    void appendSessionLog(logPath, line).catch(() => {});
  };

  let committed = false;
  try {
    const result = await runClaude({
      cwd: worktreePath,
      prompt: ticketPrompt(ticket),
      appendSystemPrompt,
      model: settings.model,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      signal: ctx.signal,
      onEvent,
    });
    if (!result.ok) {
      throw new Error(`claude reported an error for ${ticket.id}: ${result.text ?? "unknown"}`);
    }

    // Verify gates (optional — configured per project): tests + operator-pinned lint/typecheck/
    // build (anton-3oh8). Absent → no gates run. A non-zero exit fails the ticket before commit.
    await runVerifyGates(
      resolveVerifyGates(settings),
      worktreePath,
      ctx.signal,
      logPath,
      (gate, code) => `${gate.label} gate failed for ${ticket.id} (exit ${code})`,
    );

    // Commit whatever claude changed — and honor commitAll's { committed } verdict. A clean agent
    // exit that leaves NO diff delivered nothing: the exact false-success in issue #46 (root cause
    // #1). Do NOT close/advance the ticket on empty delivery. Throw a NoDeliveryError so the catch
    // below BLOCKS the ticket for a human (never re-queues it open) and the error propagates out of
    // the ticket loop, halting dispatch of the rest of the epic. NoDeliveryError is poison, so the
    // runner parks the run for a human instead of retrying claude to the same empty result forever.
    const { committed: didCommit } = await commitAll(worktreePath, `${ticket.id}: ${ticket.title}`);
    if (!didCommit) {
      throw new NoDeliveryError(
        `${ticket.id} produced no delivery: claude exited cleanly and passed the verify gates but ` +
          `left no changes to commit (zero diff). Blocking the ticket for operator review and ` +
          `halting the epic — nothing landed, so closing it would be a false success.`,
      );
    }
    committed = true;

    // Persist this ticket's "code done" state the moment it commits. An epic child closes (stage
    // → done). A standalone target isn't closed until its PR merges, so instead move it to
    // stage:in-review here (dropping implementing): that is both its board state and the persisted
    // resume marker, so a retry after a failed PR step skips it rather than re-running claude on
    // committed work. endSession still records the work done either way.
    if (closeOnDone) {
      await safe(() => beads.close(repo, ticket.id));
    } else {
      await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("in-review")]));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    await endSession(db, clock, sessionId, "done");
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    // Record the no-delivery reason in the session log too, so it's visible when tailing/replaying
    // the session — not just in the run row's error. Best-effort; never mask the run's own error.
    const noDelivery = e instanceof NoDeliveryError;
    if (noDelivery) {
      await appendSessionLog(logPath, `[no-delivery] ${e.message}\n`).catch(() => {});
    }
    // Release the claim so the board never shows a dead session's ticket as in-flight
    // (anton-live-sync R10). A usage-limit park is NOT dead — the run resumes with the claim
    // intact. Two states must NOT silently re-queue the ticket open: work already landed on the
    // branch (commits exist), OR the agent delivered nothing at all (zero diff). Both are
    // human-review states — block with an operator-facing note. Resetting a no-delivery ticket to
    // open would silently re-queue it into the ready pool and hide the false-success. All
    // best-effort: never mask the run's error; the epic-level finally sync pushes the release.
    if (!isUsageLimitError(e)) {
      if (committed || noDelivery) {
        await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
        await safe(() =>
          beads.note(
            repo,
            ticket.id,
            noDelivery
              ? `anton: run made no changes (clean agent exit, zero diff) — nothing was delivered; ` +
                  `needs a human to implement it or fix the ticket, then resume the run`
              : `anton: run failed after committing work — needs review`,
          ),
        );
      } else {
        await safe(() => beads.setStatus(repo, ticket.id, "open"));
      }
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    throw e;
  }
}

// ── helpers ──

/** A permanent, human-needed failure (never retried). */
class PoisonEpic extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The agent exited clean but delivered no code — a zero-diff commit (issue #46 root cause #1).
 * Poison-classified (`name = "PoisonError"`), so the runner parks the run for a human rather than
 * burning retries: re-running the agent on the same unchanged ticket would just reproduce the empty
 * result. A distinct subclass so runTicket's catch can tell "delivered nothing" apart from other
 * failures and block (never re-queue open) the ticket accordingly.
 */
class NoDeliveryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

function childrenOf(all: Bead[], epicId: string): Bead[] {
  return all.filter((b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId);
}

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
}

/**
 * Tickets whose `agent:` label names a specialist agent the project has disabled (anton-dm7).
 * `activeAgents` is settings.agents. Semantics:
 *   • absent (never persisted / cleared) → all agents active (a project that never touched
 *     settings must not stall; the API persists a cleared value as `undefined`, never `[]`)
 *   • EMPTY allowlist `[]` → no agents active: every ticket with an `agent:` label is parked.
 *     The operator explicitly toggled every agent off, and the API persists `[]` as a real
 *     value distinct from clearing (settings/route.ts) — honoring it is the whole point.
 *   • no `agent:` label → runs with the default agent, never blocked
 *   • the allowlist gates ALL agents — bundled AND the operator's own `.claude/agents` (anton-dvo.1).
 *     Custom agents are discoverable and toggleable in Settings now, so a ticket needing a disabled
 *     custom agent is parked just like a bundled one, rather than silently running.
 */
export function inactiveAgentTickets(
  tickets: Bead[],
  activeAgents: string[] | undefined,
): { id: string; agent: string }[] {
  if (activeAgents == null) return [];
  const active = new Set(activeAgents);
  const out: { id: string; agent: string }[] = [];
  for (const t of tickets) {
    const agent = labelValue(t.labels, "agent");
    if (!agent) continue;
    if (!active.has(agent)) out.push({ id: t.id, agent });
  }
  return out;
}

/**
 * Topologically order tickets so a ticket runs after the tickets it depends on (`blocks` edges
 * among the epic's own members). Falls back to input order on a cycle.
 */
export function orderTickets(tickets: Bead[], all: Bead[]): Bead[] {
  const ids = new Set(tickets.map((t) => t.id));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of tickets) {
    indeg.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    // e.from depends on e.to → e.to must come first.
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
    indeg.set(e.from, (indeg.get(e.from) ?? 0) + 1);
  }
  const queue = tickets.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (order.length !== tickets.length) return tickets; // cycle → original order
  return order.map((id) => byId.get(id)!);
}

/**
 * Cap on each inlined ticket field. anton worktrees carry a frozen embedded Dolt with no remote,
 * so `bd show` inside the worktree can fail (issue #46 root cause #3) — the prompt must therefore
 * carry the spec itself and not be load-bearing on in-worktree DB access. A generous per-field
 * budget keeps a pathologically large body from bloating the prompt while still delivering the
 * whole spec for the common case.
 */
const MAX_TICKET_FIELD_CHARS = 4000;

function truncateField(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TICKET_FIELD_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TICKET_FIELD_CHARS)}\n… [truncated — run \`bd show\` for the full text]`;
}

/**
 * The concrete task (`-p`) for one ticket. The operating contract (git/beads ownership, scope,
 * learnings, fail-loud) lives in the locked base system prompt (composeSystemPrompt), so it isn't
 * duplicated here.
 *
 * The ticket's full spec — Goal / Out of scope / Verify (the `description` markdown), Acceptance,
 * and Context — is inlined so the agent can implement even when the worktree's beads DB is
 * unreadable (issue #46 root cause #3). `bd show` is offered as a convenience, never as the sole
 * source: a bead whose spec is genuinely empty AND whose `bd show` fails is a fail-loud/blocked
 * condition, not a cue to silently produce nothing.
 */
export function ticketPrompt(ticket: Bead): string {
  const description = ticket.description?.trim();
  const acceptance = (ticket.acceptance_criteria ?? ticket.acceptance)?.trim();
  // In some boards Context is a separate column; in others it's folded into `description` as a
  // `## Context` heading. Only inline the standalone field when it isn't already in `description`.
  const context =
    ticket.context?.trim() && ticket.context.trim() !== description
      ? ticket.context.trim()
      : undefined;

  const lines = [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
  ];
  if (description) {
    lines.push(``, `## Goal / Out of scope / Verify`, truncateField(description));
  }
  lines.push(``, `## Acceptance criteria`, acceptance ? truncateField(acceptance) : "(none stated)");
  if (context) {
    lines.push(``, `## Context`, truncateField(context));
  }
  lines.push(
    ``,
    `The full ticket spec is inlined above so you can implement it even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticket.id}\` gives the same content when bd is healthy. If ` +
      `the spec above is empty AND \`bd show\` fails, stop and report the ticket as blocked — do ` +
      `not guess or silently bail. Follow the operating contract in your system prompt.`,
  );
  return lines.join("\n");
}

function prBody(target: Bead, tickets: Bead[]): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const lines = [
    `Autonomous run for **${target.id}** — ${target.title}.`,
    ``,
    ...(standalone ? [] : [`Tickets:`, ...tickets.map((t) => `- ${t.id} — ${t.title}`), ``]),
    `🤖 Generated with [anton](https://github.com/) autonomous execution`,
  ];
  return lines.join("\n");
}

/** Swallow errors from best-effort bd side effects (already-applied labels, etc.). */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
