/**
 * What a PROPOSAL DETECTION is (anton-02oc): one evidenced claim that something about the board is
 * wrong, carrying everything a proposal bead needs and nothing it doesn't.
 *
 * TWO PRODUCERS share this module, and the sharing is the point. The gardener (anton-e42l) detects
 * STRUCTURAL hygiene — work that rides no card, an ordering no edge records, work reality has moved
 * past — in code, from a board snapshot. The product master (anton-d2sx) exercises PRODUCT judgment
 * — what matters next, what is too big, what should die — in an LLM session, and its claims arrive
 * as a report anton turns into detections here. Both then travel the identical path: fingerprint
 * dedup (anton-9qwq), evidence and `discovered-from` provenance on the bead, apply-on-approve
 * (anton-1t3n), decline-as-abandon. One machinery, two namespaces — `gardener:` and `pm:` — so a
 * reader, a re-run, and the approve route each have exactly one convention to know.
 *
 * The split from the hygiene report (src/lib/hygiene.ts) is deliberate. A hygiene FINDING is bd's
 * own verdict on one bead — bd owns lint/stale/orphans/duplicates and the patrol never re-derives
 * them. A DETECTION is anton's judgment: about how beads relate, or about what they are worth. bd
 * has no verb for any of it, because they are questions about anton's own tier and product model.
 *
 * Detections are pure VALUES: nothing here reads a repo or writes a bead. Emission is anton-9qwq's
 * job and application anton-1t3n's — a detector that could apply itself would make the approval gate
 * (the whole point of the feature) optional.
 */
import { createHash } from "node:crypto";

/**
 * Which producer filed a proposal. It is the fingerprint's label prefix, the `source:` label, and
 * the word the bead's prose introduces itself with — so a founder reading a proposal knows whether a
 * mechanical patrol or a judgment pass raised it, and `/scan-triage` can dedup across both
 * (board-context.ts `PRODUCER_NAMESPACES`).
 */
export type ProposalNamespace = "gardener" | "pm";

export const PROPOSAL_NAMESPACES: readonly ProposalNamespace[] = ["gardener", "pm"];

/**
 * The apply verb class a detection would resolve to if approved (anton-1t3n). Carried on the
 * detection rather than inferred later from `kind`, so a new kind must state which move it wants
 * instead of silently falling into someone's default branch.
 *
 * `split` is the one move anton deliberately CANNOT run: decomposing a ticket means writing new
 * contracts, which is `/shape`'s job and a human's call. It is a move all the same, because the ask
 * still belongs on the board with evidence and a fingerprint — approving it is refused, and
 * declining is what settles it (the same shape as a targetless re-parent; see `isManualProposal`).
 *
 * `approve` is the only move that STARTS work rather than tidying the board (anton-1ivg). Every other
 * verb re-shapes, parks or retires something; this one grants the founder's own gate, and what
 * follows it is a run that spends tokens and opens a PR. Taking the label back does not un-run that,
 * which is why it is priced at the dearest earned-autonomy tier (autonomy.ts `autonomyTierOf`).
 */
export type GardenerMove =
  | "reparent"
  | "link"
  | "retire"
  | "reprioritize"
  | "split"
  | "unapprove"
  | "approve";

/**
 * The claims the two producers know how to name.
 *
 * The gardener's — board SHAPE, detected mechanically:
 *   • `container-orphan`    — a working-layer bead whose parent is a CONTAINER epic, so no board
 *                             card carries it and no run will ever ship it (the anton-do0q class).
 *   • `parentless-cluster`  — parentless working-layer beads that share one obvious card home.
 *   • `implied-order`       — two run targets whose bodies state an ordering the graph has no
 *                             `blocks` edge for.
 *   • `superseded`          — an open bead whose identical twin already landed.
 *   • `stale`               — untouched far past the report threshold for its status.
 *   • `shipped-orphan`      — a commit shipped it, the board never closed it.
 *
 * The product master's — PRODUCT judgment, reported by a fresh-context session (anton-d2sx):
 *   • `mispriority`         — the bead's priority contradicts what the board says it is worth.
 *   • `missing-order`       — one top-tier bead has to land before another and no edge says so.
 *   • `misfiled`            — a bead hangs under the wrong home: a feature under the wrong epic, or a
 *                             ticket under the wrong card. ONE kind for both, because it is one claim
 *                             about one relation — and the gardener's re-parents cannot see it, since
 *                             both of theirs fire on work riding NO card, never on a home that is
 *                             merely wrong. Which home is right is a reading of what two beads are
 *                             about, so it is judgment rather than topology.
 *   • `oversized`           — one ticket carries several concerns, with a decomposition sketch.
 *   • `low-value`           — work whose value the evidence no longer supports: kill it.
 *   • `degraded-approval`   — approved work that has since stopped clearing the approve gate. The one
 *                             pm kind that is DETERMINISTIC rather than judged: it re-runs the gate's
 *                             own validator over the pass's board snapshot (anton-xg5y), so it costs
 *                             no session and never depends on one.
 *   • `withheld-approval`   — the board's best next work carries no approval, so nothing will ever
 *                             pick it up: grant the gate and let a run start. The mirror of
 *                             `degraded-approval` and the only kind whose move STARTS work — until
 *                             this one, the judgment tier could withdraw a founder's approval but
 *                             never grant one.
 */
