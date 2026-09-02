/**
 * Assembles the Board from beads. Stage/approval/PR are derived — never stored. See DESIGN.md §2/§3.
 */
import { compareBacklogEpics } from "@/components/board/board-utils";
import { beads, getSyncStatus, getSyncStatusToken, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import { readAllIssues } from "./beads/issues";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "./epic-graph";
import {
  hygieneVersion,
  latestHygieneReport,
  latestHygieneVersion,
  NO_HYGIENE_REPORT,
  type HygieneReport,
} from "./hygiene";
import { issueSnapshotVersion, type SnapshotReadOptions } from "./beads/snapshot";
import { operatorQueue } from "./operator-queue";
import {
  isPlanStale,
  latestBoardPickerPlan,
  stampBoard,
  type BoardPickerPlan,
} from "./board-picker-plan";
import { boardProvenance, provenanceVersion } from "./board-provenance";
import { getDb } from "./db";
import {
  deferralVersion,
  latestDeclinedPicks,
  latestPickerDeferrals,
  pickerTrackRecord,
} from "./picker-veto";
import { reviewTrajectory } from "./review-trajectory";
import { isScheduleEnabled } from "./schedules";
import { upNextEntries, upNextVersion } from "./up-next";
import {
  latestScanHealth,
  latestScanHealthVersion,
  NO_SCAN_HEALTH,
  scanHealthVersion,
  type ScanHealth,
} from "./scan-health";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
import type { Policy } from "./policy/types";
import { getProjectSettings, resolvePickerAutonomy, resolvePickerPolicy } from "./projects";
import {
  boardCards,
  isRunTicket,
  parentEpicOf,
  parseAcceptance,
  parseGoal,
  toEpic,
  toStandaloneItem,
  toTicket,
} from "./ticket-view";
import {
  STAGES,
  type BeadProvenance,
  type Board,
  type Epic,
  type Project,
  type Stage,
  type StandaloneItem,
} from "./types";

// deriveStage lives in ticket-view.ts now; re-exported here for existing importers/tests.
export { deriveStage } from "./ticket-view";

/**
 * The board's freshness token. The gardener's report version rides in it beside the snapshot and
 * sync tokens (anton-uwal), so a fresh patrol breaks a poll that would otherwise 304 and the
 * hygiene panel updates on the same cadence as the cards. Compared as an opaque string, never
 * parsed — the hygiene part goes BEFORE the sync token, which ends in a free-text error message.
 */
function boardVersion(
  snapshotVersion: number,
  hygiene: string,
  scan: string,
  vetoes: string,
  provenance: string,
  upNext: string,
  repoPath: string,
): string {
  return `${snapshotVersion}:${hygiene}:${scan}:${vetoes}:${provenance}:${upNext}:${getSyncStatusToken(repoPath)}`;
}

export async function getBoardVersion(project: Project): Promise<string> {
  // The policy joins the plan on the poll path (not just the build): it is half the plan's freshness
  // fence, so saving a narrower one turns every live pick into history — the lane goes and
  // `[Release]` with it — while the bead snapshot, the plan row and the schedule all sit still. A
  // token blind to it would 304 the operator back onto the board they just invalidated.
  const [hygiene, scan, deferrals, plan, picker] = await Promise.all([
    readHygieneVersion(project),
    readScanHealthVersion(project),
    readDeferrals(project),
    readPickerPlan(project),
    readPickerStance(project),
  ]);
  return boardVersion(
    issueSnapshotVersion(project.repoPath),
    hygiene,
    scan,
    deferralVersion(deferrals),
    // Gated on OFFERING, exactly as the served board gates the marks themselves (`armedPlan` in
    // getBoard): a picker that is switched off — or running below the level that offers its picks —
    // carries no provenance, so letting a plan row written before that move the token would break a
    // 304 and serve back data the client already holds. The stance itself is covered separately by
    // upNextVersion, which is what makes a level change land on the next poll: moving between
    // `propose` and `shadow` touches neither a bead, nor the plan row, nor the policy.
    provenanceVersion(picker.offers ? plan : undefined, picker.policy),
    upNextVersion(picker.offers),
    project.repoPath,
  );
}

/**
 * The hygiene reads degrade to "never patrolled" on an anton.db failure instead of taking the board
 * down with them: the panel is advisory, while the board is where every run is approved. Logged, so
 * a broken db is visible in the server log rather than silently reading as a clean board.
 */
async function readHygiene(project: Project): Promise<HygieneReport | undefined> {
  try {
    return await latestHygieneReport(project.id);
  } catch (err) {
    console.error(`[board] hygiene report read failed for ${project.slug}`, err);
    return undefined;
  }
}

async function readHygieneVersion(project: Project): Promise<string> {
  try {
    return await latestHygieneVersion(project.id);
  } catch (err) {
    console.error(`[board] hygiene version read failed for ${project.slug}`, err);
    return NO_HYGIENE_REPORT;
  }
}

/** The scan-health reads degrade to "never scanned" for the same reason the hygiene ones do. */
async function readScanHealth(project: Project): Promise<ScanHealth | undefined> {
  try {
    return await latestScanHealth(project.id);
  } catch (err) {
    console.error(`[board] scan health read failed for ${project.slug}`, err);
    return undefined;
  }
}

/**
 * The picker vetoes in force (anton-jqvy), bead id → expiry. Degrades to "nothing deferred" on an
 * anton.db failure for the same reason the reads above do: a veto is pacing, and losing it must
 * never take the board — where every run is approved — down with it.
 *
 * Fed into the freshness token as the ACTIVE set rather than as a write stamp, so a window closing
 * moves the token on its own: an expiry is not a write, and a card left drawn as deferred after its
 * hold ran out is a card the operator would think anton had forgotten.
 */
async function readDeferrals(project: Project): Promise<Map<string, number>> {
  try {
    return await latestPickerDeferrals(project.id);
  } catch (err) {
    console.error(`[board] picker deferral read failed for ${project.slug}`, err);
    return new Map();
  }
}

/**
 * The picks of the recorded plan the operator has already vetoed — what retires a generation the
 * picker never got to rewrite (`isPlanStale`). Degrades to "none declined" like the reads above: the
 * worst a lost read costs is a plan that reads current for one more pass.
 */
async function readDeclinedPicks(project: Project, planId: string): Promise<Set<string>> {
  try {
    return await latestDeclinedPicks(project.id, planId);
  } catch (err) {
    console.error(`[board] picker decline read failed for ${project.slug}`, err);
    return new Set();
  }
}

/**
 * The picker's latest recorded plan — where a card's `◈ policy` provenance comes from (anton-cqxd).
 * Degrades to "the picker has never run here" on an anton.db failure, exactly as the reads above do:
 * a missing badge is a board with less explanation on it, a throw is no board at all.
 */
async function readPickerPlan(project: Project): Promise<BoardPickerPlan | undefined> {
  try {
    return await latestBoardPickerPlan(project.id);
  } catch (err) {
    console.error(`[board] picker plan read failed for ${project.slug}`, err);
    return undefined;
  }
}

/**
 * What the picker is doing on this project, as the board projects it: the policy `◈ policy` anchors
 * at, and whether the pass is OFFERING its picks at all.
 *
 * Two facts make one answer because the board asks one question. The schedule is the first half — a
 * ranking left on screen by a pass that stopped running is the one thing a shadow-mode lane must not
 * be. The resolved AUTONOMY is the second (PR #218 review): `propose` promises "ranks what could run
 * next · nothing is offered" in settings, and it is also where every unarmed project sits by default,
 * so a lane drawn from it would offer ranked cards, `[Release]` and vetoes — and RECORD those answers
 * into the track record `apply` is earned on — against a level that promised none of it. Only
 * `shadow` (offer and answer) and `apply` (offer and start) put picks on the board.
 *
 * Fail-soft to "offering" on each half independently — losing a read must not silently hide a lane
 * that is running, and the plan's own freshness fence still governs what it may claim.
 */
interface PickerStance {
  /** The policy armed on this machine, or undefined when the project has armed none. */
  policy?: Policy;
  /** The pass is running AND its level puts picks in front of the operator. */
  offers: boolean;
}

async function readPickerStance(project: Project): Promise<PickerStance> {
  const [scheduled, level] = await Promise.all([
    isScheduleEnabled(project.id, "board-picker").catch((err) => {
      console.error(`[board] picker schedule read failed for ${project.slug}`, err);
      return true;
    }),
    readPickerLevel(project),
  ]);
  return { ...level, offers: scheduled && level.offers };
}

/** The settings half of {@link readPickerStance} — the armed policy and the resolved autonomy. */
async function readPickerLevel(project: Project): Promise<PickerStance> {
  try {
    const db = getDb();
    // Two independent reads, so one round trip rather than two on every board view.
    const [settings, record] = await Promise.all([
      getProjectSettings(db, project.id),
      pickerTrackRecord(db, project.id),
    ]);
    // The EARNED floor rides along (`resolvePickerAutonomy`): a project demoted off `apply` lands on
    // `shadow`, which still offers — the lane is where the record that lifts it back is made.
    const autonomy = resolvePickerAutonomy(settings, record);
    const armed = resolvePickerPolicy(settings);
    return { ...(armed ? { policy: armed } : {}), offers: autonomy !== "propose" };
  } catch (err) {
    console.error(`[board] picker settings read failed for ${project.slug}`, err);
    return { offers: true };
  }
}

async function readScanHealthVersion(project: Project): Promise<string> {
  try {
    return await latestScanHealthVersion(project.id);
  } catch (err) {
    console.error(`[board] scan health version read failed for ${project.slug}`, err);
    return NO_SCAN_HEALTH;
  }
}

/** Standalone chips read newest-first within a stage, but a self-filed unread bug jumps ahead of
 * its read siblings so triage-worthy work surfaces above the "+N more" cap. */
function compareStandalone(a: StandaloneItem, b: StandaloneItem): number {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export async function getBoard(project: Project, opts?: SnapshotReadOptions): Promise<Board> {
  // The raw, unfiltered bead list. Keep it around for blocker readiness below: the standalone-blocker
  // helpers treat a blocker missing from the list as still-open (fail-safe), so readiness must be
  // derived against every bead — including intentionally-hidden types — or a `blocks` edge to an
  // already-closed `molecule` or a resolved `gate` would surface as a phantom open blocker (matches
  // the approve route, which gates on the same unfiltered read).
  // Read beads and their snapshot version together: a background refresh can land mid-build, so
  // stamping the response with a separately-read version would let it advance past the data served
  // here — the client would then poll that version, 304, and never see this board's data refreshed.
  // The bead read (bd) and the anton.db reads (hygiene, scan health, picker vetoes, the picker's
  // plan and policy) are independent — run them concurrently so the slowest sets the board's latency
  // instead of their sum.
  const [
    { beads: allBeads, version: snapshotVersion },
    hygiene,
    scan,
    deferrals,
    plan,
    picker,
  ] = await Promise.all([
    readAllIssues(project.repoPath, opts),
    readHygiene(project),
    readScanHealth(project),
    readDeferrals(project),
    readPickerPlan(project),
    readPickerStance(project),
  ]);

  // Only work items land on the board. Pipeline plumbing — a poured `molecule` root and the `gate`
  // beads hanging off it (isPipelineArtifact) — coordinates work without being work, so it never
  // renders as a card, a ticket or a chip.
  const workBeads = allBeads.filter((b) => !isPipelineArtifact(b));

  // Cards key off RUN TARGETS, not epic ids (docs/design/2026-07-26-tier-and-linear-ux.md): a
  // `feature` is what anton runs, a legacy epic with no feature children still runs as it always
  // did, and a container epic steps back to being the badge/swimlane key it can't be a card for
  // (approving it 422s). See isBoardCard.
  const cards = boardCards(workBeads);
  const cardBeads = workBeads.filter((b) => cards.ids.has(b.id));
  // The working layer: everything that is neither a card nor a container epic (a container groups
  // cards — it is never a ticket riding on one). Same predicate the run uses (see runTickets), so a
  // card never displays a ticket its run wouldn't execute.
  const workingBeads = workBeads.filter((b) => isRunTicket(b, cards));

  // Attribute each working-layer bead to its NEAREST card ancestor, from the inline `parent` field
  // — no per-card bd calls. Walking the chain (rather than joining on a single parent hop) is the
  // bug fix: a task under a feature matched neither the old epic-child join nor the parentless-chip
  // rule, so it vanished from the board entirely.
  const childrenByCard = new Map<string, Bead[]>(cardBeads.map((b) => [b.id, []]));
  const claimedTaskIds = new Set<string>();
  for (const bead of workingBeads) {
    const cardId = cards.cardOf(bead);
    if (!cardId) continue;
    childrenByCard.get(cardId)!.push(bead);
    claimedTaskIds.add(bead.id);
  }

  const columns: Record<Stage, Epic[]> = {
    backlog: [],
    implementing: [],
    "in-review": [],
    done: [],
  };
  const standalone: Record<Stage, StandaloneItem[]> = {
    backlog: [],
    implementing: [],
    "in-review": [],
    done: [],
  };

  // Derive epic→epic dependency rollup once (blockedBy/ready/rank), so the board reflects the
  // readiness the runtime's bd-ready enforces. Degrades to a stable order on a cycle (epic-graph.ts).
  //
  // Over `allBeads`, not the pipeline-stripped `workBeads`: the rollup's per-child readiness reads a
  // blocker missing from the list as still open (fail-safe), so stripping the gate beads would make
  // every RESOLVED gate — and every in-review target's own `gh:pr` merge gate, which `isOwnMergeWait`
  // can only recognise from the bead — read as a permanent open blocker, exactly the state
  // loadAllIssues reads gates to prevent. It adds no node and no edge: `isUnit` rejects gate/molecule
  // and the rollup attributes pipeline artifacts to no unit.
  const graphNodes = new Map(computeEpicGraph(allBeads).epics.map((n) => [n.id, n]));

  for (const card of cardBeads) {
    const children = childrenByCard.get(card.id) ?? [];
    const tickets = children.map(toTicket);
    const node = graphNodes.get(card.id);
    // The epic-graph rollup DROPS any blocks edge whose blocker is a parentless standalone task/bug
    // (it has no unit ancestor to attribute to). Fold those back in — the same set the approve route
    // gates on — so the board's blockedBy/ready match what approval will actually enforce and the
    // card doesn't show a not-ready run target as approvable.
    const blockedBy = [...(node?.blockedBy ?? []), ...epicStandaloneBlockers(allBeads, card.id)];
    // ^ allBeads (unfiltered) on purpose: a closed `molecule` or resolved `gate` blocker must
    //   resolve to done here, not read as a phantom open blocker via the missing-bead fail-safe.
    const built = toEpic(card, {
      goal: parseGoal(card),
      acceptance: parseAcceptance(card),
      tickets,
      // The raw children too: the card's contract marker covers the whole run (target + open
      // tickets), so it can't advertise Approve on a target one unshaped child would 422.
      children,
      blockedBy,
      ready: blockedBy.length === 0,
      // The finer verdict beside that coarse flag (anton-nywj): which of the run's tickets are
      // actually held. It needs no standalone fold-back — the rollup gates an unattributable blocker
      // on the blocker itself, exactly as epicStandaloneBlockers does — so it already answers for
      // every blocker `blockedBy` above collects, one ticket at a time.
      childReadiness: node?.childReadiness,
      readyChildren: node?.readyChildren,
      blockedChildren: node?.blockedChildren,
      rank: node?.rank ?? 0,
      // The product epic above this card — the key the board's epic swimlanes group on.
      epic: parentEpicOf(card, workBeads),
    });
    columns[built.stage].push(built);
  }

  // Parentless tasks/bugs are standalone run targets (epic-of-one), not fake epics: they land as
  // typed chips at the foot of their stage column, carrying their real issue_type. Only RUNNABLE
  // parentless beads become chips (beads.isRunTarget — task/bug only): a parentless `learning`/
  // `chore`/etc. is not a run target, so a chip for it would advertise `Approve & run` yet the
  // approve route + runner reject it via the same isRunTarget gate — a permanent 422/park. Gate
  // here so the board never surfaces an item it can't actually run.
  const orphanTasks = workingBeads.filter(
    (t) => !claimedTaskIds.has(t.id) && beads.isRunTarget(t, workBeads),
  );
  for (const task of orphanTasks) {
    // A standalone target never appears in the epic-graph rollup, so derive its blockers from its
    // own `blocks` edges — the same set the approve route + runner gate on. Feeds the chip's
    // ready/blockedBy so it can hide Approve & run and show a blocked chip while a prerequisite is open.
    const item = toStandaloneItem(task, standaloneBlockers(allBeads, task.id));
    standalone[item.stage].push(item);
  }

  for (const stage of STAGES) {
    if (!columns[stage]) columns[stage] = [];
    if (!standalone[stage]) standalone[stage] = [];
  }

  // The operator's own queue (anton-qfso.1): the approved `agent:human` beads anton refuses to
  // dispatch. Derived from the SAME snapshot as the cards — excluding this work from the agent queue
  // must not cost a read to find it again.
  const humanWork = operatorQueue(workBeads);

  // Every run target the board holds — cards and standalone chips alike — rolled up into the
  // project's score trend (anton-tprv). Off the labels already in this snapshot: no per-card read.
  const trajectory = reviewTrajectory([...cardBeads, ...orphanTasks]);

  // Only the backlog is dependency-aware ordered (ready-first → rank → priority → createdAt); the
  // other columns are stage-based, so deps can't reorder across them — they keep insertion order.
  columns.backlog.sort(compareBacklogEpics);
  // Chips read the same way in every column (unread-first, then newest), independent of epic order.
  for (const stage of STAGES) standalone[stage].sort(compareStandalone);

  // The plan, only while a pass is actually keeping it AND offering it (`readPickerStance`): a
  // project whose `board-picker` schedule was switched off — or whose level is `propose`, which
  // promises a ranking and nothing else — keeps its last recorded plan in the db, and reading it here
  // would badge every old entry `◈ policy`. That badge is what `[Release]` is derived from
  // (isPickerPick), so ordinary Backlog cards would go on offering to record accepts against a pass
  // that no longer runs, or a level that never asked.
  const armedPlan = picker.offers ? plan : undefined;
  // Does the recorded plan still describe the decision anton would make NOW? Asked ONCE, over every
  // input to that decision — the beads and the armed policy, which stampBoard folds in together, plus
  // the deferrals, whose expiry no digest can see (isPlanStale). So an operator narrowing
  // `pickerPolicy` without touching a bead invalidates the plan, and so does a hold running out on a
  // target the pass set aside — or on one it picked, when no pass ran to record the exclusion.
  //
  // Every live claim the board makes about the picker reads this one answer: the Up Next lane
  // (withheld whole rather than presented as a current ranking) and the `[Release]` derived from the
  // provenance badge. They must not disagree — a lane that vanished while its button stayed would go
  // on offering a start against a decision anton has already stopped standing behind.
  //
  // The declines are read here rather than beside the deferrals above because the question is about
  // ONE generation — it needs the plan id the read above returns.
  const declined = armedPlan ? await readDeclinedPicks(project, armedPlan.planId) : undefined;
  const planIsStale =
    armedPlan !== undefined &&
    isPlanStale(armedPlan, stampBoard(allBeads, Date.now(), picker.policy), deferrals, declined);
  // Who touched each bead and why (anton-cqxd), joined once over the whole board: the picker's
  // recorded plan and the product master's own proposals, which are ordinary beads in this snapshot.
  // A stale plan still badges — the rule a target WAS picked under does not stop being true — but
  // the mark carries `stale`, so what survives staleness is the badge and not the button.
  const provenance = boardProvenance({
    board: allBeads,
    plan: armedPlan,
    policy: picker.policy,
    planIsStale,
  });
  // The Up Next lane's input (anton-t9m4). The lane holds a stricter standard than the badge beside
  // it: a badge records the rule a target WAS picked under (history), while the lane claims this is
  // the order anton would start work in NOW — so a stale plan is withheld whole. Deferrals are
  // subtracted for the same reason: a target vetoed since the pass ran is not up next.
  const currentPlan = planIsStale ? undefined : armedPlan;
  const upNext = upNextEntries(allBeads, currentPlan, deferrals);
  // A DONE target is never badged: provenance answers "should this run?", and a shipped run has
  // stopped asking. Off the stage rather than the card, so the rule holds for chips too.
  const marksFor = (stage: Stage, id: string): BeadProvenance[] | undefined =>
    stage === "done" ? undefined : provenance.get(id);

  // Resolve PR links from the repo's origin remote (once) so `gh-<n>` refs become clickable.
  const base = await githubBaseUrl(project.repoPath);
  for (const stage of STAGES) {
    for (const epic of columns[stage]) {
      attachPrUrl(epic, base);
      // A vetoed target reads as SET ASIDE on the board, never as silently missing (anton-jqvy).
      const held = deferrals.get(epic.id);
      if (held !== undefined) epic.notNowUntil = held;
      const marks = marksFor(stage, epic.id);
      if (marks?.length) epic.provenance = marks;
      for (const ticket of epic.tickets) attachPrUrl(ticket, base);
    }
    for (const item of standalone[stage]) {
      attachPrUrl(item, base);
      const held = deferrals.get(item.id);
      if (held !== undefined) item.notNowUntil = held;
      const marks = marksFor(stage, item.id);
      if (marks?.length) item.provenance = marks;
    }
  }

  return {
    projectSlug: project.slug,
    // Pin the freshness token to the snapshot version the served beads carry (not a re-read of the
    // live version), so a poll on this token only 304s while this exact data is still current. Same
    // reasoning for the hygiene and scan parts: they name what is served below, not whatever is
    // newest now.
    version: boardVersion(
      snapshotVersion,
      hygieneVersion(hygiene),
      scanHealthVersion(scan),
      deferralVersion(deferrals),
      provenanceVersion(armedPlan, picker.policy),
      upNextVersion(picker.offers),
      project.repoPath,
    ),
    columns,
    standalone,
    operatorQueue: humanWork,
    // Length, not existence: a plan every entry drops out of (the bead left the snapshot, or every
    // pick is vetoed) projects an EMPTY lane, and `Board.upNext` promises absent-never-empty — an
    // "Up Next" heading over nothing reads as "anton has nothing to start".
    // The generation rides with the lane it projects: a card's veto names the decision it was drawn
    // from, so a tab a later pass has overtaken records no pick rather than a stranger's.
    ...(upNext?.length && currentPlan ? { upNext, upNextPlanId: currentPlan.planId } : {}),
    hygiene,
    ...(trajectory ? { reviewTrajectory: trajectory } : {}),
    ...(scan ? { scanHealth: scan } : {}),
    // Read from the globalThis-anchored registry, so the API bundle sees passes run by the
    // instrumentation-started sync engine (see bd.ts).
    sync: getSyncStatus(project.repoPath),
  };
}
