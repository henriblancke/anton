/**
 * How far a pass may go with a proposal it just filed (anton-nbyy) — the policy as DATA, decided in
 * one place before anything consults it.
 *
 * Three values, and the middle one is why the feature is affordable: `propose` files the proposal and
 * stops (everything anton does today), `shadow` also records what applying it WOULD have done, and
 * `apply` writes it. The decision is per KIND rather than per producer, because what a mistake costs
 * is a property of the move: a `degraded-approval` unapprove and a `shipped-orphan` close come out of
 * the same pass and are nothing alike to get wrong.
 *
 * Pure values, in the same sense detections.ts is: nothing here reads a board, a settings store, or a
 * bead. That purity is what lets the hard floor be a PROVEN property instead of a comment — a `split`
 * and a targetless re-parent have no mechanical move to run, so {@link autonomyFor} answers `propose`
 * for them before the policy is consulted at all, and no setting can route them anywhere else.
 */
import {
  GARDENER_DETECTION_KINDS,
  isManualProposal,
  type GardenerDetectionKind,
  type GardenerMove,
} from "./detections";

/**
 * The three values, ordered by how much of the move the pass is trusted to make — which is also the
 * order the settings control offers them in, so "further right is more autonomous" reads the same in
 * the type and on screen.
 */
export const PROPOSAL_AUTONOMY_LEVELS = ["propose", "shadow", "apply"] as const;

export type ProposalAutonomy = (typeof PROPOSAL_AUTONOMY_LEVELS)[number];

/**
 * The resolved policy: every kind decided, never partial. Written as a total `Record` on purpose —
 * adding a detection kind without deciding what it defaults to is a type error at
 * {@link DEFAULT_PROPOSAL_AUTONOMY_POLICY} rather than a kind that silently inherits someone's
 * fallback branch.
 */
export type ProposalAutonomyPolicy = Record<GardenerDetectionKind, ProposalAutonomy>;

/** What a project STORES: only the kinds an operator moved off the default. */
export type ProposalAutonomyOverrides = Partial<ProposalAutonomyPolicy>;

/**
 * The shipped policy. `propose` everywhere, so a project that never opens the setting behaves exactly
 * as it did before this existed — arming anything is an act, never an upgrade side effect.
 */
export const DEFAULT_PROPOSAL_AUTONOMY_POLICY: ProposalAutonomyPolicy = {
  "container-orphan": "propose",
  "parentless-cluster": "propose",
  "implied-order": "propose",
  superseded: "propose",
  stale: "propose",
  "shipped-orphan": "propose",
  mispriority: "propose",
  "missing-order": "propose",
  oversized: "propose",
  "low-value": "propose",
  "degraded-approval": "propose",
};

function isAutonomy(value: unknown): value is ProposalAutonomy {
  return typeof value === "string" && (PROPOSAL_AUTONOMY_LEVELS as readonly string[]).includes(value);
}

function isDetectionKind(value: string): value is GardenerDetectionKind {
  return (GARDENER_DETECTION_KINDS as readonly string[]).includes(value);
}

/**
 * The shipped policy with a project's stored overrides applied — never partial.
 *
 * Takes `unknown` and DROPS what it doesn't recognise rather than throwing: this reads a settings blob
 * a human can hand-edit and a future anton can write kinds into, and a pass is the wrong place to
 * discover that. An entry anton can't read falls back to `propose`, which is the safe direction — the
 * loud rejection belongs at the settings boundary, where an operator is there to see it.
 */
export function resolveProposalAutonomyPolicy(overrides?: unknown): ProposalAutonomyPolicy {
  const policy = { ...DEFAULT_PROPOSAL_AUTONOMY_POLICY };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return policy;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (isDetectionKind(key) && isAutonomy(value)) policy[key] = value;
  }
  return policy;
}

/**
 * How far this proposal may go: the policy's answer for its kind, floored by what the move can
 * actually DO.
 *
 * The floor comes first and is not negotiable. A `split` decomposes a ticket into new contracts —
 * `/shape`'s work and a human's call — and a container orphan filed without a target is a question
 * ("which feature?") rather than an instruction; both settle by being DECLINED (see
 * {@link isManualProposal}). Arming them could only mean arming nothing, so an `apply` policy resolves
 * them to `propose` instead of leaving each caller to remember the exception.
 *
 * The kind and the move arrive separately because they answer different halves: the policy is a
 * decision about the KIND, the floor is a fact about the MOVE. Both shapes that consult this — a
 * detection about to be filed, a plan read back off a proposal bead — carry the move/target pair, so
 * neither has to be converted into the other first.
 */
export function autonomyFor(
  kind: GardenerDetectionKind,
  plan: { move: GardenerMove; target?: string },
  policy: ProposalAutonomyPolicy,
): ProposalAutonomy {
  if (isManualProposal(plan)) return "propose";
  return policy[kind] ?? "propose";
}
