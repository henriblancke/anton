import { beads, labelValueOf, labelValuesOf, type Bead, type GraphPlanNode } from "./beads/bd";
import { ownerOf } from "./beads/claim";
import { withBeadWriteLock } from "./beads/claim-lock";
import { validateBeadContract, type ContractViolation } from "./beads/contract";
import { beadSkeleton, type BeadSkeleton } from "./beads/formula";
import { allIssues, loadAllIssues } from "./beads/issues";
import { scanMarkdown } from "./beads/markdown";
import { AREA_SHAPE } from "./epic-patch";
import {
  activeOutcomeIds,
  outcomesConfigured,
  parseOutcomes,
  readProductMd,
  readProjectOutcomes,
  type ProjectOutcome,
} from "./outcomes";
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
  /** Which `.product/PRODUCT.md` outcome id(s) this epic's features serve — the epic's `## Outcome IDs`. */
  outcomeIds: string;
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
  /** Which outcome this serves, and how — the feature's `## Why`. */
  why: string;
  /** The `.product/PRODUCT.md` outcome id this feature serves — lands as its `outcome:<id>` label,
   * the run-target home for that label (skills/bd/SKILL.md); set alongside `why`. */
  outcomeId: string;
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

/** Everything the Add-work panel offers: the epics a feature may attach to and the `area:`
 * vocabulary a new epic should reuse, off ONE board read (the warm issue snapshot, so no extra bd
 * spawn) — plus the outcomes `.product/PRODUCT.md` currently offers for new work, so the panel can
 * suggest them and catch a typo'd outcome id before it ever reaches {@link createDraftFeature}. */
export async function getDraftOptions(
  project: Project,
): Promise<{ areas: string[]; epics: EpicChoice[]; outcomes: ProjectOutcome[] }> {
  const [all, outcomes] = await Promise.all([
    allIssues(project.repoPath),
    readProjectOutcomes(project.repoPath),
  ]);
  return { areas: knownAreas(all), epics: epicChoices(all), outcomes: outcomes.filter((o) => !o.retired) };
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
    outcome_ids: draft.outcomeIds,
  });
}

/** The same, for the feature tier — the six sections a run and its self-review read. */
export function buildFeatureSkeleton(
  project: Project,
  draft: FeatureDraft,
): Promise<BeadSkeleton> {
  return beadSkeleton(project.repoPath, "feature", {
    title: draft.title,
    goal: draft.goal,
    why: draft.why,
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

/**
 * A draft whose outcome doesn't hold up against `.product/PRODUCT.md` — the feature's outcome id
 * names nothing active there, or a NEW epic's `## Outcome IDs` never mentions it. Same shape as
 * {@link DraftEpicError}: a question for the founder, not a bd failure, and the route maps it to a
 * 400.
 */
export class DraftOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftOutcomeError";
  }
}

/** Split a free-text `## Outcome IDs` field (e.g. `outcome:reports-are-shareable,
 * outcome:report-sharng`) into its individual declared id tokens: comma/whitespace-separated
 * entries, each with an optional `outcome:` label prefix stripped. Shared by every check that
 * needs the full declared set, not just whether one particular id is among them. */
export function outcomeIdTokens(outcomeIds: string): string[] {
  return outcomeIds
    .split(/[,\s]+/)
    .map((token) => token.trim().replace(/^outcome:/i, ""))
    .filter(Boolean);
}

/** Does the epic's free-text `## Outcome IDs` name this outcome id? A bare id, an `outcome:<id>`
 * label form, and a comma/whitespace-separated list of several all match — while a longer id
 * merely containing this one as a substring does not. */
function outcomeIdsMention(outcomeIds: string, outcomeId: string): boolean {
  return outcomeIdTokens(outcomeIds).includes(outcomeId);
}

// Exact match, like `sectionHeading` for `Goal`/`Why` in ticket-dialog-utils.ts — a prefix match
// would also claim `## Outcome IDs and Caveats`, scooping its free text in as the declared ids.
const OUTCOME_IDS_HEADING = /^##\s*Outcome IDs\s*$/i;

/** An existing epic's `## Outcome IDs` section: whether the heading is present at all, and its body
 * verbatim ("" for an absent OR a blank-but-present section — those two are NOT the same case to a
 * caller, so `present` carries the distinction). Free text (unlike Goal/Acceptance, "Outcome IDs"
 * is not a section `validateBeadContract` judges), so a plain heading scan rather than the
 * contract's slugged-heading machinery — same shape as `extractSection` in ticket-dialog-utils.ts.
 * Uses `scanMarkdown`'s AST-aware heading metadata (`heading?.depth === 2`), not a raw `/^##\s+/`
 * text test, so a fenced example whose line merely reads `## Outcome IDs` isn't mistaken for the
 * genuine section. */
export function extractOutcomeIdsSection(description: string): { present: boolean; body: string } {
  const lines = description.split("\n");
  const scanned = scanMarkdown(description);
  const occurrences: string[] = [];
  let body: string[] = [];
  let inSection = false;
  let present = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const depth = scanned[i]?.heading?.depth;
    // Any rendered heading at or above this section's own depth ends it — not just another `##`.
    // A `#` placed after `## Outcome IDs` still closes the document's own top-level grouping, and
    // leaving it in the body would let outcomeIdTokens tokenize the heading text and everything
    // after it as declared ids. A repeated `## Outcome IDs` heading reopens the section rather than
    // ending the read entirely — mirrors `sectionsOf` in beads/contract.ts, which every other
    // contract reader concatenates repeated sections through; stopping at the first occurrence
    // silently dropped ids declared only in a later one.
    if (depth !== undefined && depth <= 2) {
      if (inSection) {
        occurrences.push(body.join("\n").trim());
        body = [];
      }
      inSection = depth === 2 && OUTCOME_IDS_HEADING.test(trimmed);
      if (inSection) present = true;
      continue;
    }
    if (inSection) body.push(line);
  }
  if (inSection) occurrences.push(body.join("\n").trim());
  return { present, body: occurrences.filter(Boolean).join("\n\n") };
}