export type GardenerDetectionKind =
  | "container-orphan"
  | "parentless-cluster"
  | "implied-order"
  | "superseded"
  | "stale"
  | "shipped-orphan"
  | "mispriority"
  | "missing-order"
  | "misfiled"
  | "oversized"
  | "low-value"
  | "degraded-approval"
  | "withheld-approval";

export const GARDENER_DETECTION_KINDS: readonly GardenerDetectionKind[] = [
  "container-orphan",
  "parentless-cluster",
  "implied-order",
  "superseded",
  "stale",
  "shipped-orphan",
  "mispriority",
  "missing-order",
  "misfiled",
  "oversized",
  "low-value",
  "degraded-approval",
  "withheld-approval",
];

/**
 * Which retirement bd actually performs — the three verbs the feature's Acceptance names. They are
 * not interchangeable: `close` records work that LANDED, `supersede` points at the bead that
 * replaced it, `defer` parks work still wanted but not now. Retiring an abandoned run with `close`
 * would read as shipped (see LABELS.abandoned in beads/bd.ts), which is the one lie a retirement
 * proposal must not tell.
 */
export type RetireVerb = "close" | "supersede" | "defer";

/**
 * The shape of the one PARAMETER a move can take that is not a bead id — carried in
 * {@link GardenerDetection.detail} and validated against this pattern at both ends.
 *
 * Only `reprioritize` needs one today: "which priority" is neither a subject nor a target, and it is
 * the whole content of the ask. It is part of the fingerprinted identity (see
 * {@link detectionSubjectKey}) precisely because it decides what gets written — without that, a
 * hand-edited bead could keep its label and its hash while swapping P3 for P0.
 */
export type DetailShape = "priority";

const DETAIL_PATTERN: Record<DetailShape, RegExp> = { priority: /^P[0-4]$/ };

/**
 * What a kind's fingerprint stands for — which fields are the CLAIM and which are only how it is
 * carried out. Absent (the default) means the subject list is the claim: "retire this bead", "order
 * this pair", "move this bead there" are each about the beads they name, so two subject sets are two
 * asks and both belong on the board.
 *
 * `target` is the exception a MEMBERSHIP-derived kind needs. A `parentless-cluster` asks one question
 * — "the loose work orbiting this card belongs under it" — and its subject list is whatever was
 * parentless and free at patrol time, so it changes whenever a member is claimed, closed, or joined
 * by a new loose bead. Hashing that list gave every patrol a fresh fingerprint for the same claim and
 * made suppression vacuous: four proposals naming anton-5ahy stood open at once (anton-9hpp). Kind
 * plus target is the identity that holds still.
 */
export type ClaimIdentity = "target";

/** What one detection kind IS: who files it, what it applies as, and what parameter it carries. */
export interface KindSpec {
  namespace: ProposalNamespace;
  move: GardenerMove;
  retireAs?: RetireVerb;
  /** Set exactly when the move takes a non-bead parameter; absent means `detail` is forbidden. */
  detail?: DetailShape;
  /** Set when the subject list is not the claim's identity — see {@link ClaimIdentity}. */
  identity?: ClaimIdentity;
}

/**
 * The one move each kind resolves to, and the producer it belongs to. A detection still STATES its
 * move (see {@link GardenerMove}) — this is the table that says the statement was true, and it is
 * the only thing binding `move` and `retireAs` to a proposal's identity: the fingerprint hashes what
 * the claim is ABOUT (kind, subjects, target, detail), so without a canonical pairing a hand-edited
 * bead could keep its label and its hash while swapping a `stale` defer for a close. Every kind is
 * listed, so adding one without deciding its verb is a type error rather than a silent default.
 *
 * The product master's kills DEFER rather than close. `close` records work that LANDED and `abandon`
 * is the human's recorded won't-do (and the verb that DECLINES a proposal), so neither is honest for
 * a judgment pass: deferring takes the bead out of the ready set and off the roadmap with its
 * contract intact, and `bd undefer` puts it back. A permanent won't-do stays a human's act — which
 * is the right bar for a kill an LLM proposed.
 */
export const KINDS: Record<GardenerDetectionKind, KindSpec> = {
  "container-orphan": { namespace: "gardener", move: "reparent" },
  "parentless-cluster": { namespace: "gardener", move: "reparent", identity: "target" },
  "implied-order": { namespace: "gardener", move: "link" },
  superseded: { namespace: "gardener", move: "retire", retireAs: "supersede" },
  stale: { namespace: "gardener", move: "retire", retireAs: "defer" },
  "shipped-orphan": { namespace: "gardener", move: "retire", retireAs: "close" },
  mispriority: { namespace: "pm", move: "reprioritize", detail: "priority" },
  "missing-order": { namespace: "pm", move: "link" },
  misfiled: { namespace: "pm", move: "reparent" },
  oversized: { namespace: "pm", move: "split" },
  "low-value": { namespace: "pm", move: "retire", retireAs: "defer" },
  "degraded-approval": { namespace: "pm", move: "unapprove" },
  "withheld-approval": { namespace: "pm", move: "approve" },
};

/** Which producer files this kind — the fingerprint's prefix and the proposal's `source:` label. */
export function namespaceOf(kind: GardenerDetectionKind): ProposalNamespace {
  return KINDS[kind].namespace;
}

