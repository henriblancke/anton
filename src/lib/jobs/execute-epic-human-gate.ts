/**
 * The human wait (anton-287p, anton-mv70 — extracted from execute-epic.ts in anton-1lix).
 *
 * Everything that turns "only a person can do the next thing" into board state and back: the ask a
 * gate carries, the arm that publishes it, the settle that records the park beside it, and the
 * reconcile that takes the arm back when a kill lands in the cleanup's own window. One module,
 * because the arm and its undo have to agree about what an armed gate looks like — the reason
 * string is the identity, and a second opinion about it is how a wait gets armed twice.
 */
import { beads, gateReason, LABELS, type Bead, type Gate } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { runTickets } from "../ticket-view";
import { PoisonEpic } from "./errors";
import { orderTickets, ticketSetDrift } from "./execute-epic-board";
import {
  askSettleError,
  NeedsHumanError,
  ParkedAskError,
  StrandedHumanGateError,
} from "./execute-epic-errors";
import { safe } from "./execute-epic-persist";
import type { RunPatch } from "../runs";

// ── human wait (anton-287p) ──

/**
 * An ask as its TICKET raised it — the two halves a gate reason is composed from.
 * {@link NeedsHumanError} satisfies it structurally, so the run's catch passes the error itself.
 */
export interface HumanAsk {
  /** The ticket that raised the ask — where an ANSWER goes, as a human note. */
  ticketId: string;
  /** The agent's ask, verbatim. Undefined when it named none. */
  ask: string | undefined;
}

/**
 * The reason a human gate carries for THIS ask — the string the gate is identified by, so the arm
 * can tell "this ask is already with someone" from "the ask has changed". Shared by the plan and
 * the create so the two can never disagree about what an armed gate looks like.
 *
 * It NAMES the asking ticket (PR #205 review), because the gate's reason is the only evidence the
 * ask leaves on the board: the gate blocks the RUN TARGET, so a feature with several children gives
 * the escalation surface no way back to the child that stopped — and an answer left on the feature
 * never reaches the resumed session, which reads human notes off the ticket it re-dispatches.
 *
 * `<ticket> needs a human: <ask>` is a SHAPE, not just prose: the escalation surface reads the
 * ticket back off it (`askOf`, jobs/run-health.ts), so the two are pinned by a test each.
 */
export function humanGateReason(targetId: string, { ticketId, ask }: HumanAsk): string {
  return `${ticketId} needs a human: ${
    ask ?? `${targetId} stopped for a human, but the agent named no ask`
  }`;
}

/**
 * The run target as the board describes it NOW, adopted after a step that refreshed from the shared
 * board (anton-mv70, PR #213 review).
 *
 * A re-read that rebuilds only the ticket set leaves the target itself at a pre-refresh snapshot,
 * and every check downstream then judges labels the board has already moved on from. `agent:human`
 * is the label that cannot survive that: outside the backstop at the top of the handler, this is the
 * only place that asks it, so a target relabelled while the run was starting would go on to dispatch
 * a person's work to the default agent. Refused here in the backstop's own words
 * ({@link humanTargetPoison}).
 *
 * Called at EVERY refresh, not only the one the human-ticket arm makes (PR #213 review) — the pull
 * in step 0 and the under-lock confirm in step 1c adopt boards of their own, and a relabel that
 * lands in either window is caught here or nowhere.
 *
 * A target that has vanished from the refreshed board keeps the caller's object rather than throwing
 * — losing the bead is {@link runTargetDrift}'s question, asked under the run-lease, and answering it
 * twice in two different voices is how the two drift apart.
 */
export function adoptRefreshedTarget(board: Bead[], targetId: string, current: Bead): Bead {
  const fresh = board.find((b) => b.id === targetId);
  if (!fresh) return current;
  if (beads.isHumanWork(fresh)) throw humanTargetPoison(targetId);
  return fresh;
}

/**
 * The refusal a run target labelled `agent:human` settles with (anton-mv70).
 *
 * Shared by the top-of-handler backstop and every board refresh that follows it ({@link
 * adoptRefreshedTarget}), so a label that only becomes visible once the run has started is refused
 * in exactly the same words — and no site can drift into telling an operator something different
 * about the same bead.
 */
export function humanTargetPoison(targetId: string): PoisonEpic {
  return new PoisonEpic(
    `target ${targetId} is labelled ${LABELS.agentHuman} — a person executes this work, not ` +
      `an agent, so it is never claimable and no run can deliver it. It stays on the board as ` +
      `approved work waiting for an operator: do it by hand and close the bead, or drop the ` +
      `label if an agent can in fact do it and run it again`,
  );
}

/**
 * The ask a HUMAN TICKET carries into its own gate (anton-mv70). Its title IS the ask — shaping
 * applied `agent:human` precisely because a person does this work — so the reason quotes the bead
 * rather than inventing prose it does not have, and names the one gesture that ends the wait.
 *
 * That gesture is the RESOLVE, not a close: `bd close` refuses a bead an open gate blocks, so the
 * person cannot close this ticket while its wait stands. Resolving is the answer, and anton closes
 * the ticket on the way back in ({@link answeredHumanGate}).
 *
 * Derived purely from the bead, so re-entering a run reproduces the same reason and reuses the same
 * wait instead of stacking a second one. One line, because it becomes an escalation row.
 */
export function humanTicketAsk(ticket: Bead): string {
  const title = (ticket.title ?? "").replace(/\s+/g, " ").trim();
  return (
    `${title || ticket.id} — labelled ${LABELS.agentHuman}, so a person does this work, not an ` +
    `agent. Do it, then resolve this gate; anton closes ${ticket.id} and runs the rest`
  );
}

/**
 * The gate a person ANSWERED for this ticket's ask: a human gate anton armed on the ticket, carrying
 * this exact reason, now closed (anton-mv70).
 *
 * It exists because bd refuses to close a bead an open gate blocks ("blocked by open issues"), so a
 * person physically cannot do the work and close the ticket while the wait stands — the resolve has
 * to come first. Without reading the resolve as the answer, the resumed run would find the ticket
 * still open and still human and arm the same ask again: a loop no answer ever ends.
 *
 * Narrow on purpose. Anton's OWN label, so a hold a person hung by hand is never read as an answer;
 * and the SAME reason, so a superseded gate for an ask that has since changed cannot close a ticket
 * nobody did the work for.
 *
 * The label is what makes "closed" mean "a person answered it" (PR #213 review). Anton resolves its
 * own gates too — a cancelled arm, an ask an operator relabelled away, a wait a newer ask supersedes
 * — and every one of those paths goes through {@link retireArmedGate}, which strips the marker as it
 * closes. So a gate anton took back reads as no answer at all, and the ticket is asked again rather
 * than closed for work nobody did.
 */
export function answeredHumanGate(board: Bead[], ticket: Bead): Gate | undefined {
  const reason = humanGateReason(ticket.id, {
    ticketId: ticket.id,
    ask: humanTicketAsk(ticket),
  }).trim();
  const byId = new Map(board.map((b) => [b.id, b]));
  return (board.find((b) => b.id === ticket.id)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => byId.get(d.depends_on_id))
    .find(
      (b): b is Gate =>
        b !== undefined &&
        b.status === "closed" &&
        beads.isHumanGate(b) &&
        (b.labels?.includes(HUMAN_GATE_ARMED_LABEL) ?? false) &&
        gateReason(b)?.trim() === reason,
    );
}

/**
 * The bead's open prerequisites BY BD'S RULE — every `blocks` dependency that is not closed
 * (anton-mv70). This is what decides whether `bd close` will be accepted: bd refuses a bead any open
 * issue holds ("blocked by open issues [...] (use --force to override)"), gate or not.
 *
 * Deliberately NOT `standaloneBlockers`: that resolves a child blocker to the RUN TARGET that ships
 * it, which during this very run is the open feature itself — a ticket whose real prerequisite has
 * already closed would read as blocked forever and never be closed at all. An unknown dependency
 * counts as open, the same fail-safe the graph takes: bd holds the close either way.
 */
export function openBlockersOf(
  board: Bead[],
  beadId: string,
  /** Beads closed since `board` was read — closed to bd, still open in this snapshot. */
  closedSince: ReadonlySet<string> = new Set(),
): string[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  return (board.find((b) => b.id === beadId)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => d.depends_on_id)
    .filter((id) => !closedSince.has(id) && byId.get(id)?.status !== "closed");
}

/**
 * The human tickets' half of preflight (anton-mv70): close what a person has already answered, arm a
 * wait on what they have not, and report back the tickets an ordinary blocker still holds.
 *
 * Walked in DEPENDENCY order (PR #213 review). One human ticket can block another ("sign the
 * contract, then wire the account"), and `board` is the read taken BEFORE this pass — so a
 * prerequisite closed here still reads as open to the ticket waiting on it. Ordered, and with the
 * closes this pass made carried alongside the board, the dependent is closed too instead of being
 * held for a wait that is already over: a hold there parks the run on a blocker the very next board
 * read shows closed, with no remaining event to resume it.
 *
 * Every wait armed here is taken back when a kill lands mid-pass — INCLUDING one that lands after
 * the last arm returns, which no next iteration would ever observe (PR #213 review).
 * {@link armHumanGate} unwinds only the gate it was arming when the signal flipped, so without this
 * the earlier ones would stand for a run nothing is coming back for, each promising a person that
 * resolving it resumes that run.
 *
 * Answers the tickets whose gate is ANSWERED but whose ordinary prerequisite has not landed, keyed
 * to the blockers still holding them — the caller folds them into the run's verdict as gated.
 */
