/**
 * The checkout-staleness preflight (anton-mh3c / anton-vzhf). Its three dependencies — the
 * self-freshness verdict, the breaker's contract line, and the poison that parks the run — live here
 * rather than in {@link prepareEpicRun}; the run-shape seam re-exports {@link assertSelfCheckoutFresh}
 * to it (anton-8x1k), so preparation reaches this gate through the one seam it already threads its
 * pipeline and lease through instead of fanning these modules out into its own top-level imports.
 */
import { BREAKER_EFFECT } from "../autopilot-breaker";
import { PoisonEpic } from "./errors";
import { checkSelfFreshness, selfRepoRoot, type SelfFreshness } from "./self-freshness";

/**
 * Step 0-pre. Refuse to START a new run when anton is running behind its own latest code
 * (anton-mh3c). anton pulls before it starts, but a fix merged after that pull — or a lockfile bump
 * nobody reinstalled — leaves the process a step behind its own repairs; starting new work on it
 * ships that stale code into the trunk.
 *
 * Machine-level, not board-level: the self-freshness verdict (anton-vzhf) is about the PROCESS, so
 * it is read against anton's OWN install root — not the project checkout in {@link EpicRun.repo}.
 *
 * A read-only refusal like every gate around it, and it inherits their contract: the park costs no
 * lease, worktree or claim, and a run already in flight — a separate job long past this gate — is
 * untouched, only a new start is stopped ({@link BREAKER_EFFECT}). {@link prepareEpicRun} places it
 * AFTER the completion short-circuit so a target already carried to its pull request still settles
 * idempotently rather than being grounded by a staleness with nothing left to run. The PoisonEpic
 * parks the job for a human — the fix is theirs (pull/reinstall, then restart anton) — and its
 * message is the durable record the run row keeps and the run-health sweep surfaces.
 */
export async function assertSelfCheckoutFresh(): Promise<void> {
  const root = selfRepoRoot();
  const refusal = staleCheckoutRefusal(await checkSelfFreshness(root), root);
  if (refusal) throw new PoisonEpic(refusal);
}

/**
 * The refusal a stale checkout parks a new start on (anton-mh3c), or undefined when anton is running
 * its own latest code. Names WHAT is stale and the command that clears it, and closes with the
 * disarm's contract line ({@link BREAKER_EFFECT}) so the operator reads the same "running work is
 * unaffected" promise a disarm makes rather than fearing a full stop.
 *
 * Only a verdict anton can act on by rebuilding counts as stale: HEAD behind its own upstream, or
 * installed packages that no longer match the lockfile. Every INDETERMINATE verdict — a remote it
 * could not reach, a branch with no upstream, a lockfile it could not read — passes exactly as a
 * clean one does: refusing a start on a check that never answered would ground an offline runner on
 * no evidence, the line anton-vzhf drew and this honours.
 */
export function staleCheckoutRefusal(
  freshness: SelfFreshness,
  repoPath: string,
): string | undefined {
  const stale: string[] = [];
  if (freshness.checkout.state === "behind") {
    const { behind, upstream } = freshness.checkout;
    stale.push(`its checkout is ${behind} commit(s) behind ${upstream} — run \`git pull\``);
  }
  if (freshness.dependencies.state === "drift") {
    stale.push(
      `its installed packages no longer match bun.lock ` +
        `(${freshness.dependencies.packages.join(", ")}) — run \`bun install\``,
    );
  }
  if (stale.length === 0) return undefined;
  return (
    `anton is running behind its own latest code, so it will not start new work: ` +
    `${stale.join("; ")} in ${repoPath}, then restart anton. ${BREAKER_EFFECT}`
  );
}
