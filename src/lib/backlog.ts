import { beads, labelValueOf, type Bead } from "./beads/bd";
import { validateBeadContract, type ContractViolation } from "./beads/contract";
import { beadSkeleton, type BeadSkeleton } from "./beads/formula";
import { allIssues, refreshAllIssues } from "./beads/issues";
import type { Project } from "./types";

/**
 * The epic half of an Add-work draft — the contract an epic carries (skills/bd/SKILL.md): an epic is
 * READ, not executed, so it holds an outcome, the Success Criteria its features add up to, and the
 * one `area:` label the roadmap groups by. Only filled when the founder creates the epic here rather
 * than attaching to one already on the board.
 */
export interface EpicDraft {
  title: string;
  /** The outcome, in one line a stakeholder would recognise — the epic's `## Goal`. */
  goal: string;
  /** How we know the outcome is reached — mirrored into bd's own Success Criteria field. */
  successCriteria: string;
  /** The product surface this outcome advances, without the `area:` prefix. */
  area: string;
}

/**
 * The feature half — what Add-work actually lands (anton-h1ds). A `feature` is the run target: one
 * worktree, one PR (docs/design/2026-07-26-tier-and-linear-ux.md), so the draft carries the five
 * contract sections a run and its self-review read, and nothing about grouping.
 *
 * Every field is required rather than optional because that is this path's whole promise: the bead
 * is rendered from the project's bead formula and passes `validateBeadContract` BY CONSTRUCTION. An
 * optional field would just re-open the gap the board then has to flag.
 */
export interface FeatureDraft {
  title: string;
  goal: string;
  acceptance: string;
  context: string;
  outOfScope: string;
  verify: string;
}

/**
 * Where the feature attaches. There is no third case on purpose: a feature with no epic runs fine
 * and appears on no roadmap, so the producer refuses rather than committing one parentless
 * (skills/bd/SKILL.md, invariant 4).
 */
export type EpicTarget =
  | { kind: "existing"; id: string }
  | { kind: "new"; epic: EpicDraft };

/** A shaping draft the founder accepts in the Add-work UI: one feature, and the epic above it. */
export interface ShapeDraft {
  feature: FeatureDraft;
  epic: EpicTarget;
}

/** What the commit created — the feature, its epic, and whether that epic is new to the board. */
export interface CreatedFeature {
  id: string;
  epicId: string;
  epicCreated: boolean;
}

/** One selectable epic in the Add-work picker. */
export interface EpicChoice {
  id: string;
  title: string;
  /** The epic's product surface, when it carries one — shown so a near-match is spotted. */
  area?: string;
  /**
   * Ticket children hanging directly off this epic. A feature landing here turns it into a
   * container, and a ticket under a container epic never runs — nothing claims it
   * (skills/bd/SKILL.md, invariant 1). The picker warns; it does not refuse, because re-homing
   * those tickets is board surgery, not part of filing one feature.
   */
  looseTickets: number;
}

/** bd types that make up the working layer — the tickets a container epic would strand. */
const TICKET_TYPES = new Set(["task", "bug", "chore"]);

/**
 * The `area:` values already in use on the board, sorted — what the Add-work form suggests. Offering
 * the existing surfaces is what keeps the vocabulary from fragmenting into `report`/`reports`/
 * `reporting`; anton never validates WHICH surfaces exist, so reuse has to come from the UI.
 */
export function knownAreas(all: Bead[]): string[] {
  const areas = new Set<string>();
  for (const bead of all) {
    const area = labelValueOf(bead.labels, "area");
    if (area) areas.add(area);
  }
  return [...areas].sort();
}


/**
 * A legacy epic anton is currently running as a target of its own — approved, or claimed and in
 * flight. It has no `feature` children yet, so landing one turns it into a container mid-flight
 * (`beads.isContainer`): execute-epic's `isRunTarget` gate then poison-parks the queued run, and an
 * in-review one drops out of review-fix's sweep with its PR left unfinished. An epic that already
 * groups features is not at risk — it was never the run target.
 */
function isInFlightRunTarget(epic: Bead, board: Bead[]): boolean {
  return (
    !beads.isContainer(epic, board) && (beads.isApproved(epic) || epic.status === "in_progress")
  );
}

/**
 * Why this bead may not parent a new feature, or undefined when it may. ONE predicate behind both
 * the picker and the submit-time re-check, so a target the picker refuses to offer can never be
 * written by a page that rendered before the board moved — the shape page is long-lived, and
 * another machine can close, abandon, or approve an epic while the founder is still typing.
 */
