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
 */
export type GardenerMove =
  | "reparent"
  | "link"
  | "retire"
  | "reprioritize"
  | "split"
  | "unapprove";

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
  | "degraded-approval";

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

/** What one detection kind IS: who files it, what it applies as, and what parameter it carries. */
export interface KindSpec {
  namespace: ProposalNamespace;
  move: GardenerMove;
  retireAs?: RetireVerb;
  /** Set exactly when the move takes a non-bead parameter; absent means `detail` is forbidden. */
  detail?: DetailShape;
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
  "parentless-cluster": { namespace: "gardener", move: "reparent" },
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
   * spelled out because a cluster's key spans every member — an id list grows past what belongs in a
   * bd label. Mirrors the `stringer:<collector>:<hash>` fingerprint /scan-triage already tags with,
   * so the board has one convention for "this proposal was already made" (anton-9qwq).
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
  const subjects = [...input.subjects].sort();
  const subjectKey = detectionSubjectKey(input.kind, subjects, input.target, input.detail);
  return {
    kind: input.kind,
    move: input.move,
    fingerprint: proposalFingerprint(input.kind, subjectKey),
    subjectKey,
    subjects,
    ...(input.target ? { target: input.target } : {}),
    ...(input.retireAs ? { retireAs: input.retireAs } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
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
 * What a detection is ABOUT, as one readable string: the kind, its subjects (sorted, so two patrols
 * that walk the board in different orders agree), whatever it points at, and the move's parameter
 * when it takes one. The identity the fingerprint hashes — and the thing apply RECOMPUTES from a
 * proposal's own fields, so a bead whose subjects, target or detail were edited after emission no
 * longer matches its label.
 */
export function detectionSubjectKey(
  kind: GardenerDetectionKind,
  subjects: string[],
  target?: string,
  detail?: string,
): string {
  const sorted = [...subjects].sort();
  return (
    `${kind}:${sorted.join("+")}` + (target ? `>${target}` : "") + (detail ? `#${detail}` : "")
  );
}

/**
 * `<namespace>:<kind>:<hash>` — the label a proposal bead carries so a re-run recognises its own
 * work. The namespace comes from the KIND rather than from the caller, so the gardener cannot file
 * under `pm:` (or the reverse) even by mistake, and the two producers can never collide on a hash.
 */
export function proposalFingerprint(kind: GardenerDetectionKind, subjectKey: string): string {
  const hash = createHash("sha1").update(subjectKey).digest("hex").slice(0, FINGERPRINT_HASH_LENGTH);
  return `${namespaceOf(kind)}:${kind}:${hash}`;
}

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
  };
}

const GARDENER_MOVES: readonly GardenerMove[] = [
  "reparent",
  "link",
  "retire",
  "reprioritize",
  "split",
  "unapprove",
];
const RETIRE_VERBS: readonly RetireVerb[] = ["close", "supersede", "defer"];

/**
 * Read a plan back off a bead's metadata, or `undefined` when what is there is not one. Validated
 * field by field rather than cast: this value decides which beads get MUTATED, so anything the
 * emitter did not write — a hand-edited metadata blob, a plan from a future anton that added a move
 * — must read as "no readable plan" and stop the apply, not fall through to a default branch.
 *
 * `retireAs` is required exactly when the move is `retire` and forbidden otherwise, which is the
 * same invariant {@link GardenerDetection} documents; a retire with no verb has no safe default.
 *
 * Two checks bind the plan to the ONE claim its fingerprint stands for, so an approver cannot read
 * one ask and have another execute:
 *   • the fingerprint is RECOMPUTED from the parsed kind/subjects/target and must match the field
 *     carried alongside them — editing the subjects or the target of a proposal now invalidates it
 *     rather than silently redirecting the move;
 *   • the move and retirement verb must be the ones {@link CANONICAL_MOVE} pairs with the kind,
 *     which is what covers the two fields the hash can't (a `stale` bead reads as a defer, so it
 *     must not execute a close).
 */
export function parseGardenerPlan(value: unknown): GardenerPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const kind = raw.kind;
  const move = raw.move;
  const fingerprint = raw.fingerprint;
  if (typeof kind !== "string" || !GARDENER_DETECTION_KINDS.includes(kind as GardenerDetectionKind)) {
    return undefined;
  }
  if (typeof move !== "string" || !GARDENER_MOVES.includes(move as GardenerMove)) return undefined;
  if (typeof fingerprint !== "string" || !FINGERPRINT_LABEL.test(fingerprint)) return undefined;

  const subjects = raw.subjects;
  if (!Array.isArray(subjects) || subjects.length === 0) return undefined;
  if (!subjects.every((s) => typeof s === "string" && s.length > 0)) return undefined;

  const target = raw.target;
  if (target !== undefined && (typeof target !== "string" || !target)) return undefined;

  const retireAs = raw.retireAs;
  if (move === "retire") {
    if (typeof retireAs !== "string" || !RETIRE_VERBS.includes(retireAs as RetireVerb)) {
      return undefined;
    }
  } else if (retireAs !== undefined) {
    return undefined;
  }

  const detail = raw.detail;
  if (detail !== undefined && (typeof detail !== "string" || !detail)) return undefined;
  // Required exactly where the kind declares a shape, forbidden elsewhere, and matching that shape:
  // the same bar `makeDetection` holds the emitter to, re-applied to a metadata blob a human can
  // edit. A `reprioritize` whose detail is not a priority has nothing to write.
  if (detailViolation(kind as GardenerDetectionKind, detail as string | undefined)) return undefined;

  // The move must be the one this kind means, and the identity must be the one these fields hash to.
  const canonical = KINDS[kind as GardenerDetectionKind];
  if (canonical.move !== move || canonical.retireAs !== (move === "retire" ? retireAs : undefined)) {
    return undefined;
  }
  const recomputed = proposalFingerprint(
    kind as GardenerDetectionKind,
    detectionSubjectKey(
      kind as GardenerDetectionKind,
      subjects as string[],
      target as string | undefined,
      detail as string | undefined,
    ),
  );
  if (recomputed !== fingerprint) return undefined;

  return {
    kind: kind as GardenerDetectionKind,
    move: move as GardenerMove,
    fingerprint,
    subjects: subjects as string[],
    ...(target ? { target: target as string } : {}),
    ...(move === "retire" ? { retireAs: retireAs as RetireVerb } : {}),
    ...(detail ? { detail: detail as string } : {}),
  };
}

/**
 * The move a PROPOSAL BEAD carries, if it carries a readable one. The plan has already been checked
 * against ITSELF ({@link parseGardenerPlan} recomputes the fingerprint from the fields it parsed);
 * what this adds is the bead's own label, the third record of the same claim. A mismatch anywhere
 * means the bead was assembled by something other than the emitter — which is exactly when applying
 * it blind is worst.
 */
export function proposalPlanOf(bead: { labels?: string[]; metadata?: Record<string, unknown> }):
  | GardenerPlan
  | undefined {
  const plan = parseGardenerPlan(bead.metadata?.[GARDENER_PLAN_KEY]);
  if (!plan) return undefined;
  return fingerprintLabelOf(bead) === plan.fingerprint ? plan : undefined;
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