/**
 * A run target's outcome id(s), wherever its tier stores them. A feature-tier target carries them as
 * `outcome:<id>` labels (the Add-work path labels only feature nodes), but a standalone epic run
 * target (no feature children, execute-epic's own tier) never gets that label — its contract stores
 * them as free text in its own `## Outcome IDs` section instead. Falling back to the label read alone
 * would make every standalone epic look like it predates outcome ids and silently drop its declared
 * outcomes wherever a caller derives them from the target.
 */
export function outcomeIdsOf(target: Bead): string[] {
  const labeled = labelValuesOf(target.labels, "outcome");
  if (labeled.length > 0) return labeled;
  const { present, body } = extractOutcomeIdsSection(target.description ?? "");
  return present ? outcomeIdTokens(body) : [];
}

/**
 * Refuse a draft whose feature outcome id names nothing `.product/PRODUCT.md` currently offers for
 * new work — a typo, or one marked `(retired)` — or, for a NEW epic, whose `## Outcome IDs` never
 * mentions that same id. The epic's outcome ids are the outcomes its features add up to serving
 * (skills/bd/SKILL.md), so a feature naming an outcome its own new epic doesn't list is exactly the
 * drift the contract exists to catch.
 *
 * Read fresh on every commit rather than cached: PRODUCT.md can change between the shape page
 * rendering and the founder sending the draft, same reason {@link assertEpicEligible} re-reads the
 * board instead of trusting the picker's snapshot.
 */
