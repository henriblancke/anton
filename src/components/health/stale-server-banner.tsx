import { RotateCcwIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { describeBuildIdentity, type ServerDrift } from "@/lib/build/drift";

/**
 * What each verdict means in the operator's terms — the claim, then what it costs.
 *
 * `who` stays generic only for the process rendering this page, alone: "this anton server" is what
 * an operator reads as the tab in front of them, so a drifting NEIGHBOUR wearing it sends them to
 * restart the wrong process — the current UI — while the stale runner keeps executing the
 * nightlies (PR #217 review). Every other case is named by pid; the lone self-drift is the install
 * that has only ever run one process, where a pid in front of every sentence is noise.
 */
function driftCopy(server: ServerDrift, who: string): { headline: string; detail: string } {
  const { drift } = server;
  const onDisk = describeBuildIdentity(drift.onDisk);
  if (drift.state === "unstamped") {
    return {
      headline: `${who} can't say what build it is running`,
      detail:
        `Its build carries no stamp — it predates this check, or it was compiled outside ` +
        `\`anton start\` — so nothing here can tell whether it matches the ${onDisk} on disk.`,
    };
  }
  const moved = drift.state === "outdated" ? "the runtime on disk is now" : "the checkout has since moved to";
  return {
    headline: `${who} is older than the code on disk`,
    detail: `It booted from ${describeBuildIdentity(drift.running)} and ${moved} ${onDisk}.`,
  };
}

/**
 * What this drift actually costs, which depends entirely on whether the process runs the jobs
 * (PR #217 review). An install can serve its pages from an `ANTON_RUNNER=off` server while a second
 * process executes the nightlies, and telling the operator a stale UI is degrading their scans is a
 * false alarm as surely as saying nothing about a stale runner is a false all-clear.
 *
 * A record predating the flag claims neither — an absence is not evidence.
 */
function consequence(runner: boolean | undefined): string | null {
  if (runner === undefined) return null;
  return runner
    ? "Scheduled jobs — the nightly scan, the patrol, every run — execute the build this process holds, so anything shipped since it booted is not running."
    : "This process serves the UI only (ANTON_RUNNER=off), so scheduled jobs are unaffected by it — the process running them is reported here separately when its own build drifts.";
}

/**
 * The stale-process warning (anton-pzfb), at the top of the report because it changes how to read
 * everything under it: a nightly that ran under a build predating a shipped filter charts signals
 * that filter would have dropped, which is exactly what happened for three nights running while the
 * fix sat un-run on disk and only the CLI could have said so.
 *
 * One warning per drifting process, not one for the process that happened to render the page: the
 * runner is the one whose build the jobs execute, and it is not necessarily this one.
 *
 * It names the restart and stops there. anton does not restart itself — a live process may be
 * mid-run — the same read-only stance `anton doctor` takes with skill drift.
 *
 * Renders nothing when every running server matches the checkout, which is the ordinary case: this
 * is a banner an operator should see roughly never.
 */
export function StaleServerBanner({ servers }: { servers: ServerDrift[] }) {
  if (servers.length === 0) return null;

  return (
    <>
      {servers.map((server) => {
        const sole = server.self && servers.length === 1;
        const who = sole ? "This anton server" : `The anton server on pid ${server.pid}`;
        const { headline, detail } = driftCopy(server, who);
        const cost = consequence(server.runner);
        const headingId = `stale-server-heading-${server.pid}`;

        return (
          <section
            key={server.pid}
            aria-labelledby={headingId}
            className="rounded-xl border border-risk-med/30 bg-risk-med/5 text-xs"
          >
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-risk-med/20 px-3 py-2">
              <RotateCcwIcon className="size-3.5 text-risk-med" aria-hidden="true" />
              <h2 id={headingId} className="text-xs font-medium text-foreground">
                {headline}
              </h2>
              <MetaChip tone="risk-med">restart to clear</MetaChip>
              {server.runner ? <MetaChip tone="risk-med">runs scheduled jobs</MetaChip> : null}
              {server.drift.bootedAt ? (
                <span className="text-xs text-subtle">
                  running since <RelativeTime iso={new Date(server.drift.bootedAt).toISOString()} />
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 px-3 py-2">
              <p className="text-muted-foreground">{detail}</p>
              {cost ? <p className="text-muted-foreground">{cost}</p> : null}
              <p className="text-subtle">
                Restart {sole ? "the server" : `pid ${server.pid}`} to adopt the build on disk. anton
                will not do it for you: a running process may be mid-run.
              </p>
            </div>
          </section>
        );
      })}
    </>
  );
}