export async function armHumanTicketGates(
  repo: string,
  targetId: string,
  /** The board these tickets were read from — the pre-pass snapshot. */
  board: Bead[],
  humanTickets: Bead[],
  signal: AbortSignal | undefined,
  /**
   * The waits the CALLER has already armed for this run, appended to here. {@link
   * preflightHumanTickets} makes several passes, and a kill in a later one must take back the
   * earlier passes' gates too — each is a wait promising a person that resolving it resumes a run
   * that is not coming back.
   */
  armedSoFar?: ArmedTicketGate[],
): Promise<Map<string, string[]>> {
  // A ticket whose gate a person answered but whose ORDINARY prerequisite has not landed yet: held
  // for this pass, closed by the resume that follows the blocker.
  const answeredButBlocked = new Map<string, string[]>();
  // Every wait this run armed, so a kill landing between two arms — or after the last one — can
  // take them back.
  const armedHere: ArmedTicketGate[] = armedSoFar ?? [];
  // The tickets this pass has already closed: closed to bd, still open in `board`.
  const closedHere = new Set<string>();
  try {
    for (const t of orderTickets(humanTickets, board)) {
      // A wait a person already ANSWERED closes the ticket instead of re-arming it — bd will not
      // let them close a gate-blocked bead themselves, so this is anton's half of the exchange.
      const answered = answeredHumanGate(board, t);
      if (answered) {
        // bd refuses `bd close` on a bead ANY open blocker holds, not just an open gate, so a
        // human ticket that ALSO waits on ordinary work ("ship the API, then sign the DPA")
        // cannot be closed until that work lands. Closing anyway throws a plain error the runner
        // retries identically until the attempts are gone — a cryptic bd message and no sibling
        // ever dispatched. Hold the ticket instead: the person's half is done and must not be
        // asked for again (so no re-arm), the code it waits on is not, and the resume that
        // follows that blocker closes it into this same branch.
        const stillBlocked = openBlockersOf(board, t.id, closedHere);
        if (stillBlocked.length > 0) {
          answeredButBlocked.set(t.id, stillBlocked);
          console.log(
            `[execute-epic] ${targetId}: holding ${t.id} — its human gate ${answered.id} is ` +
              `answered but it is still blocked by ${stillBlocked.join(", ")}`,
          );
          continue;
        }
        await beads.close(repo, t.id, `human work done — gate ${answered.id} resolved`);
        closedHere.add(t.id);
        console.log(
          `[execute-epic] ${targetId}: closed ${t.id} — a person answered its human gate ` +
            `${answered.id}`,
        );
        continue;
      }
      armedHere.push({
        ticketId: t.id,
        gate: await armHumanGate(repo, t.id, { ticketId: t.id, ask: humanTicketAsk(t) }, signal),
      });
    }
    // A kill landing after the LAST arm returns has no next iteration to observe it: the loop exits
    // normally and the undo below is never reached. Ask once more on the way out.
    if (signal?.aborted && armedHere.length > 0) {
      throw new Error(`${targetId}'s run was cancelled after its human ticket gate(s) were armed`);
    }
  } catch (e) {
    throw await undoCancelledTicketGates(armedHere, signal, e);
  }
  return answeredButBlocked;
}

/** What a run adopts from {@link preflightHumanTickets} once it has acted on human work. */
export interface HumanTicketPreflight {
  /** The board the closes and the arms landed on — what the run recomputes its verdict from. */
  board: Bead[];
  target: Bead;
  children: Bead[];
  tickets: Bead[];
  /** Tickets whose gate a person answered but whose ordinary blockers still hold them. */
  answeredButBlocked: Map<string, string[]>;
  /** False when the run has no human work at all — nothing was written, nothing to adopt. */
  armed: boolean;
}

/**
 * How many classify→arm→refresh passes a run makes before it gives up and retries (PR #213 review).
 * Each pass acts on at least one ticket no earlier pass saw, so a board that settles takes two: one
 * to arm, one to confirm the refresh found nothing new. More than a handful means the labels are
 * still moving under this run, which a fresh attempt re-gates better than a loop here can.
 */
export const MAX_HUMAN_TICKET_PASSES = 5;

/**
 * The mutable state one preflight carries ACROSS its passes — what earlier passes decided, which the
 * later ones reconcile against a board that has moved under them.
 *
 * Threaded explicitly through the steps below rather than captured by closures inside
 * {@link preflightHumanTickets}, so each step of a pass is a named function that can be read on its
 * own — and so the pass loop reads as its sequence rather than as one body around its parts.
 */
interface HumanTicketPreflightState {
  repo: string;
  targetId: string;
  /** Tickets an earlier pass already closed or armed — never re-armed, so no wait is stacked. */
  handled: Set<string>;
  /** Tickets whose gate a person answered but whose ordinary blockers still hold them. */
  answeredButBlocked: Map<string, string[]>;
  /** Every wait armed so far, so a kill in a later pass takes the earlier passes' gates back too. */
  armedGates: ArmedTicketGate[];
}

/** What one pass found to act on. `undefined` once the board and the arm agree — the loop is done. */
interface HumanTicketPass {
  /** Tickets a person owns that no earlier pass handled. */
  humanTickets: Bead[];
  /** Tickets an earlier pass armed that STOPPED being a person's work. */
  relabelled: Bead[];
}

/** A person's work this preflight has not acted on yet — the tickets a pass arms. */
function isUnarmedHumanWork(
  state: HumanTicketPreflightState,
  isResumeSkipped: (t: Bead) => boolean,
  t: Bead,
): boolean {
  return !state.handled.has(t.id) && !isResumeSkipped(t) && beads.isHumanWork(t);
}

/** A ticket an earlier pass armed that an operator has since reclassified as agent work. */
function isRelabelledAgentWork(state: HumanTicketPreflightState, t: Bead): boolean {
  return state.handled.has(t.id) && !beads.isHumanWork(t);
}

/**
 * What this pass has to act on, read off the CURRENT tickets: newly human work, work that stopped
 * being human, and holds an earlier pass judged against a board the refresh has since replaced.
 */
function humanTicketPass(
  state: HumanTicketPreflightState,
  tickets: Bead[],
  isResumeSkipped: (t: Bead) => boolean,
  /** A refresh landed and the holds it may already have released have not been re-judged yet. */
  holdsJudgedOnStaleBoard: boolean,
): HumanTicketPass | undefined {
  const humanTickets = tickets.filter((t) => isUnarmedHumanWork(state, isResumeSkipped, t));
  const relabelled = tickets.filter((t) => isRelabelledAgentWork(state, t));
  const staleHolds = holdsJudgedOnStaleBoard && state.answeredButBlocked.size > 0;
  if (humanTickets.length === 0 && relabelled.length === 0 && !staleHolds) return undefined;
  return { humanTickets, relabelled };
}

/**
 * The holds a refresh owes a re-judge: tickets held on prerequisites read off the board the arming
 * pass held, which the refresh may already have closed.
 *
 * Computed only AFTER {@link retireRelabelledGates} has run — it drops the tickets that stopped being
 * a person's work, and re-judging one of those would re-arm a wait the retire just took back.
 */
function holdsOwedRejudge(
  state: HumanTicketPreflightState,
  tickets: Bead[],
  isResumeSkipped: (t: Bead) => boolean,
  holdsJudgedOnStaleBoard: boolean,
): Bead[] {
  if (!holdsJudgedOnStaleBoard) return [];
  return tickets.filter((t) => state.answeredButBlocked.has(t.id) && !isResumeSkipped(t));
}

/**
 * Refuse a preflight whose labels are still moving under it.
 *
 * Plain Error, not a park: the next attempt re-gates from a board that has settled rather than this
 * run arming behind a moving target forever.
 *
 * Reached only AFTER {@link retireRelabelledGates} ran for this pass (PR #219 review) — the waits
 * left standing here are all for tickets a person still owns, which is the state the next attempt
 * should find.
 */
function refuseMovingLabels(
  state: HumanTicketPreflightState,
  pass: HumanTicketPass,
): never {
  const moving = [...pass.humanTickets, ...pass.relabelled].map((t) => t.id);
  throw new Error(
    `${state.targetId} kept finding newly-labelled ${LABELS.agentHuman} tickets after ` +
      `${MAX_HUMAN_TICKET_PASSES} arming passes ` +
      `(${(moving.length > 0 ? moving : [...state.answeredButBlocked.keys()]).join(", ")}) ` +
      `— retrying so the run gates a settled board rather than dispatching a person's work`,
  );
}

/**
 * Retire the waits armed for tickets that STOPPED being a person's work (PR #213 review).
 *
 * The gate outlives the label: nothing auto-resolves a human gate, so a ticket an operator
 * reclassified mid-arm stays blocked by an ask that no longer applies, and the run parks asking a
 * person to do work an agent can now do. Retiring is safe precisely because the ask is retired with
 * it — this leaves the ticket carrying no wait, which is the correct state for agent work.
 *
 * Un-handles the ticket rather than only clearing its gate, so a label that flips back is armed again
 * by a later pass instead of running ungated.
 *
 * THROWS when a resolve fails, naming every gate still standing: the ticket is then blocked by a wait
 * this run knows is dead and nothing else on the board points at it.
 */
