/**
 * MISSING TIER EDGES (anton-02oc): two run targets whose ordering is already written down somewhere
 * the graph can't read — in a body, or in the board's own provenance — while `blocks` says they are
 * independent.
 *
 * This matters more than tidiness. `bd ready`, the claimable set and the board's readiness badges
 * all derive from `blocks` edges, so an ordering that lives only in prose is an ordering nothing
 * enforces: two machines will happily claim both ends at once, and the second one lands on a base
 * that doesn't have the first one's work yet.
 *
 * Scoped to features/epics — the units `computeEpicGraph` ranks. A missing ticket-level edge inside
 * one run target is invisible to sequencing (the run works through its tickets in order anyway), so
 * proposing one would be noise.
 */
import type { Bead } from "../beads/bd";
import { isUnit } from "../epic-graph";
import { isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

/** Phrases placing the MENTIONING bead after the bead it names. */
const AFTER_PHRASES = [
  "blocked on",
  "blocked by",
  "depends on",
  "depend on",
  "dependent on",
  "waiting on",
  "waits on",
  "prerequisite",
  "requires",
  "needs",
  "follows",
  "once",
  "after",
];

/** Phrases placing the MENTIONING bead before the bead it names. */
const BEFORE_PHRASES = ["unblocks", "blocks", "precedes", "before"];

/** How far past an ordering phrase a bead id still counts as that phrase's object. */
const MENTION_WINDOW = 100;

/** bd ids as they appear in prose (`anton-02oc`). Membership in the board decides what is real. */
const ID_PATTERN = /\b[a-z][a-z0-9]*-[a-z0-9]{2,12}\b/gi;

const AFTER_RE = phraseRegex(AFTER_PHRASES);
const BEFORE_RE = phraseRegex(BEFORE_PHRASES);

/** Both readings of a mention: whose side of the ordering the NAMED bead lands on. */
const DIRECTIONS = [
  { regex: AFTER_RE, mentionedIsBlocker: true },
  { regex: BEFORE_RE, mentionedIsBlocker: false },
] as const;

/**
 * Ordering the board states but does not enforce, from two independent signals:
 *
 *   • BODY — a run target's own prose names another run target after an ordering phrase ("blocked on
 *     anton-x", "once anton-y lands"). Whoever wrote it already made the call; the edge was just
 *     never drawn.
 *   • TIMING — a `discovered-from` edge. It records that this work was found WHILE doing the other,
 *     which is a fact about sequence: as long as the source is still open, its landing is what the
 *     discovered work is waiting for. bd files that edge for provenance and gives it no ordering
 *     weight (see computeEpicGraph), so the sequence it implies is invisible to every reader.
 *
 * Both are proposals, never applied — a phrase in prose is evidence, not proof, so the matched
 * sentence travels with the detection for the approver to read.
 */
export function detectImpliedOrdering(index: BoardIndex, nowMs: number): GardenerDetection[] {
  return [...bodyImplied(index, nowMs), ...discoveryImplied(index, nowMs)];
}

function bodyImplied(index: BoardIndex, nowMs: number): GardenerDetection[] {
  const detections: GardenerDetection[] = [];
  const units = index.all.filter((bead) => isUnit(bead) && isOpenWork(bead));

  for (const { writer, blocked, blocker, mention } of bodyOrderings(index, units)) {
    if (!canOrder(index, blocked, blocker, nowMs)) continue;
    detections.push(
      makeDetection({
        kind: "implied-order",
        move: "link",
        subjects: [blocked.id],
        target: blocker.id,
        // Named after the bead that WROTE the ordering, which is not always the blocked one:
        // "this blocks anton-x" puts the writer first.
        summary: `${writer.id}'s body places ${blocked.id} after ${blocker.id}, but no blocks edge records it`,
        evidence: [
          `${writer.id} body: "${mention.snippet}"`,
          `"${mention.phrase}" places ${blocked.id} after ${blocker.id}`,
          `no blocks edge exists between them, so ${blocked.id} reads as ready while ${blocker.id} is still open`,
        ],
      }),
    );
  }

  return detections;
}

/** One ordering a bead's own prose states, before any bar on whether it is worth proposing. */
interface BodyOrdering {
  /** The bead whose body carries the phrase — either end of the pair, depending on the wording. */
  writer: Bead;
  blocked: Bead;
  blocker: Bead;
  mention: OrderingMention;
}

/**
 * Every ordering the bodies of `candidates` state, as resolved pairs. Split out from
 * {@link bodyImplied} so the EVIDENCE half is derivable on its own: apply re-asks it at approve time
 * ({@link impliesOrdering}), and a second reading of the same prose would be a second answer.
 */
function* bodyOrderings(index: BoardIndex, candidates: Iterable<Bead>): Generator<BodyOrdering> {
  for (const bead of candidates) {
    const body = bodyOf(bead);
    if (!body) continue;
    for (const { regex, mentionedIsBlocker } of DIRECTIONS) {
      for (const mention of scanOrdering(body, regex)) {
        for (const id of mention.ids) {
          const other = index.byId.get(id);
          if (!other) continue;
          yield {
            writer: bead,
            blocked: mentionedIsBlocker ? bead : other,
            blocker: mentionedIsBlocker ? other : bead,
            mention,
          };
        }
      }
    }
  }
}

/**
 * Does the board STILL state this ordering — the evidence an `implied-order` proposal rests on?
 *
 * A body phrase can be edited out and a `discovered-from` edge dropped, and either removal is a
 * newer decision than the proposal: someone took the ordering away on purpose. Approving the ask
 * anyway would draw a `blocks` edge whose only evidence no longer exists, and take the blocked bead
 * back out of the ready set that edit put it in.
 *
 * The EVIDENCE alone, deliberately — not the whole detection. {@link canOrder}'s bars (open units,
 * nothing mid-flight, no cycle) say whether the ask was worth FILING; apply holds those beads to its
 * own bars, which are not the same ones, and re-running them here would refuse moves the approval
 * path has always allowed. Only the two beads' own bodies are read, because the phrase always sits
 * on one end of the pair (see {@link bodyOrderings}).
 */
export function impliesOrdering(index: BoardIndex, blockedId: string, blockerId: string): boolean {
  if (index.discoveries.some((d) => d.discovered === blockedId && d.source === blockerId)) {
    return true;
  }
  const pair = [index.byId.get(blockedId), index.byId.get(blockerId)].filter(
    (b): b is Bead => b !== undefined,
  );
  for (const { blocked, blocker } of bodyOrderings(index, pair)) {
    if (blocked.id === blockedId && blocker.id === blockerId) return true;
  }
  return false;
}

function discoveryImplied(index: BoardIndex, nowMs: number): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const { discovered, source } of index.discoveries) {
    const blocked = index.byId.get(discovered);
    const blocker = index.byId.get(source);
    if (!blocked || !blocker || !canOrder(index, blocked, blocker, nowMs)) continue;
    detections.push(
      makeDetection({
        kind: "implied-order",
        move: "link",
        subjects: [blocked.id],
        target: blocker.id,
        summary: `${blocked.id} was discovered from ${blocker.id}, which is still open — no blocks edge records the sequence`,
        evidence: [
          `discovered-from edge: ${blocked.id} was filed while working on ${blocker.id}`,
          `${blocker.id} is still ${blocker.status} — the work ${blocked.id} came out of has not landed`,
          `discovered-from carries no ordering weight, so ${blocked.id} is claimable before ${blocker.id} ships`,
        ],
      }),
    );
  }

  return detections;
}

