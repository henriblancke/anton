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
import { reviewTrajectory } from "./review-trajectory";
import {
  latestScanHealth,
  latestScanHealthVersion,
  NO_SCAN_HEALTH,
  scanHealthVersion,
  type ScanHealth,
} from "./scan-health";
import { attachPrUrl, githubBaseUrl } from "./git/remote";
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
  repoPath: string,
): string {
  return `${snapshotVersion}:${hygiene}:${scan}:${getSyncStatusToken(repoPath)}`;
}

export async function getBoardVersion(project: Project): Promise<string> {
  const [hygiene, scan] = await Promise.all([
    readHygieneVersion(project),
    readScanHealthVersion(project),
  ]);
  return boardVersion(issueSnapshotVersion(project.repoPath), hygiene, scan, project.repoPath);
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
  // The bead read (bd) and the anton.db reads (hygiene, scan health) are independent — run them
  // concurrently so the slowest sets the board's latency instead of their sum.
  const [{ beads: allBeads, version: snapshotVersion }, hygiene, scan] = await Promise.all([
    readAllIssues(project.repoPath, opts),
    readHygiene(project),
    readScanHealth(project),
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

  // Every run target the board holds — cards and standalone chips alike — rolled up into the
  // project's score trend (anton-tprv). Off the labels already in this snapshot: no per-card read.
  const trajectory = reviewTrajectory([...cardBeads, ...orphanTasks]);

  // Only the backlog is dependency-aware ordered (ready-first → rank → priority → createdAt); the
  // other columns are stage-based, so deps can't reorder across them — they keep insertion order.
  columns.backlog.sort(compareBacklogEpics);
  // Chips read the same way in every column (unread-first, then newest), independent of epic order.
  for (const stage of STAGES) standalone[stage].sort(compareStandalone);

  // Resolve PR links from the repo's origin remote (once) so `gh-<n>` refs become clickable.
  const base = await githubBaseUrl(project.repoPath);
  for (const stage of STAGES) {
    for (const epic of columns[stage]) {
      attachPrUrl(epic, base);
      for (const ticket of epic.tickets) attachPrUrl(ticket, base);
    }
    for (const item of standalone[stage]) attachPrUrl(item, base);
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
      project.repoPath,
    ),
    columns,
    standalone,
    hygiene,
    ...(trajectory ? { reviewTrajectory: trajectory } : {}),
    ...(scan ? { scanHealth: scan } : {}),
    // Read from the globalThis-anchored registry, so the API bundle sees passes run by the
    // instrumentation-started sync engine (see bd.ts).
    sync: getSyncStatus(project.repoPath),
  };
}