async function retireRelabelledGates(
  state: HumanTicketPreflightState,
  tickets: Bead[],
): Promise<boolean> {
  const { repo, targetId, armedGates } = state;
  let wrote = false;
  const stranded: string[] = [];
  for (const t of tickets) {
    const armedGate = armedGates.find((g) => g.ticketId === t.id);
    if (armedGate) {
      const resolved = await retireArmedGate(
        repo,
        armedGate.gate.gateId,
        `${t.id} is no longer labelled ${LABELS.agentHuman} — an agent runs it, so the wait ` +
          `on a person no longer applies`,
      );
      // Left handled: the wait still stands, so re-arming it would stack a second one beside it.
      if (!resolved) {
        stranded.push(`${armedGate.gate.gateId} (${t.id})`);
        continue;
      }
      armedGates.splice(armedGates.indexOf(armedGate), 1);
      wrote = true;
      console.log(
        `[execute-epic] ${targetId}: resolved human gate ${armedGate.gate.gateId} — ${t.id} no ` +
          `longer carries ${LABELS.agentHuman}, so an agent runs it after all`,
      );
    }
    state.handled.delete(t.id);
    state.answeredButBlocked.delete(t.id);
  }
  if (stranded.length > 0) {
    throw new Error(
      `${targetId}'s human gate(s) ${stranded.join(", ")} could not be resolved after their ` +
        `ticket(s) stopped carrying ${LABELS.agentHuman} — they still block work an agent can ` +
        `now run, so the run would park asking a person for work the operator reclassified. ` +
        `Resolve them by hand (\`bd gate resolve\`), then re-run the target`,
    );
  }
  return wrote;
}

/**
 * Act on this pass's tickets: close what a person answered, arm what they have not, and re-judge the
 * holds a refresh may already have released. Answers whether anything landed on the board.
 *
 * `rejudge` is computed by the CALLER after {@link retireRelabelledGates} has run, which drops the
 * tickets that stopped being a person's work — re-judging one of those would re-arm a wait the retire
 * just took back.
 */
async function armHumanTicketPass(
  state: HumanTicketPreflightState,
  args: {
    /** The board these tickets were read from — the pre-pass snapshot. */
    board: Bead[];
    humanTickets: Bead[];
    /** Held tickets whose blockers were judged against a board the refresh has since replaced. */
    rejudge: Bead[];
    signal: AbortSignal | undefined;
  },
): Promise<boolean> {
  const { board, humanTickets, rejudge, signal } = args;
  const batch = [...humanTickets, ...rejudge];
  if (batch.length === 0) return false;
  for (const t of humanTickets) state.handled.add(t.id);
  // Dropped before the pass, re-added from its answer: a hold that has been released must not
  // survive as a stale entry the caller would fold into the run's verdict.
  for (const t of rejudge) state.answeredButBlocked.delete(t.id);
  // What a person answered is closed here, what they have not is armed, and what their answer
  // cannot yet release is reported back as held.
  const stillHeld = await armHumanTicketGates(
    state.repo,
    state.targetId,
    board,
    batch,
    signal,
    state.armedGates,
  );
  for (const [id, blockers] of stillHeld) state.answeredButBlocked.set(id, blockers);
  return batch.some((t) => !stillHeld.has(t.id));
}

/**
 * Re-read the board the gates and the closes are ON — the TARGET and the ticket SET.
 *
 * A ticket closed by the pass is done work now, and the dispatch loop reads its status off these
 * objects. The target is adopted, not just its children: every `armHumanGate` pulls the shared board
 * first, so a relabel another machine pushed lands in exactly this read, and a `target` left at its
 * pre-arm snapshot would carry the superseded labels through every step that follows.
 *
 * The refreshed SET is confirmed, never silently adopted (PR #213 review): step 1c proved this run's
 * ticket set under the run-lease, and a child attached while the arm was writing would otherwise
 * enter the run behind the approval, contract and agent-allowlist gates that already ran — or a
 * detached one disappear after selection. Same question, same words as step 1c.
 */
async function refreshAfterArming(
  state: HumanTicketPreflightState,
  target: Bead,
  children: Bead[],
): Promise<{ board: Bead[]; target: Bead; children: Bead[] }> {
  const { repo, targetId } = state;
  const board = await loadAllIssues(repo, { strictGates: true });
  // Adopted BEFORE the set is judged: a target relabelled `agent:human` mid-arm is the backstop's
  // refusal, and a set that also drifted must not answer for it in a retry's voice instead.
  const adopted = adoptRefreshedTarget(board, targetId, target);
  const refreshed = runTickets(board, targetId);
  const drift = ticketSetDrift(children, refreshed);
  if (drift) {
    throw new Error(
      `${targetId}'s ticket set changed while its human tickets were gated (${drift}) — ` +
        `retrying so the run re-gates and executes the whole set rather than adopting a ticket ` +
        `that never passed the gates this run already ran`,
    );
  }
  return { board, target: adopted, children: refreshed };
}

/**
 * The human tickets' preflight (anton-mv70): classify the run's tickets, arm what a person owns,
 * then re-classify what the refresh brought back.
 *
 * The loop is the point (PR #213 review). {@link armHumanTicketGates} pulls the shared board before
 * each arm, so a sibling another machine relabelled `agent:human` mid-pass lands in the refresh
 * below — adopted, but never classified. Readiness never asks about the label, so that ticket stays
 * dispatchable and the run only notices at the dispatch loop's backstop, which parks telling the
 * operator to resolve a wait nobody ever armed. Re-classifying until a pass finds nothing new is
 * what makes the arm and the labels agree.
 *
 * Only tickets no earlier pass handled are re-armed, so a wait is never stacked on an ask that
 * already has one, and a ticket held on an ordinary blocker is not re-asked for.
 *
 * Each refresh is RECONCILED against what the earlier passes decided, not merely adopted (PR #213
 * review) — the board moved under all three of them:
 *
 *   • The ticket SET, judged with the same {@link ticketSetDrift} as step 1c and retried
 *     ({@link refreshAfterArming}), so the next attempt re-gates the whole set.
 *   • The HOLDS. A ticket whose gate is answered is held on the ordinary prerequisites open in the
 *     board the pass READ; one that closed in the arm's own window would park the run behind an
 *     already-closed bead, with no blocker event left to resume it. Re-judged against the refreshed
 *     board, which closes it instead.
 *   • The LABEL. An operator who drops `agent:human` mid-arm leaves a wait holding a ticket an agent
 *     can now run, and the run parks asking a person for work that was reclassified. The gate this
 *     preflight armed for it is retired ({@link retireRelabelledGates}).
 */
export async function preflightHumanTickets(args: {
  repo: string;
  targetId: string;
  /** The board the tickets were read from — the pre-pass snapshot. */
  board: Bead[];
  target: Bead;
  /** The target's working-layer subtree; the run's tickets when it groups children. */
  children: Bead[];
  standaloneRun: boolean;
  isResumeSkipped: (t: Bead) => boolean;
  signal: AbortSignal | undefined;
}): Promise<HumanTicketPreflight> {
  const { repo, targetId, standaloneRun, isResumeSkipped, signal } = args;
  let { board, target, children } = args;
  const ticketsOf = () => (standaloneRun ? [target] : children);
  const state: HumanTicketPreflightState = {
    repo,
    targetId,
    handled: new Set<string>(),
    answeredButBlocked: new Map<string, string[]>(),
    armedGates: [],
  };
  let armed = false;
  // Set by every refresh, cleared by the re-judge it owes: the holds below were decided against the
  // board the pass READ, and the refresh can already have closed what was holding them.
  let holdsJudgedOnStaleBoard = false;

  for (let attempt = 0; ; attempt++) {
    const pass = humanTicketPass(state, ticketsOf(), isResumeSkipped, holdsJudgedOnStaleBoard);
    if (!pass) break;
    armed = true;
    // Retired BEFORE the budget is judged (PR #219 review). A wait whose ticket stopped being a
    // person's work is dead whichever way this pass ends, and refusing first strands it: the retry
    // parks at the readiness gate the gate itself blocks (step 0a-bis), which runs long before this
    // preflight — so the one code path that could take the wait back is never reached again.
    let wrote = await retireRelabelledGates(state, pass.relabelled);
    if (attempt >= MAX_HUMAN_TICKET_PASSES) refuseMovingLabels(state, pass);
    const rejudge = holdsOwedRejudge(state, ticketsOf(), isResumeSkipped, holdsJudgedOnStaleBoard);
    holdsJudgedOnStaleBoard = false;
    const landed = await armHumanTicketPass(state, {
      board,
      humanTickets: pass.humanTickets,
      rejudge,
      signal,
    });
    wrote = landed || wrote;
    // Nothing landed on the board this pass — every ticket it touched is still held on the very
    // board we hold, so a refresh could only re-read what is already here.
    if (!wrote) break;
    ({ board, target, children } = await refreshAfterArming(state, target, children));
    holdsJudgedOnStaleBoard = true;
  }

  return {
    board,
    target,
    children,
    tickets: ticketsOf(),
    answeredButBlocked: state.answeredButBlocked,
    armed,
  };
}