/**
 * Is proposing `blocker` → `blocked` meaningful? Both must be open units, and the pair must be
 * unrelated today: an existing blocks edge in EITHER direction is already someone's answer (the
 * reverse one is a contradiction to raise with a human, not to silently invert), and a
 * parent/ancestor pair sequences through the hierarchy rather than through `blocks`.
 *
 * Mid-flight work is off limits, the same bar every other detector proposes under: apply refuses to
 * record a live bead as blocked, and by the time its run lands the bead is settled — so the proposal
 * would never become appliable and would suppress the claim until someone declined it by hand.
 *
 * The same reasoning bars a CYCLE. A blocker that already waits on the blocked bead through other
 * beads has no direct edge, so the pair reads as unrelated — but bd refuses to write the edge that
 * would close the loop (bd-hygiene.integration.test.ts), so the proposal could only ever be approved
 * into an error. Checked here as well as at apply, so the ask is never filed in the first place.
 */
function canOrder(index: BoardIndex, blocked: Bead, blocker: Bead, nowMs: number): boolean {
  if (blocked.id === blocker.id) return false;
  if (!isUnit(blocked) || !isUnit(blocker)) return false;
  if (!isOpenWork(blocked) || !isOpenWork(blocker)) return false;
  if (isInFlight(blocked, nowMs) || isInFlight(blocker, nowMs)) return false;
  if (index.hasBlocksEdge(blocked.id, blocker.id)) return false;
  if (index.isBlockedBy(blocker.id, blocked.id)) return false;
  return !index.isAncestor(blocked.id, blocker.id) && !index.isAncestor(blocker.id, blocked.id);
}

/** Every place a bead states its ordering in prose — `bd list --json` carries all of them. */
function bodyOf(bead: Bead): string {
  return [bead.description, bead.context, bead.acceptance, bead.acceptance_criteria]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
}

interface OrderingMention {
  phrase: string;
  snippet: string;
  ids: string[];
}

/** Ordering phrases in `body`, each with the ids that follow it on the same line. */
function scanOrdering(body: string, regex: RegExp): OrderingMention[] {
  const mentions: OrderingMention[] = [];
  for (const match of body.matchAll(regex)) {
    const start = match.index ?? 0;
    const [line] = body.slice(start, start + MENTION_WINDOW).split("\n");
    const after = line.slice(match[0].length);
    const ids = [...after.matchAll(ID_PATTERN)].map((m) => m[0].toLowerCase());
    if (ids.length > 0) mentions.push({ phrase: match[0], snippet: line.trim(), ids });
  }
  return mentions;
}

/** Longest phrase first, so "blocked on" is never truncated to a shorter alternative. */
function phraseRegex(phrases: string[]): RegExp {
  const ordered = [...phrases].sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${ordered.join("|")})\\b`, "gi");
}
