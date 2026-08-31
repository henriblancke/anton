/**
 * The report protocol of the product-master pass (anton-d2sx): the wire format anton DEMANDS of the
 * session, the claim shapes it may report, and the parser that reads them back.
 *
 * Format and parser live in one module on purpose — the same discipline review-context.ts keeps. A
 * report format defined next to the reasoning contract that happens to describe it, and parsed
 * somewhere else, is one prompt edit away from a protocol anton can no longer read.
 */
import { oneLine } from "./text";

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
  start: "withheld-approval",
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
 * which tier is legal is the board's answer, not the session's (`rehomeRefusal`).
 */
export type PmClaimRehome = PmClaimBase & { kind: "rehome"; home: string };
/** `split`: the decomposition sketch, one line per proposed ticket. */
export type PmClaimSplit = PmClaimBase & { kind: "split"; pieces: string[] };
/** `kill`: the ask is the bead itself, so the evidence is all there is. */
export type PmClaimKill = PmClaimBase & { kind: "kill" };
/**
 * `start`: the mirror of `kill` in shape and its opposite in consequence — the ask is the bead
 * itself, so the evidence is all it carries, and approving it grants the gate a run starts on.
 */
export type PmClaimStart = PmClaimBase & { kind: "start" };

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
  | PmClaimKill
  | PmClaimStart;

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
    `- \`"start"\` — no extra field. The bead is what anton should run NEXT and nothing has approved`,
    `  it, so no worker will ever come. Approving the proposal grants the \`approved\` gate and a run`,
    `  can start on it, which makes this the only claim whose approval SPENDS a run — so the evidence`,
    `  bar is the kill's. anton refuses a bead that already carries the gate, one a run holds, and one`,
    `  the board itself would not offer as work to start: not a run target, blocked by open work, or`,
    `  short of the approve gate's own promises (a missing contract section, a broken tier shape).`,
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
    const result = reportIn(text, blocks[i]);
    if (result) return result;
  }
  return { ok: false, violation: "no-report" };
}

/**
 * The report this block holds, or undefined when it is not one and the scan should keep looking.
 * Distinguishing the two is the whole job: "not a report" walks past an unrelated json block, while
 * a violation STOPS the scan, so an earlier draft can never stand in for a report just withdrawn.
 */
function reportIn(text: string, block: RegExpExecArray): PmReportResult | undefined {
  const parsed = jsonIn(block[1]);
  if (parsed === undefined) {
    // A block that tried to be the report and failed IS the report — a malformed one.
    return /"proposals"\s*:/.test(block[1]) ? { ok: false, violation: "malformed-proposals" } : undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("proposals" in parsed)) return undefined;
  if (text.slice((block.index ?? 0) + block[0].length).trim()) {
    return { ok: false, violation: "trailing-content" };
  }
  return claimsIn((parsed as { proposals: unknown }).proposals);
}

/** The block's body as json, or undefined when it does not parse — `null` parses, so it is a hit. */
function jsonIn(body: string): unknown {
  try {
    return JSON.parse(body) ?? null;
  } catch {
    return undefined;
  }
}

/** The claims a report block carries, or the violation that stops it standing in for a healthy board. */
function claimsIn(proposals: unknown): PmReportResult {
  if (!Array.isArray(proposals)) return { ok: false, violation: "malformed-proposals" };
  const claims = proposals.map(toClaim);
  return claims.every((claim) => claim !== undefined)
    ? { ok: true, claims: claims as PmClaim[] }
    : { ok: false, violation: "malformed-proposals" };
}

/**
 * The one field each kind adds to {@link PmClaimBase}, as data: the wire contract
 * `pmReportFormatSection` documents, in the shape the parser reads it back with.
 *
 * A table rather than a switch of inline checks because the per-kind field IS the claim — every
 * entry here is a line of the format section, and the two drifting apart is how a session ends up
 * emitting a claim anton silently drops. Each reader is checked against its own kind's fields, so a
 * new claim kind cannot be added to {@link CLAIM_KINDS} without a reader that produces its field.
 */
type ClaimFields<K extends ClaimKind> = Omit<
  Extract<PmClaim, { kind: K }>,
  keyof PmClaimBase | "kind"
>;

/** Reads the field kind `K` adds, or undefined when the entry cannot carry that claim at all. */
type FieldReader<K extends ClaimKind> = (raw: Record<string, unknown>) => ClaimFields<K> | undefined;

const CLAIM_FIELDS: { [K in ClaimKind]: FieldReader<K> } = {
  reprioritize: (raw) => {
    const priority = str(raw.priority);
    return priority && /^P[0-4]$/.test(priority) ? { priority } : undefined;
  },
  order: (raw) => {
    const blockedBy = str(raw.blockedBy);
    return blockedBy ? { blockedBy } : undefined;
  },
  // A home claim names two beads, and the second is the whole content of the ask: "this is
  // misfiled" with no home to move it to has nothing anton could ever write.
  rehome: (raw) => {
    const home = str(raw.home);
    return home ? { home } : undefined;
  },
  split: (raw) => {
    const pieces = lines(raw.pieces);
    // Two is the smallest decomposition there is; one "piece" is the ticket restated.
    return pieces && pieces.length >= 2 ? { pieces } : undefined;
  },
  // `kill`: the ask is the bead itself, so the base fields are the whole claim.
  kill: () => ({}),
  // `start`: likewise — naming the bead IS the ask, and the gate it must clear is the board's answer.
  start: () => ({}),
};

/** One wire entry as a claim, or undefined when it is not a usable one. */
function toClaim(entry: unknown): PmClaim | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const raw = entry as Record<string, unknown>;
  // Own keys only: `in` would let an inherited `Object.prototype` name ("constructor", "toString")
  // pass as a kind and dispatch to whatever the prototype holds, admitting a claim with no fields.
  if (typeof raw.kind !== "string" || !Object.hasOwn(CLAIM_KINDS, raw.kind)) return undefined;
  const kind = raw.kind as ClaimKind;

  const base = claimBase(raw);
  const fields = (CLAIM_FIELDS[kind] as FieldReader<ClaimKind>)(raw);
  // The kind is checked above, so the cast only re-states which table entry produced `fields`.
  return base && fields ? ({ ...base, kind, ...fields } as PmClaim) : undefined;
}

/** What every entry must carry whatever its kind, or undefined when it carries less. */
function claimBase(raw: Record<string, unknown>): PmClaimBase | undefined {
  const bead = str(raw.bead);
  const summary = str(raw.summary);
  const evidence = lines(raw.evidence);
  return bead && summary && evidence?.length ? { bead, summary, evidence } : undefined;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? oneLine(value) : undefined;

const lines = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(str).filter((s): s is string => s !== undefined);
  return out.length === value.length ? out : undefined;
};