/**
 * Marks a human gate ANTON armed for an ask of its own — the only ones a later arm may supersede.
 * Without it every open human gate on the target reads as anton's leftover, and a hold a person put
 * there by hand (`bd gate create --blocks <target>`, the "stop until I say so" gesture) would be
 * auto-resolved by the next ask — breaking the one contract this gate flavour has, that nothing but
 * an explicit human action ends it.
 */
export const HUMAN_GATE_ARMED_LABEL = "gate-armed";

/**
 * Take a human gate ANTON armed BACK — a cancelled arm, an ask that stopped applying, a wait a newer
 * ask supersedes — as opposed to one a PERSON answered (PR #213 review).
 *
 * The label is the whole difference. Nothing on a closed gate records WHO ended it, so a
 * cleanup-resolved gate left carrying {@link HUMAN_GATE_ARMED_LABEL} is exactly what {@link
 * answeredHumanGate} reads as proof the work was done: the next run would close a still-human ticket
 * without a person ever touching it. Stripping the marker as part of retiring it means a later run
 * finds no answer and arms the ask again, which is the state the board is actually in.
 *
 * Untag BEFORE resolve, so neither half failing can leave a false answer behind. A lost untag leaves
 * the gate open and standing — the caller's stranded path, unchanged.
 *
 * A lost RESOLVE puts the marker BACK (PR #213 review). The gate stays open carrying its original
 * ask, and a ticket ask tells the person reading it to do the work and resolve the gate — so an
 * unlabelled leftover is the one state that reads as neither anton's wait nor a person's hold: the
 * answer a person then gives is invisible to {@link answeredHumanGate}, and the next run asks them
 * for work they already did instead of closing the ticket. Restored only after the gate is confirmed
 * still OPEN, because a `gateResolve` that failed AFTER landing would otherwise be relabelled into
 * exactly the false answer the untag-first order exists to prevent. When either the re-read or the
 * re-tag fails the gate keeps the pre-fix shape — open and unlabelled, which reads as a person's own
 * hold, the safe direction for a wait only a human ends.
 */
export async function retireArmedGate(repo: string, gateId: string, reason: string): Promise<boolean> {
  if (!(await safe(() => beads.untag(repo, gateId, [HUMAN_GATE_ARMED_LABEL])))) return false;
  if (await safe(() => beads.gateResolve(repo, gateId, reason))) return true;
  await restoreArmedMarker(repo, gateId);
  return false;
}

/**
 * Put {@link HUMAN_GATE_ARMED_LABEL} back on a gate whose retirement failed — and ONLY while the
 * board still says that gate is open. Best-effort throughout: every failure here lands on the
 * pre-existing open-and-unlabelled state, which the caller already treats as stranded.
 */
export async function restoreArmedMarker(repo: string, gateId: string): Promise<void> {
  const gate = await beads.show(repo, gateId).catch(() => undefined);
  // The resolve landed after all and only its reporting failed: anton closed this gate, so the
  // marker must stay OFF — restoring it there is precisely the false answer.
  if (gate?.status === "closed") return;
  if (gate && (await safe(() => beads.tag(repo, gateId, [HUMAN_GATE_ARMED_LABEL])))) return;
  console.warn(
    `[execute-epic] human gate ${gateId} could not be resolved and its ${HUMAN_GATE_ARMED_LABEL} ` +
      `marker could not be restored — while it stands, an answer to it reads as a hold anton ` +
      `never armed`,
  );
}

/**
 * Every OPEN human gate blocking the target. The one place the target's waits are read out of a
 * board, so the plan made BEFORE the arm and the reconcile made after it can never disagree about
 * what counts as a wait on this target.
 */
export function openHumanGates(board: Bead[], targetId: string): Gate[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  return (board.find((b) => b.id === targetId)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => byId.get(d.depends_on_id))
    .filter((b): b is Gate => b !== undefined && b.status !== "closed" && beads.isHumanGate(b));
}

/**
 * What arming this target's human wait has to do, from the board alone: the open gate that already
 * carries THIS ask (`open` — reuse it, a second gate would race it), anton's own earlier waits
 * (`stale` — their ask no longer applies, so they are superseded), and every other open human gate
 * on the target (`held` — a person's own hold, reported but never touched).
 *
 * ALL the stale gates, not the first, for the reason mergeGatePlan resolves all of its own: a
 * `gateResolve` that failed on an earlier run leaves a superseded gate open ALONGSIDE the live one,
 * and dependency order says nothing about which is seen first. It costs more here than it does
 * there — a human gate is a real blocker, so one left behind keeps the target unrunnable until
 * someone finds it by hand.
 *
 * `open` matches on the ask alone, label or not: an arm whose tag write was lost still created that
 * gate, and reusing it is what keeps the arm re-entrant. Ownership only ever narrows what may be
 * CLOSED, never what may be reused.
 */
export function humanGatePlan(
  board: Bead[],
  targetId: string,
  reason: string,
): { stale: Gate[]; held: Gate[]; open: Gate | undefined } {
  const armed = openHumanGates(board, targetId);
  const open = armed.find((g) => gateReason(g)?.trim() === reason.trim());
  const superseded = armed.filter((g) => g !== open);
  return {
    stale: superseded.filter((g) => g.labels?.includes(HUMAN_GATE_ARMED_LABEL) ?? false),
    held: superseded.filter((g) => !(g.labels?.includes(HUMAN_GATE_ARMED_LABEL) ?? false)),
    open,
  };
}

/** What an arm left on the board — and, only while that is safe, how to take it back. */
export interface ArmedHumanGate {
  /** The gate carrying this ask: created here, or the one an earlier attempt armed for it. */
  gateId: string;
  /**
   * Every OTHER open human gate on the target — holds this arm left where they are. Read back AFTER
   * the arm, so a gate armed while this run planned is named in the park too (PR #205 review); an
   * arm that could not complete that read fails rather than returning a list it knows is partial.
   */
  held: string[];
  /**
   * Resolve the gate this call created, returning the target to the state the arm found it in.
   *
   * Offered ONLY while undoing cannot be the thing that leaves the target bare (anton-287p): the
   * gate was created here AND no older wait was retired behind it. Absent for a gate an earlier
   * attempt armed — not this run's to take back — and absent after a supersede, where resolving the
   * replacement would leave the target carrying no wait at all on an ask nobody answered. Answers
   * whether the gate is actually gone; a resolve that failed leaves it standing.
   */
  undo?: () => Promise<boolean>;
}

/**
 * One arm in progress: who is being armed, the live kill signal, and the plan's verdict on the waits
 * the target already carries.
 *
 * Threaded explicitly through the steps below rather than captured by closures inside
 * {@link armHumanGate}, so each step of the arm is a named function that can be read on its own —
 * and so the sequence the arm performs is visible in one place rather than buried under its parts.
 */
interface ArmAttempt {
  repo: string;
  targetId: string;
  /** The run's LIVE cancellation signal, re-read immediately before every board write below. */
  signal: AbortSignal | undefined;
  /** Anton's OWN waits this ask supersedes — retired only once the replacement is armed. */
  stale: Gate[];
  /** Every other open human gate on the target: a person's own hold, reported but never touched. */
  held: Gate[];
}

/**
 * Refuse an arm the run was cancelled under.
 *
 * A kill can only be observed between awaits, and {@link armHumanGate} awaits the board twice before
 * it writes anything — so the caller's pre-arm read of the signal is already stale by then
 * (anton-287p). Re-read it before each write instead: a gate armed after an operator stopped the run
 * blocks the target until someone clears it by hand, for a wait nobody is waiting on. Refusing the
 * SUPERSEDE matters for the same reason in reverse — resolving the older ask while arming nothing
 * would leave the target with no wait at all, silently runnable again on an ask nobody answered.
 */
function refuseArmIfCancelled(arm: ArmAttempt, consequence: string): void {
  if (arm.signal?.aborted) {
    throw new Error(
      `refusing to arm ${arm.targetId}'s human gate — the run was cancelled while the board was ` +
        `read; ${consequence}`,
    );
  }
}

/**
 * Take a just-armed gate back when the kill landed inside the write that created or labelled it.
 *
 * Those writes are uninterruptible awaits of their own, so no check BEFORE one covers a kill that
 * lands while it runs (anton-287p): the gate would exist, the caller would read a successful arm, and
 * a cancelled run would park behind a wait nobody is waiting on. Re-read the signal after each and
 * undo the create, so the ask settles in its cancelled form exactly as if it never landed.
 *
 * Only ever called BEFORE the supersede: undoing is safe exactly while every wait this ask supersedes
 * is still open, so the undo can never be what leaves the target bare.
 */
