"use client";

/**
 * The advisory half of the contract, where the operator actually is when it matters (anton-j9zs).
 *
 * The approve route refuses a BLOCKING gap and reports the advisory ones in its 200 body: the run is
 * starting despite them, so they cost quality, not runnability. Nothing else surfaces them at that
 * moment — the board chip is behind on the card the operator just left — so every surface that
 * starts a run reads the body here and says it once, next to its own success toast.
 */
import { toast } from "sonner";

/** One `id → missing X, Y` line per thin bead, as the approve route formats them. */
function gapsOf(body: unknown): string[] {
  const advisory = (body as { advisory?: unknown } | null)?.advisory;
  return Array.isArray(advisory) ? advisory.filter((g): g is string => typeof g === "string") : [];
}

/**
 * Surface the advisory contract gaps an approve/run POST reported, if any. Consumes the response
 * body, so callers pass a response they've already accepted as ok. Silent on a conformant target
 * (the common case) and on a body that carries none — a run must never be held up by its own
 * reporting, so a malformed payload is simply nothing to say.
 *
 * NEVER throws, which is what lets every caller await it inside the `try` that wraps its approve.
 * The approval has already landed by the time this runs; a failure here rethrown into that `try`
 * would roll the optimistic state back and toast an error for work that actually succeeded.
 */
export async function toastContractAdvisory(res: Response): Promise<void> {
  try {
    toastAdvisoryGaps(await res.json().catch(() => null));
  } catch (err) {
    console.error("[contract-advisory] failed to read advisory gaps", err);
  }
}

/**
 * The same report, for a caller that has ALREADY read the body — a response body can only be
 * consumed once, and a surface that inspects the 200 payload before deciding the run really started
 * (`release-action.tsx`, which reads `jobId`) has nothing left to hand {@link toastContractAdvisory}.
 *
 * NEVER throws, for the same reason as above.
 */
export function toastAdvisoryGaps(body: unknown): void {
  try {
    const gaps = gapsOf(body);
    if (gaps.length === 0) return;
    toast.warning(gaps.length === 1 ? "1 spec gap" : `${gaps.length} spec gaps`, {
      // Long enough to read several bead ids and act on them; the run is already under way.
      duration: 10_000,
      description: (
        <div className="flex flex-col gap-1">
          <span>Runs as shaped, but thinner than it could be.</span>
          <ul className="flex flex-col gap-0.5">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ),
    });
  } catch (err) {
    console.error("[contract-advisory] failed to surface advisory gaps", err);
  }
}
