/**
 * The board-picker's recorded plan (anton-it5i): what one pass decided, and the anton.db row that
 * holds the latest decision per project.
 *
 * The pass ranks the claimable set into a queue and leaves everything else out for a stated reason.
 * Three surfaces need that answer — the Up Next lane, the decision log, and the arming step that
 * actually starts a target — and each of them could recompute it from the board. Three
 * re-derivations of a ranking over a board that moves between them is three answers that can
 * disagree, so the pass records ONE and they read it. That is the whole point of this module.
 *
 * Machine-local, like the policy it derives from: nothing here is shared between machines, and bd's
 * claim protocol — not this record — is what stops two machines starting the same target.
 *
 * Reading the record costs no `bd` call by construction: every field a surface needs is on the row,
 * and everything the stamp reaches for is pure and spawn-free — anton.db, the contract reader it
 * judges through (`beads/contract.ts`), and the eligibility pass whose candidate pool its fence is
 * narrowed to (`jobs/picker-targets.ts`). `Bead` is a type-only import.
 *
 * db-injectable (like run-health) so the pass and its tests share one connection; the UI read and
 * write paths go through the shared anton.db.
 *
 * The pass is no longer the only writer (anton-f12y): the board read derives the same decision from
 * the board it is already holding and records it too, so the generation a surface hands out names
 * what is on screen rather than what a background tick last wrote. Both go through
 * {@link saveBoardPickerPlan}, which is idempotent per decision — restating one costs no new
 * generation.
 *
 * Two writers need an order, and it is the OBSERVATION, not the clock the write landed on
 * (anton-m4il): the pass yields rather than replace a generation derived from a strictly fresher
 * look at the board (`yieldToFresher`), so a slow tick cannot retire the plan an operator is
 * looking at. The read never yields — see the field for why.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { beads } from "./beads/bd";
import { contractStatusOf } from "./beads/contract";
import type { Bead } from "./beads/types";
import { eligibleTargets } from "./jobs/picker-targets";
import { ageBoundBreached, ageInDays } from "./policy/age";
import { policyDigest } from "./policy/digest";
import { namespaceOf, type Policy } from "./policy/types";
import { boardCards, isRunTicket } from "./ticket-view";
import { systemClock, type AntonDb, type Clock } from "./jobs/queue";

/**
 * Why a candidate is not in the plan. Machine-readable rather than prose because the policy editor
 * answers "why not this one?" per bead (R2.6) and the lane groups the rest — both of which a
 * free-text sentence would force them to parse.
 *
 *   • `proposal`         — a gardener/pm proposal: a decision the founder applies, not work an agent
 *                          implements, even though it is shaped as a parentless task (anton-x37c).
 *   • `not-a-run-target` — not a feature, a parentless task/bug, or a childless epic, so nothing
 *     about it is a thing anton runs (`beads.isRunTarget`).
 *   • `not-open`         — closed, deferred, or already in flight.
 *   • `abandoned`        — a won't-do. Usually closed with it, but a crashed cascade can leave the
 *                          label on an OPEN bead, which nothing may pick up.
 *   • `claimed`          — carries an assignee. A target a human took is never taken back.
 *   • `needs-human`      — labelled `agent:human`: approved work waiting for a PERSON, which no
 *                          agent can finish, so anton never starts it (anton-mv70).
 *   • `blocked`          — an unmet blocker on the `blocks` graph.
 *   • `approval-gap`     — fails one of the approve gate's four promises (`approval-gate.ts`).
 *   • `policy`           — structurally claimable, but the standing policy does not admit it.
 *   • `deferred`         — the operator vetoed this pick (`picker-veto.ts`), and the bounded window
 *                          they bought with it has not run out. Their answer, not a rule's.
 */
export type PickerExclusionReason =
  | "proposal"
  | "not-a-run-target"
  | "not-open"
  | "abandoned"
  | "claimed"
  | "needs-human"
  | "blocked"
  | "approval-gap"
  | "policy"
  | "deferred";

/** One target in the plan, at the position the ranking gave it. */
export interface PickerPlanEntry {
  beadId: string;
  /**
   * 1-based position in the ranked plan. Stored rather than left implicit in array order, so an
   * entry quoted on its own — a bead note, a provenance badge — still carries where it stood.
   */
  rank: number;
  /** The policy rule that admitted this target: what `◈ policy` links to, and what a `Never` veto
   *  opens the editor at. */
  rule: string;
}

/** One candidate the pass left out, and what excluded it. */
export interface PickerExclusion {
  beadId: string;
  reason: PickerExclusionReason;
  /** The specifics behind the reason — which blocker, which criterion, who holds the claim. */
  detail?: string;
}

