/**
 * The anton↔claude protocol for the product-master pass (anton-d2sx): the board as a judgment
 * session needs to see it, the machine-readable report format demanded of it, and the claims parsed
 * back out of its final message.
 *
 * Mirrors review-context.ts and its discipline: the report format is DEFINED here
 * ({@link pmReportFormatSection}) and PARSED here ({@link parsePmReport}), so swapping the pass's
 * reasoning contract — an operator prompt, a rewritten skill — can never break the protocol the job
 * relies on. HOW to judge lives in `skills/product-master/SKILL.md`; WHAT to judge and how to say it
 * live here.
 *
 * The session emits CLAIMS, not beads. A fingerprint is a sha1 of a canonical key and dedup, capping
 * and provenance are mechanical — asking an LLM to produce them would be asking it to be a hash
 * function, and one wrong digit files a duplicate ask forever. So the session's whole output is
 * judgment, and {@link detectionsFor} turns it into the same {@link GardenerDetection} values the
 * gardener's own detectors produce, after checking every claim against the board it was made about.
 */
import { beads, labelValueOf, type Bead } from "../beads/bd";
import { goalBody, isAuthoredBody, isPipelineArtifact, preambleOf } from "../beads/contract";
import { loadSkill } from "../claude/prompt";
import { homeWrongTier, HOME_STANDING } from "../gardener/apply-plan";
import {
  ageInDays,
  indexBoard,
  isClaimed,
  isInFlight,
  isOpenWork,
  runClaimOf,
  ticketOwnerOf,
  type BoardIndex,
} from "../gardener/board-index";
import { isProposalBead, makeDetection, type GardenerDetection } from "../gardener/detections";
import { resolveProductMasterConfig, type ProjectSettings } from "../projects";
import type { RunSummary } from "../runs";

/**
 * The claim classes the session may report, as they appear on the wire, and the detection kind each
 * becomes. Two of them are the "reprioritize" the feature's Acceptance names — a priority delta and
 * a missing ordering edge are one product question but two different board writes, so they are two
 * wire kinds rather than one whose meaning depends on which field happens to be present.
 */
export const CLAIM_KINDS = {
  reprioritize: "mispriority",
  order: "missing-order",
  rehome: "misfiled",
  split: "oversized",
  kill: "low-value",
} as const;

export type ClaimKind = keyof typeof CLAIM_KINDS;

/** What every claim carries whatever it asks for. */
interface PmClaimBase {
  /** The bead the claim is about. */
  bead: string;
  summary: string;
  evidence: string[];
}

/** `reprioritize`: the priority the bead should carry, as `P0`…`P4`. */
export type PmClaimReprioritize = PmClaimBase & { kind: "reprioritize"; priority: string };
/** `order`: the bead that has to land first. */
export type PmClaimOrder = PmClaimBase & { kind: "order"; blockedBy: string };
/**
 * `rehome`: the bead the subject should hang under — the epic a feature belongs to, or the card that
 * should carry a ticket. One field for both cases, because they are one claim about one relation;
 * which tier is legal is the board's answer, not the session's ({@link rehomeRefusal}).
 */
export type PmClaimRehome = PmClaimBase & { kind: "rehome"; home: string };
/** `split`: the decomposition sketch, one line per proposed ticket. */
export type PmClaimSplit = PmClaimBase & { kind: "split"; pieces: string[] };
/** `kill`: the ask is the bead itself, so the evidence is all there is. */
export type PmClaimKill = PmClaimBase & { kind: "kill" };

/**
 * One judgment the session reported, before anything has checked it against the board.
 *
 * A union rather than one shape with optional fields, because the per-kind field is what the claim
 * IS: a `rehome` without a home has nothing anton could write. {@link toClaim} is the only producer
 * and refuses an entry missing it, so every reader downstream sees the guarantee at its own site
 * instead of inheriting it from a call site two files away.
 */
export type PmClaim =
  | PmClaimReprioritize
  | PmClaimOrder
  | PmClaimRehome
  | PmClaimSplit
  | PmClaimKill;

/**
 * How a pass broke the protocol. Deliberately NOT folded into "no proposals": a session that never
 * reported, or whose report anton could not read, has told us nothing about the board — and an empty
 * report is the pass's most common LEGITIMATE answer, so the two must never be confused. One would
 * make a healthy board indistinguishable from a broken pass.
 */