async function undoArmIfCancelled(arm: ArmAttempt, gateId: string, during: string): Promise<void> {
  if (!arm.signal?.aborted) return;
  const undone = await retireArmedGate(
    arm.repo,
    gateId,
    `run cancelled while ${arm.targetId}'s human gate was armed`,
  );
  if (undone) {
    throw new Error(
      `refusing to arm ${arm.targetId}'s human gate — the run was cancelled while ${during}; gate ` +
        `${gateId} was resolved, so the target carries no wait from this run`,
    );
  }
  // The undo was the only thing that would ever have closed it: no automatic pass resolves a human
  // gate, so the target stays blocked until someone clears this id by hand. It rides out in the
  // error because nothing else on the board names it.
  throw new StrandedHumanGateError(
    arm.targetId,
    gateId,
    `the run was cancelled while ${during}, and gate ${gateId} could not be resolved`,
  );
}

/**
 * Retire the waits this ask supersedes — ONLY ever with `armed` already live on the board.
 *
 * Ordering is the safety property (anton-287p): closing the old wait first would, on a `gate create`
 * that fails or a kill that lands in it, leave the target carrying no human gate at all while its
 * current ask is still unanswered — silently claimable again, on a shared board by another machine.
 * Armed-then-retired can only ever overshoot into TWO open waits, which blocks the target rather than
 * freeing it, and which the next arm's own supersede clears.
 *
 * THROWS with every still-open id when a supersede fails, or when a kill lands inside one: past this
 * point the replacement is the target's only blocker, so undoing it is exactly the failure above. The
 * gate stands and rides out in the error instead — the run settles FAILED naming it.
 */
async function retireSupersededGates(arm: ArmAttempt, armed: string): Promise<void> {
  const { repo, targetId, stale } = arm;
  const unresolved: string[] = [];
  for (const gate of stale) {
    const resolved = await retireArmedGate(
      repo,
      gate.id,
      `superseded — ${targetId} now waits on a newer ask`,
    );
    if (!resolved) unresolved.push(gate.id);
  }
  // Nothing else will ever close them, and each is a real blocker while it lives — so a park behind
  // the current ask is a wait resolving the named gate cannot end. Fail the arm instead: the run
  // settles FAILED carrying the ask and every id still holding the target.
  if (unresolved.length > 0) {
    throw new StrandedHumanGateError(
      targetId,
      armed,
      `${targetId}'s superseded human gate(s) ${unresolved.join(", ")} could not be resolved, so ` +
        `they stay open beside the wait this run armed (${armed})`,
      unresolved,
    );
  }
  if (stale.length > 0 && arm.signal?.aborted) {
    throw new StrandedHumanGateError(
      targetId,
      armed,
      `the run was cancelled while ${targetId}'s superseded human gate(s) were retired, so the ` +
        `wait this run armed stands rather than leaving the target with none`,
    );
  }
}

/**
 * End an arm whose holds could not be reconciled — taking the gate back where that is still safe.
 *
 * Mirrors the cancellation unwind, and for the same reason: a gate this arm CREATED can be resolved
 * right up to the supersede, so the ask settles exactly as if it never landed. A gate an earlier
 * attempt armed carries this same ask and is not this run's to close — it stands, and rides out named
 * in the error, because nothing else on the board would point at it.
 */
async function unreconciledArmFailure(
  arm: ArmAttempt,
  gateId: string,
  undoable: boolean,
  cause: unknown,
): Promise<unknown> {
  const why =
    `${arm.targetId}'s human gates could not be re-read after arming ${gateId} (${
      cause instanceof Error ? cause.message : String(cause)
    }), so a gate armed for this target while this run planned would be missing from the park`;
  if (undoable) {
    const undone = await retireArmedGate(arm.repo, gateId, `arm abandoned — ${why}`);
    if (undone) {
      return new Error(
        `refusing to park ${arm.targetId} behind ${gateId} — ${why}; the gate was resolved, so the ` +
          `target carries no wait from this run`,
        { cause },
      );
    }
  }
  return new StrandedHumanGateError(arm.targetId, gateId, why);
}

/**
 * Re-read the target's waits AFTER the arm, so the park names every gate that actually holds it
 * (PR #205 review).
 *
 * The plan and the write are separate bd transactions with nothing serializing them: an operator —
 * or another machine, whose commits are global the moment bd makes them on a shared server — can arm
 * a human gate for this target in the window between them. That gate is invisible to the plan, so a
 * park composed from the plan alone promises the operator that resolving THIS run's gate resumes the
 * run, while the target stays blocked by a wait nothing names.
 *
 * REPORTS rather than resolves, whoever armed it: a gate that appeared after the plan was made was
 * never judged against this ask, and closing a live wait anton did not plan to supersede is exactly
 * what the ownership label exists to prevent. The waits this ask DOES supersede are excluded — they
 * are retired moments later, and naming them would send the operator after gates that are about to
 * close.
 *
 * ABORTS the arm when the re-read fails, rather than falling back to the plan's holds (PR #205
 * review). The plan is exactly the reading that cannot see a gate armed since it was taken, so
 * parking on it publishes a message promising that resolving anton's gate resumes the run while an
 * unnamed wait keeps blocking the target — the same dead park the preflight read is strict to
 * prevent, reached from the other side. Failing costs only a re-run: the gate the arm created is
 * taken back first (safe only while the waits this ask supersedes are all still open behind it), and
 * the run settles FAILED carrying the ask.
 */
async function reconcileHeldGates(
  arm: ArmAttempt,
  armed: string,
  undoable: boolean,
): Promise<string[]> {
  let fresh: Bead[];
  try {
    // Pulled as well as re-read: the other writer may be another MACHINE, whose gate reaches this
    // workspace only through a pull. Both legs resolve trivially for a board with no remote.
    await beads.pull(arm.repo);
    fresh = await loadAllIssues(arm.repo, { strictGates: true });
  } catch (e) {
    throw await unreconciledArmFailure(arm, armed, undoable, e);
  }
  const staleIds = new Set(arm.stale.map((g) => g.id));
  const plannedHolds = new Set(arm.held.map((g) => g.id));
  const stillHeld = openHumanGates(fresh, arm.targetId)
    .map((g) => g.id)
    .filter((id) => id !== armed && !staleIds.has(id));
  for (const id of stillHeld.filter((id) => !plannedHolds.has(id))) {
    console.warn(
      `[execute-epic] ${arm.targetId} gained human gate ${id} while this run armed ${armed} — left ` +
        `open, because it was never judged against this ask; the run resumes only once it is ` +
        `resolved too`,
    );
  }
  return stillHeld;
}

/**
 * The board an arm plans against: the SHARED board, refreshed and read strictly, with a target the
 * ask can never become a gate on refused up front.
 *
 * Refresh first, and refuse the arm when that cannot be done (PR #205 review). The run's own step-0
 * pull is a whole run old by the time an ask lands here, and on a shared board another machine — or
 * an operator — can have armed a human gate for this target in between. Planned against a stale local
 * working set that gate is invisible, so the strict read below reports the target as bare and the arm
 * creates a SECOND wait, which the run's next sync then publishes: the same duplicate the read is
 * strict to prevent, and the park would name only the new one. `beads.pull` resolves for a board with
 * no remote and for a shared server (nothing to reconcile in either), so a rejection means exactly
 * "anton cannot establish that it is looking at the current board" — which is not a board to arm a
 * human wait against.
 *
 * An EPIC target is refused here rather than attempted: bd rejects a gate edge onto one ("epics can
 * only block other epics") and a failed `gate create` still leaves an orphan gate bead behind.
 */
async function armBoard(repo: string, targetId: string): Promise<Bead[]> {
  try {
    await beads.pull(repo);
  } catch (e) {
    throw new Error(
      `refusing to arm ${targetId}'s human gate — the shared board could not be refreshed (${
        e instanceof Error ? e.message : String(e)
      }), so a wait another machine already armed for this ask would be invisible and this arm ` +
        `would stack a second one beside it`,
      { cause: e },
    );
  }

  // STRICT, and no catch: this read is the ONLY thing that can tell "the ask is already with
  // someone" from "nothing is armed", and bd omits gate beads from every ordinary listing — so a
  // best-effort read that lost its `--type gate` leg would report an armed board as bare and create
  // a SECOND wait for the same ask. Two human gates is a wait resolving cannot end: the park names
  // only the new one, and closing it leaves the target blocked by the old one forever, with nothing
  // that ever auto-resolves it. Let the failure reject instead — the caller settles the run FAILED
  // with the ask in its error, which is recoverable; a duplicate gate is not.
  const board = await loadAllIssues(repo, { strictGates: true });

  const target = board.find((b) => b.id === targetId);
  if (target && beads.isEpic(target)) {
    throw new Error(
      `${targetId} is an epic — bd refuses a gate edge onto one, so the ask cannot become a gate`,
    );
  }
  return board;
}

/**
 * Reuse the gate an earlier attempt armed for THIS ask. Two gates for one ask is one dead wait:
 * resolving either leaves the target blocked by the other.
 */
