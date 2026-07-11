import { STAGES } from "@/lib/types";

export function BoardSkeleton() {
  return (
    <div
      className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      aria-busy="true"
      aria-label="Loading board"
    >
      {STAGES.map((stage) => (
        <div key={stage} className="flex flex-col gap-3 rounded-xl bg-muted/30 p-3">
          <div className="flex items-center justify-between px-1">
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            <div className="h-4 w-5 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="flex flex-col gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