function ineligibleReason(bead: Bead, board: Bead[]): string | undefined {
  if (!beads.isEpic(bead)) return `${bead.id} is a ${bead.issue_type ?? "bead"}, not an epic`;
  // Abandoned first: it is also closed, but "won't do" is a different answer than "shipped".
  if (beads.isAbandoned(bead)) return `epic ${bead.id} was abandoned — pick another`;
  if (bead.status === "closed") return `epic ${bead.id} is closed — pick another`;
  if (isInFlightRunTarget(bead, board)) {
    return `epic ${bead.id} is approved and running as its own target — a feature under it would strand that run`;
  }
  return undefined;
}

/**
 * The epics a draft feature may attach to: every eligible epic, titled and sorted the way the picker
 * lists them. Closed and abandoned epics are out — attaching new work to a finished outcome is
 * never the right answer, and an abandoned one is a won't-do decision — as are epics anton is
 * already running as run targets of their own (see {@link isInFlightRunTarget}).
 */
export function epicChoices(all: Bead[]): EpicChoice[] {
  const looseByEpic = new Map<string, number>();
  for (const bead of all) {
    if (!TICKET_TYPES.has(bead.issue_type ?? "")) continue;
    // Settled tickets strand nothing — they already shipped or were dropped — so counting them
    // would warn the founder off the very epic their feature belongs under.
    if (bead.status === "closed" || beads.isAbandoned(bead)) continue;
    const parent = beads.parentOf(bead);
    if (parent) looseByEpic.set(parent, (looseByEpic.get(parent) ?? 0) + 1);
  }
  return all
    .filter((b) => ineligibleReason(b, all) === undefined)
    .map((epic) => ({
      id: epic.id,
      title: epic.title,
      area: labelValueOf(epic.labels, "area"),
      looseTickets: looseByEpic.get(epic.id) ?? 0,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Everything the Add-work panel offers, derived from ONE board read — the warm issue snapshot the
 * board already holds, so no extra bd spawn: the epics a feature may attach to, and the `area:`
 * vocabulary a new epic should reuse. */
export async function getDraftOptions(
  project: Project,
): Promise<{ areas: string[]; epics: EpicChoice[] }> {
  const all = await allIssues(project.repoPath);
  return { areas: knownAreas(all), epics: epicChoices(all) };
}

/**
 * Render a draft through the project's bead formula (`.beads/formulas/anton-bead.formula.json`,
 * anton's bundled copy as fallback). The shape is structural — the sections come from the formula,
 * not from this function remembering which headings a tier carries.
 */
export function buildEpicSkeleton(project: Project, draft: EpicDraft): Promise<BeadSkeleton> {
  return beadSkeleton(project.repoPath, "epic", {
    title: draft.title,
    outcome: draft.goal,
    success_criteria: draft.successCriteria,
  });
}

/** The same, for the feature tier — the five sections a run and its self-review read. */
export function buildFeatureSkeleton(
  project: Project,
  draft: FeatureDraft,
): Promise<BeadSkeleton> {
  return beadSkeleton(project.repoPath, "feature", {
    title: draft.title,
    goal: draft.goal,
    acceptance: draft.acceptance,
    context: draft.context,
    out_of_scope: draft.outOfScope,
    verify: draft.verify,
  });
}

/** A draft whose rendered bead the contract validator faults — the route maps this to a 422. */
export class DraftContractError extends Error {
  constructor(readonly violations: ContractViolation[]) {
    super(`draft does not meet the bead contract: ${violations.map((v) => v.message).join(", ")}`);
    this.name = "DraftContractError";
  }
}

/**
 * A draft that names no usable epic — none chosen, or one the board no longer holds as an epic. The
 * route maps this to a 400: it is a question for the founder, not a bd failure, and the answer is
 * one selection away.
 */
export class DraftEpicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftEpicError";
  }
}

/** Judge a rendered skeleton before any bead exists, and refuse the whole commit if it falls short. */
function assertContract(title: string, skeleton: BeadSkeleton, labels: string[]): void {
  const rendered: Bead = {
    id: "draft",
    title,
    status: "open",
    issue_type: skeleton.type,
    description: skeleton.description,
    acceptance_criteria: skeleton.acceptance,
    labels,
  };
  const violations = validateBeadContract(rendered);
  if (violations.length > 0) throw new DraftContractError(violations);
}

/**
 * Create the open, unapproved epic bead from an accepted draft and return its id. No `approved`
 * label + open status → the board derives `backlog`. Bead writes go through `bd` (DESIGN.md §3).
 *
 * The rendered skeleton is judged with the contract validator BEFORE the bead exists. A non-empty
 * field can still be a placeholder ("- [ ] TODO — decide later"), which the validator classifies
 * as unwritten — creating that bead would land it instantly contract-blocked and unapprovable,
 * the opposite of this path's by-construction guarantee. Refusing here keeps the founder in the
 * form, where the fix is one edit away.
 */
export async function createDraftEpic(project: Project, draft: EpicDraft): Promise<string> {
  const skeleton = await buildEpicSkeleton(project, draft);
  const labels = [`area:${draft.area.trim()}`];
  assertContract(draft.title.trim(), skeleton, labels);
  return beads.create(project.repoPath, {
    title: draft.title.trim(),
    type: skeleton.type,
    description: skeleton.description,
    // The description is the canonical home of the contract; the mirror is what `bd lint` and the
    // board card read (parseAcceptance falls through to this field for an epic).
    acceptance: skeleton.acceptance,
    labels,
  });
}

/** The chosen epic must still be eligible on a FRESH board read, by the same rule the picker offered
 * it under ({@link ineligibleReason}) — a stale pick must not parent a feature under a task, under
 * an outcome that has since closed, or under a run already in flight, and a vanished one must not
 * create a dangling edge bd would reject mid-write.
 *
 * `refreshAllIssues`, not `allIssues`: the warm snapshot the picker rendered from is exactly what
 * this gate must not trust. It serves retained beads for up to ISSUE_SNAPSHOT_MAX_AGE_MS — and even
 * once invalidated it answers with the retained board while refreshing behind the request — so the
 * shape page's own warming would let this accept an epic another machine has since closed,
 * abandoned, or approved as a standalone run target. The same reason approve/claim/move force a
 * fresh read before they decide. */
async function resolveExistingEpic(project: Project, id: string): Promise<string> {
  const chosen = id.trim();
  if (!chosen) throw new DraftEpicError("no epic chosen — a feature must attach to one");
  const all = await refreshAllIssues(project.repoPath);
  const bead = all.find((b) => b.id === chosen);
  if (!bead) throw new DraftEpicError(`epic ${chosen} is not on the board`);
  const reason = ineligibleReason(bead, all);
  if (reason) throw new DraftEpicError(reason);
  return chosen;
}

/**
 * Create the open, unapproved FEATURE bead from an accepted draft, attached to its epic (anton-h1ds).
 * The feature — not the epic — is what anton runs: one worktree, one PR. This is the one write behind
 * "Send to backlog", and it is deliberately the only shape this path can produce, so the UI producer
 * and the `/shape` CLI producer agree on what a run target is.
 *
 * Both skeletons are judged BEFORE any bead exists — the feature's here, the epic's inside
 * {@link createDraftEpic}, which validates ahead of its own write — so a contract refusal can never
 * leave a half-written tree. What remains unatomic is the pair of bd writes: bd's `--graph` plan is
 * the atomic form and `beads.create` does not speak it, so a failing feature write can strand a
 * just-created epic — named in the error rather than swallowed, because a silent orphan on the
 * roadmap is worse than a loud one.
 */
export async function createDraftFeature(
  project: Project,
  draft: ShapeDraft,
): Promise<CreatedFeature> {
  const target = draft.epic;
  const feature = await buildFeatureSkeleton(project, draft.feature);
  assertContract(draft.feature.title.trim(), feature, []);

  const epicId =
    target.kind === "new"
      ? await createDraftEpic(project, target.epic)
      : await resolveExistingEpic(project, target.id);

  try {
    const id = await beads.create(project.repoPath, {
      title: draft.feature.title.trim(),
      type: feature.type,
      description: feature.description,
      // Mirrored into bd's own field so `bd lint` and the board card read the same criteria the
      // description states — the same pairing the epic write makes.
      acceptance: feature.acceptance,
      deps: [`parent-child:${epicId}`],
    });
    return { id, epicId, epicCreated: target.kind === "new" };
  } catch (err) {
    const stray = target.kind === "new" ? ` — epic ${epicId} was created and is now empty` : "";
    throw new Error(`${(err as Error).message}${stray}`);
  }
}