async function reuseArmedGate(arm: ArmAttempt, open: Gate): Promise<ArmedHumanGate> {
  // Reconciled before the cancellation check, not after: the re-read is an uninterruptible await
  // like every other, so a kill landing inside it must still reach the refusal below rather than
  // ride out as a successful arm. Not undoable: an earlier attempt armed this wait for this same
  // ask, so a reconcile that fails leaves it standing and names it instead.
  const stillHeld = await reconcileHeldGates(arm, open.id, false);
  // Reusing writes nothing, so it reaches neither guarded write in the create path — but a successful
  // return is what makes the caller PARK, and a cancelled run must never park (anton-287p). The gate
  // itself stays: an earlier attempt armed it for this same ask, and it is not this run's to take
  // back.
  refuseArmIfCancelled(
    arm,
    `gate ${open.id} already carries this ask, so the cancelled run must settle instead of ` +
      `parking behind a wait it is no longer taking`,
  );
  // Still retires what this ask supersedes — the reused gate IS the armed replacement, so an earlier
  // attempt's leftovers would otherwise stay open beside it forever.
  await retireSupersededGates(arm, open.id);
  // No `undo`: an earlier attempt armed this wait for this same ask, and closing someone else's live
  // wait is not how this run stops.
  return { gateId: open.id, held: stillHeld };
}

/** Arm a NEW wait for this ask, then retire the older ones it supersedes — in that order, always. */
async function createArmedGate(arm: ArmAttempt, reason: string): Promise<ArmedHumanGate> {
  const { repo, targetId, stale } = arm;
  refuseArmIfCancelled(arm, "a gate armed now would block the target with nobody waiting on it");
  const gateId = await beads.gateCreate(repo, { blocks: targetId, type: "human", reason });
  await undoArmIfCancelled(arm, gateId, "the gate was created");
  // Best-effort, unlike everything above: the gate exists and carries the ask, so the park is
  // already valid. A lost tag only costs a later arm the right to supersede this wait — it reads as
  // a person's hold and stays open, which is the safe direction for a gate only a human ends.
  if (!(await safe(() => beads.tag(repo, gateId, [HUMAN_GATE_ARMED_LABEL])))) {
    console.warn(
      `[execute-epic] could not label ${targetId}'s human gate ${gateId} ` +
        `(${HUMAN_GATE_ARMED_LABEL}) — a later ask will leave it open instead of superseding it`,
    );
  }
  // Before the last cancellation check, so that check covers the re-read's own window too. Undoable
  // for the same reason the kill's undo is: the waits this ask supersedes are all still open behind
  // this gate, so taking it back cannot be what leaves the target bare.
  const stillHeld = await reconcileHeldGates(arm, gateId, true);
  // The label write and the re-read are the last uninterruptible awaits, and a kill landing inside
  // one would otherwise ride out as a successful arm past every check above. Last point an undo is
  // still safe: the waits this ask supersedes are all still open behind it.
  await undoArmIfCancelled(arm, gateId, "the gate was labelled");
  // Replacement armed — only now is the older ask's wait retired.
  await retireSupersededGates(arm, gateId);
  return {
    gateId,
    held: stillHeld,
    // Retiring a wait behind this one spends the right to undo it: resolving the replacement would
    // then leave the target carrying no wait of anton's at all, on an ask nobody answered.
    undo:
      stale.length > 0
        ? undefined
        : () =>
            retireArmedGate(repo, gateId, `run cancelled after ${targetId}'s human gate was armed`),
  };
}

/**
 * Arm the run target's HUMAN wait: a `human` gate blocking the target, whose reason IS the agent's
 * ask, verbatim. Returns that gate's id alongside the ids of every OTHER open human gate on the
 * target — the holds a person armed, which this arm leaves untouched but which keep the target
 * blocked, so the park message can name them instead of promising one `bd gate resolve` is enough.
 *
 * The one gate flavour nothing automates away, by design on both sides: `bd gate check` never
 * evaluates a human gate, and gate-check's expiry pass deliberately skips it (a wait on a person is
 * never anton's to call overdue). So it carries no timeout and ends only when someone runs
 * `bd gate resolve` — at which point the gate-resume pass hands this target back to the runner,
 * which is why the resume half needed nothing new here.
 *
 * Re-entrant (anton-287p.4), because a park is not the only way this is reached: a settle lost after
 * the gate landed, a resume, or a fresh worktree on another machine all re-run the arm against a
 * board that may already carry the wait. Planned against a board pulled and read strictly
 * ({@link armBoard}) — then mirror the merge gate's shape:
 *
 *   • THIS ask ALREADY ARMED — return that gate's id, create nothing ({@link reuseArmedGate}).
 *   • A DIFFERENT ask ANTON armed — this run stopped for a new reason, so the old wait is superseded
 *     and resolved here ({@link retireSupersededGates}). Nothing else ever would, and it blocks the
 *     target while it lives.
 *   • A DIFFERENT ask A PERSON armed — left exactly where it is. A hand-made human gate is a hold
 *     only its author may release; superseding it would let this run resume through someone's
 *     explicit stop.
 *
 * THROWS when the gate cannot be created, when a superseded gate cannot be resolved (the replacement
 * stands — it is the target's only blocker by then — and every still-open id rides out in the
 * error), when a kill lands anywhere from the board read through the label write (a gate this run
 * created is undone first, which is safe only while the superseded wait is still open; one it was
 * only reusing is left where it stands), or when the shared board cannot be refreshed or read —
 * before the arm, where arming blind is how the duplicate wait gets made, or after it, where a
 * re-read that fails cannot rule out a gate armed concurrently (the created gate is undone first) —
 * so the caller settles the run LOUDLY instead of parking it. They are all the same failure: a park
 * is only meaningful if resolving the gate it names makes the target runnable, and it does not when
 * there is no gate, when a twin blocks the target, when anton's own superseded wait is still open
 * beside it, or when a wait the park never names holds it.
 */
export async function armHumanGate(
  repo: string,
  targetId: string,
  /** The ask AND the ticket that raised it — both go into the gate's reason (PR #205 review). */
  ask: HumanAsk,
  /** The run's LIVE cancellation signal, re-read immediately before every board write below. */
  signal?: AbortSignal,
): Promise<ArmedHumanGate> {
  const reason = humanGateReason(targetId, ask);
  const board = await armBoard(repo, targetId);
  const { stale, held, open } = humanGatePlan(board, targetId, reason);
  const arm: ArmAttempt = { repo, targetId, signal, stale, held };
  // A person's own hold is not anton's to close, and it keeps blocking the target after this ask is
  // answered — the park would otherwise read as though one `bd gate resolve` resumes the run.
  for (const gate of held) {
    console.warn(
      `[execute-epic] ${targetId} also waits on human gate ${gate.id}, which anton did not arm — ` +
        `left open; the run resumes only once that hold is resolved too`,
    );
  }
  // this ask is already with a human — a second gate would race it
  return open ? reuseArmedGate(arm, open) : createArmedGate(arm, reason);
}

/** A ticket's human wait as this preflight armed it — the ticket, and the arm's own undo rights. */
export interface ArmedTicketGate {
  ticketId: string;
  gate: ArmedHumanGate;
}

/**
 * Take back the ticket gates THIS preflight armed, when the pass that armed them is cut short by a
 * kill (PR #213 review).
 *
 * {@link armHumanGate} unwinds only the gate it was arming when the signal flipped — the waits
 * earlier iterations already returned survive it. Left standing they block their tickets for a run
 * nothing comes back for, each carrying an ask whose gate promises that resolving it resumes that
 * run. Undone where {@link ArmedHumanGate.undo} says that is still safe, and NAMED where it is not:
 * a gate whose resolve failed, or one whose arm spent its undo retiring an older wait, stays open
 * and nothing else on the board points at it, so its id rides out in the error the run settles with.
 *
 * Answers the error to throw — the cause unchanged when every wait was taken back, since then the
 * cancelled pass left the board exactly as it found it.
 */
export async function undoCancelledTicketGates(
  armed: ArmedTicketGate[],
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<unknown> {
  if (!signal?.aborted || armed.length === 0) return cause;
  const stranded: string[] = [];
  for (const { ticketId, gate } of armed) {
    if (gate.undo && (await gate.undo())) continue;
    stranded.push(`${gate.gateId} (${ticketId})`);
  }
  if (stranded.length === 0) return cause;
  return new Error(
    `${cause instanceof Error ? cause.message : String(cause)} The human gate(s) armed earlier in ` +
      `this cancelled pass could not be taken back and still block their tickets: ` +
      `${stranded.join(", ")} — resolve them by hand once the work is done, or resume the target, ` +
      `which reuses them rather than arming a second wait.`,
    { cause },
  );
}

/**
 * The park reason on the run row: the agent's ask, WHERE its answer goes, and the command(s) that
 * release the run.
 *
 * Where the answer goes is load-bearing for the asks that are a DECISION rather than an action (PR
 * #205 review). Resolving the gate records only that the wait ended — it carries nothing back — so a
 * resumed session handed the same inputs asks the same question again, and "choose A or B" becomes a
 * permanent resolve/re-arm loop. The channel that DOES reach it is the ticket's human notes: anton
 * inlines them into the dispatch prompt as binding steering (steps/prompts.ts), so an answer left
 * there is read by the very session that re-runs this work. Naming it here is what makes resolving
 * the gate mean "answered" instead of "asked again".
 *
 * Every open human gate is named, not just anton's own. A person's hand-made hold keeps blocking the
 * target after this ask is answered, so a message promising one `bd gate resolve` resumes the run
 * sends the operator down a path that leaves it parked, with nothing naming what still holds it.
 */
export function needsHumanParkMessage(e: NeedsHumanError, gateId: string, held: string[]): string {
  const base =
    `${e.message} If answering means telling the run something — a decision, a value, which ` +
    `option to take — leave that answer as a note on ${e.ticketId} first: the resumed session reads ` +
    `human notes as binding steering, while the gate carries nothing back. Then ` +
    `\`bd gate resolve ${gateId}\``;
  return held.length > 0
    ? `${base}. ${held.length} other open human gate(s) on this target were not armed by anton ` +
        `(${held.join(", ")}) — the run resumes only once those are resolved too.`
    : `${base} — closing that gate resumes this run.`;
}

/**
 * The FAILURE reason when the ask could never become board state. Composed from the ask rather than
 * from {@link NeedsHumanError.message}, which promises a park this run deliberately does not take:
 * with no gate there is nothing to resolve, so parking would be a wait nothing can end.
 */
export function ungatedAskMessage(e: NeedsHumanError, gateError: string | undefined): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. Its human gate could NOT ` +
    `be created (${gateError ?? "unknown error"}), so nothing on the board carries the ask and no ` +
    `\`bd gate resolve\` can release the run — it is FAILED rather than parked, because a park with ` +
    `no gate is a wait nothing can end. Answer the ask, then re-run the target.`
  );
}

