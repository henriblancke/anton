/**
 * Resolving WHAT a run executes, off one board read (anton-ejx2 — extracted from
 * execute-epic-start.ts). A target bead, its tickets, the operator's own discoverable agents, and
 * the readiness gate those tickets are re-checked against — everything `beginEpicRun` needs before
 * it opens a run row, gathered behind one module so a change to any one of these reads does not
 * also ripple into the start path's own import surface.
 *
 * Pure except for `discoverAgents`' filesystem read; nothing here writes to the board.
 */
import { beads, type Bead } from "../beads/bd";
import { cycleEvidenceFor } from "../beads/cycle-evidence";
import { loadAllIssues } from "../beads/issues";
import { formatStructureViolations, structureGaps } from "../beads/structure";
import { isUnit } from "../epic-graph";
import { runTickets } from "../ticket-view";
import { bundledAgentIds, discoverAgents } from "../agents-discovery";
import { fingerprintLabelOf, isProposalBead } from "../gardener/detections";
import { PoisonEpic } from "./errors";
import { blockedRunPoison, runReadiness, type RunReadiness } from "./execute-epic-board";
import { humanTargetPoison } from "./execute-epic-human-gate";

/** What `beginEpicRun` needs to know about its target before it may open a run row. */
export interface ResolvedRunTarget {
  all: Bead[];
  target: Bead;
  targetIsUnit: boolean;
  standaloneRun: boolean;
  tickets: Bead[];
  userAgentIds: string[];
  /** The same readiness gate re-checked here, re-usable against every board the run re-reads. */
  readiness: (board: Bead[]) => RunReadiness;
}

/**
 * Read the board, resolve `epicBeadId` into a runnable target and its tickets, and refuse every
 * shape a run must never start. `null` — not an error — for an ABANDONED target (anton-6xj0): a
 * human declared the work won't be done, and there is nothing to run.
 */
export async function resolveRunTarget(
  repo: string,
  epicBeadId: string,
): Promise<ResolvedRunTarget | null> {
  const userAgentIds = await discoverUserAgents(repo);

  // `loadAllIssues`, not a bare `bd list`: bd OMITS gate beads from every ordinary listing while
  // carrying the `blocks` edge a gate puts on the bead it gates, and every blocker helper treats a
  // blocker it can't see as still open (fail safe). Since a run arms a `gh:pr` merge gate on its own
  // target (anton-k0kj), a bare list would leave that edge dangling and poison the target's own
  // recovery run forever. STRICT for the same reason: a swallowed gate-listing failure would leave
  // that edge dangling and the blocker check would read it as open, poisoning a run a retry would
  // have carried. Let it reject; the runner retries. `withCycles` reads authoritative `bd dep
  // cycles` evidence alongside — see the structure re-check below.
  const all = await loadAllIssues(repo, { strictGates: true, withCycles: true });
  const target = assertRunnableTarget(all, epicBeadId);
  if (!target) return null;

  // Re-run the authoritative structure/cycle gate here too, not only at approval (route.ts).
  // Approval only guarantees this target's tree was cycle-free at approval time; a cross-machine
  // Dolt merge can land an internal `blocks` cycle among this run's OWN tickets after that check
  // passed but before this job ever dispatches. `runReadiness` below treats an internal edge as
  // ORDERING rather than a blocker, so it never sees a cycle — and `orderTickets`
  // (execute-epic-board.ts) falls back to input order the moment its topological sort can't place
  // every ticket, which would let the run dispatch a dependent ticket ahead of the prerequisite the
  // very edges say it must follow. Poison the run before anything is held; the fix is on the board
  // (remove the cycle edge), not a retry.
  const structural = structureGaps(epicBeadId, all, { cycles: cycleEvidenceFor(all) });
  if (structural.blocking.length > 0) {
    throw new PoisonEpic(
      `${epicBeadId} breaks the tier structure: ${formatStructureViolations(structural.blocking)}`,
    );
  }

  // Unit-ness is type-only (isUnit reads `issue_type`), so unlike the grouping shape it genuinely
  // can't change across a pull — captured here and reused against every board this run re-reads.
  const targetIsUnit = isUnit(target);
  const readiness = (board: Bead[]) => runReadiness(board, epicBeadId, targetIsUnit);

  // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
  // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
  // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a blocker
  // that's no longer done. PARK if NOTHING can start — starting still-blocked work would violate the
  // sequence. Recoverable: once the blocker completes, resuming the parked job re-reads beads and
  // passes this gate.
  const verdict = readiness(all);
  if (!verdict.runnable) throw blockedRunPoison(epicBeadId, verdict, all);

  const { standaloneRun, tickets } = selectRunTickets(all, target, epicBeadId);

  return { all, target, targetIsUnit, standaloneRun, tickets, userAgentIds, readiness };
}

