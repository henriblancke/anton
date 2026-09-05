/**
 * The FACTUAL repair pass on a blocked ticket (anton-fzas, anton-qg4h / R5.4 — extracted from
 * execute-epic-ticket.ts) — the two repairs that invent nothing: a pointer rewritten to what it
 * already meant, and an ordering that already exists in reality written down.
 *
 * WHICH FAILURES may reach it at all is the settlement's judgement (`repairableBlock`, in
 * execute-epic-ticket-settle.ts); this module owns which of the two repairs then runs, how far it
 * may go, and what it leaves behind.
 */
import { beads, type Bead } from "../beads/bd";
import type { AntonResult } from "../claude/anton-result";
import { shadowNote } from "../gardener/repair";
import {
  refusalNote as depRefusalNote,
  repairDepMissing,
  type DepMissingOutcome,
} from "../gardener/repair-dep-missing";
import { refusalNote, repairRefStale, type RefStaleOutcome } from "../gardener/repair-ref-stale";
import { resolveRepairAutonomy } from "../projects";
import { appendSessionLog } from "../sessions";
import { safe } from "./execute-epic-persist";
import type { StepContext } from "./step-registry";

/** What the repair pass answers, whichever class it ran for. */
export type TicketRepair = RefStaleOutcome | DepMissingOutcome;

/** The repair MODULE that ran — the name its stamp, its note and its log line are written under. */
type RepairKind = "dep-missing" | "ref-stale";

/**
 * Work out and (where armed) apply the repair this block earns.
 *
 * WHICH REPAIR RUNS is decided by the agent's classified report (anton-ie05 / R5.1), and only
 * `dep-missing` needs it: no fact about the bead can tell anton that other work has to land first,
 * so that class is the whole trigger — and being unable to check it is exactly why the repair writes
 * nothing it cannot resolve against the board.
 *
 * `ref-stale` keeps running on EVERY other block, class or none. Its trigger is evidence rather than
 * the agent's word — the bead's cited paths are checked against the worktree, so it fires only where
 * a pointer is provably stale and stays silent (`none`) everywhere else. That is strictly narrower
 * than trusting a self-reported class, so narrowing it to one would only lose repairs. The cost is
 * an audit trail that can read oddly (PR #223 review): a bead blocked on, say, `env` that ALSO
 * cites a moved path gets its pointer fixed and stamped `repair:ref-stale`, on a run whose block was
 * something else. The stamp is honest about what anton did — it rewrote a genuinely stale pointer —
 * and the loop guard still holds, because the next block finds that stamp and escalates rather than
 * repairing again.
 *
 * HOW FAR EITHER MAY GO is the project's call, not this function's (R5.3): each class carries its
 * own autonomy level, and the guard consults it before anything is written (`decideRepair`). Shipped
 * at `shadow`, so a project that has armed nothing gets the repair worked out and RECORDED — on the
 * bead and in the session log — while the block escalates to a human exactly as it did before this
 * feature existed. A shadowed repair is therefore not a repair: it leaves the ticket to the ordinary
 * failure path, which blocks the bead.
 *
 * Best-effort by construction: a repair that throws must never mask the block the run is settling.
 * The block still stands; only the repair is lost.
 */
export async function repairBlockedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  /** This ticket's session log — where the repair's own account lands. */
  logPath: string;
  /** The agent's parsed `ANTON-RESULT` line, when it emitted one: the class AND the reason. */
  selfReport: AntonResult | null;
  /** The error that halted the ticket — the reason's fallback when the agent stated none. */
  e: unknown;
}): Promise<TicketRepair | undefined> {
  const { run, ticket, logPath, selfReport, e } = args;
  const { clock, worktreePath } = run;
  const repo = run.repoPath;
  const klass = selfReport?.outcome === "blocked" ? selfReport.klass : undefined;
  const kind: RepairKind = klass === "dep-missing" ? "dep-missing" : "ref-stale";
  const autonomy = resolveRepairAutonomy(run.settings);
  try {
    // One instant for whichever repair runs — the arms are mutually exclusive, and the stamp is
    // what the breaker orders a later failure against.
    const now = clock.now();
    // Read the bead fresh: the snapshot this run dispatched from predates the session, and the
    // repair rewrites the description — or the edges — it is holding.
    const fresh = await beads.show(repo, ticket.id);
    // The self-report's reason FIRST for both repairs, and it is load-bearing for `dep-missing`:
    // the prerequisite is named in the agent's own prose, and the run's error message names none.
    const block = {
      reason: selfReport?.reason ?? (e instanceof Error ? e.message : undefined),
    };
    const outcome =
      kind === "dep-missing"
        ? await repairDepMissing({
            repoPath: repo,
            bead: fresh,
            block,
            now,
            autonomy: autonomy["dep-missing"],
          })
        : await repairRefStale({
            repoPath: repo,
            worktreePath,
            bead: fresh,
            block,
            now,
            autonomy: autonomy["ref-stale"],
          });
    await recordRepairOutcome({ repo, ticketId: ticket.id, logPath, kind, outcome });
    return outcome;
  } catch (failure) {
    // The MODULE that ran and the block CLASS it ran on are two different facts (PR #223 review).
    // Every non-`dep-missing` block falls through to `ref-stale`, so naming the class alone reads as
    // if an `env` repair existed and threw, rather than that `ref-stale` refused an `env` block.
    console.error(
      `[execute-epic] ${kind} repair failed for ${ticket.id} (block class: ${klass ?? "unclassified"})`,
      failure,
    );
    return undefined;
  }
}

/**
 * What a repair leaves behind whichever way it went: the refusal or shadow note on the bead, then
 * its own line in the session log. Both best-effort — the block stands either way.
 */
async function recordRepairOutcome(args: {
  repo: string;
  ticketId: string;
  logPath: string;
  kind: RepairKind;
  outcome: TicketRepair;
}): Promise<void> {
  const { repo, ticketId, logPath, kind, outcome } = args;
  if (outcome.action === "escalate") {
    await safe(() =>
      beads.note(
        repo,
        ticketId,
        kind === "dep-missing" ? depRefusalNote(outcome) : refusalNote(outcome),
      ),
    );
  } else if (outcome.action === "shadow") {
    await safe(() => beads.note(repo, ticketId, shadowNote(kind, outcome.attempted)));
  }
  await appendSessionLog(logPath, `[repair:${kind}] ${repairLogLine(outcome)}\n`).catch(() => {});
}

/** One line of the repair's own account, for the session log. */
function repairLogLine(outcome: TicketRepair): string {
  switch (outcome.action) {
    case "repaired":
      return `repaired — ${outcome.attempted}`;
    case "parked":
      return `parked — ${outcome.attempted}`;
    case "shadow":
      // The one line an operator reads a week of shadow off, so it says what the write WOULD have
      // been, not merely that one was withheld.
      return `shadow (not armed to write) — would have: ${outcome.attempted}`;
    case "escalate":
      return `escalated — ${[outcome.why, ...outcome.evidence].join(" ")}`;
    // Named rather than left to `default`, so a future outcome shape without a `why` is a type error
    // HERE instead of an `undefined` in the log line (PR #223 review).
    case "none":
      return `no repair — ${outcome.why}`;
  }
}