export type PmProtocolViolation = "no-report" | "malformed-proposals" | "trailing-content";

export type PmReportResult =
  | { ok: true; claims: PmClaim[] }
  | { ok: false; violation: PmProtocolViolation };

/** A claim the board refused, with the reason — reported, never silently dropped. */
export interface RejectedClaim {
  claim: PmClaim;
  reason: string;
}

export interface DetectionsResult {
  detections: GardenerDetection[];
  rejected: RejectedClaim[];
}

/** Which reasoning contract the pass ran with — reported for the session log and the precedence test. */
export interface PmReasoningSource {
  kind: "prompt" | "default";
}

/**
 * The full prompt handed to the pass: the reasoning contract, then the concrete board, then the
 * report protocol.
 *
 * Precedence mirrors the reviewer's (anton-3apm): the operator's `productMasterPrompt` replaces
 * anton's shipped `product-master` skill, and anton appends the board beneath whichever ran. No
 * named-agent tier here, unlike the reviewer: anton's bundled specialists are IMPLEMENTERS, and one
 * swapped in as the product judgment would arrive with instructions to write code.
 *
 * The board section and the report protocol are anton's either way — an operator prompt is free to
 * restyle the judgment, and must not be able to change what the pass is judging or how anton reads
 * its answer.
 */
export async function buildProductMasterPrompt(args: {
  settings: ProjectSettings;
  board: PmBoardInput;
}): Promise<{ prompt: string; reasoningFrom: PmReasoningSource }> {
  const config = resolveProductMasterConfig(args.settings);
  const reasoning = config.prompt ?? (await loadSkill("product-master"));
  const reasoningFrom: PmReasoningSource = { kind: config.prompt ? "prompt" : "default" };
  const prompt = [
    reasoning,
    ``,
    `---`,
    ``,
    formatPmBoardContext(args.board),
    ``,
    pmReportFormatSection(),
  ].join("\n");
  return { prompt, reasoningFrom };
}

// ── the board section ──

/** How many run targets the context renders before it says what it dropped. */
export const MAX_CARDS = 60;
/** Per card — a feature with forty tickets is a shape problem, not a ranking input. */
export const MAX_TICKETS_PER_CARD = 12;
/** How many recent runs the outcome section carries. */
export const MAX_RUNS = 20;
/**
 * How much of one bead's stated goal rides along. Enough to weigh two contracts against each other,
 * far short of quoting them: the cap is per bead and the board is capped at hundreds, so the whole
 * contract of every bead is a prompt nothing could read.
 */
export const MAX_GOAL_CHARS = 240;
/** How many score rounds one bead's series shows, newest last. */
export const MAX_SCORE_ROUNDS = 6;

/** Everything anton resolves for the pass rather than leaving to the session's own reads. */
export interface PmBoardInput {
  /** The whole board (`--status all`): declined proposals are closed, and tiers need closed beads. */
  board: Bead[];
  /**
   * Per-bead review-score series, oldest first — the anton-3apm round comments, replayed by the job.
   * Absent for a bead nobody reviewed, which is not the same as a bead that scored zero.
   */
  scores?: Map<string, number[]>;
  /** The project's recent runs, newest first — how the work that DID ship actually went. */
  runs?: RunSummary[];
  /** ms epoch, so a fixture board dates deterministically. */
  now: number;
}

/**
 * The board section of the pass's prompt: the tiers, the ordering edges, the priorities, ages, sizes,
 * review-score history and recent run outcomes — resolved here, in code, rather than left to the
 * session's own `bd` reads.
 *
 * The pass runs unattended on a cron, so a board read it skips or truncates costs a proposal made
 * about half a board. It is also deliberately the ONLY board the session sees: it has no `bd`, which
 * is what makes "this pass never writes to the board" a property of the session rather than a promise
 * in a prompt.
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
  const targets: Bead[] = [];
  const targetIds = new Set<string>();
  for (const bead of index.all) {
    if (!isOpenWork(bead) || isProposalBead(bead)) continue;
    if (!beads.isRunTarget(bead, index.all)) continue;
    targets.push(bead);
    targetIds.add(bead.id);
  }

  const tickets = new Map<string, Bead[]>();
  const containers: Bead[] = [];
  const loose: Bead[] = [];
  for (const bead of index.all) {
    if (!isOpenWork(bead) || isProposalBead(bead) || targetIds.has(bead.id)) continue;
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

  return {
    targets: targets.sort(byPriorityThenId),
    ticketsOf: (id) => (tickets.get(id) ?? []).sort(byPriorityThenId),
    containers: containers.sort(byPriorityThenId),
    loose: loose.sort(byPriorityThenId),
  };
}

/**
 * The run targets, each with the tickets it carries. Grouped by target rather than listed flat
 * because every question the pass answers is relational — is THIS ranked right against the things it
 * blocks, is THIS one bead doing several jobs — and a flat list of two hundred ids answers none of
 * them.
 */
