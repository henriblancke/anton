/**
 * The board as the product-master pass has to see it (anton-d2sx): the tiers, the ordering edges,
 * the priorities, ages, sizes, review-score history and recent run outcomes — resolved here, in
 * code, rather than left to the session's own `bd` reads.
 *
 * WHAT the pass judges lives here; HOW to judge it lives in `skills/product-master/SKILL.md`, and
 * what it must say back lives in `report.ts`. Rendering is kept apart from both so a change to the
 * prompt's wording can never reach the protocol anton parses.
 */
import { beads, type Bead } from "../beads/bd";
import { isPipelineArtifact } from "../beads/contract";
import { indexBoard, isOpenWork, ticketOwnerOf, type BoardIndex } from "../gardener/board-index";
import { isProposalBead } from "../gardener/detections";
import type { RunSummary } from "../runs";
import { beadLines, MAX_GOAL_CHARS, type BeadFacts } from "./bead-line";
import { oneLine } from "./text";

/** How many run targets the context renders before it says what it dropped. */
export const MAX_CARDS = 60;
/** Per card — a feature with forty tickets is a shape problem, not a ranking input. */
export const MAX_TICKETS_PER_CARD = 12;
/** How many recent runs the outcome section carries. */
export const MAX_RUNS = 20;
/** Everything anton resolves for the pass rather than leaving to the session's own reads. */
export interface PmBoardInput extends BeadFacts {
  /** The whole board (`--status all`): declined proposals are closed, and tiers need closed beads. */
  board: Bead[];
  /** The project's recent runs, newest first — how the work that DID ship actually went. */
  runs?: RunSummary[];
}

/**
 * The board section of the pass's prompt.
 *
 * The pass runs unattended on a cron, so a board read it skips or truncates costs a proposal made
 * about half a board. It is also deliberately the ONLY board the session sees: it has no `bd`, which
 * is what makes "this session never writes to the board" a property of the session rather than a
 * promise in a prompt.
 *
 * That promise covers the SESSION and not the pass around it. The judgment reaches no board; the pass
 * that carries its answer files what it proposed and applies the kinds an operator armed at `apply`
 * (gardener/armed.ts) — so "it only proposes" is true here and false one level up.
 */
export function formatPmBoardContext(input: PmBoardInput): string {
  const index = indexBoard(input.board);
  const split = partitionBoard(index);
  return [
    `## Board context`,
    ``,
    `Everything below is anton's own read of this project's board, taken just now. It is the only`,
    `board you have — you cannot run \`bd\`, and nothing you write reaches it. Judge from this.`,
    ``,
    ...targetsSection(split, index, input),
    ...containersSection(split, index, input),
    ...looseSection(split, index, input),
    ...proposalsSection(input.board),
    ...runsSection(input.runs ?? []),
  ].join("\n");
}

/** The board split the way anton RUNS it: what is a run target, what rides one, what rides nothing. */
interface PmBoardSplit {
  /** Every open run target, in board order. */
  targets: Bead[];
  /** The open working-layer beads a given target carries, at any depth. */
  ticketsOf(id: string): Bead[];
  /**
   * The open epics that GROUP run targets rather than being one. Kept apart from `targets` because
   * anton never runs them — but they are the homes everything else hangs off, and an epic the pass
   * cannot see is one it can never weigh a feature against.
   */
  containers: Bead[];
  /** Open work no runnable target carries — nothing will ship it as it stands. */
  loose: Bead[];
}

/**
 * Who runs what, resolved through `beads.isRunTarget` and {@link ticketOwnerOf} — the SAME predicates
 * execute-epic and the approve route gate on — rather than through `index.cards`, which is narrower.
 *
 * The distinction is not cosmetic: `isBoardCard` restricts to epic/feature because the board renders
 * a parentless task/bug as a standalone chip instead of a card, but that bead is a run target and
 * anton will run it. Splitting on cards therefore filed every standalone target under "no board card
 * carries this" — telling the pass that a parentless P0 bug, the most urgent thing on the board, can
 * never ship, which is exactly the input that produces a kill proposal on the work anton runs next.
 */
function partitionBoard(index: BoardIndex): PmBoardSplit {
  const targetIds = runTargetIdsOf(index);
  const { tickets, containers, loose } = carriedWork(index, targetIds);
  const targets = index.all.filter((bead) => targetIds.has(bead.id));

  return {
    targets: targets.sort(byPriorityThenId),
    ticketsOf: (id) => (tickets.get(id) ?? []).sort(byPriorityThenId),
    containers: containers.sort(byPriorityThenId),
    loose: loose.sort(byPriorityThenId),
  };
}