/**
 * The decision inputs a plan was computed from — the board snapshot AND the policy in force —
 * carried on the record so staleness is detectable rather than assumed from the clock.
 */
export interface BoardStamp {
  /**
   * When the pass read the board (epoch ms), in the gardener's `observedAtMs` sense: the moment a
   * change to a bead counts as having happened "since we looked".
   */
  observedAtMs: number;
  /** {@link stampBoard}'s digest over those inputs. Two reads agree iff their digests do. */
  digest: string;
  /** How many beads the digest covers: the decision's reachable set ({@link reachableSet}), not the
   *  board it was narrowed from. */
  beadCount: number;
}

export interface BoardPickerPlan {
  projectId: string;
  /**
   * Identity of this GENERATION of the plan — what a verdict names when it answers one of its picks
   * ({@link restatesDecision} is what carries it over, or does not).
   */
  planId: string;
  /** The picker job that produced it; absent for a plan written outside the job (tests). */
  jobId?: string;
  /** Unix seconds, matching every other timestamp this app hands the UI. */
  generatedAt: number;
  stamp: BoardStamp;
  /** The ranked queue, in rank order. Empty means "the pass ran and found nothing to start". */
  entries: PickerPlanEntry[];
  exclusions: PickerExclusion[];
}

/** Long enough that a collision is not a practical concern; short enough to read in a log line. */
const DIGEST_LENGTH = 16;

/**
 * The bead's contract standing, as the digest carries it: the VERDICT, never the prose it was read
 * from.
 *
 * Eligibility reads the contract-bearing fields — `description`, `acceptance_criteria`,
 * `acceptance` — through the approve gate (`makeApprovalGate` → `contractGaps`), so a deleted
 * Acceptance section flips a target from eligible to `approval-gap` without touching any other
 * field. A digest over the raw prose would catch that, but it would also mark every plan stale on a
 * typo fix; a digest over the parsed verdict catches exactly the edits that can change the answer.
 * `undefined` — exempt tier, or a bead no bd read produced — is its own state, distinct from
 * "judged and clean", because those two are different answers about whether the gate applies.
 */
function contractDigest(bead: Bead): string {
  const status = contractStatusOf(bead);
  if (!status) return "unjudged";
  return [...status.blocking, ...status.advisory]
    .map((v) => `${v.severity}/${v.section}`)
    .sort()
    .join(",");
}

/** Can a move in this input change which targets the pass picks, or the order it picks them in? */
export type DecisionRelevance = "decision-relevant" | "not-decision-relevant";

/**
 * WHOSE copy of the field the decision reads — the distinction a narrowing of this fence lives or
 * dies on (anton-gsny).
 *
 *   • `candidate` — read only off a bead that could itself be picked: the policy predicate and the
 *     comparator see the admitted set and nothing else.
 *   • `board`     — read off beads that are NOT candidates. The transitive `blocks` walk
 *     (`beads/rank.ts`) counts what finishing a target releases, and it traverses the whole
 *     snapshot: a closed bead three hops downstream changes a pick's `unblocks` and can reorder the
 *     queue. Card attribution, the container-epic test and the contract gate reach off-candidate
 *     beads the same way.
 *
 * So a fence narrowed to "the beads this plan picked" would be wrong, not merely tighter — most of
 * the ranking's second term is computed from beads no policy would ever admit. The narrowing that
 * IS available is per-FIELD (and, inside {@link DIGEST_LABEL_NAMESPACES}, per-namespace), never per
 * bead.
 */
export type DecisionScope = "candidate" | "board";

/** One column of {@link digestLine}, classified, with the read that makes the classification true. */
export interface DigestField {
  /** The bead field, named as this module writes it. */
  field: string;
  relevance: DecisionRelevance;
  scope: DecisionScope;
  /** One line: which read makes it so. */
  why: string;
  /** How the column is written. The table IS the line, so a column cannot be added unclassified. */
  read: (bead: Bead) => string;
}

