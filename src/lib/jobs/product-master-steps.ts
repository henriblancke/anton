/**
 * The product-master pass's named steps (anton-l4do), split out of product-master.ts so the handler
 * reads as the order they run in and each can be exercised without a job queue.
 *
 * The pass has TWO tiers and only one of them needs a session: {@link revalidationTier} is a FACT
 * (the approve gate's own validator, re-run over the snapshot), while {@link judgeBoard} and
 * {@link acceptClaims} are the judgment. Both file through the same {@link makeProposalFiler}, so a
 * proposal is fingerprinted, capped and shadowed identically whichever tier raised it.
 */
import type { Bead } from "../beads/bd";
import type { RunClaudeOptions, runClaude } from "../claude/driver";
import type { GardenerDetection } from "../gardener/detections";
import {
  emitProposals,
  MAX_PROPOSALS_PER_PASS,
  PartialEmissionError,
  type EmissionResult,
} from "../gardener/emit";
import { shadowProposals } from "../gardener/shadow";
import {
  buildProductMasterPrompt,
  detectionsFor,
  parsePmReport,
  type PmBoardInput,
  type PmClaim,
} from "../pm/context";
import { revalidateApprovals } from "../pm/revalidate";
import type { ProjectSettings } from "../projects";
import type { PassScope } from "./pass-preamble";

/**
 * Tools the pass may NOT use. Everything that writes, plus the shell — which is how `bd` would be
 * reached, and the whole point is that this session cannot touch the board. It needs none of them:
 * its entire input is the prompt anton assembles.
 *
 * Reading is deliberately left alone. A product judgment is better for having seen the project's own
 * direction (`.product/PRODUCT.md`, a README), and a read cannot change anything. `Bash` is denied
 * outright rather than by command prefix because a prefix filter has no way to cover every path to a
 * write — and unlike the reviewer (REVIEW_DENIED_TOOLS), this pass has no need to run the project's
 * checks, so there is nothing to trade off.
 */
export const PM_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"];

export interface ProposalFilerInput {
  /** The board snapshot every claim was made about — what suppression and the cap read. */
  board: Bead[];
  /** The premise fence: the stamp of that snapshot. */
  observedAtMs: number;
}

/**
 * Report what an emission landed, or held back. Never a silent cap: the overflow is deterministic
 * and the next pass files it, but a reader has to be able to tell "the board is this healthy" from
 * "we stopped at ten".
 */
function reportEmission(scope: PassScope, emission: EmissionResult): void {
  if (emission.created.length > 0) {
    console.log(
      `[product-master] ${scope.slug}: filed ${emission.created.length} proposal(s) ` +
        `(${emission.created.map((p) => p.id).join(", ")})` +
        `${emission.suppressed > 0 ? `, ${emission.suppressed} already on the board` : ""}`,
    );
    scope.nudge(scope.project);
  }
  if (emission.deferred > 0) {
    console.log(
      `[product-master] ${scope.slug}: held back ${emission.deferred} proposal(s) — one pass ` +
        `files at most ${MAX_PROPOSALS_PER_PASS}; the next one picks them up`,
    );
  }
}

/**
 * File one tier's detections, reporting whatever landed before a failure rather than losing it.
 *
 * Returned as a closure because both tiers file against the SAME board snapshot and fence — the two
 * are entitled to their own emission (so they cannot cap each other out) but never to their own
 * premise.
 */
export function makeProposalFiler(
  scope: PassScope,
  input: ProposalFilerInput,
): (detections: GardenerDetection[]) => Promise<void> {
  const { board, observedAtMs } = input;
  const repo = scope.project.repoPath;

  return async (detections: GardenerDetection[]): Promise<void> => {
    scope.ctx.signal.throwIfAborted();
    try {
      const emission = await emitProposals(repo, {
        board,
        detections,
        observedAtMs,
        signal: scope.ctx.signal,
      });
      reportEmission(scope, emission);
      // What the armed pass WOULD have done with what this tier just filed (anton-lmps): decided
      // against a board read fresh at this moment, exactly as an approval would, and writing
      // nothing — so a shadow that fails is a line in the log rather than a failed pass.
      await shadowProposals({
        repo,
        created: emission.created,
        policy: scope.policy,
        observedAtMs,
        nowMs: scope.clock.now(),
        producer: "[product-master]",
        log: scope.log,
        signal: scope.ctx.signal,
      });
    } catch (e) {
      // Whatever landed before a create failed is real board state living only in the local working
      // set — report and propagate it, or a pass that parks leaves the proposals that DID file
      // invisible to every other machine.
      if (e instanceof PartialEmissionError) reportEmission(scope, e.result);
      throw e;
    }
  };
}

