/**
 * The anton↔claude protocol for the product-master pass (anton-d2sx): the prompt the pass runs with,
 * and the public surface of the three modules that make it up.
 *
 * Mirrors review-context.ts and its discipline: the report format is DEFINED and PARSED by anton
 * ({@link pmReportFormatSection}, {@link parsePmReport}), so swapping the pass's reasoning contract —
 * an operator prompt, a rewritten skill — can never break the protocol the job relies on. HOW to
 * judge lives in `skills/product-master/SKILL.md`; WHAT to judge and how to say it live here.
 *
 * One job per module, assembled here (anton-w22q):
 *   • `board-context.ts` / `bead-line.ts` — the board as the session must see it, and one bead's
 *     own line within it;
 *   • `report.ts` — the wire format it must answer in, and the parser that reads it back;
 *   • `refusals.ts` — every bar a claim clears before anton files it as a proposal.
 */
import { loadSkill } from "../claude/prompt";
import { resolveProductMasterConfig, type ProjectSettings } from "../projects";
import { formatPmBoardContext, type PmBoardInput } from "./board-context";
import { pmReportFormatSection } from "./report";

export { MAX_GOAL_CHARS, MAX_SCORE_ROUNDS } from "./bead-line";
export {
  formatPmBoardContext,
  MAX_CARDS,
  MAX_RUNS,
  MAX_TICKETS_PER_CARD,
  type PmBoardInput,
} from "./board-context";
export {
  CLAIM_KINDS,
  parsePmReport,
  pmReportFormatSection,
  type ClaimKind,
  type PmClaim,
  type PmClaimKill,
  type PmClaimOrder,
  type PmClaimRehome,
  type PmClaimReprioritize,
  type PmClaimSplit,
  type PmProtocolViolation,
  type PmReportResult,
} from "./report";
export {
  detectionsFor,
  type DetectionsResult,
  type RejectedClaim,
} from "./refusals";

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