function targetsSection(split: PmBoardSplit, index: BoardIndex, input: PmBoardInput): string[] {
  const shown = split.targets.slice(0, MAX_CARDS);
  const lines: string[] = [
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
  for (const target of shown) {
    lines.push(...beadLines(target, index, input, ""));
    const tickets = split.ticketsOf(target.id);
    for (const ticket of tickets.slice(0, MAX_TICKETS_PER_CARD)) {
      lines.push(...beadLines(ticket, index, input, "  "));
    }
    const dropped = tickets.length - MAX_TICKETS_PER_CARD;
    if (dropped > 0) lines.push(`  - …and ${dropped} more ticket(s) under ${target.id}, not shown`);
  }
  if (shown.length === 0) lines.push(`(no open run targets)`);
  if (split.targets.length > shown.length) {
    lines.push(
      ``,
      `${split.targets.length - shown.length} further run target(s) are NOT shown — this list is capped at`,
      `${MAX_CARDS}, lowest priority first. Do not read their absence as "the board holds nothing else".`,
    );
  }
  lines.push(``);
  return lines;
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
      `capped at ${MAX_CARDS}, lowest priority first.`,
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
 * One bead as the pass reads it: the facts a ranking, sizing or value judgment rests on, and — on
 * its own second line — what the bead says it is FOR ({@link goalOf}).
 */
function beadLines(
  bead: Bead,
  index: BoardIndex,
  input: PmBoardInput,
  indent: string,
  extras: (string | undefined)[] = [],
): string[] {
  const facts = [
    `[${bead.issue_type ?? "task"}]`,
    `P${bead.priority ?? "?"}`,
    sizeOf(bead),
    ageOf(bead, input.now),
    homeOf(bead, index),
    shippedBy(bead, index),
    blockedByOf(bead, index),
    ...extras,
    scoresOf(bead, input.scores),
    ownedBy(bead, input.now),
    beads.isDeferred(bead) ? "deferred" : undefined,
  ].filter((f): f is string => f !== undefined);
  const lines = [`${indent}- ${bead.id} ${facts.join(" · ")} — ${oneLine(bead.title ?? "")}`];
  const goal = goalOf(bead);
  if (goal) lines.push(`${indent}  goal: ${goal}`);
  return lines;
}

/**
 * What the bead states it is FOR, in its own words — the one contract field a home judgment cannot
 * be made without.
 *
 * The pass is required to match two beads' CONTRACTS and forbidden to judge a home from their names
 * (skills/product-master/SKILL.md: "naming is not evidence"), so a context carrying only titles left
 * it two answers and both were wrong — omit every home claim, or guess from the shape of the words.
 *
 * Its `## Goal` where the bead states one, else the description's opening prose: an unshaped bead
 * still says something about itself, and a reader that knew only the heading rendered nothing at all
 * for it. Excerpted rather than quoted whole — see {@link MAX_GOAL_CHARS}.
 *
 * AUTHORED text only ({@link isAuthoredBody}). `goalBody` returns the formula's `TODO — …` prompt
 * when nothing is written, because a view must show the operator the placeholder its "no goal yet"
 * marker is about — but this line is quoted to the pass as the bead's own contract text and as the
 * only evidence a home claim may rest on, so rendering the scaffold would let a home be proposed on
 * words the approval gate itself treats as missing. Omitted instead, which reads correctly: a bead
 * with no `goal:` line has stated nothing to match.
 */
const goalOf = (bead: Bead): string | undefined => {
  const description = typeof bead.description === "string" ? bead.description : "";
  const authored = [goalBody(bead), preambleOf(description)].find(isAuthoredBody);
  const text = oneLine(authored ?? "");
  if (!text) return undefined;
  return text.length > MAX_GOAL_CHARS ? `${text.slice(0, MAX_GOAL_CHARS)}…` : text;
};

/**
 * "A run owns this", in both halves — a published lease, and the claim a lease has not caught up to
 * yet. Shown because a proposal against either is refused at filing time ({@link subjectRefusal},
 * {@link rehomeRefusal}); a session that cannot see the claim spends its judgment on asks the board
 * will throw away.
 */
const ownedBy = (bead: Bead, nowMs: number): string | undefined => {
  if (isInFlight(bead, nowMs)) return "IN FLIGHT — a run owns it, do not propose against it";
  if (isClaimed(bead)) {
    return `CLAIMED by ${runClaimOf(bead)} — a run has picked it up, do not propose against it`;
  }
  return undefined;
};

const sizeOf = (bead: Bead): string | undefined => {
  const size = labelValueOf(bead.labels, "size");
  return size ? `size:${size}` : undefined;
};

const ageOf = (bead: Bead, nowMs: number): string | undefined => {
  const days = ageInDays(bead, nowMs);
  return days === undefined ? undefined : `${days}d since last write`;
};

/**
 * Where the bead hangs today, named rather than implied by the nesting: a feature's epic, a ticket's
 * card. Rendered with the parent's TITLE because an id alone does not say what a home is for, and the
 * only judgment worth making about a home is whether the work belongs in it.
 *
 * A bead with NO parent says so in those words rather than rendering blank. `rehome` is a claim about
 * a home that is WRONG and anton refuses one about a bead that has none ({@link rehomeRefusal}) —
 * first homes are the gardener's ask. The loose section says that for the work IT covers, but a
 * parentless task/bug is a run target and renders as one, so silence there read as a home the pass
 * had merely not been told.
 */
const homeOf = (bead: Bead, index: BoardIndex): string => {
  const parentId = beads.parentOf(bead);
  // Parenthesised, not em-dashed: the em dash is what separates the facts from the title.
  if (!parentId) return `under nothing (no home to be the wrong one)`;
  const parent = index.byId.get(parentId);
  // A parent absent from a full-board read is a dangling pointer; naming the id is still the truth.
  if (!parent) return `under ${parentId} (not on the board)`;
  return `under ${parent.id} "${oneLine(parent.title ?? "")}"`;
};

/**
 * The run target that will actually SHIP this bead, whenever that is not its own parent — resolved
 * through {@link ticketOwnerOf}, the same attribution the runner and the board use.
 *
 * bd nesting runs to any depth: under `feature → task → subtask` the subtask rides the FEATURE's run
 * and its PR. Its parent is therefore a bead no `rehome` could ever name as a home (a ticket's home
 * must be a card, {@link homeWrongTier}) — so a line showing only the parent read as a ticket hanging
 * off a non-card, and the repair for that appearance is a proposal to flatten nesting somebody meant.
 */
const shippedBy = (bead: Bead, index: BoardIndex): string | undefined => {
  const owner = ticketOwnerOf(index, bead);
  if (!owner || owner.id === beads.parentOf(bead)) return undefined;
  return `shipped by ${owner.id} "${oneLine(owner.title ?? "")}"`;
};

const blockedByOf = (bead: Bead, index: BoardIndex): string | undefined => {
  const blockers = index.all
    .filter((other) => other.id !== bead.id && index.recordsBlocker(bead.id, other.id))
    .map((b) => b.id);
  return blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : undefined;
};

/**
 * The bead's review-score series — the single strongest piece of evidence the pass has, and the one
 * thing a board read alone cannot produce (it lives in the round comments anton-3apm appends).
 */
const scoresOf = (bead: Bead, scores: PmBoardInput["scores"]): string | undefined => {
  const series = scores?.get(bead.id);
  if (!series?.length) return undefined;
  const shown = series.slice(-MAX_SCORE_ROUNDS);
  const prefix = series.length > shown.length ? "…," : "";
  return `review scores ${prefix}${shown.join(",")}`;
};

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

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// ── the report protocol ──

/**
 * The wire format, demanded by anton rather than by the (swappable) reasoning contract — so an
 * operator prompt that has never heard of anton still emits claims this module can parse. Hence the
 * explicit "even if your instructions above say otherwise": the contract above owns the judgment,
 * this section owns the protocol.
 */
export function pmReportFormatSection(): string {
  return [
    `## Reporting format (required)`,
    ``,
    `End your final message with a fenced json block — nothing after it — in exactly this shape,`,
    `even if your instructions above describe a different format:`,
    ``,
    "```json",
    `{"proposals":[{"kind":"reprioritize","bead":"<id>","priority":"P0"|"P1"|"P2"|"P3"|"P4","summary":"one line: what is wrong and what the move does","evidence":["a fact naming the ids/scores it rests on"]}]}`,
    "```",
    ``,
    `\`proposals\` is MANDATORY: an array. **An empty array is the expected answer on a healthy**`,
    `**board** — report \`{"proposals":[]}\` and stop. Anything that is not an array of well-formed`,
    `entries — a null, an object, one garbled entry — is a protocol violation and parks the pass,`,
    `because anton cannot tell a healthy board from a report it failed to read.`,
    ``,
    `Every entry carries \`kind\`, \`bead\` (the id the claim is about), a non-empty one-line`,
    `\`summary\`, and a non-empty \`evidence\` array of one-line strings. Each \`kind\` adds one field:`,
    ``,
    `- \`"reprioritize"\` — \`priority\`: the priority the bead should carry, \`P0\`…\`P4\`. It must`,
    `  differ from the one the board context shows.`,
    `- \`"order"\` — \`blockedBy\`: the id of the bead that has to land FIRST. This is the other half of`,
    `  reprioritizing: it records an ordering the graph is missing rather than changing a number.`,
    `- \`"rehome"\` — \`home\`: the id of the bead this one should hang under — the epic a feature`,
    `  belongs to, or the card that should carry a ticket. One kind for both. anton refuses a home`,
    `  that is already the parent, that is not on the board, that a run owns, and one the tier`,
    `  taxonomy will not let carry this bead: a ticket hangs off a board card, a card off a container`,
    `  epic (an epic that already groups cards), and nothing hangs off its own descendant. It also`,
    `  refuses a SUBJECT the context shows as hanging \`under nothing\`: this claim is about a home`,
    `  that is wrong, and a first home is the gardener pass's ask.`,
    `- \`"split"\` — \`pieces\`: the decomposition sketch, one short line per proposed ticket, at least`,
    `  two. A split with no sketch is not actionable and anton drops it.`,
    `- \`"kill"\` — no extra field. Approving it DEFERS the bead: out of the ready set, contract`,
    `  intact, reversible with \`bd undefer\`.`,
    ``,
    `One entry per claim, and at most one claim per bead per kind — anton fingerprints each claim by`,
    `what it is ABOUT, so two entries saying the same thing become one ask either way.`,
    ``,
    `anton CHECKS every claim against the board before filing it: a bead that is not there, a run`,
    `that owns it, a priority equal to the one it already has, an ordering edge the graph already`,
    `records. A rejected claim is reported to the founder as a claim anton refused, so name real ids`,
    `from the board context above and nothing else.`,
    ``,
    `"Nothing after it" is MANDATORY too: the block must be the last thing in the message. Any`,
    `trailing text — a closing remark, a correction, a retraction — is a protocol violation, because`,
    `anton cannot tell a courtesy sign-off from a report you just took back. If you change your mind,`,
    `emit a new report block last; do not amend one in prose.`,
  ].join("\n");
}

/**
 * The claim block a session is asked to end its message with: the LAST fenced ```json block that
 * looks like a report. Unrelated json blocks (a bead body the session quoted) are skipped.
 *
 * Strict for the same reason `parseReviewFindings` is. `{"proposals":null}` and a list with one
 * garbled entry both look exactly like a report whose claim got mangled, and reading either as "the
 * board is healthy" is how a pass reports a clean bill of health it never reached. Scanning stops at
 * the first report-shaped block from the end — including a BROKEN one — so an earlier draft can never
 * stand in for a report the session withdrew, and the chosen block must actually END the message.
 */
export function parsePmReport(text: string | undefined): PmReportResult {
  if (!text) return { ok: false, violation: "no-report" };

  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[i][1]);
    } catch {
      // A block that tried to be the report and failed IS the report — a malformed one.
      if (/"proposals"\s*:/.test(blocks[i][1])) {
        return { ok: false, violation: "malformed-proposals" };
      }
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || !("proposals" in parsed)) continue;

    const block = blocks[i];
    if (text.slice((block.index ?? 0) + block[0].length).trim()) {
      return { ok: false, violation: "trailing-content" };
    }

    const raw = (parsed as { proposals: unknown }).proposals;
    if (!Array.isArray(raw)) return { ok: false, violation: "malformed-proposals" };
    const claims = raw.map(toClaim);
    if (claims.some((c) => c === undefined)) return { ok: false, violation: "malformed-proposals" };
    return { ok: true, claims: claims as PmClaim[] };
  }
  return { ok: false, violation: "no-report" };
}