/** The ids anton would RUN, in board order — the split every other bucket is defined against. */
function runTargetIdsOf(index: BoardIndex): Set<string> {
  const ids = new Set<string>();
  for (const bead of index.all) {
    if (!isRankable(bead)) continue;
    if (!beads.isRunTarget(bead, index.all)) continue;
    ids.add(bead.id);
  }
  return ids;
}

/** Everything that is not itself a run target: what each target carries, the homes, and the rest. */
function carriedWork(
  index: BoardIndex,
  targetIds: Set<string>,
): { tickets: Map<string, Bead[]>; containers: Bead[]; loose: Bead[] } {
  const tickets = new Map<string, Bead[]>();
  const containers: Bead[] = [];
  const loose: Bead[] = [];
  for (const bead of index.all) {
    if (!isRankable(bead) || targetIds.has(bead.id)) continue;
    // Plumbing coordinates work rather than being it; ranking or killing a gate is meaningless.
    if (isPipelineArtifact(bead)) continue;
    const owner = ticketOwnerOf(index, bead);
    if (owner && targetIds.has(owner.id)) {
      const carried = tickets.get(owner.id);
      if (carried) carried.push(bead);
      else tickets.set(owner.id, [bead]);
    } else if (index.isContainer(bead)) {
      containers.push(bead);
    } else {
      loose.push(bead);
    }
  }
  return { tickets, containers, loose };
}

/** Open work the pass may judge — a proposal is a bead ABOUT the board, not a piece of it. */
const isRankable = (bead: Bead): boolean => isOpenWork(bead) && !isProposalBead(bead);

/**
 * The run targets, each with the tickets it carries. Grouped by target rather than listed flat
 * because every question the pass answers is relational — is THIS ranked right against the things it
 * blocks, is THIS one bead doing several jobs — and a flat list of two hundred ids answers none of
 * them.
 */
function targetsSection(split: PmBoardSplit, index: BoardIndex, input: PmBoardInput): string[] {
  const shown = split.targets.slice(0, MAX_CARDS);
  return [
    ...targetsPreamble(),
    ...shown.flatMap((target) => targetBlock(target, split, index, input)),
    ...(shown.length === 0 ? [`(no open run targets)`] : []),
    ...droppedTargetsNotice(split.targets.length - shown.length),
    ``,
  ];
}

function targetsPreamble(): string[] {
  return [
    `### Run targets`,
    ``,
    `Each block is one run target — the unit anton actually runs — followed by the tickets it`,
    `carries. A block with no tickets under it runs as a single ticket, itself. \`blocked by\` is a`,
    `\`blocks\` edge the graph already records; \`under\` is the bead's parent — the home it hangs off`,
    `today — and \`shipped by\` names the run target that carries it when that is not the same bead.`,
    `Nesting runs to any depth here: a ticket filed under another ticket ships in the same run and`,
    `the same PR, so it is filed legitimately, not misfiled.`,
    ``,
    `\`goal:\` is what the bead states about itself, in its own words, cut at ${MAX_GOAL_CHARS} characters — the`,
    `rest of its contract (Context, Acceptance, Verify) is NOT in this prompt, so never read a cut`,
    `line as the whole of what a bead is for. It is also the only evidence a home judgment may rest`,
    `on: a bead with no \`goal:\` line has stated nothing to match, however suggestive its title.`,
    ``,
  ];
}

/** One run target and the tickets it ships, indented beneath it. */
function targetBlock(
  target: Bead,
  split: PmBoardSplit,
  index: BoardIndex,
  input: PmBoardInput,
): string[] {
  const tickets = split.ticketsOf(target.id);
  const dropped = tickets.length - MAX_TICKETS_PER_CARD;
  return [
    ...beadLines(target, index, input, ""),
    ...tickets.slice(0, MAX_TICKETS_PER_CARD).flatMap((t) => beadLines(t, index, input, "  ")),
    ...(dropped > 0 ? [`  - …and ${dropped} more ticket(s) under ${target.id}, not shown`] : []),
  ];
}

/** What the cap dropped, said outright — silence here reads as "the board holds nothing else". */
function droppedTargetsNotice(dropped: number): string[] {
  if (dropped <= 0) return [];
  return [
    ``,
    `${dropped} further run target(s) are NOT shown — this list is capped at`,
    `${MAX_CARDS}, most urgent (P0) first — the ones dropped are the LEAST urgent. Do not read their`,
    `absence as "the board holds nothing else".`,
  ];
}