/**
 * Settle the run row for an ask whose gate IS armed, and answer with the error the run throws.
 *
 * Split out of the handler because it is where the two halves of a needs-human park can still come
 * apart (anton-287p): the gate is on the board, and the row write that records the park is both
 * fallible and — like every other await in this unwind — a window a force-kill can land in. Three
 * outcomes, one per way that goes:
 *
 *   • **It landed.** The run is parked behind the gate; the ask rides out as the runner's park,
 *     NAMING that gate ({@link ParkedAskError}) so the sweep reports the wait once, not twice.
 *   • **A kill landed inside it.** Every check in the arm passed before it, and no check follows,
 *     so the row would otherwise read as parked behind a wait nobody is servicing. The arm is taken
 *     back where {@link ArmedHumanGate.undo} says that is still safe, and the gate is NAMED where
 *     it is not; either way the row settles FAILED, like a kill that landed earlier in the arm.
 *   • **The write failed.** The gate stays. Taking it back is the one move that is never right
 *     here — this failed on the run's own database, not on the board, so undoing would leave
 *     nothing at all carrying the ask, and a supersede the arm already retired makes it worse. The
 *     gate is the durable half (run-health reports an open human gate from the instant it opens)
 *     and the job parks LOUDLY naming it, rather than retrying into a park that says "blocked".
 *
 * The first two are decided by the LIVE signal alone, never by whether the write landed (PR #205
 * review): a kill can arrive inside a settle that then rejects too, and reading the failure first
 * would report a stopped run as an ordinary armed ask, with its gate blocking a target nobody
 * returns to. So cancellation is checked first, and the park write's own failure — still true of
 * the row when the corrective write fails as well — rides out alongside it.
 *
 * The second write in the cancelled outcome can fail the same way, and then only the message
 * changes: the unwind's verdict on the gate already happened, so it is carried through
 * ({@link unsettledCancelledAskMessage}) instead of being restated as still armed.
 *
 * A kill can also land AFTER all of this, in the cleanup the caller still has to run — so the first
 * outcome reports itself ({@link ArmedAskSettlement.parked}) and the caller reconciles that window
 * through {@link reconcileCancelledArmedPark}.
 */