/**
 * The projection of a bead the digest covers — exactly the inputs eligibility and the PRIME ranking
 * read — and the ARGUMENT for each one (anton-gsny).
 *
 * Deliberately NOT the bead's raw prose or its `updated_at` stamp. A digest over "was this bead
 * written at all" would mark every plan stale the moment somebody fixed a typo in a description, on
 * a board where the pass reruns every ten minutes anyway — so "the board moved" would stop meaning
 * anything. What the fence must catch is a move that could change the ANSWER: the fields below, plus
 * whatever the description says about the contract, which enters as {@link contractDigest}'s verdict
 * rather than as its text.
 *
 * The classification is a TABLE rather than a comment because it has to stay true: {@link digestLine}
 * hashes the entries this table calls decision-relevant and nothing else, so a column added without
 * a stated verdict does not compile, and a verdict is a change to the fence rather than a note about
 * it. Every field here comes back decision-relevant, and that is the honest reading of the code as
 * it stands — the narrowing lives one level down, in {@link DIGEST_LABEL_NAMESPACES}, where
 * anton's own bookkeeping namespaces churn inside the `labels` column without any of the decision's
 * readers ever consulting them.
 *
 * Fail CLOSED, in both directions: an input nobody could classify stays in the fence, and a field
 * whose reader is merely unlikely — not provably absent — is decision-relevant. The cost of keeping
 * one is a plan retired early and rewritten by the next pass; the cost of dropping one is a
 * `[Release]` offering a start the board no longer supports.
 *
 * Age is the one ranking input absent here, and necessarily: it is a function of wall-clock time,
 * so it changes every second and no digest can hold it. It is re-judged instead of hashed —
 * {@link agedOutPicks}, which the fence reads beside this digest.
 */
export const DIGEST_FIELDS: readonly DigestField[] = [
  {
    field: "id",
    relevance: "decision-relevant",
    scope: "board",
    why: "the `blocks` walk's node key and the comparator's final tiebreak, so a bead's identity decides both what it releases and where it sits among equals",
    read: (b) => b.id,
  },
  {
    field: "status",
    relevance: "decision-relevant",
    scope: "board",
    why: "eligibility admits `open` alone, and the walk reads EVERY bead's status to decide what still waits, which blockers still grip, and where the chain halts",
    read: (b) => b.status,
  },
  {
    field: "issue_type",
    relevance: "decision-relevant",
    scope: "board",
    why: "run-target identity is read off a bead and its children (a feature child turns an epic into a container), the tier gate reads it over the subtree, and the policy's `types` criterion admits on it",
    read: (b) => b.issue_type ?? "",
  },
  {
    field: "priority",
    relevance: "decision-relevant",
    scope: "candidate",
    why: "the comparator's first term and the policy's min/maxPriority bound — nothing reads it off a bead that could not be picked",
    read: (b) => String(b.priority ?? ""),
  },
  {
    field: "assignee",
    relevance: "decision-relevant",
    scope: "candidate",
    why: "a held claim is the `claimed` exclusion, and a claim a human took is never taken back",
    read: (b) => b.assignee ?? "",
  },
  {
    field: "parent",
    relevance: "decision-relevant",
    scope: "board",
    why: "card attribution walks the whole parent chain, so a re-parent anywhere moves container-ness, the ticket set a run would dispatch, and the policy's parentage depth",
    read: (b) => b.parent ?? b.parent_id ?? "",
  },
  {
    field: "created_at",
    relevance: "decision-relevant",
    scope: "candidate",
    why: "the age tiebreak between equally urgent picks, and the field the policy's age bounds judge — the bounds themselves move with the clock, which is what {@link agedOutPicks} re-judges",
    read: (b) => b.created_at ?? "",
  },
  {
    field: "labels",
    relevance: "decision-relevant",
    scope: "board",
    why: "`abandoned` and `agent:human` refuse a target outright, `stage:in-review` changes which beads the contract gate even reads, and the operator's criteria are written over the board's own namespaces — narrowed per namespace in {@link DIGEST_LABEL_NAMESPACES}",
    read: (b) => [...(b.labels ?? [])].filter(isDecisionRelevantLabel).sort().join(","),
  },
  {
    field: "dependencies",
    relevance: "decision-relevant",
    scope: "board",
    why: "`blocks` edges are the whole input to the transitive unblocking walk and to the blocker rollup; parent-child edges carry the parentage the card attribution reads",
    read: (b) =>
      (b.dependencies ?? [])
        .map((d) => `${d.type}:${d.issue_id}>${d.depends_on_id}`)
        .sort()
        .join(","),
  },
  {
    field: "contract",
    relevance: "decision-relevant",
    scope: "board",
    why: "the approve gate judges the target AND every ticket the run would dispatch, so a child's cleared Acceptance disqualifies a card that is not itself the edited bead",
    read: contractDigest,
  },
];

/** One `ns:` group inside the `labels` column, classified on its own — see {@link DIGEST_FIELDS}. */
export interface DigestLabelNamespace {
  /** The `ns` of a `ns:value` label, as the board writes it — `"stage"`, not `"stage:"`. */
  namespace: string;
  relevance: DecisionRelevance;
  why: string;
}

