import { RotateCcwIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { describeBuildIdentity, type BuildDrift } from "@/lib/build/drift";

/** What each verdict means in the operator's terms — the claim, then what it costs. */
function driftCopy(drift: BuildDrift): { headline: string; detail: string } {
  const onDisk = describeBuildIdentity(drift.onDisk);
  if (drift.state === "unstamped") {
    return {
      headline: "This anton server can't say what build it is running",
      detail:
        `It recorded no build identity, so it predates this check — nothing here can tell whether ` +
        `it matches the ${onDisk} on disk.`,
    };
  }
  const moved = drift.state === "outdated" ? "the runtime on disk is now" : "the checkout has since moved to";
  return {
    headline: "This anton server is older than the code on disk",
    detail: `It booted from ${describeBuildIdentity(drift.running)} and ${moved} ${onDisk}.`,
  };
}

/**
 * The stale-process warning (anton-pzfb), at the top of the report because it changes how to read
 * everything under it: a nightly that ran under a build predating a shipped filter charts signals
 * that filter would have dropped, which is exactly what happened for three nights running while the
 * fix sat un-run on disk and only the CLI could have said so.
 *
 * It names the restart and stops there. anton does not restart itself — a live process may be
 * mid-run — the same read-only stance `anton doctor` takes with skill drift.
 *
 * Renders nothing when the running server matches the checkout, which is the ordinary case: this is
 * a banner an operator should see roughly never.
 */
export function StaleServerBanner({ drift }: { drift: BuildDrift | null }) {
  if (!drift) return null;
  const { headline, detail } = driftCopy(drift);

  return (
    <section
      aria-labelledby="stale-server-heading"
      className="rounded-xl border border-risk-med/30 bg-risk-med/5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-risk-med/20 px-3 py-2">
        <RotateCcwIcon className="size-3.5 text-risk-med" aria-hidden="true" />
        <h2 id="stale-server-heading" className="text-xs font-medium text-foreground">
          {headline}
        </h2>
        <MetaChip tone="risk-med">restart to clear</MetaChip>
        {drift.bootedAt ? (
          <span className="text-xs text-subtle">
            running since <RelativeTime iso={new Date(drift.bootedAt).toISOString()} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 px-3 py-2">
        <p className="text-muted-foreground">{detail}</p>
        <p className="text-muted-foreground">
          Scheduled jobs — the nightly scan, the patrol, every run — execute the build this process
          holds, so anything shipped since it booted is not running.
        </p>
        <p className="text-subtle">
          Restart the server to adopt the build on disk. anton will not do it for you: a running
          process may be mid-run.
        </p>
      </div>
    </section>
  );
}