/** One wire entry as a claim, or undefined when it is not a usable one. */
function toClaim(entry: unknown): PmClaim | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const raw = entry as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !(kind in CLAIM_KINDS)) return undefined;

  const bead = str(raw.bead);
  const summary = str(raw.summary);
  if (!bead || !summary) return undefined;
  const evidence = lines(raw.evidence);
  if (!evidence?.length) return undefined;

  const base: PmClaimBase = { bead, summary, evidence };
  switch (kind as ClaimKind) {
    case "reprioritize": {
      const priority = str(raw.priority);
      if (!priority || !/^P[0-4]$/.test(priority)) return undefined;
      return { ...base, kind: "reprioritize", priority };
    }
    case "order": {
      const blockedBy = str(raw.blockedBy);
      return blockedBy ? { ...base, kind: "order", blockedBy } : undefined;
    }
    case "rehome": {
      // A home claim names two beads, and the second is the whole content of the ask: "this is
      // misfiled" with no home to move it to has nothing anton could ever write.
      const home = str(raw.home);
      return home ? { ...base, kind: "rehome", home } : undefined;
    }
    case "split": {
      const pieces = lines(raw.pieces);
      // Two is the smallest decomposition there is; one "piece" is the ticket restated.
      return pieces && pieces.length >= 2 ? { ...base, kind: "split", pieces } : undefined;
    }
    case "kill":
      return { ...base, kind: "kill" };
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? oneLine(value) : undefined;

const lines = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(str).filter((s): s is string => s !== undefined);
  return out.length === value.length ? out : undefined;
};