/**
 * The project's OWN agents — a discoverable `agent:<id>` whose id anton does NOT ship as a bundled
 * specialist. These are NEVER gated by the active-agents allowlist (anton-dvo.1 reversed): the
 * operator brought them and labels tickets with them deliberately, so a second opt-in in Settings is
 * pure friction. The allowlist governs anton's bundled NAMESPACE only; a bundled id stays gated even
 * when the operator has a `.claude/agents/<id>.md` override of it (else a machine that mirrors every
 * bundled name into ~/.claude/agents would slip the whole allowlist). An id that resolves nowhere (a
 * typo) is not in `discovered`, so it isn't exempted — it parks.
 *
 * Fails safe to "no user agents" on a discovery error rather than crashing the run here.
 */
async function discoverUserAgents(repo: string): Promise<string[]> {
  return Promise.all([discoverAgents(repo), bundledAgentIds()])
    .then(([discovered, bundled]) => {
      const bundledSet = new Set(bundled);
      return discovered.filter((a) => !bundledSet.has(a.id)).map((a) => a.id);
    })
    .catch(() => [] as string[]);
}

/** Why a bead that WAS found still cannot run — every shape {@link classifyRunTarget} answers. */
type RunTargetState =
  | "proposal"
  | "not-run-target"
  | "not-approved"
  | "abandoned"
  | "human-work"
  | "runnable";

/**
 * The run-target predicate: what `target` IS and what STATE it's in, as one of
 * {@link RunTargetState} — the decision {@link assertRunnableTarget} throws or returns against.
 *
 * Ahead of the run-target and approval tests for the same reason the picker puts it first
 * (picker-targets.ts): what the bead IS settles this before anything about its shape or state is
 * consulted — a PROPOSAL is a decision, not work (anton-x37c), and must not read as work merely
 * waiting for a signature.
 */
export function classifyRunTarget(target: Bead, all: Bead[]): RunTargetState {
  if (isProposalBead(target)) return "proposal";
  if (!beads.isRunTarget(target, all)) return "not-run-target";
  if (!beads.isApproved(target)) return "not-approved";
  // Reached by a job that was already queued (or is being resumed) when the abandon landed; a job
  // that was RUNNING is cancelled by the abandon itself.
  if (beads.isAbandoned(target)) return "abandoned";
  // Work only a person can do never reaches an agent (anton-mv70). `agent:human` names the one
  // specialist anton does not have, so dispatching it would fall through to the DEFAULT agent and
  // spend a run flailing at a credential, a purchase or a taste call. The claimable set already
  // excludes it (beads.isHumanWork); this is the backstop for every other way a run starts — Force
  // run, a resumed job queued before the label landed, an API enqueue. Poison, not retry: no number
  // of attempts turns human work into agent work, and parking puts it back in front of the operator
  // who has to do it.
  if (beads.isHumanWork(target)) return "human-work";
  return "runnable";
}

/**
 * The bead this run executes, or `undefined` when a human has abandoned it (the caller's clean exit).
 *
 * A target is a feature, a parentless task/bug run as an epic-of-one, or a legacy epic with no
 * feature children (isRunTarget). The non-runnable cases are distinguished so the poison message is
 * honest: a bead that WAS found but isn't a valid target must not read "not found" (that sends the
 * operator hunting for a missing bead), and a container epic must be told it is one.
 */
