/**
 * What a gardener DETECTION is (anton-02oc): one evidenced claim that the board's SHAPE is wrong,
 * carrying everything a proposal bead needs and nothing it doesn't.
 *
 * The split from the hygiene report (src/lib/hygiene.ts) is deliberate. A hygiene FINDING is bd's
 * own verdict on one bead — bd owns lint/stale/orphans/duplicates and the patrol never re-derives
 * them. A DETECTION is anton's judgment about how beads relate: work that rides no board card, a
 * cluster that obviously belongs under one feature, an ordering a body states but no edge records,
 * work the board still holds open that reality has moved past. bd has no verb for any of those,
 * because they are questions about anton's own tier model.
 *
 * Detections are pure VALUES: nothing here reads a repo or writes a bead. Emission is anton-9qwq's
 * job and application anton-1t3n's — a detector that could apply itself would make the approval gate
 * (the whole point of the feature) optional.
 */
import { createHash } from "node:crypto";

/**
 * The apply verb class a detection would resolve to if approved (anton-1t3n). Carried on the
 * detection rather than inferred later from `kind`, so a new kind must state which move it wants
 * instead of silently falling into someone's default branch.
 */
export type GardenerMove = "reparent" | "link" | "retire";

/**
 * The board-shape smells the detectors know how to name:
 *   • `container-orphan`    — a working-layer bead whose parent is a CONTAINER epic, so no board
 *                             card carries it and no run will ever ship it (the anton-do0q class).
 *   • `parentless-cluster`  — parentless working-layer beads that share one obvious card home.
 *   • `implied-order`       — two run targets whose bodies or provenance state an ordering the
 *                             graph has no `blocks` edge for.
 *   • `superseded`          — an open bead whose identical twin already landed.
 *   • `stale`               — untouched far past the report threshold for its status.
 *   • `shipped-orphan`      — a commit shipped it, the board never closed it.
 */
export type GardenerDetectionKind =
  | "container-orphan"
  | "parentless-cluster"
  | "implied-order"
  | "superseded"
  | "stale"
  | "shipped-orphan";

export const GARDENER_DETECTION_KINDS: readonly GardenerDetectionKind[] = [
  "container-orphan",
  "parentless-cluster",
  "implied-order",
  "superseded",
  "stale",
  "shipped-orphan",
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
 * The one move each kind resolves to. A detection still STATES its move (see {@link GardenerMove}) —
 * this is the table that says the statement was true, and it is the only thing binding `move` and
 * `retireAs` to a proposal's identity: the fingerprint hashes what the claim is ABOUT (kind,
 * subjects, target), so without a canonical pairing a hand-edited bead could keep its label and its
 * hash while swapping a `stale` defer for a close. Every kind is listed, so adding one without
 * deciding its verb is a type error rather than a silent default.
 */
export const CANONICAL_MOVE: Record<
  GardenerDetectionKind,
  { move: GardenerMove; retireAs?: RetireVerb }
> = {
  "container-orphan": { move: "reparent" },
  "parentless-cluster": { move: "reparent" },
  "implied-order": { move: "link" },
  superseded: { move: "retire", retireAs: "supersede" },
  stale: { move: "retire", retireAs: "defer" },
  "shipped-orphan": { move: "retire", retireAs: "close" },
};

export interface GardenerDetection {
  kind: GardenerDetectionKind;
  move: GardenerMove;
  /**
   * Stable dedup key, label-safe: `gardener:<kind>:<hash of subjectKey>`. Hashed rather than spelled
   * out because a cluster's key spans every member — an id list grows past what belongs in a bd
   * label. Mirrors the `stringer:<collector>:<hash>` fingerprint /scan-triage already tags with, so
   * the board has one convention for "this proposal was already made" (anton-9qwq).
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
  /** One line: what is wrong and what the move would do. The proposal's title material. */
  summary: string;
  /**
   * The facts behind the claim, one per line, each naming the ids it rests on. A proposal without
   * evidence is an assertion — an approver has to be able to check the reasoning without re-deriving
   * it from the board.
   */
  evidence: string[];
}