/**
 * Does this proposal name a move anton can RUN, or only a question a human can answer?
 *
 * Two shapes reach here. A `split` never has a mechanical answer — decomposing a ticket writes new
 * contracts, which is `/shape`'s work. A container orphan with no single open feature home files
 * WITHOUT a target on purpose (see reparent.ts): the ask is real, but the answer is a choice.
 *
 * Both are filed anyway, because the ASK belongs on the board with its evidence and its fingerprint;
 * what changes is how it settles. Approve refuses, and DECLINING is what records the answer — which
 * both the proposal's own prose (emit.ts) and the apply's refusal have to say out loud, or a card
 * that reads "approving applies the move" while Approve always refuses is worse than the bead it is
 * about.
 */
export function isManualProposal(plan: { move: GardenerMove; target?: string }): boolean {
  return plan.move === "split" || (plan.move === "reparent" && !plan.target);
}

/**
 * The bd priority a `reprioritize` plan asks for, or undefined when it carries none. Parsed rather
 * than stored as a number so the wire form stays the `P<n>` an operator reads on the bead, and so a
 * detail that is not a priority at all can never be coerced into one.
 */
export function priorityOf(plan: { move: GardenerMove; detail?: string }): number | undefined {
  if (plan.move !== "reprioritize" || !plan.detail) return undefined;
  return DETAIL_PATTERN.priority.test(plan.detail) ? Number(plan.detail.slice(1)) : undefined;
}

export interface GardenerDetection {
  kind: GardenerDetectionKind;
  move: GardenerMove;
  /**
   * Stable dedup key, label-safe: `<namespace>:<kind>:<hash of subjectKey>`. Hashed rather than
   * spelled out because a subject key spells out ids and grows past what belongs in a bd label.
   * Mirrors the `stringer:<collector>:<hash>` fingerprint /scan-triage already tags with, so the
   * board has one convention for "this proposal was already made" (anton-9qwq).
   */
  fingerprint: string;
  /** The readable key the fingerprint hashes — kept for debugging and for tests to assert against. */
  subjectKey: string;
  /** The beads the move would act ON, sorted. Several only for a cluster; one for everything else. */
  subjects: string[];
  /** The bead the move points AT: the new parent, the blocker to add, the bead that superseded. */
  target?: string;
  /** Set exactly when `move` is `retire` — which of bd's three retirement verbs this asks for. */
  retireAs?: RetireVerb;
  /**
   * The move's non-bead parameter, set exactly when its kind declares a {@link DetailShape} — today
   * a `reprioritize`'s target priority, as `P0`…`P4`. Part of the fingerprinted identity: two
   * priorities for one bead are two different asks, and collapsing them would let the first one
   * approved suppress the second forever.
   */
  detail?: string;
  /**
   * Binds the subject list for a kind whose fingerprint no longer does — set exactly when the kind
   * declares a {@link ClaimIdentity}, absent everywhere else. Two records of one claim, deliberately
   * kept apart: the fingerprint is the SUPPRESSION identity (one open ask per target, whatever
   * membership the patrol found), this is the INTEGRITY one (these subjects, as emitted).
   *
   * Without it a target-identified plan's membership is unguarded, and the grouping evidence apply
   * re-derives can be manufactured by editing it — naming a ticket the home already carries makes it
   * an in-place member, so a single loose bead clears the cluster's two-member bar and lands under a
   * home no fresh patrol would propose for it.
   */
  subjectChecksum?: string;
  /** One line: what is wrong and what the move would do. The proposal's title material. */
  summary: string;
  /**
   * The facts behind the claim, one per line, each naming the ids it rests on. A proposal without
   * evidence is an assertion — an approver has to be able to check the reasoning without re-deriving
   * it from the board.
   */
  evidence: string[];
}

/** How much of the digest the fingerprint carries — collision-safe at board scale, label-short. */
const FINGERPRINT_HASH_LENGTH = 12;

export interface DetectionInput {
  kind: GardenerDetectionKind;
  move: GardenerMove;
  subjects: string[];
  target?: string;
  retireAs?: RetireVerb;
  detail?: string;
  summary: string;
  evidence: string[];
}

/**
 * Build a detection, deriving its identity from what it is ABOUT rather than from when it was found.
 * Subjects are sorted first, so two patrols that walk the board in different orders fingerprint the
 * same cluster identically.
 *
 * The `target` is part of the identity on purpose: "move these three under feature A" and "move them
 * under feature B" are different proposals, and a fingerprint that collapsed them would let the
 * first one approved suppress the second forever.
 */
