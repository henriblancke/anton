import { beads, labelValueOf, type Bead, type GraphPlanNode } from "./beads/bd";
import { ownerOf } from "./beads/claim";
import { withBeadWriteLock } from "./beads/claim-lock";
import { validateBeadContract, type ContractViolation } from "./beads/contract";
import { beadSkeleton, type BeadSkeleton } from "./beads/formula";
import { allIssues, loadAllIssues } from "./beads/issues";
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
 * Why a legacy epic is spoken for as a run target of its own, or undefined when it is free. It has
 * no `feature` children yet, so landing one turns it into a container (`beads.isContainer`) and
 * whatever holds it loses its target: execute-epic's `isRunTarget` gate poison-parks a queued run,
 * an in-review one drops out of review-fix's sweep with its PR left unfinished, and a human
 * reservation becomes unreleasable — the claim route 422s a container, so the assignee is stuck on a
 * bead nothing runs while the new feature lands unclaimed for anyone to take. An epic that already
 * groups features is not at risk — it was never the run target.
 */
function spokenForReason(epic: Bead, board: Bead[]): string | undefined {
  if (beads.isContainer(epic, board)) return undefined;
  const strandsRun = (state: string) =>
    `epic ${epic.id} is ${state} as its own target — a feature under it would strand that run`;
  if (beads.isApproved(epic)) return strandsRun("approved and running");
  if (epic.status === "in_progress") return strandsRun("claimed and running");
  const owner = ownerOf(epic);
  return owner
    ? `epic ${epic.id} is reserved by ${owner} as its own target — a feature under it would leave that claim unreleasable; release it first`
    : undefined;
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
  return spokenForReason(bead, board);
}

/**
 * The epics a draft feature may attach to: every eligible epic, titled and sorted the way the picker
 * lists them. Closed and abandoned epics are out — attaching new work to a finished outcome is
 * never the right answer, and an abandoned one is a won't-do decision — as are epics already spoken
 * for as run targets of their own (see {@link spokenForReason}).
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
 * Render and judge the open, unapproved epic an accepted draft shapes, as the graph-plan node that
 * lands it. No `approved` label + open status → the board derives `backlog`.
 *
 * The rendered skeleton is judged with the contract validator BEFORE any bead exists. A non-empty
 * field can still be a placeholder ("- [ ] TODO — decide later"), which the validator classifies
 * as unwritten — creating that bead would land it instantly contract-blocked and unapprovable,
 * the opposite of this path's by-construction guarantee. Refusing here keeps the founder in the
 * form, where the fix is one edit away.
 */
async function draftEpicNode(
  project: Project,
  draft: EpicDraft,
  key: string,
): Promise<GraphPlanNode> {
  const skeleton = await buildEpicSkeleton(project, draft);
  const labels = [`area:${draft.area.trim()}`];
  assertContract(draft.title.trim(), skeleton, labels);
  return {
    key,
    title: draft.title.trim(),
    type: skeleton.type,
    description: skeleton.description,
    labels,
  };
}

/** The chosen epic must still be eligible on a FRESH board read, by the same rule the picker offered
 * it under ({@link ineligibleReason}) — a stale pick must not parent a feature under a task, under
 * an outcome that has since closed, or under a run already in flight, and a vanished one must not
 * create a dangling edge bd would reject mid-write.
 *
 * `loadAllIssues` — a raw bd read — not either snapshot-backed read, and for two reasons. The warm
 * `allIssues` is the snapshot the picker rendered from, which is exactly what this gate must not
 * trust: it serves retained beads for up to ISSUE_SNAPSHOT_MAX_AGE_MS, so the shape page's own
 * warming would let this accept an epic another machine has since closed, abandoned, or approved as
 * a standalone run target. But `refreshAllIssues` is no better HERE, because a refresh whose
 * generation is bumped mid-flight (any other bd write to this repo) discards what it loaded and
 * answers with the RETAINED board instead (beads/snapshot.ts) — last-good data is right for a view
 * and wrong for a gate that is about to write: a retained board can hide the very approval this gate
 * exists to catch. The approve route's in-lock verdict reads raw for the same reason.
 *
 * Only the EXISTING-epic path needs this: a NEW epic lands in the same atomic plan as its child, so
 * there is no board state to re-judge. Call it only while holding the epic's write lock — a verdict
 * is worth exactly as long as nothing can move the epic before the child write it authorizes (see
 * {@link createDraftFeature}). */