/** The label namespace every gardener fingerprint lives in. */
export const GARDENER_LABEL_PREFIX = "gardener";

/** How much of the digest the fingerprint carries — collision-safe at board scale, label-short. */
const FINGERPRINT_HASH_LENGTH = 12;

export interface DetectionInput {
  kind: GardenerDetectionKind;
  move: GardenerMove;
  subjects: string[];
  target?: string;
  retireAs?: RetireVerb;
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
  const canonical = CANONICAL_MOVE[input.kind];
  if (canonical.move !== input.move || canonical.retireAs !== input.retireAs) {
    // Fail loud at emission rather than filing a bead nobody can approve: apply reads the plan back
    // against this same table, so a detector that drifts from it would put proposals on the board
    // that refuse forever as "no readable move".
    throw new Error(
      `${input.kind} is a ${canonical.move}${canonical.retireAs ? `/${canonical.retireAs}` : ""} detection, not ${input.move}${input.retireAs ? `/${input.retireAs}` : ""}`,
    );
  }
  const subjects = [...input.subjects].sort();
  const subjectKey = detectionSubjectKey(input.kind, subjects, input.target);
  return {
    kind: input.kind,
    move: input.move,
    fingerprint: gardenerFingerprint(input.kind, subjectKey),
    subjectKey,
    subjects,
    ...(input.target ? { target: input.target } : {}),
    ...(input.retireAs ? { retireAs: input.retireAs } : {}),
    summary: input.summary,
    evidence: input.evidence,
  };
}

/**
 * What a detection is ABOUT, as one readable string: the kind, its subjects (sorted, so two patrols
 * that walk the board in different orders agree), and whatever it points at. The identity the
 * fingerprint hashes — and the thing apply RECOMPUTES from a proposal's own fields, so a bead whose
 * subjects or target were edited after emission no longer matches its label.
 */
export function detectionSubjectKey(
  kind: GardenerDetectionKind,
  subjects: string[],
  target?: string,
): string {
  const sorted = [...subjects].sort();
  return `${kind}:${sorted.join("+")}` + (target ? `>${target}` : "");
}

/** `gardener:<kind>:<hash>` — the label a proposal bead carries so a re-run recognises its own work. */
export function gardenerFingerprint(kind: GardenerDetectionKind, subjectKey: string): string {
  const hash = createHash("sha1").update(subjectKey).digest("hex").slice(0, FINGERPRINT_HASH_LENGTH);
  return `${GARDENER_LABEL_PREFIX}:${kind}:${hash}`;
}

/** The fingerprint label's exact shape, so an unrelated `gardener:`-ish label is never mistaken for one. */
const FINGERPRINT_LABEL = new RegExp(
  `^${GARDENER_LABEL_PREFIX}:[a-z-]+:[0-9a-f]{${FINGERPRINT_HASH_LENGTH}}$`,
);

/**
 * The `gardener:<kind>:<hash>` label a bead carries, if any. Structurally typed rather than taking a
 * `Bead`, so this module stays free of the bd seam — a fingerprint is a fact about labels.
 */
export function fingerprintLabelOf(bead: { labels?: string[] }): string | undefined {
  return (bead.labels ?? []).find((l) => FINGERPRINT_LABEL.test(l));
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
  };
}

const GARDENER_MOVES: readonly GardenerMove[] = ["reparent", "link", "retire"];
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

  // The move must be the one this kind means, and the identity must be the one these fields hash to.
  const canonical = CANONICAL_MOVE[kind as GardenerDetectionKind];
  if (canonical.move !== move || canonical.retireAs !== (move === "retire" ? retireAs : undefined)) {
    return undefined;
  }
  const recomputed = gardenerFingerprint(
    kind as GardenerDetectionKind,
    detectionSubjectKey(kind as GardenerDetectionKind, subjects as string[], target as string | undefined),
  );
  if (recomputed !== fingerprint) return undefined;

  return {
    kind: kind as GardenerDetectionKind,
    move: move as GardenerMove,
    fingerprint,
    subjects: subjects as string[],
    ...(target ? { target: target as string } : {}),
    ...(move === "retire" ? { retireAs: retireAs as RetireVerb } : {}),
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