async function assertOutcomeUsable(project: Project, draft: ShapeDraft): Promise<void> {
  const outcomeId = draft.feature.outcomeId.trim();
  const markdown = await readProductMd(project.repoPath);
  const active = activeOutcomeIds(parseOutcomes(markdown));
  // A missing `## Outcomes` section is an upgrade gap (anton-cdeki), not a deliberate choice to
  // offer only the built-in `codebase-health` — gating a closed set that was never configured
  // would leave every project that predates this feature unable to submit a normal feature until
  // someone manually discovers and edits the new file format. Once a project DOES declare the
  // section, even an empty one, it's opted in and gets the full check.
  const configured = outcomesConfigured(markdown);
  if (configured && !active.has(outcomeId)) {
    throw new DraftOutcomeError(
      `"${outcomeId}" is not an outcome \`.product/PRODUCT.md\` offers for new work — pick one from its \`## Outcomes\` section`,
    );
  }
  if (draft.epic.kind === "new") {
    const declared = outcomeIdTokens(draft.epic.epic.outcomeIds);
    if (!declared.includes(outcomeId)) {
      throw new DraftOutcomeError(
        `the new epic's Outcome IDs must include "${outcomeId}" — the feature's own outcome is one of the outcomes its epic serves`,
      );
    }
    // Label syntax is checked unconditionally — even with no `.product/PRODUCT.md` configured, a
    // declared id still has to survive as an `outcome:<id>` label, so a bare `,`-typo like
    // `outcome:bad!` is refused before it ever lands on the board.
    const malformed = declared.filter((id) => !AREA_SHAPE.test(id));
    if (malformed.length > 0) {
      throw new DraftOutcomeError(
        `the new epic's Outcome IDs name ${malformed.map((id) => `"${id}"`).join(", ")}, which can't be an \`outcome:<id>\` label (letters, digits, . _ - only) — fix the syntax or remove it`,
      );
    }
    // Every declared id is a real commitment the epic makes, not just the one the feature happens
    // to use — a typo elsewhere in the list (`outcome:report-sharng`) would otherwise persist onto
    // the board unnoticed because the feature's OWN id already satisfied the check above. Same
    // upgrade-gap exemption as above: nothing to validate against until PRODUCT.md is configured.
    if (configured) {
      const unknown = declared.filter((id) => !active.has(id));
      if (unknown.length > 0) {
        throw new DraftOutcomeError(
          `the new epic's Outcome IDs name ${unknown.map((id) => `"${id}"`).join(", ")}, which \`.product/PRODUCT.md\` doesn't offer for new work — fix the typo or remove it`,
        );
      }
    }
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
 * {@link createDraftFeature}).
 *
 * Also re-checks the outcome the new-epic path already enforces at draft time
 * ({@link assertOutcomeUsable}): a chosen epic whose `## Outcome IDs` names a set that does NOT
 * include the feature's own outcome would otherwise land a feature its parent's declared outcomes
 * don't cover — the epic then undersells what it groups. A MISSING section is not a contradiction —
 * an epic that predates this convention, or was never asked to state one, has nothing to conflict
 * with — so only a section that is present and silent on this id is refused; nothing here mutates
 * that epic to add it, since a silent auto-edit of another bead's contract is a worse surprise than
 * asking the founder to fix the mismatch (or pick another epic). */
async function assertEpicEligible(project: Project, epicId: string, outcomeId: string): Promise<void> {
  const all = await loadAllIssues(project.repoPath);
  const bead = all.find((b) => b.id === epicId);
  if (!bead) throw new DraftEpicError(`epic ${epicId} is not on the board`);
  const reason = ineligibleReason(bead, all);
  if (reason) throw new DraftEpicError(reason);
  const { present, body } = extractOutcomeIdsSection(bead.description ?? "");
  if (present && !outcomeIdsMention(body, outcomeId)) {
    throw new DraftOutcomeError(
      `epic ${epicId}'s Outcome IDs don't include "${outcomeId}" — the feature's own outcome must be one of the outcomes its epic serves`,
    );
  }
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
 *
 * That lock orders writes made in THIS process only, so two anton instances sharing a board can
 * still interleave this re-check with the other's approval. Nothing here closes that: the board is
 * a per-machine Dolt DB whose writes merge at sync, not a store offering a conditional write, so
 * there is no CAS to take (anton-od4). The residue is answered where the merge first becomes
 * observable instead of guessed at here — every run re-derives its target's shape off the freshly
 * pulled board and poison-parks an epic that gained a feature child (execute-epic's 0a-ter gate and
 * its `runTargetDrift`), so the losing side stops loudly, naming the epic, rather than executing a
 * feature nobody approved. Rolling the feature back after sync would be the worse trade: it deletes
 * the founder's shaped work on a race whose "after" a distributed board never defines, and the
 * rollback races the same way.
 */
export async function createDraftFeature(
  project: Project,
  draft: ShapeDraft,
): Promise<CreatedFeature> {
  const target = draft.epic;
  const title = draft.feature.title.trim();
  const feature = await buildFeatureSkeleton(project, draft.feature);
  // The `outcome:` label lives on the run target (skills/bd/SKILL.md), never on the epic that
  // groups it — so every write path below carries it on the FEATURE node alone.
  const labels = [`outcome:${draft.feature.outcomeId.trim()}`];
  assertContract(title, feature, labels);
  await assertOutcomeUsable(project, draft);

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
          labels,
          parent_key: EPIC_KEY,
        },
      ],
    });
    return { id: ids[FEATURE_KEY]!, epicId: ids[EPIC_KEY]!, epicCreated: true };
  }

  const epicId = target.id.trim();
  if (!epicId) throw new DraftEpicError("no epic chosen — a feature must attach to one");

  const id = await withBeadWriteLock(project.repoPath, epicId, async () => {
    await assertEpicEligible(project, epicId, draft.feature.outcomeId.trim());
    return beads.create(project.repoPath, {
      title,
      type: feature.type,
      description: feature.description,
      labels,
      // Mirrored into bd's own field so `bd lint` and the board card read the same criteria the
      // description states. The graph path above has no such field and needs none — the plan schema
      // carries only the description, which is the home both readers check first.
      acceptance: feature.acceptance,
      deps: [`parent-child:${epicId}`],
    });
  });
  return { id, epicId, epicCreated: false };
}