// ── claims → detections ──

/**
 * Turn the session's claims into detections, dropping every one the board refuses.
 *
 * This check is not defensive padding — it is the seam between a language model's judgment and a
 * write to the founder's board. A claim naming a bead that does not exist, or one a run is shipping
 * right now, would otherwise become a proposal that can only ever refuse at approve time; and a
 * priority "change" to the value the bead already carries is an ask with no content. Each rejection
 * is returned with its reason so the job can report it rather than swallow it — a pass whose claims
 * were all refused looks exactly like a healthy board unless somebody says otherwise.
 *
 * What it deliberately does NOT re-judge is the product question. Whether a bead is worth killing is
 * the session's call, and second-guessing it here would put the judgment in two places.
 */
export function detectionsFor(claims: PmClaim[], board: Bead[], nowMs: number): DetectionsResult {
  const index = indexBoard(board);
  const detections: GardenerDetection[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of claims) {
    const checked = subjectChecked(claim, index, nowMs);
    const refusal =
      "refusal" in checked ? checked.refusal : kindRefusal(claim, checked.subject, index, nowMs);
    if (refusal) {
      rejected.push({ claim, reason: refusal });
      continue;
    }
    detections.push(detectionFor(claim));
  }
  return { detections, rejected };
}

/**
 * The claim's SUBJECT, or why it cannot carry a proposal at all — the bars every kind shares.
 *
 * Returns the bead rather than a boolean so every bar downstream HOLDS the thing those bars proved
 * exists, instead of looking it up again and asserting the guarantee a caller established.
 */