function assertRunnableTarget(all: Bead[], targetId: string): Bead | undefined {
  const target = all.find((b) => b.id === targetId);
  if (!target) throw new PoisonEpic(`bead ${targetId} not found on the board`);
  const state = classifyRunTarget(target, all);
  if (state === "runnable") return target;
  if (state === "abandoned") return undefined;
  throw runTargetPoison(state, target, all, targetId);
}

/** The refusal each non-runnable {@link RunTargetState} settles with, in the operator's words. */
function runTargetPoison(
  state: Exclude<RunTargetState, "runnable" | "abandoned">,
  target: Bead,
  all: Bead[],
  targetId: string,
): PoisonEpic {
  const poisonOf: Record<typeof state, () => PoisonEpic> = {
    proposal: () => proposalTargetPoison(target),
    "not-run-target": () => notARunTarget(target, all, targetId),
    "not-approved": () => new PoisonEpic(`target ${targetId} is not approved — refusing to execute`),
    "human-work": () => humanTargetPoison(targetId),
  };
  return poisonOf[state]();
}

/**
 * The refusal a PROPOSAL target settles with (anton-x37c) — the runner's half of the rule the
 * approve route and the picker already hold.
 *
 * Poison, not retry: no number of attempts turns a decision into work, and parking puts it back in
 * front of the person whose call it is. The message names the label (the one thing on the bead that
 * says "decision") and the gesture that ends it — approving a proposal APPLIES its move and closes
 * it, which is the whole reason no agent is dispatched at it.
 */
function proposalTargetPoison(target: Bead): PoisonEpic {
  return new PoisonEpic(
    `bead ${target.id} is a proposal, not work — it is labelled ${fingerprintLabelOf(target)}, ` +
      `which anton files for a board move a person decides on. Approving one APPLIES the move and ` +
      `closes the bead; no agent implements it and no run can deliver it. Approve or decline it ` +
      `instead of running it, and file the work as its own bead if there is any`,
  );
}

/** Why this bead cannot be run, in the words the operator needs to act on it. */
function notARunTarget(target: Bead, all: Bead[], targetId: string): PoisonEpic {
  if (beads.isContainer(target, all)) {
    return new PoisonEpic(
      `epic ${targetId} is a container, not a run target — it has feature children, and each ` +
        `feature runs on its own (own worktree, own PR); run one of its features instead`,
    );
  }
  const parent = beads.parentOf(target);
  return new PoisonEpic(
    `bead ${targetId} is not runnable: type "${target.issue_type ?? "unknown"}"` +
      (parent ? ` with parent ${parent}` : "") +
      ` — only a feature, a parentless task/bug, or an epic with no feature children can be run`,
  );
}

/**
 * The tickets this run dispatches, and whether the target IS its own single ticket.
 *
 * A grouping target runs all its children into one PR; a leaf target IS its own single ticket (an
 * epic-of-one). The rest of the pipeline — worktree, per-ticket claude→tests→commit→close, one PR —
 * is identical either way, so the leaf case is just a one-element ticket list. An epic always groups
 * (a childless one poisons here, exactly as before the tier split); a feature groups only once
 * tickets have been shaped under it — a feature shaped as one unit of work is its own ticket, so it
 * must not poison for having no children. A parentless task/bug is always a leaf. The rule is shared
 * with epic-detail (beads.groupsChildren) so a run and its detail page never disagree about which
 * tickets the target contains.
 *
 * The ticket set is the target's whole working-layer SUBTREE (runTickets), the same set the board
 * card displays and counts — a direct-children run would merge the PR while leaving a deeper subtask
 * open under a finished run target.
 */
export function selectRunTickets(
  all: Bead[],
  target: Bead,
  targetId: string,
): { standaloneRun: boolean; tickets: Bead[] } {
  const children = runTickets(all, targetId);
  const standaloneRun = !beads.groupsChildren(target, children);
  const tickets = standaloneRun ? [target] : children;
  if (tickets.length === 0) throw new PoisonEpic(`epic ${targetId} has no tickets`);
  return { standaloneRun, tickets };
}