export function makeDetection(input: DetectionInput): GardenerDetection {
  const canonical = KINDS[input.kind];
  if (canonical.move !== input.move || canonical.retireAs !== input.retireAs) {
    // Fail loud at emission rather than filing a bead nobody can approve: apply reads the plan back
    // against this same table, so a detector that drifts from it would put proposals on the board
    // that refuse forever as "no readable move".
    throw new Error(
      `${input.kind} is a ${canonical.move}${canonical.retireAs ? `/${canonical.retireAs}` : ""} detection, not ${input.move}${input.retireAs ? `/${input.retireAs}` : ""}`,
    );
  }
  const detailError = detailViolation(input.kind, input.detail);
  if (detailError) throw new Error(detailError);
  // Deduped as well as sorted, so a detection's subject list is a SET: one bead named twice is one
  // member, and the kind whose identity no longer covers that list (see {@link ClaimIdentity}) would
  // otherwise let the repeat count twice towards MIN_CLUSTER_SIZE. Canonical here, required on read
  // ({@link parseGardenerPlan}).
  const subjects = [...new Set(input.subjects)].sort();
  const subjectKey = detectionSubjectKey(input.kind, subjects, input.target, input.detail);
  const checksum = subjectChecksum(input.kind, subjects, input.target, input.detail);
  return {
    kind: input.kind,
    move: input.move,
    fingerprint: proposalFingerprint(input.kind, subjectKey),
    subjectKey,
    subjects,
    ...(input.target ? { target: input.target } : {}),
    ...(input.retireAs ? { retireAs: input.retireAs } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(checksum ? { subjectChecksum: checksum } : {}),
    summary: input.summary,
    evidence: input.evidence,
  };
}

/**
 * Why this kind cannot carry this `detail`, or undefined when the pair is legal. Required exactly
 * where {@link KINDS} declares a shape and forbidden everywhere else — the same all-or-nothing
 * invariant `retireAs` holds, and for the same reason: a move whose parameter is missing has no safe
 * default, and one carrying a parameter nothing reads is a plan whose identity says more than its
 * execution does.
 */
function detailViolation(kind: GardenerDetectionKind, detail: string | undefined): string | undefined {
  const shape = KINDS[kind].detail;
  if (!shape) {
    return detail === undefined ? undefined : `${kind} takes no detail, but "${detail}" was given`;
  }
  if (detail === undefined) return `${kind} requires a ${shape} detail`;
  return DETAIL_PATTERN[shape].test(detail)
    ? undefined
    : `"${detail}" is not a ${shape} (expected ${DETAIL_PATTERN[shape]})`;
}

/**
 * The stand-in a {@link ClaimIdentity} of `target` puts where the subject list would go. Not a legal
 * bead id, so it can never collide with a kind whose subjects ARE its identity.
 */
const ANY_SUBJECTS = "*";

/**
 * What a detection is ABOUT, as one readable string: the kind, its subjects (sorted, so two patrols
 * that walk the board in different orders agree), whatever it points at, and the move's parameter
 * when it takes one. The identity the fingerprint hashes — and the thing apply RECOMPUTES from a
 * proposal's own fields, so a bead whose subjects, target or detail were edited after emission no
 * longer matches its label.
 *
 * …except where the KIND says the subjects are not the claim ({@link ClaimIdentity}), which today is
 * `parentless-cluster` alone: its subject list is a membership the next patrol re-derives, so it
 * hashes as {@link ANY_SUBJECTS} and one open proposal per target answers for every membership.
 *
 * What that kind gives up here it gets back from a second record: the subjects it was filed with are
 * bound by {@link subjectChecksum}, so suppression can stay target-shaped while a membership edit
 * still invalidates the plan. Apply re-derives the "no board card carries this" premise for each
 * subject from the fresh board besides (apply-plan.ts `reparentPremiseGone`), because a list that is
 * intact is not the same as a list that is still true.
 */
export function detectionSubjectKey(
  kind: GardenerDetectionKind,
  subjects: string[],
  target?: string,
  detail?: string,
): string {
  const about =
    KINDS[kind].identity === "target" && target ? ANY_SUBJECTS : [...subjects].sort().join("+");
  return subjectKey(kind, about, target, detail);
}

/** The readable identity itself, once the caller has decided what the claim is ABOUT. */
const subjectKey = (
  kind: GardenerDetectionKind,
  about: string,
  target?: string,
  detail?: string,
): string => `${kind}:${about}` + (target ? `>${target}` : "") + (detail ? `#${detail}` : "");

/**
 * The membership spelled out: the same key {@link detectionSubjectKey} builds for every kind whose
 * subjects ARE its claim. Two readers need it for a kind whose subjects are not — {@link
 * subjectChecksum}, which binds the list the fingerprint stopped covering, and the legacy identity a
 * proposal filed before the claim moved to its target still carries ({@link identityForm}).
 */
const membershipKey = (
  kind: GardenerDetectionKind,
  subjects: string[],
  target?: string,
  detail?: string,
): string => subjectKey(kind, [...subjects].sort().join("+"), target, detail);

/**
 * The checksum a target-identified kind carries so its subject list stays guarded — see
 * {@link GardenerDetection.subjectChecksum}. Undefined for every other kind: their fingerprint
 * already hashes the membership, and a second record of it would be a field nothing reads.
 */
export function subjectChecksum(
  kind: GardenerDetectionKind,
  subjects: string[],
  target?: string,
  detail?: string,
): string | undefined {
  if (KINDS[kind].identity === undefined) return undefined;
  return hashKey(membershipKey(kind, subjects, target, detail));
}

/** Which record of its claim a proposal's fingerprint is, or undefined when it is neither. */
type IdentityForm = "canonical" | "legacy";

/**
 * Does this fingerprint stand for exactly these fields — the canonical identity, or the membership
 * hash a proposal carries that was filed before its kind's claim moved to the target?
 *
 * The older form is accepted ON READ ALONE, and only for the kind whose identity actually moved.
 * Without it the rollout strands every open `parentless-cluster`: it would parse as "no readable
 * move" and refuse forever, while the next patrol filed a fresh-format duplicate beside it — the
 * exact state target-identity exists to remove. Emission only ever writes the canonical form, and
 * suppression folds a legacy proposal onto it (`canonicalFingerprintOf`), so no duplicate is filed.
 *
 * Which form matched decides how hard {@link readGardenerPlan} presses on the subject checksum: a
 * legacy fingerprint hashes the membership itself, so it needs no second record of it.
 */
function identityForm(
  kind: GardenerDetectionKind,
  subjects: string[],
  target: string | undefined,
  detail: string | undefined,
  fingerprint: string,
): IdentityForm | undefined {
  const canonical = proposalFingerprint(kind, detectionSubjectKey(kind, subjects, target, detail));
  if (canonical === fingerprint) return "canonical";
  if (KINDS[kind].identity === undefined) return undefined;
  const legacy = proposalFingerprint(kind, membershipKey(kind, subjects, target, detail));
  return legacy === fingerprint ? "legacy" : undefined;
}

/**
 * `<namespace>:<kind>:<hash>` — the label a proposal bead carries so a re-run recognises its own
 * work. The namespace comes from the KIND rather than from the caller, so the gardener cannot file
 * under `pm:` (or the reverse) even by mistake, and the two producers can never collide on a hash.
 */
export function proposalFingerprint(kind: GardenerDetectionKind, subjectKey: string): string {
  return `${namespaceOf(kind)}:${kind}:${hashKey(subjectKey)}`;
}

/** The digest both records of a claim are cut from — collision-safe at board scale, label-short. */
const hashKey = (key: string): string =>
  createHash("sha1").update(key).digest("hex").slice(0, FINGERPRINT_HASH_LENGTH);

/** A fingerprint label's exact shape, so an unrelated `pm:`-ish label is never mistaken for one. */
const FINGERPRINT_LABEL = new RegExp(
  `^(?:${PROPOSAL_NAMESPACES.join("|")}):[a-z-]+:[0-9a-f]{${FINGERPRINT_HASH_LENGTH}}$`,
);

/**
 * The `gardener:<kind>:<hash>` label a bead carries, if any. Structurally typed rather than taking a
 * `Bead`, so this module stays free of the bd seam — a fingerprint is a fact about labels.
 */
export function fingerprintLabelOf(bead: { labels?: string[] }): string | undefined {
  return (bead.labels ?? []).find((l) => FINGERPRINT_LABEL.test(l));
}

/**
 * The kind a fingerprint label names, or undefined when it names none anton knows.
 *
 * The label is the one record of a proposal's kind that survives everything: a hand-edited metadata
 * blob, a plan from an older anton, a bead whose description someone rewrote. That is why the
 * settled-proposal record reads the kind from HERE rather than from the plan (track-record.ts) — the
 * record is a count of what the founder decided, and a proposal whose metadata rotted was still
 * decided about.
 */
export function kindOfFingerprint(label: string): GardenerDetectionKind | undefined {
  if (!FINGERPRINT_LABEL.test(label)) return undefined;
  const kind = label.split(":")[1] as GardenerDetectionKind;
  return GARDENER_DETECTION_KINDS.includes(kind) ? kind : undefined;
}

/**
 * Is this bead one of the gardener's own proposals (anton-9qwq)? Both tiers need the question and
 * for opposite reasons: emission asks it to dedup, and detection asks it to EXCLUDE — a proposal is
 * a bead about the board, not part of its shape, so left in the snapshot every parentless proposal
 * would read as a cluster candidate and every forgotten one as a retirement candidate.
 */
export function isProposalBead(bead: { labels?: string[] }): boolean {
  return fingerprintLabelOf(bead) !== undefined;
}

/**
 * The metadata key a proposal bead carries its move under (anton-1t3n). A proposal's prose is for
 * the human deciding; THIS is what the apply step reads — the move as data, written in the same
 * `bd create` as the bead itself, so approving one never depends on parsing a description a person
 * is free to edit.
 *
 * ONE key for both producers, despite the name it was born with: apply has a single reader, and a
 * per-namespace key would fork it into two that must never disagree. The plan's own `kind` already
 * says which producer filed it ({@link namespaceOf}).
 */
export const GARDENER_PLAN_KEY = "gardener";

/**
 * The metadata key a proposal carries the moment its EVIDENCE describes: the board snapshot the
 * detection ran against, as an ISO stamp.
 *
 * Not the same instant as the bead's own `created_at`, and the gap matters. One pass reads the board
 * ONCE and then files up to ten proposals through sequential bd writes, so a subject edited after
 * that read — especially before a later proposal in the loop is created — is a change the detection
 * never saw. Every "has this moved since we asked" check in apply.ts dates against this stamp for
 * that reason; `created_at` would read such an edit as already-observed and let a retirement settle
 * a bead written out from under its own evidence.
 */
export const GARDENER_OBSERVED_AT_KEY = "gardenerObservedAt";

/**
 * The move a proposal would apply, stripped of everything only a reader needs (summary, evidence).
 * Exactly the fields the executors branch on — anything else would be state the board and the plan
 * could disagree about.
 */
export interface GardenerPlan {
  kind: GardenerDetectionKind;
  move: GardenerMove;
  fingerprint: string;
  subjects: string[];
  target?: string;
  retireAs?: RetireVerb;
  /** The move's non-bead parameter — see {@link GardenerDetection.detail}. */
  detail?: string;
  /** The subject list's own guard — see {@link GardenerDetection.subjectChecksum}. */
  subjectChecksum?: string;
}

/** The plan half of a detection — what rides on the proposal bead as metadata. */
export function planOf(detection: GardenerDetection): GardenerPlan {
  return {
    kind: detection.kind,
    move: detection.move,
    fingerprint: detection.fingerprint,
    subjects: detection.subjects,
    ...(detection.target ? { target: detection.target } : {}),
    ...(detection.retireAs ? { retireAs: detection.retireAs } : {}),
    ...(detection.detail ? { detail: detection.detail } : {}),
    ...(detection.subjectChecksum ? { subjectChecksum: detection.subjectChecksum } : {}),
  };
}

const GARDENER_MOVES: readonly GardenerMove[] = [
  "reparent",
  "link",
  "retire",
  "reprioritize",
  "split",
  "unapprove",
  "approve",
];
const RETIRE_VERBS: readonly RetireVerb[] = ["close", "supersede", "defer"];

/**
 * Why a wire plan was refused, naming the FIELD that failed. One reason per plan — the first rule
 * that catches it — because the point is to tell a reader which field to look at, not to grade a
 * metadata blob a human is free to edit.
 */
export interface PlanRejection {
  field: PlanField;
  reason: string;
}

/** What was on the bead: the plan, or why what is there is not one. */
export type PlanRead = { plan: GardenerPlan } | { rejected: PlanRejection };

/** The stand-in for the value AS A WHOLE — what a blob that is not plan-shaped at all is refused as. */
const PLAN_ROOT = "(plan)";

type PlanField = keyof GardenerPlan | typeof PLAN_ROOT;

/**
 * What one field must look like ON ITS OWN, before any rule that reads two fields together. Stated
 * as a row per field rather than as a guard in a chain, so adding a field to {@link GardenerPlan} is
 * a row here — and a missing row is a type error rather than a field nothing validates.
 */
interface FieldSpec {
  /** Every plan carries it. Presence that DEPENDS on another field is a rule, not a spec. */
  required?: boolean;
  /** What a legal value is, in the words the rejection reports. */
  shape: string;
  ok: (value: unknown) => boolean;
}

/**
 * The table itself, with requiredness DERIVED from each field's own declared type rather than left
 * to the row to remember: a property {@link GardenerPlan} declares non-optional must say
 * `required: true`, and one it declares optional must not. That is what makes a field added to the
 * plan a type error twice over — once for the missing row, once for a row that would let the read
 * skip a value the plan says is always there.
 */
type PlanFieldSpecs = {
  [K in keyof GardenerPlan]-?: undefined extends GardenerPlan[K]
    ? FieldSpec & { required?: false }
    : FieldSpec & { required: true };
};

/** A bead id, or any other string a plan carries that must not be empty. */
const isId = (value: unknown): boolean => typeof value === "string" && value.length > 0;

const PLAN_FIELDS = {
  kind: {
    required: true,
    shape: "a kind some detector emits",
    ok: (v) => isId(v) && GARDENER_DETECTION_KINDS.includes(v as GardenerDetectionKind),
  },
  move: {
    required: true,
    shape: "a move anton has an executor for",
    ok: (v) => isId(v) && GARDENER_MOVES.includes(v as GardenerMove),
  },
  fingerprint: {
    required: true,
    shape: "a <namespace>:<kind>:<hash> label",
    ok: (v) => typeof v === "string" && FINGERPRINT_LABEL.test(v),
  },
  subjects: {
    required: true,
    shape: "a non-empty list of bead ids",
    ok: (v) => Array.isArray(v) && v.length > 0 && v.every(isId),
  },
  target: { shape: "a bead id", ok: isId },
  retireAs: {
    shape: `one of ${RETIRE_VERBS.join("/")}`,
    ok: (v) => isId(v) && RETIRE_VERBS.includes(v as RetireVerb),
  },
  detail: { shape: "a non-empty parameter", ok: isId },
  subjectChecksum: { shape: "a digest", ok: (v) => typeof v === "string" },
} satisfies PlanFieldSpecs;

const PLAN_FIELD_NAMES = Object.keys(PLAN_FIELDS) as (keyof GardenerPlan)[];

/**
 * A rule that reads the plan as a WHOLE: presence that depends on the move, and the kind→verb
 * pairing. Ordered, and the first violation is the one reported — so each rule may assume the ones
 * above it held.
 */
interface PlanRule {
  field: keyof GardenerPlan;
  violation: (plan: GardenerPlan) => string | undefined;
}

const PLAN_RULES: readonly PlanRule[] = [
  {
    // A subject list is a SET, and emission writes it as one ({@link makeDetection}) — so a repeat is
    // an edit, and for the kind whose identity is its target the fingerprint no longer catches it.
    // Left standing, one bead listed twice counts twice towards MIN_CLUSTER_SIZE and a single bead
    // already under the home settles as an applied cluster no detector would derive.
    field: "subjects",
    violation: (plan) =>
      new Set(plan.subjects).size === plan.subjects.length ? undefined : "names a bead twice",
  },
  {
    field: "move",
    violation: (plan) =>
      KINDS[plan.kind].move === plan.move
        ? undefined
        : `${plan.kind} is a ${KINDS[plan.kind].move}, not a ${plan.move}`,
  },
  { field: "retireAs", violation: retireViolation },
  { field: "detail", violation: (plan) => detailViolation(plan.kind, plan.detail) },
];

/** What a fingerprint that stands for none of the fields filed with it is refused as. */
const FINGERPRINT_UNBOUND = "does not hash the kind, subjects, target and detail filed with it";

/**
 * A rule that reads the plan AGAINST THE IDENTITY its fingerprint turned out to be — so it runs only
 * once the fingerprint held, and takes that {@link IdentityForm} rather than "maybe one". The
 * ordering the fingerprint rule used to impose by sitting above these in one list is a type here: a
 * rule that needs the form cannot be written into {@link PLAN_RULES}, which has none to give.
 */
interface IdentityRule {
  field: keyof GardenerPlan;
  violation: (plan: GardenerPlan, form: IdentityForm) => string | undefined;
}

const IDENTITY_RULES: readonly IdentityRule[] = [
  { field: "subjectChecksum", violation: checksumViolation },
];

/**
 * Read a plan back off a bead's metadata, or say which field refused it. Validated against
 * {@link PLAN_FIELDS}, {@link PLAN_RULES} and {@link IDENTITY_RULES} rather than cast: this value
 * decides which beads get MUTATED, so anything the emitter did not write — a hand-edited metadata blob, a plan from a future
 * anton that added a move — must read as "no readable plan" and stop the apply, not fall through to
 * a default branch.
 *
 * The reason is what the field spec buys over the guard chain it replaced: a refusal used to be a
 * bare `undefined`, so a proposal that would not apply gave no account of WHICH field had rotted.
 *
 * `retireAs` is required exactly when the move is `retire` and forbidden otherwise, which is the
 * same invariant {@link GardenerDetection} documents; a retire with no verb has no safe default.
 *
 * Four rules bind the plan to the ONE claim its fingerprint stands for, so an approver cannot read
 * one ask and have another execute:
 *   • the fingerprint is RECOMPUTED from the parsed kind/subjects/target and must match the field
 *     carried alongside them — editing the subjects or the target of a proposal now invalidates it
 *     rather than silently redirecting the move (for the one kind whose subjects are not its
 *     identity, the target still is — see {@link ClaimIdentity});
 *   • the {@link subjectChecksum} is recomputed too, which is what re-binds the subject list for
 *     exactly that kind ({@link checksumViolation});
 *   • the move and retirement verb must be the ones {@link KINDS} pairs with the kind, which is what
 *     covers the two fields the hash can't (a `stale` bead reads as a defer, so it must not execute
 *     a close);
 *   • the subjects must be DISTINCT — a bead named twice is not two members of anything, and no
 *     hash of a sorted set catches it.
 */
export function readGardenerPlan(value: unknown): PlanRead {
  const raw = planObject(value);
  if (!raw) return { rejected: { field: PLAN_ROOT, reason: "is not an object" } };
  const read = readPlanFields(raw);
  if ("rejected" in read) return read;

  for (const rule of PLAN_RULES) {
    const reason = rule.violation(read.plan);
    if (reason) return { rejected: { field: rule.field, reason } };
  }

  const { kind, subjects, target, detail, fingerprint } = read.plan;
  const form = identityForm(kind, subjects, target, detail, fingerprint);
  if (!form) return { rejected: { field: "fingerprint", reason: FINGERPRINT_UNBOUND } };
  for (const rule of IDENTITY_RULES) {
    const reason = rule.violation(read.plan, form);
    if (reason) return { rejected: { field: rule.field, reason } };
  }
  return read;
}

/**
 * The plan a bead carries, or `undefined` when what is there is not one — the contract every caller
 * that only decides whether to apply depends on. {@link readGardenerPlan} is the same read with the
 * refusal's field kept.
 */
export function parseGardenerPlan(value: unknown): GardenerPlan | undefined {
  const read = readGardenerPlan(value);
  return "plan" in read ? read.plan : undefined;
}

/** The metadata blob as a plain object — an array or a scalar is not a plan, whatever it carries. */
const planObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The wire object as a plan CANDIDATE: every field it carries checked against its own spec, every
 * field it omits left off. Unknown keys are dropped rather than refused — a plan is what the
 * executors branch on, and an extra key is not something they could act on.
 */
function readPlanFields(raw: Record<string, unknown>): PlanRead {
  const plan: Partial<GardenerPlan> = {};
  for (const field of PLAN_FIELD_NAMES) {
    const spec: FieldSpec = PLAN_FIELDS[field];
    const value = raw[field];
    if (value === undefined) {
      if (spec.required) return { rejected: { field, reason: `is missing; expected ${spec.shape}` } };
      continue;
    }
    if (!spec.ok(value)) return { rejected: { field, reason: `is not ${spec.shape}` } };
    // The one cast in the read, and the spec above is what earns it: the field was just checked
    // against the shape its own declaration names.
    (plan as Record<string, unknown>)[field] = value;
  }
  return { plan: plan as GardenerPlan };
}

/**
 * Why this plan's retirement verb is wrong, or undefined when it is right. Required exactly when the
 * move is `retire`, forbidden otherwise, and it must be the verb {@link KINDS} pairs with the kind:
 * `move` and `retireAs` are the two fields the fingerprint cannot cover, so this pairing is their
 * whole guard — a bead whose prose says "defer" must never execute a close.
 */
function retireViolation(plan: GardenerPlan): string | undefined {
  const expected = KINDS[plan.kind].retireAs;
  if (plan.move !== "retire") {
    return plan.retireAs === undefined
      ? undefined
      : `only a retire carries a verb, and ${plan.move} is not one`;
  }
  if (plan.retireAs === undefined) return `a retire has no default verb; expected ${expected}`;
  return plan.retireAs === expected
    ? undefined
    : `${plan.kind} retires as ${expected}, not ${plan.retireAs}`;
}

/**
 * Why this plan's subject guard is wrong for what it carries, or undefined when it is right.
 * All-or-nothing, the same invariant `detail` and `retireAs` hold: a kind whose fingerprint already
 * hashes its membership must carry no checksum, because a second record nothing reads is a plan
 * whose identity says more than its execution does.
 *
 * Where the kind DOES declare one, the canonical form must carry it and it must match — that is the
 * whole guard, and the reason a cluster's membership cannot be edited into fresh grouping evidence.
 * A legacy fingerprint is exempt from carrying one, and only from carrying one: it hashes the
 * membership itself, so the list is already bound, and requiring a field the older emitter never
 * wrote would strand exactly the proposals {@link identityForm} exists to keep readable.
 */
function checksumViolation(plan: GardenerPlan, form: IdentityForm): string | undefined {
  const expected = subjectChecksum(plan.kind, plan.subjects, plan.target, plan.detail);
  const carried = plan.subjectChecksum;
  if (expected === undefined) {
    return carried === undefined
      ? undefined
      : `${plan.kind} binds its subjects by fingerprint and carries no guard`;
  }
  if (carried === undefined) {
    return form === "legacy" ? undefined : `${plan.kind} must carry the subject guard it was filed with`;
  }
  return carried === expected ? undefined : "does not match the subject list it is filed with";
}

/**
 * The move a PROPOSAL BEAD carries, or which field refused it. The plan has already been checked
 * against ITSELF ({@link readGardenerPlan} recomputes the fingerprint from the fields it parsed);
 * what this adds is the bead's own label, the third record of the same claim. A mismatch anywhere
 * means the bead was assembled by something other than the emitter — which is exactly when applying
 * it blind is worst.
 *
 * This is the read the APPLY takes, so the field a refusal names reaches the operator holding the
 * unappliable proposal ({@link describePlanRejection}) rather than only a direct caller of the
 * parse: a proposal that will never apply is one a human has to fix by hand, and "which field" is
 * the whole of what they need.
 */
export function readProposalPlan(bead: {
  labels?: string[];
  metadata?: Record<string, unknown>;
}): PlanRead {
  const read = readGardenerPlan(bead.metadata?.[GARDENER_PLAN_KEY]);
  if ("rejected" in read) return read;
  return fingerprintLabelOf(bead) === read.plan.fingerprint
    ? read
    : { rejected: { field: "fingerprint", reason: "is not the one the bead is labelled with" } };
}

/**
 * The same read for every caller that only decides WHETHER a bead carries a move — suppression,
 * counting, the views. {@link readProposalPlan} is it with the refusal's field kept.
 */
export function proposalPlanOf(bead: { labels?: string[]; metadata?: Record<string, unknown> }):
  | GardenerPlan
  | undefined {
  const read = readProposalPlan(bead);
  return "plan" in read ? read.plan : undefined;
}

/**
 * The refusal as one clause, for a message that has to tell a human which field to go look at. The
 * colon is load-bearing: reasons come in two grammars — a predicate the field completes ("is not an
 * object") and a standalone sentence that names the kind ("a retire has no default verb") — and only
 * an explicit separator keeps the second kind from reading as prose that swallowed the field name.
 */
export const describePlanRejection = ({ field, reason }: PlanRejection): string =>
  `${field}: ${reason}`;

/**
 * The fingerprint this proposal's own plan hashes to TODAY, whatever label the bead carries — or
 * undefined when it carries no readable plan.
 *
 * Equal to the label for everything the current emitter filed. It differs for exactly one bead: a
 * `parentless-cluster` proposal filed before the claim moved to its target (anton-9hpp), whose label
 * hashes the membership it happened to be found with. Suppression reads THIS, so such a proposal
 * still answers for the target it names and the rollout files no duplicate beside it.
 */
export function canonicalFingerprintOf(bead: {
  labels?: string[];
  metadata?: Record<string, unknown>;
}): string | undefined {
  const plan = proposalPlanOf(bead);
  if (!plan) return undefined;
  return proposalFingerprint(
    plan.kind,
    detectionSubjectKey(plan.kind, plan.subjects, plan.target, plan.detail),
  );
}

/**
 * Every bead a detection concerns — its subjects plus whatever it points at. This is the set the
 * emitter hangs `discovered-from` edges off (anton-9qwq), so a proposal is reachable from each bead
 * it would touch, not just from the one it acts on.
 */
export function concernedBeads(detection: GardenerDetection): string[] {
  const ids = new Set(detection.subjects);
  if (detection.target) ids.add(detection.target);
  return [...ids].sort();
}

/**
 * Deterministic order: by kind, then by fingerprint. Two passes over an unchanged board serialize
 * identically, which is what lets a caller compare runs instead of re-reading the board — the same
 * property `sortFindings` gives the hygiene report.
 */
export function sortDetections(detections: GardenerDetection[]): GardenerDetection[] {
  return [...detections].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.fingerprint.localeCompare(b.fingerprint),
  );
}

/** Collapse detections that share a fingerprint — the same claim reached twice is still one claim. */
export function dedupeDetections(detections: GardenerDetection[]): GardenerDetection[] {
  const byFingerprint = new Map<string, GardenerDetection>();
  for (const detection of detections) {
    if (!byFingerprint.has(detection.fingerprint)) byFingerprint.set(detection.fingerprint, detection);
  }
  return [...byFingerprint.values()];
}
