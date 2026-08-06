/**
 * Instant skeleton for the Health page's route-level `loading.tsx` — the page's data read (the board's
 * hygiene/scan/trajectory reads plus the open-escalation read, see lib/health.ts) happens before the
 * page returns any markup, so only a route-level boundary can cover it. Mirrors the report's own
 * shape (a main column of panels beside a narrower rail) rather than a generic spinner, so the layout
 * doesn't jump once the real data lands.
 */
export function HealthPageFallback({ slug }: { slug?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{slug}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Health</span>
        </div>
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 p-[18px] min-[900px]:flex-row min-[900px]:items-start"
        aria-label="Loading health report"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card/60 p-3">
              <span className="anton-shimmer h-3 w-1/4 rounded" />
              <span className="anton-shimmer h-3 w-3/4 rounded" />
              <span className="anton-shimmer h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
        <div className="flex w-full flex-col gap-2.5 rounded-xl border border-border bg-card/60 p-3 min-[900px]:w-52 min-[900px]:shrink-0">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="anton-shimmer h-8 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