function subjectChecked(
  claim: PmClaim,
  index: BoardIndex,
  nowMs: number,
): { subject: Bead } | { refusal: string } {
  const subject = index.byId.get(claim.bead);
  if (!subject) return { refusal: `${claim.bead} is not on the board` };
  if (isProposalBead(subject)) return { refusal: `${claim.bead} is itself a proposal, not work` };
  if (!isOpenWork(subject)) return { refusal: `${claim.bead} is already settled` };
  if (isInFlight(subject, nowMs)) {
    return { refusal: `${claim.bead} is mid-run — a proposal would race the run` };
  }
  return { subject };
}

/** Why this claim's own move cannot stand, or undefined. */
function kindRefusal(
  claim: PmClaim,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  switch (claim.kind) {
    case "reprioritize":
      return subject.priority !== undefined && `P${subject.priority}` === claim.priority
        ? `${claim.bead} is already at ${claim.priority}`
        : undefined;
    case "order":
      return orderRefusal(claim, index);
    case "rehome":
      return rehomeRefusal(claim, subject, index, nowMs);
    // A deferred bead is still OPEN work, so `subjectChecked` waves it through — but a kill applies as
    // `defer`, and `planRetire` settles an already-deferred subject without writing anything. Left
    // unchecked the ask reaches the board, costs a founder a decision, and settles as a no-op. The
    // gardener's stale detector excludes deferred beads for this exact reason (gardener/retire.ts).
    case "kill":
      return beads.isDeferred(subject)
        ? `${claim.bead} is already deferred — killing it again would change nothing`
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Why an ordering edge cannot be recorded — every reason bd or the graph would refuse it later.
 *
 * Checked here rather than left to approve time because an ask that can only ever fail is worse than
 * no ask: it sits on the board asking a founder to approve something anton will refuse, until
 * somebody declines it by hand (the anton-wsap failure mode).
 */
function orderRefusal(claim: PmClaimOrder, index: BoardIndex): string | undefined {
  const blockerId = claim.blockedBy;
  if (blockerId === claim.bead) return `${claim.bead} cannot block itself`;
  const blocker = index.byId.get(blockerId);
  if (!blocker) return `${blockerId} is not on the board`;
  // A proposal is open work, so `isOpenWork` waves it through — but it closes when the founder
  // approves or declines it, and the `blocks` edge outlives it. The subject would sit queue-blocked
  // behind an ask that no longer exists, with nothing left to land and unblock it.
  if (isProposalBead(blocker)) {
    return `${blockerId} is a proposal, not work — the edge would outlive it and leave ${claim.bead} blocked forever`;
  }
  if (!isOpenWork(blocker)) return `${blockerId} has already landed, so the edge would constrain nothing`;
  if (index.hasBlocksEdge(claim.bead, blockerId)) {
    return `the board already records an ordering between ${claim.bead} and ${blockerId}`;
  }
  // bd keeps ONE edge per directed pair and refuses a second type over it rather than replacing it.
  if (index.recordsDiscovery(claim.bead, blockerId) || index.recordsDiscovery(blockerId, claim.bead)) {
    return `${claim.bead} and ${blockerId} already carry a discovered-from edge, and bd keeps one edge per pair`;
  }
  if (index.isBlockedBy(blockerId, claim.bead)) {
    return `${blockerId} is already blocked by ${claim.bead} through other beads — the edge would close a cycle`;
  }
  return undefined;
}

/**
 * Why this bead cannot be hung under the home the claim names, or undefined — every reason apply
 * would refuse the move later, asked at filing time for the same reason {@link orderRefusal} is: an
 * ask that can only ever fail sits on the board asking a founder to approve something anton will
 * refuse, until somebody declines it by hand (the anton-wsap failure mode).
 *
 * The tier bar is asked through apply's own {@link homeWrongTier} rather than a copy of it, so the
 * filing check and the approve check cannot disagree about which homes the taxonomy allows — a
 * ticket hangs off the card that runs it, a card off the container epic that groups it.
 */
function rehomeRefusal(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  const homeId = claim.home;
  if (homeId === claim.bead) return `${claim.bead} cannot be its own home`;
  const currentHome = beads.parentOf(subject);
  if (currentHome === homeId) {
    return `${claim.bead} already hangs under ${homeId} — the move would write nothing`;
  }
  // The same no-op one tier out, and the one the context now invites: bd nesting runs to any depth,
  // so under `feature → task → subtask` the subtask already ships in the FEATURE's run and its PR,
  // and its line names that feature as `shipped by`. A claim citing that line proposes the card the
  // work already rides — which moves nothing between runs and only flattens nesting somebody meant.
  // A `rehome` is a claim that the work would ship in the WRONG card; here nothing is misfiled.
  const owner = ticketOwnerOf(index, subject);
  if (owner?.id === homeId) {
    return `${claim.bead} already ships under ${homeId} — it hangs inside that run's ticket set today, so the move would flatten nesting somebody meant rather than change what ships it`;
  }
  // The subject's half of "a run owns it". `subjectRefusal` asks only `isInFlight`, which cannot see
  // a claim: a run working a ticket writes the assignee and `in_progress` onto it while the run-lease
  // lives on the CARD above, so the ticket reads as free work there. Moved out of that run's ticket
  // set, its commit lands in the old card's PR while the bead hangs off the new one, open and unrun.
  if (isClaimed(subject)) {
    return `${claim.bead} is held by ${runClaimOf(subject)} — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places`;
  }
  // The rest of that half, and the one no per-bead signal can reach: a grouped run publishes ONE
  // lease, on the CARD its tickets hang under, and cascades an assignee only to the tickets it has
  // already reached. So a ticket that run has SELECTED but not yet started carries no lease and no
  // claim — both bars above read it as free work. Moving it out of that set now takes a bead out of
  // a set the run already chose, and the run aborts when its claim reaches it.
  if (owner && (isInFlight(owner, nowMs) || isClaimed(owner))) {
    return `${claim.bead} rides ${owner.id}'s ticket set and a run owns ${owner.id} — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships`;
  }
  const home = index.byId.get(homeId);
  if (!home) return `${homeId} is not on the board`;
  // A proposal is open work, so `isOpenWork` waves it through — but it is a bead ABOUT the board,
  // not part of its shape, and it closes the moment the founder answers it. Work hung under one
  // would be left beneath a settled ask nothing will ever run.
  if (isProposalBead(home)) return `${homeId} is a proposal, not a home`;
  if (!isOpenWork(home)) {
    return `${homeId} is already settled — hanging work under it would leave it riding a home nothing will run`;
  }
  // Both halves of "a run owns it": a published lease, and the pickup window before one exists. A run
  // that already selected the tickets it will work through would carry the newcomer along unrun.
  if (isInFlight(home, nowMs)) {
    return `${homeId} is mid-run — hanging work under it would race the run that owns it`;
  }
  if (isClaimed(home)) {
    return `${homeId} is held by ${runClaimOf(home)} — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`;
  }
  if (index.isAncestor(claim.bead, homeId)) {
    return `${homeId} sits under ${claim.bead} — the move would make the subtree its own ancestor`;
  }
  const wrongTier = homeWrongTier(subject, home, index, HOME_STANDING.snapshot);
  if (wrongTier) return wrongTier;
  // Last, so it never masks a stronger fault: a container epic and a `learning` are both naturally
  // parentless, and each is refused above for the reason it will still be refused for once somebody
  // gives it a home — the taxonomy names no home for it at all.
  //
  // A `rehome` is a claim about a home that is WRONG; a FIRST home is the gardener's mechanical ask,
  // and this pass is told to leave it alone. The context's "no run target carries this" section says
  // so for the work IT covers — but a parentless task/bug is a RUN TARGET and renders as one, so
  // nothing else here stops a claim that demotes a standalone run (often the most urgent bead on the
  // board) into somebody else's child ticket, cancelling the run it would have had.
  if (!currentHome) {
    return `${claim.bead} hangs under nothing — giving homeless work its first home is the gardener's proposal, not this pass's`;
  }
  return undefined;
}

/** The detection one accepted claim becomes — the shape both emission and apply already speak. */
function detectionFor(claim: PmClaim): GardenerDetection {
  switch (claim.kind) {
    case "reprioritize":
      return makeDetection({
        kind: CLAIM_KINDS.reprioritize,
        move: "reprioritize",
        subjects: [claim.bead],
        detail: claim.priority,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "order":
      return makeDetection({
        kind: CLAIM_KINDS.order,
        move: "link",
        subjects: [claim.bead],
        target: claim.blockedBy,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "rehome":
      return makeDetection({
        kind: CLAIM_KINDS.rehome,
        move: "reparent",
        subjects: [claim.bead],
        // Always a target, never the gardener's targetless "which feature?" ask: the session that
        // makes a home claim has already named the home, and one without it never parses.
        target: claim.home,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "split":
      return makeDetection({
        kind: CLAIM_KINDS.split,
        move: "split",
        subjects: [claim.bead],
        summary: claim.summary,
        // The sketch rides with the evidence because it IS part of the claim: a split proposal
        // without a decomposition asks a founder to do the thinking the pass was run to do.
        evidence: [
          ...claim.evidence,
          ...claim.pieces.map((piece, i) => `proposed ticket ${i + 1}: ${piece}`),
        ],
      });
    case "kill":
      return makeDetection({
        kind: CLAIM_KINDS.kill,
        move: "retire",
        retireAs: "defer",
        subjects: [claim.bead],
        summary: claim.summary,
        evidence: claim.evidence,
      });
  }
}
