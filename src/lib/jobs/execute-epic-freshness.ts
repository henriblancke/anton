/**
 * The checkout-staleness preflight (anton-mh3c / anton-vzhf). Its three dependencies — the
 * self-freshness verdict, the breaker's contract line, and the reschedulable stop that defers the
 * run — live here rather than in {@link prepareEpicRun}; the run-shape seam re-exports
 * {@link assertSelfCheckoutFresh} to it (anton-8x1k), so preparation reaches this gate through the
 * one seam it already threads its pipeline and lease through instead of fanning these modules out
 * into its own top-level imports.
 */
import { BREAKER_EFFECT } from "../autopilot-breaker";
import { isPoisonError, StaleCheckoutError, STALE_CHECKOUT_REFUSAL_PREFIX } from "./errors";
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
 * A read-only refusal like every gate around it, and it inherits their contract: the deferral costs
 * no lease, worktree or claim, and a run already in flight — a separate job long past this gate — is
 * untouched, only a new start is stopped ({@link BREAKER_EFFECT}). {@link prepareEpicRun} places it
 * AFTER the completion short-circuit so a target already carried to its pull request still settles
 * idempotently rather than being grounded by a staleness with nothing left to run.
 *
 * A {@link StaleCheckoutError}, NOT a poison: the fix is process-wide (pull/reinstall, then restart
 * anton), so parking would leave every job that hit it stranded in `parked` until a human resumed
 * each by hand even after the restart cleared the condition. Instead the runner reschedules the job
 * on a slow cadence with the attempt refunded, so the restarted-on-fresh-code process runs it
 * itself. The message is still the durable record the run row keeps and the run-health sweep
 * surfaces, and `staleBreaker` shows the stopped state in the app independent of the deferral.
 */
export async function assertSelfCheckoutFresh(): Promise<void> {
  const root = selfRepoRoot();
  const refusal = staleCheckoutRefusal(await checkSelfFreshness(root), root);
  if (refusal) throw new StaleCheckoutError(refusal);
}

/**
 * The same refusal, asked of a PRE-START gate's permanent verdict (PR #257 review).
 *
 * {@link assertSelfCheckoutFresh} sits after the completion short-circuit, which is deliberate — a
 * target already carried to its pull request must settle idempotently rather than be grounded by a
 * staleness with nothing left to run. But `beginEpicRun` runs BEFORE that short-circuit, and its
 * gates park PERMANENTLY: target shape, approval, proposal-ness, human ownership, readiness. A stale
 * process decides all five on the code it booted with, so a fix that changed any of those semantics
 * would have the old process park the job on the old rule — and a park is not undone by a restart.
 * Nothing re-dispatches a parked job; only a person does.
 *
 * So a poison raised while the process is behind its own code is not trusted as permanent: the
 * freshness verdict is re-asked and, when it is stale, the run defers on {@link StaleCheckoutError}
 * instead — refunded and rescheduled, to be re-decided by the restarted process on fresh code. A
 * verdict that is still poison there parks then, on rules anton actually has.
 *
 * Asked only on the refusal path, so an ordinary start pays nothing here and reaches the gate in its
 * documented place — which is what keeps the completion path for an already-delivered target intact:
 * that target passes every gate above, so it never reaches this at all.
 */
export async function assertPreStartPoisonIsFresh(e: unknown): Promise<void> {
  if (isPoisonError(e)) await assertSelfCheckoutFresh();
}

/**
 * The refusal a stale checkout stops a new start with (anton-mh3c), or undefined when anton is
 * running its own latest code. Names WHAT is stale and the command that clears it, and closes with the
 * disarm's contract line ({@link BREAKER_EFFECT}) so the operator reads the same "running work is
 * unaffected" promise a disarm makes rather than fearing a full stop.
 *
 * Only a verdict anton can act on counts as stale: HEAD behind its own upstream, installed packages
 * that no longer match the lockfile, packages reinstalled under the ones the process is running, or a
 * running build the code on disk has already moved past — the last two being the gap a pull/reinstall
 * opens before the restart that adopts it. Every INDETERMINATE verdict — a remote it could not reach,
 * a branch with no upstream, a lockfile it could not read, a build identity it could not establish —
 * passes exactly as a clean one does: refusing a start on a check that never answered would ground an
 * offline runner on no evidence, the line anton-vzhf drew and this honours.
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
  if (freshness.dependencies.state === "replaced") {
    // `bun install` makes node_modules match the lockfile instantly and moves no build identity at
    // all — node_modules is excluded from every one — so without this the prescribed remedy would
    // clear the stop on a process still importing the old install (PR #257 review).
    stale.push("its packages were reinstalled under the ones it is running");
  }
  if (freshness.build.state === "drifted") {
    // The filesystem halves above clear the moment a pull/reinstall lands, but the process keeps the
    // modules it booted with — so the disk can be current while the running build is not (anton-vzhf).
    stale.push("the code on disk has already moved past the build it is running");
  }
  if (stale.length === 0) return undefined;
  return (
    `${STALE_CHECKOUT_REFUSAL_PREFIX} ` +
    `${stale.join("; ")} in ${repoPath}, then restart anton. ${BREAKER_EFFECT}`
  );
}