/**
 * The `labels` column, argued per namespace — where this epic's narrowing actually is (anton-gsny).
 *
 * anton writes four namespaces of its own bookkeeping (`POLICY_CONTROL_NAMESPACES`), and the store
 * REFUSES a policy criterion over any of them (`projects.ts`), so no operator rule can be reading
 * one. Three of the four are read by nothing in the decision either — they describe anton's runs,
 * not what is worth starting — and one is, which is the finding worth writing down: `stage:` looks
 * like pure bookkeeping and is not.
 *
 * Everything else on a board is decision-relevant by DEFAULT, which is the fail-closed half of
 * {@link isDecisionRelevantLabel}: a repo invents its own vocabulary, an operator's criteria are
 * written over exactly that vocabulary, and a namespace nobody has classified is one nobody has
 * proved unread.
 */
export const DIGEST_LABEL_NAMESPACES: readonly DigestLabelNamespace[] = [
  {
    namespace: "stage",
    relevance: "decision-relevant",
    why: "`stage:in-review` makes `contractGatedBeads` skip a standalone target, so it can flip that target from `approval-gap` to eligible — anton writes this one, but eligibility reads it back",
  },
  {
    namespace: "run-lease",
    relevance: "not-decision-relevant",
    why: "a heartbeat expiry rewritten every few seconds mid-run; eligibility, the policy and the walk all ignore it, the run it marks is already `claimed` and `in_progress` to this fence, and a race against a foreign lease is arbitrated by the claim protocol, not here",
  },
  {
    namespace: "review-score",
    relevance: "not-decision-relevant",
    why: "anton's verdict on a finished run — read by the UI and by the score-slide breaker, which the apply path re-asks live (`picker-apply-checks`), never by eligibility, the policy or the ranking",
  },
  {
    namespace: "source",
    relevance: "not-decision-relevant",
    why: "provenance for a bead anton's own automation filed; no reader in the picker decision path consults it (ticket-view reads it for display, orphan-grooming reads it to find its own bucket epic — neither is in eligibility, the policy or the ranking)",
  },
];

const IRRELEVANT_NAMESPACES: ReadonlySet<string> = new Set(
  DIGEST_LABEL_NAMESPACES.filter((n) => n.relevance === "not-decision-relevant").map(
    (n) => n.namespace,
  ),
);

/**
 * Is this label one the fence must carry? True unless its namespace is classified
 * `not-decision-relevant` above — an unknown namespace, and every bare label, stays in.
 *
 * The narrowing's fail-closed rule, stated once here and applied by the `labels` column of
 * {@link DIGEST_FIELDS}, so the rule and the argument that justifies it cannot drift apart.
 */
export function isDecisionRelevantLabel(label: string): boolean {
  return !IRRELEVANT_NAMESPACES.has(namespaceOf(label));
}

/**
 * The columns the fence actually hashes. Derived from the table rather than restated, so a field
 * reclassified `not-decision-relevant` leaves the digest by that edit alone.
 */
const FENCED_FIELDS: readonly DigestField[] = DIGEST_FIELDS.filter(
  (f) => f.relevance === "decision-relevant",
);

/** The classified projection, written in column order — the decision-relevant columns, and only
 *  those. */
function digestLine(bead: Bead): string {
  return FENCED_FIELDS.map((f) => f.read(bead)).join("\t");
}

/**
 * THE BEADS ONE DECISION CAN READ — the fence's input set (anton-t01f).
 *
 * {@link DIGEST_FIELDS} narrows the fence per FIELD; this narrows it per BEAD, and both are the same
 * argument at a different granularity: the digest may cover a read the decision actually makes, and
 * nothing else. A fence over the whole snapshot retires a generation on every unrelated write there
 * is — on anton's own board the decision reaches 289 of 842 beads, and an hour of ordinary grooming
 * that left the whole-board fence naming the current top pick 50% of the time leaves this one
 * naming it 85.8% of the time, with the false-current share still at zero
 * (`board-picker-plan.currency.test.ts`, which measures both sides and the guard between them).
 *
 * Four parts, each one a read the pass makes:
 *
 *   1. the CANDIDATE POOL — every bead {@link eligibleTargets} weighed, admitted or refused. On any
 *      board that is every non-closed bead, because a refusal is recorded for each of them.
 *   2. the BLOCKS CLOSURE over it — the transitive unblocking walk (`beads/rank.ts`) is the
 *      comparator's second term and it traverses closed beads freely, so a blocker three hops
 *      downstream is a decision input even though no policy would ever admit it. Walked both ways
 *      along each edge: what a candidate releases decides its rank, and what grips it decides
 *      whether it is a candidate at all.
 *   3. the PARENT CLOSURE of everything in 1 and 2, and the FEATURE CHILDREN of everything in that
 *      — taken together, to a fixpoint, because each clause feeds the other. `structureGaps` walks
 *      UPWARD from a candidate (`feature-under-non-epic` reads the parent's type,
 *      `ticket-under-container-epic` reads whether an ancestor is a container) and `beads.cardOf`
 *      attributes a bead to its nearest card ANCESTOR, so an ancestor of any status is a decision
 *      input; and `beads.isContainer` counts a feature child of ANY status, so each ancestor pulled
 *      in brings its own feature children, which decide whether IT is a container. Neither clause
 *      reaches a fixpoint alone. Without the feature-children half, re-parenting a finished feature
 *      under an epic pick drops that pick from the plan with no bead entering the pool and no
 *      `blocks` edge moving (anton-icu6 found it by sweeping the corpus; pinned as "a closed feature
 *      child"). Without the parent half, re-typing a CLOSED epic ancestor, or re-parenting a closed
 *      feature under a closed ancestor, does the same through the very same silence.
 *   4. the RUN TICKETS of every bead in 1 — the descendants `runTickets` attributes to it, at any
 *      depth and ANY status. `contractGatedBeads` judges a candidate through
 *      `beads.groupsChildren`, which counts a ticket child of any status, so the mere existence of a
 *      CLOSED ticket under a feature decides whether that feature is contract-gated at all: groom
 *      the finished ticket onto another card and the feature falls out of the plan with no bead
 *      entering the pool and no edge above it moving. Scoped to the POOL, not to everything reached:
 *      a bead reached only by 2 or 3 is closed, and a closed target is refused on status before the
 *      gate ever reads its tickets.
 *
 * Computed over the board being STAMPED rather than carried on the plan, which is what makes the two
 * digests comparable: a bead that has newly become a candidate is in this board's set and was not in
 * the plan's, so the lines differ and the mismatch is honest.
 *
 * Fail CLOSED, like the field table: what is dropped here is what has been SHOWN unread, swept
 * exhaustively over a real board rather than argued from a fixture.
 */