async function assertEpicEligible(project: Project, epicId: string): Promise<void> {
  const all = await loadAllIssues(project.repoPath);
  const bead = all.find((b) => b.id === epicId);
  if (!bead) throw new DraftEpicError(`epic ${epicId} is not on the board`);
  const reason = ineligibleReason(bead, all);
  if (reason) throw new DraftEpicError(reason);
}

/** Plan-local handles for the epic+feature tree a NEW-epic draft lands in one write. */
const EPIC_KEY = "epic";
const FEATURE_KEY = "feature";

/**
 * Create the open, unapproved FEATURE bead from an accepted draft, attached to its epic (anton-h1ds).
 * The feature — not the epic — is what anton runs: one worktree, one PR. This is the one write behind
 * "Send to backlog", and it is deliberately the only shape this path can produce, so the UI producer
 * and the `/shape` CLI producer agree on what a run target is.
 *
 * Every skeleton is judged BEFORE any bead exists — the feature's here, the epic's inside
 * {@link draftEpicNode} — so a contract refusal can never leave a half-written tree.
 *
 * The two shapes of draft need two different guarantees, and each takes the one bd actually offers:
 *
 * **A NEW epic goes in ONE write**, as a `bd create --graph` plan ({@link beads.createGraph}). Two
 * sequential creates cannot be made atomic, and the failure was not hypothetical: a feature write
 * that timed out or was refused left the epic it had just minted permanently on the roadmap with
 * nothing under it, and the founder's unchanged retry minted a second one beside it. The plan also
 * closes the window this path used to have to defend with a lock — a just-minted childless epic is a
 * run target of its own, so between the two writes another machine could approve or claim it and
 * have the feature strand that run. bd rolls the whole plan back on any failure, so the epic is
 * never on the shared board without its child and there is no window to defend.
 *
 * **An EXISTING epic takes that epic's write lock** across both the eligibility re-check and the
 * child write — the same per-bead chain approve and claim queue on (beads/claim-lock.ts). The
 * re-check alone is not enough: it answers from a read, and an approval or a claim landing between
 * that read and the write turns a live standalone run target into a container behind its own
 * runner's back — execute-epic's `isRunTarget` gate poison-parks the queued run, and a human claim
 * becomes unreleasable because the claim route 422s a container. Under the lock the two outcomes are
 * the only ones left: the approval lands first and the re-check refuses the draft (naming the epic),
 * or the feature lands first and the approval refuses. Both halves are needed — the approve route
 * takes its own run-target verdict INSIDE this same lock, because a check it made before queuing on
 * the lock says nothing about the board it is about to write to.
 */
export async function createDraftFeature(
  project: Project,
  draft: ShapeDraft,
): Promise<CreatedFeature> {
  const target = draft.epic;
  const title = draft.feature.title.trim();
  const feature = await buildFeatureSkeleton(project, draft.feature);
  assertContract(title, feature, []);

  if (target.kind === "new") {
    const epicNode = await draftEpicNode(project, target.epic, EPIC_KEY);
    const ids = await beads.createGraph(project.repoPath, {
      nodes: [
        epicNode,
        {
          key: FEATURE_KEY,
          title,
          type: feature.type,
          description: feature.description,
          parent_key: EPIC_KEY,
        },
      ],
    });
    return { id: ids[FEATURE_KEY]!, epicId: ids[EPIC_KEY]!, epicCreated: true };
  }

  const epicId = target.id.trim();
  if (!epicId) throw new DraftEpicError("no epic chosen — a feature must attach to one");

  const id = await withBeadWriteLock(project.repoPath, epicId, async () => {
    await assertEpicEligible(project, epicId);
    return beads.create(project.repoPath, {
      title,
      type: feature.type,
      description: feature.description,
      // Mirrored into bd's own field so `bd lint` and the board card read the same criteria the
      // description states. The graph path above has no such field and needs none — the plan schema
      // carries only the description, which is the home both readers check first.
      acceptance: feature.acceptance,
      deps: [`parent-child:${epicId}`],
    });
  });
  return { id, epicId, epicCreated: false };
}
