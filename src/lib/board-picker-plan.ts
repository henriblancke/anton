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
 * and the only runtime dependency here is anton.db and the contract reader the stamp judges through
 * (`beads/contract.ts`, itself pure and spawn-free). `Bead` is a type-only import.
 *
 * db-injectable (like run-health) so the pass and its tests share one connection; the UI read path
 * goes through the shared anton.db.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { contractStatusOf } from "./beads/contract";
import type { Bead } from "./beads/types";
import { ageBoundBreached, ageInDays } from "./policy/age";
import { policyDigest } from "./policy/digest";
import { namespaceOf, type Policy } from "./policy/types";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * Why a candidate is not in the plan. Machine-readable rather than prose because the policy editor
 * answers "why not this one?" per bead (R2.6) and the lane groups the rest — both of which a
 * free-text sentence would force them to parse.
 *
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
  /** How many beads the digest covers. */
  beadCount: number;
}

export interface BoardPickerPlan {
  projectId: string;
  /**
   * Identity of this GENERATION of the plan — what a verdict names when it answers one of its picks
   * ({@link planIdFor}).
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
    why: "provenance for a bead anton's own automation filed; read only by the board's card projection (`ticket-view`), which no part of the decision consults",
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
 * Stamp the inputs one decision was made from — the classified ones ({@link DIGEST_FIELDS}) and no
 * others, so a `run-lease:` heartbeat rewritten mid-run leaves the ranking's fence exactly where it
 * was.
 *
 * Order-independent — the lines are sorted before hashing — because two reads of an unchanged board
 * may return the beads in any order, and a stamp that disagreed with itself over that would report
 * every plan stale.
 *
 * The armed POLICY is hashed alongside the beads (anton-t9m4 review): admission is a function of
 * both, so an operator who narrows `pickerPolicy` without touching a bead has invalidated the plan
 * just as surely as a claim would have. A fence over the beads alone would keep offering a start the
 * new policy refuses until the next pass ran. Absent means the project has armed none, which is its
 * own state and digests differently from any policy.
 */
export function stampBoard(board: Bead[], observedAtMs: number, policy?: Policy): BoardStamp {
  const hash = createHash("sha256");
  hash.update(`policy\t${policyDigest(policy)}\n`);
  for (const line of board.map(digestLine).sort()) hash.update(`${line}\n`);
  return {
    observedAtMs,
    digest: hash.digest("hex").slice(0, DIGEST_LENGTH),
    beadCount: board.length,
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

/**
 * The identity of the plan generation being saved — the name a verdict records when it answers one
 * of this plan's picks (`picker-veto.ts`).
 *
 * NOT the board digest, and that is the whole point (PR #212 review). The digest covers the decision
 * INPUTS — the board and the armed policy — so it is legitimately REUSABLE: a target vetoed on
 * Monday is re-admitted by a later pass over a board and a policy nobody has touched, and that pass
 * stamps a byte-identical digest. A verdict keyed to it would make the new pick inherit the old
 * decline, so the release would start the run and record no accept, quietly skewing the track record
 * earned autonomy reads.
 *
 * Carried over when the pass re-decides the SAME plan, though — the digest, the ranking and the
 * exclusions all unchanged. The accept and the veto are written by two routes that each read the
 * plan for themselves, and a fresh id on every ten-minute no-op tick would let a rerun landing
 * between those two reads hand them different names for one pick, which is exactly the collision
 * `pickAlreadyAnswered` exists to catch. A veto changes the exclusions, so the pass that re-admits
 * the target after the window closes is never mistaken for the one that offered it before.
 */
async function planIdFor(
  db: AntonDb,
  projectId: string,
  decided: { boardDigest: string; entriesJson: string; exclusionsJson: string },
): Promise<string> {
  const [prev] = await db
    .select({
      planId: schema.boardPickerPlans.planId,
      boardDigest: schema.boardPickerPlans.boardDigest,
      entriesJson: schema.boardPickerPlans.entriesJson,
      exclusionsJson: schema.boardPickerPlans.exclusionsJson,
    })
    .from(schema.boardPickerPlans)
    .where(eq(schema.boardPickerPlans.projectId, projectId))
    .limit(1);
  const unchanged =
    prev !== undefined &&
    prev.planId !== "" &&
    prev.boardDigest === decided.boardDigest &&
    prev.entriesJson === decided.entriesJson &&
    prev.exclusionsJson === decided.exclusionsJson;
  return unchanged ? prev.planId : randomUUID();
}

/**
 * Write the project's plan, replacing the previous one. One row per project by construction, so
 * this is an upsert rather than an append — a pass that admits nothing stores an empty plan, which
 * is the signal "decided, nothing to start" and NOT "never ran".
 */
export async function saveBoardPickerPlan(
  db: AntonDb,
  clock: Clock,
  input: {
    projectId: string;
    jobId?: string;
    stamp: BoardStamp;
    entries: PickerPlanEntry[];
    exclusions: PickerExclusion[];
  },
): Promise<void> {
  // Rank order, not array order: the ranking owns the sequence, and normalizing to the rank it
  // assigned means a caller that built the list some other way still records the queue it decided.
  const entries = [...input.entries].sort((a, b) => a.rank - b.rank);
  const exclusions = sortExclusions(input.exclusions);
  const decided = {
    boardDigest: input.stamp.digest,
    entriesJson: JSON.stringify(entries),
    exclusionsJson: JSON.stringify(exclusions),
  };
  const row = {
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    planId: await planIdFor(db, input.projectId, decided),
    generatedAt: secDate(clock.now()),
    boardObservedAtMs: input.stamp.observedAtMs,
    boardBeadCount: input.stamp.beadCount,
    targetCount: entries.length,
    ...decided,
  };
  await db
    .insert(schema.boardPickerPlans)
    .values(row)
    .onConflictDoUpdate({ target: schema.boardPickerPlans.projectId, set: row });
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
  if (!row) return undefined;
  return {
    projectId: row.projectId,
    planId: row.planId,
    jobId: row.jobId ?? undefined,
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

/** UI read path over the shared anton.db. */
export function latestBoardPickerPlan(projectId: string): Promise<BoardPickerPlan | undefined> {
  return getBoardPickerPlan(getDb(), projectId);
}