export function reachableSet(board: Bead[]): ReadonlySet<string> {
  const { eligible, exclusions } = eligibleTargets(board);
  const pool = new Set<string>([...eligible.map((b) => b.id), ...exclusions.map((x) => x.beadId)]);
  const reached = new Set<string>(pool);

  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const known = neighbours.get(from);
    if (known) known.push(to);
    else neighbours.set(from, [to]);
  };
  for (const bead of board) {
    for (const dep of bead.dependencies ?? []) {
      if (dep?.type !== "blocks" || !dep.issue_id || !dep.depends_on_id) continue;
      link(dep.issue_id, dep.depends_on_id);
      link(dep.depends_on_id, dep.issue_id);
    }
  }

  // Cursor rather than `shift()`: this walk runs on every stamp, and every board read takes one.
  const queue = [...reached];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbours.get(queue[i]) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  // Upward along every parent edge; downward along the FEATURE ones, and from a POOL bead to the
  // run tickets attributed to it — matching what the structure and contract reads do. Walked as one
  // closure, seeded from the set above, because an ancestor admitted here can itself be a container
  // and a feature child admitted here can itself have an ancestor.
  const cards = boardCards(board);
  const kin = new Map<string, string[]>();
  const relate = (from: string, to: string) => {
    const known = kin.get(from);
    if (known) known.push(to);
    else kin.set(from, [to]);
  };
  for (const bead of board) {
    const parent = beads.parentOf(bead);
    if (parent === undefined) continue;
    relate(bead.id, parent);
    if (bead.issue_type === "feature") relate(parent, bead.id);
    if (!isRunTicket(bead, cards)) continue;
    const card = cards.cardOf(bead);
    // Only a POOL card's tickets: `reached` also holds beads admitted by the walks above, and those
    // are closed (every non-closed bead earns an eligibility answer, so the pool is exactly the
    // non-closed board) — a closed target is refused on status long before the gate reads a ticket.
    if (card !== undefined && pool.has(card)) relate(card, bead.id);
  }

  const structure = [...reached];
  for (let i = 0; i < structure.length; i++) {
    for (const next of kin.get(structure[i]) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      structure.push(next);
    }
  }
  return reached;
}

/**
 * Stamp the inputs one decision was made from — the classified fields ({@link DIGEST_FIELDS}) of the
 * beads the decision can reach ({@link reachableSet}), and nothing else. So a `run-lease:` heartbeat
 * rewritten mid-run leaves the ranking's fence exactly where it was, and so does a chore closed in a
 * corner of the board no pick depends on.
 *
 * Order-independent — the lines are sorted before hashing — because two reads of an unchanged board
 * may return the beads in any order, and a stamp that disagreed with itself over that would report
 * every plan stale.
 *
 * The armed POLICY is hashed alongside the beads (anton-t9m4 review): admission is a function of
 * both, so an operator who narrows `pickerPolicy` without touching a bead has invalidated the plan
 * just as surely as a claim would have. A fence over the beads alone would keep offering a start the
 * new policy refuses until the next pass ran. Absent means the project has armed none, which is its
 * own state and digests differently from any policy. Hashed unconditionally, outside the narrowing:
 * the operator's rules decide which beads are candidates at all, so an edit to them has to move the
 * stamp even on a board whose decision reaches no bead.
 */