export async function settleArmedAsk(args: {
  /** The run target the gate blocks. */
  targetId: string;
  /** The ask as the ticket raised it — the park and failure messages are composed from it. */
  ask: NeedsHumanError;
  /** The error the run's catch received, for the cancelled form of the ask. */
  raw: unknown;
  gate: ArmedHumanGate;
  /** The run's LIVE cancellation signal, re-read AFTER the park write — landed or not. */
  signal: AbortSignal;
  now: () => number;
  /** Write the row, answering with the failure message when the write did not land. */
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<ArmedAskSettlement> {
  const { targetId, ask, gate, signal, settle } = args;
  // Names the gate from the start, because this is the error the RUNNER parks the job on: an ask
  // whose park message carries no gate id reads to the run-health sweep as a permanent failure, and
  // the wait gets escalated twice (PR #205 review). Replaced below on either path that unseats the
  // park — a cancelled unwind, or a row that could not be settled.
  let thrown: unknown = new ParkedAskError(ask, gate.gateId, gate.held);
  const parkFailure = await settle({
    status: "parked",
    error: needsHumanParkMessage(ask, gate.gateId, gate.held),
  });
  let unsettled = parkFailure;
  // Whether the cancelled unwind below already decided what the board holds. Its verdict — gate
  // taken back, or gate stranded — is the truth about the gate even if the corrective row write
  // then fails, so the still-armed message must not overwrite it.
  let cancelled = false;
  // The kill is read INDEPENDENTLY of whether the park write landed (PR #205 review): a force-kill
  // that arrives inside a settle which then also rejects (SQLITE_BUSY) is still a cancelled run, and
  // gating the unwind on the write would report it as an ordinary armed ask — leaving the gate this
  // run created blocking a target nobody is coming back for.
  if (signal.aborted) {
    cancelled = true;
    const unwound = await unwindCancelledAsk({
      ...args,
      during: "while its park was being recorded",
    });
    thrown = unwound.thrown;
    // The corrective write is the row's last word: when it lands the row is right and a failed park
    // write before it is spent history. When it does not, BOTH failures are still true of the row,
    // so both ride out in the error rather than only the one that happened last.
    unsettled =
      unwound.unsettled && parkFailure
        ? `${parkFailure}, then ${unwound.unsettled}`
        : unwound.unsettled;
  }
  if (unsettled) {
    console.error(
      `[execute-epic] ${targetId}: the run row could not be settled (${unsettled}) — ` +
        (cancelled
          ? `the cancelled unwind's verdict on human gate ${gate.gateId} stands`
          : `human gate ${gate.gateId} is armed`),
    );
    thrown = new PoisonEpic(
      cancelled
        ? unsettledCancelledAskMessage(thrown, unsettled)
        : unsettledAskMessage(ask, gate.gateId, unsettled),
    );
  }
  // `parked` is what the ROW says; `awaitsHumanGate` is what the BOARD holds. They part exactly on a
  // failed park write, and the caller needs both: the row decides how the run settles, the live wait
  // decides what the checkout and the cleanup's kill window still owe.
  return { thrown, parked: !cancelled && !parkFailure, awaitsHumanGate: !cancelled };
}

/** What {@link settleArmedAsk} left behind — the run's error, and whether the park is live. */
export interface ArmedAskSettlement {
  /** The error the run throws: the ask naming its gate behind a standing park, its cancelled form
   * otherwise. */
  thrown: unknown;
  /**
   * True only while the run really is RECORDED as parked behind the live gate — how the run settles.
   * A failed park write leaves the gate standing all the same, so what the cleanup's kill window
   * must reconcile is {@link awaitsHumanGate}, not this.
   */
  parked: boolean;
  /**
   * The gate still STANDS and a person resolving it resumes this run — true whether or not the park
   * row landed, and false only once the cancelled unwind has taken the wait back. It is what the
   * teardown needs (PR #205 review): a park write that failed settles the run as `failed`, and
   * releasing the checkout on that would delete the partial work the resume continues from. It is
   * also the arm a kill arriving LATER (in the handler's cleanup) has to reconcile, via
   * {@link reconcileCancelledArmedPark}.
   */
  awaitsHumanGate: boolean;
}

/** A needs-human wait this run left LIVE on the board — what the cleanup's kill window reconciles. */
export interface LiveArmedAsk {
  gate: ArmedHumanGate;
  ask: NeedsHumanError;
  /** The error the run's catch received, for the cancelled form of the ask. */
  raw: unknown;
  /** Whether the park row landed beside the gate — names the window in the stranded-gate message. */
  parkRecorded: boolean;
}

/**
 * The arm the run's cleanup still owes a reconcile, or `undefined` when nothing is left standing.
 *
 * Keyed on the GATE, not on the park row (PR #205 review): a park write that failed settles the run
 * as `failed` while the wait stays open, which is the sharper version of the very state this window
 * exists to prevent — a gate blocking a target with no row even recording it. Reconciling only the
 * parks that landed would make that the one live arm a cancellation can never take back. Nothing is
 * lost by taking it back: the cancelled form of the ask carries the ask itself, exactly as it does
 * for a kill that lands one await earlier ({@link settleArmedAsk}).
 *
 * A cancellation that call already unwound is settled — the gate is gone or named as stranded — so
 * it leaves no arm here.
 */
export function liveArmedAsk(
  arm: Omit<LiveArmedAsk, "parkRecorded">,
  settlement: ArmedAskSettlement,
): LiveArmedAsk | undefined {
  if (!settlement.awaitsHumanGate) return undefined;
  return { ...arm, parkRecorded: settlement.parked };
}

/**
 * Take a live armed ask back after a kill: undo the gate where {@link ArmedHumanGate.undo} says that
 * is still safe, NAME it where it is not, and record the run FAILED with whichever it was.
 *
 * Shared by the two windows a force-kill can land in once the gate is live and the park is this
 * run's verdict (anton-287p) — inside the park write itself, and inside the cleanup that runs after
 * it. Both leave the same state, because to the operator they are the same event: the run was
 * stopped, and nothing is coming back for the wait it armed.
 */
export async function unwindCancelledAsk(args: {
  targetId: string;
  ask: NeedsHumanError;
  raw: unknown;
  gate: ArmedHumanGate;
  signal: AbortSignal;
  /** What the run was doing when the kill landed — names the window in the stranded-gate message. */
  during: string;
  now: () => number;
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<{ thrown: unknown; unsettled: string | undefined; undone: boolean }> {
  const { targetId, ask, raw, gate, signal } = args;
  const undone = gate.undo ? await gate.undo() : false;
  // Undone, nothing on the board carries the ask — which is exactly what the cancelled form of the
  // error says. Standing, the gate blocks the target with no run coming back for it, so the row AND
  // the runner's park have to name it: the ask's own message would promise a park this run is no
  // longer taking.
  const thrown = undone
    ? askSettleError(raw, signal)
    : new PoisonEpic(
        strandedAskMessage(
          ask,
          new StrandedHumanGateError(
            targetId,
            gate.gateId,
            `the run was cancelled ${args.during}, so the wait armed for the ask stands`,
          ),
        ),
      );
  const unsettled = await args.settle({
    status: "failed",
    error: thrown instanceof Error ? thrown.message : String(thrown),
    endedAt: args.now(),
  });
  return { thrown, unsettled, undone };
}

/**
 * The LAST window a kill can land in once the ask's gate is live (anton-287p): the run's own cleanup
 * — awaiting the in-flight lease refresh, clearing the lease, syncing the board — runs AFTER
 * {@link settleArmedAsk}'s final signal read, is uninterruptible, and a board sync is seconds of
 * network. A force-kill arriving there would otherwise ride out as an ordinary park: the row parked,
 * the gate blocking the target, and no run ever coming back for either — the exact state every check
 * inside the arm exists to prevent, reached one await later. A park write that FAILED reaches the
 * same window with the gate open and no row recording it at all, so it is reconciled here too.
 *
 * Answers `undefined` when there is nothing to reconcile (the run was not cancelled after all), and
 * otherwise the error the run must throw INSTEAD of its ask — the same unwind, and the same row, as
 * a kill that landed one await earlier — plus whether the gate itself was taken back, which is what
 * the caller still owes the board a push for ({@link concludeCancelledArmedPark}).
 */
export async function reconcileCancelledArmedPark(args: {
  targetId: string;
  ask: NeedsHumanError;
  raw: unknown;
  gate: ArmedHumanGate;
  /** The run's LIVE signal, re-read after the cleanup awaits — nothing checks it after this. */
  signal: AbortSignal;
  /**
   * Whether the park row landed beside the gate. Only names the window in the stranded-gate message
   * — the unwind is the same either way — but a run whose park write failed must not be reported as
   * one that recorded a wait it never did.
   */
  parkRecorded?: boolean;
  now: () => number;
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<CancelledParkReconcile | undefined> {
  if (!args.signal.aborted) return undefined;
  const { thrown, unsettled, undone } = await unwindCancelledAsk({
    ...args,
    during:
      `while it released its lease and synced the board, after its park ` +
      `${args.parkRecorded === false ? "could not be recorded" : "was recorded"}`,
  });
  if (!unsettled) return { thrown, undone };
  console.error(
    `[execute-epic] ${args.targetId}: the run row could not be settled (${unsettled}) — the ` +
      `cancelled unwind's verdict on human gate ${args.gate.gateId} stands`,
  );
  // The row may still read as parked, so the verdict above is carried through rather than restated:
  // it is the only accurate account of what the board holds.
  return { thrown: new PoisonEpic(unsettledCancelledAskMessage(thrown, unsettled)), undone };
}

/** What {@link reconcileCancelledArmedPark} did with the arm the cleanup's kill window caught. */
export interface CancelledParkReconcile {
  /** The error the run throws instead of its ask. */
  thrown: unknown;
  /** The gate was resolved here — a LOCAL board write no machine but this one has seen yet. */
  undone: boolean;
}

/**
 * The whole of the cleanup's kill window (anton-287p, PR #205 review): take the arm back, then
 * finish the two things the ordinary park left standing for a resume that is no longer coming — the
 * checkout kept FOR that park, and the board push that publishes the undo.
 *
 * Both matter only in the cancelled case, and neither has another owner:
 *
 *   • **The checkout.** The teardown already ran and kept it, correctly, because at that moment the
 *     run WAS parked behind a live gate. The reconcile turns that into a failed run nothing resumes,
 *     and no later pass reclaims the tree — the scheduled reaper keeps every worktree whose bead is
 *     still open, and a cancelled run's target is. Left alone, the cancelled run's partial edits sit
 *     there until a human finds them, and the next run on the branch inherits them.
 *   • **The push.** The undo is a local Dolt write and the run's end-of-cleanup sync has already
 *     gone. Until it ships, every other machine still reads the gate as OPEN and the target as
 *     blocked, while this run reports that it armed no gate at all. So a failed push queues the
 *     durable sync-push retry (anton-nowq) AND is named in the run's own error — the run is the only
 *     place that contradiction is visible.
 *
 * Answers `undefined` when there was nothing to reconcile, and otherwise the error the run throws.
 */
export async function concludeCancelledArmedPark(args: {
  /** The gate the park was armed on — named in the error when its undo could not be published. */
  gateId: string;
  /** Take the arm back if the run was cancelled — {@link reconcileCancelledArmedPark}. */
  reconcile: () => Promise<CancelledParkReconcile | undefined>;
  /** Hand back the checkout the teardown kept for the park. Undefined when it kept none. */
  releaseKeptWorktree?: () => Promise<void>;
  /** Publish the undo to the shared board; `false` when the push did not land. */
  push: () => Promise<boolean>;
  /** Queue the durable retry that keeps pushing, and parks for a human on exhaustion. */
  queuePush: () => void;
}): Promise<{ thrown: unknown } | undefined> {
  const reconciled = await args.reconcile();
  if (!reconciled) return undefined;
  if (args.releaseKeptWorktree) await args.releaseKeptWorktree();
  if (await args.push()) return { thrown: reconciled.thrown };
  args.queuePush();
  // Only a gate that WAS taken back can disagree with the board: a stranded one is open here and
  // open everywhere else, and its error already sends the operator to resolve it by hand.
  return {
    thrown: reconciled.undone
      ? new PoisonEpic(unpushedGateUndoMessage(reconciled.thrown, args.gateId))
      : reconciled.thrown,
  };
}

/**
 * The FAILURE reason when the ask DID reach the board but the run row could not record the park.
 * The gate is the durable half and still releases the target, so it is named here: the row may say
 * nothing at all, leaving this message the only place the two halves are connected.
 */
export function unsettledAskMessage(e: NeedsHumanError, gateId: string, failure: string): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. Human gate ${gateId} ` +
    `IS armed and carries the ask, but this run's row could not be settled as parked ` +
    `(${failure}), so the run history does not show the wait. Answer the ask, then ` +
    `\`bd gate resolve ${gateId}\` — that still releases the target and resumes the run.`
  );
}

/**
 * The FAILURE reason when a cancelled unwind already settled what the board holds and only the
 * corrective row write failed. Its verdict is carried through verbatim rather than replaced by
 * {@link unsettledAskMessage}, which would contradict it: after a successful undo there is no gate
 * left to resolve, and telling the operator to close one would leave them waiting on an id that no
 * longer exists while the row still reads as parked.
 */
export function unsettledCancelledAskMessage(cancelled: unknown, failure: string): string {
  const verdict = cancelled instanceof Error ? cancelled.message : String(cancelled);
  return (
    `${verdict} (The run was cancelled mid-park and its row could not then be settled as failed — ` +
    `${failure} — so the run history may still read as parked; the state described above is the ` +
    `accurate one.)`
  );
}

/**
 * The FAILURE reason when a cancelled unwind DID take its gate back but the push that publishes the
 * undo failed. The resolve is committed in this checkout's Dolt working set alone, so every other
 * machine still reads the gate as open and the target as blocked, while the verdict above says no
 * gate was armed at all. The durable sync-push retry is already queued, so the id is named as the
 * manual fallback rather than as a wait the operator must clear.
 */
export function unpushedGateUndoMessage(cancelled: unknown, gateId: string): string {
  const verdict = cancelled instanceof Error ? cancelled.message : String(cancelled);
  return (
    `${verdict} (Resolving human gate ${gateId} could not be pushed to the shared board, so other ` +
    `machines still read it as open and the target as blocked until the queued sync-push lands. If ` +
    `it never does, \`bd gate resolve ${gateId}\` on a machine that can reach the remote.)`
  );
}

/**
 * The FAILURE reason when the arm left a live gate behind that no resume will reach — a kill whose
 * undo failed, or a supersede that failed beside the wait just armed. The ask IS on the board, on
 * gate(s) this run will never come back for. Named explicitly — nothing automatic resolves a human
 * gate, so the target stays blocked until someone clears every id.
 */
export function strandedAskMessage(e: NeedsHumanError, stranded: StrandedHumanGateError): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. ${stranded.message}. The ` +
    `run is FAILED rather than parked — no resume is coming for that gate. Answer the ask, clear ` +
    `the gate${stranded.gateIds.length > 1 ? "s" : ""}, then re-run the target.`
  );
}