/**
 * TIER 1 — the deterministic pre-pass (anton-xg5y), filed AHEAD of the session on purpose. Approval
 * rot is a FACT — the approve gate's own validator, re-run over the snapshot just read — so it costs
 * no judgment and must not depend on one: filed first, it lands even on a pass whose session errors
 * or breaks the report protocol. It reuses the board already read and spawns no `bd` of its own.
 */
export async function revalidationTier(
  scope: PassScope,
  board: Bead[],
  observedAtMs: number,
): Promise<GardenerDetection[]> {
  const degraded = revalidateApprovals(board, observedAtMs);
  if (degraded.length > 0) {
    await scope.log(
      `[product-master] ${degraded.length} approved target(s) no longer meet the approve gate\n`,
    );
  }
  return degraded;
}

export interface JudgeInput {
  settings: ProjectSettings;
  boardInput: PmBoardInput;
  claude: typeof runClaude;
  onEvent: RunClaudeOptions["onEvent"];
}

/**
 * TIER 2 — the judgment. One fresh-context session over the whole board, dispatched with no writes
 * of any kind, and its report parsed into claims.
 *
 * A broken protocol is NOT an empty board. Thrown so the runner retries and eventually parks:
 * reading an unparseable report as "nothing to propose" would publish a clean bill of health this
 * pass never reached, which is the one failure that looks exactly like success.
 */
export async function judgeBoard(scope: PassScope, input: JudgeInput): Promise<PmClaim[]> {
  const { settings, boardInput, claude, onEvent } = input;

  const { prompt, reasoningFrom } = await buildProductMasterPrompt({ settings, board: boardInput });
  await scope.log(
    `[product-master] judging ${boardInput.board.length} bead(s) with the ${reasoningFrom.kind === "prompt" ? "operator's prompt" : "shipped contract"}\n`,
  );

  const result = await claude({
    cwd: scope.project.repoPath,
    prompt,
    model: settings.model,
    permissionMode: settings.permissionMode ?? "bypassPermissions",
    disallowedTools: PM_DENIED_TOOLS,
    signal: scope.ctx.signal,
    onEvent,
  });
  if (!result.ok) {
    throw new Error(`the product-master session reported an error: ${result.text ?? "unknown"}`);
  }

  const report = parsePmReport(result.text);
  if (!report.ok) {
    throw new Error(
      `the product-master session broke the report protocol (${report.violation}) — anton cannot ` +
        `tell a healthy board from a report it failed to read`,
    );
  }
  return report.claims;
}

export interface AcceptInput {
  claims: PmClaim[];
  board: Bead[];
  /** The stamp of the read the claims were made about — never a fresh clock. */
  observedAtMs: number;
}

/**
 * Every claim checked against the board it was made about before it becomes a bead. A rejection is
 * LOGGED, never swallowed: a pass whose claims were all refused would otherwise be indistinguishable
 * from a pass that found a healthy board.
 *
 * Dated against the snapshot rather than now, because a session runs for many minutes: dating the
 * in-flight check at the end would let a bead whose run-lease expired mid-session pass as a free
 * subject — a proposal racing a run that was live when the judgment was made.
 */
export async function acceptClaims(
  scope: PassScope,
  input: AcceptInput,
): Promise<GardenerDetection[]> {
  const { claims, board, observedAtMs } = input;
  const { detections, rejected } = detectionsFor(claims, board, observedAtMs);
  for (const { claim, reason } of rejected) {
    const line = `[product-master] REFUSED a ${claim.kind} claim about ${claim.bead}: ${reason}`;
    await scope.log(`${line}\n`);
    console.warn(`${line} (${scope.slug})`);
  }
  await scope.log(
    `[product-master] ${claims.length} claim(s) reported, ${detections.length} accepted\n`,
  );
  return detections;
}