export function stampBoard(board: Bead[], observedAtMs: number, policy?: Policy): BoardStamp {
  const reached = reachableSet(board);
  const fenced = board.filter((bead) => reached.has(bead.id));
  const hash = createHash("sha256");
  hash.update(`policy\t${policyDigest(policy)}\n`);
  for (const line of fenced.map(digestLine).sort()) hash.update(`${line}\n`);
  return {
    observedAtMs,
    digest: hash.digest("hex").slice(0, DIGEST_LENGTH),
    beadCount: fenced.length,
  };
}

/**
 * Recorded picks the policy's age bounds have since moved past — the decision input {@link digestLine}
 * cannot carry (PR #226 review).
 *
 * A policy stating `minAgeDays`/`maxAgeDays` admits on WHOLE DAYS elapsed since a bead was filed, so
 * a pick crosses out of the policy while every hashed input sits still. The board read already drops
 * it from Up Next — that lane is derived live — but the `◈ policy` badge and the `[Release]` derived
 * from it read the recorded PLAN, and the approve route validates a release through the same fence.
 * Blind to age, the card would go on offering a start the current policy refuses, and clicking it
 * would record an accept and launch the run.
 *
 * Only the age bounds are re-judged, never the whole policy: every other criterion reads bead fields
 * the digest already covers, and a second evaluation of them here would be a second answer to a
 * question the stamp has settled.
 *
 * An entry whose bead has left the snapshot is skipped — a bead gone from the board moves the digest,
 * which is the stronger verdict and already the one that fires.
 */
export function agedOutPicks(
  plan: BoardPickerPlan,
  board: readonly Bead[],
  policy: Policy | undefined,
  nowMs: number,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (policy?.minAgeDays === undefined && policy?.maxAgeDays === undefined) return out;

  const now = new Date(nowMs);
  const byId = new Map(board.map((bead) => [bead.id, bead]));
  for (const entry of plan.entries) {
    const bead = byId.get(entry.beadId);
    if (!bead) continue;
    if (ageBoundBreached(ageInDays(bead.created_at, now), policy)) out.add(entry.beadId);
  }
  return out;
}

/**
 * Is the recorded plan still about the board as it now reads?
 *
 * Compares the snapshot, never the age: a plan computed an hour ago against a board nobody has
 * touched is still the current answer, and a plan computed a second ago against a board that has
 * since moved is not. The lane must show the second one as stale rather than present a ranking of
 * beads whose state it no longer describes.
 *
 * The operator's live vetoes are the third decision input, and the ONLY one the digest cannot carry:
 * a deferral is anton's own state with a wall-clock expiry, not a bead field, so a hold running out
 * re-admits a target while every hashed input sits still. A plan is therefore also stale once a
 * target it set aside as `deferred` is no longer held — otherwise the newly eligible bead would stay
 * out of Up Next until the next scheduled pass rewrote the plan. A veto ARRIVING needs no such fence:
 * the live derivation behind the lane subtracts held deferrals before it ranks
 * (`decideBoardPickerPlan`, step 2), which is a narrower and faster answer than withholding the
 * whole ranking.
 *
 * `declined` closes that same rule's gap when NO PASS RUNS (PR #212 review). The rule above reads the
 * exclusion a later pass wrote, so it fires only if a pass got to rewrite the plan; with the picker
 * disarmed or failing for the whole window, the vetoed target is still an ENTRY here and the plan
 * reads current again the moment its hold lapses. It would then be re-offered under the very
 * generation whose decline makes `recordPickerAccept` refuse the release's accept — a start with no
 * evidence, skewing the track record earned autonomy reads. So a decline recorded against THIS
 * generation retires it as soon as the hold it placed runs out, whether or not a pass observed the
 * veto. While the hold is live nothing changes: `decideBoardPickerPlan` step 2 still subtracts that
 * one card before the ranking ever reaches the lane.
 *
 * `agedOut` is the fourth, and the one the digest structurally cannot hold ({@link agedOutPicks}):
 * a pick the policy's age bounds have moved past. Retiring the WHOLE generation over one such entry
 * matches the deferral rule above and is the honest reading — the ranking those bounds produced is
 * not the ranking they would produce now — and the next pass rewrites it within its cadence.
 */