/**
 * The epics that group run targets rather than being one. They run nothing themselves — anton runs
 * the features beneath them — so they are absent from every other section, which left the pass with
 * a board whose homes were invisible: it could see that a feature exists without ever seeing the
 * epics it might belong under, and a home nothing shows is a home nothing can weigh.
 */
function containersSection(split: PmBoardSplit, index: BoardIndex, input: PmBoardInput): string[] {
  if (split.containers.length === 0) return [];
  const shown = split.containers.slice(0, MAX_CARDS);
  const lines = [
    `### Container epics`,
    ``,
    `These GROUP run targets rather than being one, so anton never runs them directly and they carry`,
    `no tickets of their own. They are the homes the work above hangs off — judge them as groupings,`,
    `not as work to rank.`,
    ``,
    ...shown.flatMap((epic) => beadLines(epic, index, input, "", [carriesOf(epic, split, index)])),
  ];
  if (split.containers.length > shown.length) {
    lines.push(
      ``,
      `${split.containers.length - shown.length} further container epic(s) are NOT shown — this list is`,
      `capped at ${MAX_CARDS}, most urgent (P0) first — the ones dropped are the LEAST urgent.`,
    );
  }
  lines.push(``);
  return lines;
}

/** How much a container actually holds — an epic grouping nothing reads very differently from one grouping nine. */
const carriesOf = (epic: Bead, split: PmBoardSplit, index: BoardIndex): string => {
  const held = split.targets.filter((t) => t.id !== epic.id && index.isAncestor(epic.id, t.id));
  return `${held.length} open run target(s) beneath it`;
};

/**
 * Open working-layer beads no run target carries. Shown because they are still work the project is
 * holding — and flagged as unowned, because "give this a FIRST home" is the GARDENER's proposal, not
 * this pass's: without the flag a ranking judgment made about them would silently duplicate that
 * ask, and so would a `rehome` claim, whose question is a home that is WRONG rather than missing.
 */
function looseSection(split: PmBoardSplit, index: BoardIndex, input: PmBoardInput): string[] {
  if (split.loose.length === 0) return [];
  return [
    `### Work no run target carries`,
    ``,
    `These ride no run target, so nothing will ship them as they stand. Giving homeless work its`,
    `first home is the gardener pass's proposal, not yours — do not \`rehome\` them; rank, split or`,
    `kill them only on their own merits.`,
    ``,
    ...split.loose.slice(0, MAX_CARDS).flatMap((b) => beadLines(b, index, input, "")),
    ``,
  ];
}

/**
 * The proposals the board already carries — open ones and DECLINED ones alike, each with the
 * fingerprint that suppresses it.
 *
 * anton's own dedup would drop a repeat claim silently, which is correct but wasteful: a session that
 * spends its judgment re-deriving three asks already on the board found nothing new. Declined ones
 * matter more still — that is a human's recorded answer, and re-raising it is how an automated pass
 * teaches a founder to ignore it.
 */
function proposalsSection(board: Bead[]): string[] {
  const proposals = board.filter(isProposalBead);
  if (proposals.length === 0) return [];
  const open = proposals.filter(isOpenWork);
  const declined = proposals.filter((b) => beads.isAbandoned(b));
  return [
    `### Asks already on the board`,
    ``,
    `Do not report a claim that repeats one of these. A DECLINED one is a human's answer, not an`,
    `oversight — raising it again is how this pass earns being ignored.`,
    ``,
    ...open.map((b) => `- OPEN ${b.id} — ${oneLine(b.title ?? "")}`),
    ...declined.map((b) => `- DECLINED ${b.id} — ${oneLine(b.title ?? "")}`),
    ``,
  ];
}

/**
 * How the recent runs went. A ranking judgment made from the queue alone is blind to the thing that
 * most changes what should run next: whether the last few attempts at this area landed at all.
 */
function runsSection(runs: RunSummary[]): string[] {
  if (runs.length === 0) return [];
  return [
    `### Recent runs`,
    ``,
    `anton's own execution record, newest first — what has actually been attempted lately and how it`,
    `ended.`,
    ``,
    ...runs
      .slice(0, MAX_RUNS)
      .map((r) => `- ${r.epicBeadId}${r.ticketBeadId ? ` / ${r.ticketBeadId}` : ""} — ${r.status}`),
    ``,
  ];
}

/** Lowest priority number (most critical) first, then id — total, so two passes read one board alike. */
function byPriorityThenId(a: Bead, b: Bead): number {
  return (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id);
}