export function isPlanStale(
  plan: BoardPickerPlan,
  current: BoardStamp,
  deferrals?: ReadonlyMap<string, number>,
  declined?: ReadonlySet<string>,
  agedOut?: ReadonlySet<string>,
): boolean {
  if (plan.stamp.digest !== current.digest) return true;
  if (plan.entries.some((e) => agedOut?.has(e.beadId))) return true;
  const lapsed = (beadId: string) => !deferrals?.has(beadId);
  if (plan.exclusions.some((x) => x.reason === "deferred" && lapsed(x.beadId))) return true;
  return plan.entries.some((e) => declined?.has(e.beadId) && lapsed(e.beadId));
}

/**
 * Deterministic ordering for the exclusions: by bead id, then reason. Unlike the entries — whose
 * order IS the ranking's output and is preserved verbatim — exclusions have no inherent order, and
 * two passes over unchanged state must serialize byte-identically for the record to be idempotent
 * rather than merely recomputed.
 *
 * Compares by code unit, never `localeCompare` — the same reason the rank order does: a
 * locale-sensitive order is not the same order twice.
 */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortExclusions(exclusions: PickerExclusion[]): PickerExclusion[] {
  return [...exclusions].sort(
    (a, b) => byCodeUnit(a.beadId, b.beadId) || byCodeUnit(a.reason, b.reason),
  );
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

type PlanRow = typeof schema.boardPickerPlans.$inferSelect;

/** The three columns that make a plan the decision it is — what {@link restatesDecision} compares. */
interface DecidedPlan {
  boardDigest: string;
  entriesJson: string;
  exclusionsJson: string;
}

/**
 * Does the row already say exactly this? The generation is identified by the DECISION, so a pass —
 * or a board read — that re-decides the same plan is restating one, not making one.
 *
 * NOT the board digest alone, and that is the whole point (PR #212 review). The digest covers the
 * decision INPUTS — the board and the armed policy — so it is legitimately REUSABLE: a target vetoed
 * on Monday is re-admitted by a later pass over a board and a policy nobody has touched, and that
 * pass stamps a byte-identical digest. A verdict keyed to it would make the new pick inherit the old
 * decline, so the release would start the run and record no accept, quietly skewing the track record
 * earned autonomy reads. The ranking and the exclusions therefore have to match too — a veto changes
 * the exclusions, so the pass that re-admits the target after the window closes is never mistaken for
 * the one that offered it before.
 *
 * A row with no generation id at all predates the field and cannot be restated: it has no name to
 * carry over.
 */
function restatesDecision(prev: PlanRow, decided: DecidedPlan): boolean {
  return (
    prev.planId !== "" &&
    prev.boardDigest === decided.boardDigest &&
    prev.entriesJson === decided.entriesJson &&
    prev.exclusionsJson === decided.exclusionsJson
  );
}

function rowToPlan(row: PlanRow): BoardPickerPlan {
  return {
    projectId: row.projectId,
    planId: row.planId,
    ...(row.jobId ? { jobId: row.jobId } : {}),
    generatedAt: toEpoch(row.generatedAt),
    stamp: {
      observedAtMs: row.boardObservedAtMs,
      digest: row.boardDigest,
      beadCount: row.boardBeadCount,
    },
    entries: parseList<PickerPlanEntry>(row.entriesJson),
    exclusions: parseList<PickerExclusion>(row.exclusionsJson),
  };
}

/** What a writer hands this module: one project's decision, and who decided it. */
export interface BoardPickerPlanInput {
  projectId: string;
  jobId?: string;
  stamp: BoardStamp;
  entries: PickerPlanEntry[];
  exclusions: PickerExclusion[];
  /**
   * Stand down rather than replace a generation the row already holds from a STRICTLY FRESHER
   * observation of the board (anton-m4il).
   *
   * Set by the scheduled pass, which is the FALLBACK writer. It stamps its observation before a
   * board read that costs seconds, and may then spend an apply on top, so by the time it writes, an
   * operator's board read can have decided the same question from a later look and recorded it.
   * Overwriting that would retire — for a generation nobody is looking at — the one a surface is
   * offering a start against, and the accept filed against it would be refused.
   *
   * Absent for the board read, which is the PRIMARY writer: what it records is what it drew, so a
   * read that stood down would hand a surface a generation naming picks that are not on screen.
   *
   * Strictly fresher, never merely different: equal observations are not an ordering, and a pass
   * that is in fact the only writer can only ever meet a row observed earlier — a restatement
   * carries that instant forward, never back — so it goes on recording exactly as it always did.
   */
  yieldToFresher?: boolean;
}

/**
 * Write the project's plan, replacing the previous one, and return the generation that now stands.
 * One row per project by construction, so this is an upsert rather than an append — a pass that
 * admits nothing stores an empty plan, which is the signal "decided, nothing to start" and NOT
 * "never ran".
 *
 * IDEMPOTENT per DECISION, not per call (anton-f12y). The board read records the ranking it derives
 * on every read, so most calls here restate a decision that is already on the row — and rewriting it
 * would mint nothing new but move `generatedAt`, which is half the board's freshness token
 * (`provenanceVersion`). Every poll would then spend a full board read to hand back byte-identical
 * data. A restatement therefore keeps the generation id, its `generatedAt` and the writer that minted
 * it, and touches only the observation instant — and only forwards, so a slow pass carrying an older
 * snapshot cannot date the row backwards.
 *
 * A writer that decides DIFFERENTLY replaces the row — unless it asked to yield to a fresher
 * observation ({@link BoardPickerPlanInput.yieldToFresher}), which is what orders the two writers by
 * the board each of them looked at rather than by which one finished last.
 *
 * Read and write happen in ONE immediate transaction: the id is chosen by comparing against the row,
 * so two overlapping writers reading before either wrote would both mint a fresh generation and the
 * loser's would be the one a surface had already handed out. The write lock is taken up front for
 * the reason `updateProjectSettings` takes it — a deferred transaction reads first and only then
 * tries to upgrade, which is the shape that loses to SQLITE_BUSY under exactly this concurrency.
 */
export async function saveBoardPickerPlan(
  db: AntonDb,
  clock: Clock,
  input: BoardPickerPlanInput,
): Promise<BoardPickerPlan> {
  // Rank order, not array order: the ranking owns the sequence, and normalizing to the rank it
  // assigned means a caller that built the list some other way still records the queue it decided.
  const entries = [...input.entries].sort((a, b) => a.rank - b.rank);
  const exclusions = sortExclusions(input.exclusions);
  const decided: DecidedPlan = {
    boardDigest: input.stamp.digest,
    entriesJson: JSON.stringify(entries),
    exclusionsJson: JSON.stringify(exclusions),
  };
  const observedAtMs = input.stamp.observedAtMs;
  const where = eq(schema.boardPickerPlans.projectId, input.projectId);

  return db.transaction(
    (tx) => {
      const prev = tx.select().from(schema.boardPickerPlans).where(where).limit(1).get();
      // The fallback writer's one refusal (anton-m4il): a decision made from an older board never
      // replaces one made from a newer one, whichever of them reached the row first.
      if (prev && input.yieldToFresher && observedAtMs < prev.boardObservedAtMs) return rowToPlan(prev);
      if (prev && restatesDecision(prev, decided)) {
        if (observedAtMs <= prev.boardObservedAtMs) return rowToPlan(prev);
        tx.update(schema.boardPickerPlans).set({ boardObservedAtMs: observedAtMs }).where(where).run();
        return rowToPlan({ ...prev, boardObservedAtMs: observedAtMs });
      }
      const row = {
        projectId: input.projectId,
        jobId: input.jobId ?? null,
        planId: randomUUID(),
        generatedAt: secDate(clock.now()),
        boardObservedAtMs: observedAtMs,
        boardBeadCount: input.stamp.beadCount,
        targetCount: entries.length,
        ...decided,
      };
      tx
        .insert(schema.boardPickerPlans)
        .values(row)
        .onConflictDoUpdate({ target: schema.boardPickerPlans.projectId, set: row })
        .run();
      return rowToPlan(row);
    },
    { behavior: "immediate" },
  );
}

/** A corrupt blob degrades to "nothing recorded" rather than crashing the lane — `targetCount` on
 *  the row still shows the pass saw something, so the discrepancy is visible instead of silent. */
function parseList<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** The project's latest plan, or undefined when the picker has never run for it. db-injectable. */
export async function getBoardPickerPlan(
  db: AntonDb,
  projectId: string,
): Promise<BoardPickerPlan | undefined> {
  const rows = await db
    .select()
    .from(schema.boardPickerPlans)
    .where(eq(schema.boardPickerPlans.projectId, projectId))
    .limit(1);
  const row = rows[0];
  return row ? rowToPlan(row) : undefined;
}

/** UI read path over the shared anton.db. */
export function latestBoardPickerPlan(projectId: string): Promise<BoardPickerPlan | undefined> {
  return getBoardPickerPlan(getDb(), projectId);
}

/**
 * The UI WRITE path over the same database (anton-f12y): the board read records the ranking it just
 * derived, so a pick it draws is named by a generation a verdict can be filed against rather than by
 * whatever the last scheduled pass happened to write down.
 *
 * The read is the fresher writer on an active board — the pass runs every ten minutes, the operator
 * looks now — but not the only one, so the write goes through the same idempotent upsert
 * ({@link saveBoardPickerPlan}) rather than a second recording path that could disagree with it.
 */
export function recordBoardPickerPlan(input: BoardPickerPlanInput): Promise<BoardPickerPlan> {
  return saveBoardPickerPlan(getDb(), systemClock, input);
}
