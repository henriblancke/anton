import { STAGES } from "@/lib/types";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";
import { cn } from "@/lib/utils";

export function BoardSkeleton() {
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4"
      aria-busy="true"
      aria-label="Loading board"
    >
      {STAGES.map((stage) => (
        <div key={stage} className="flex flex-col gap-3">
          <div className="flex items-center gap-2 px-0.5">
            <span className={cn("size-2.5 rounded-full opacity-60", STAGE_ACCENT_DOT[stage])} />
            <span className="text-[13px] font-semibold text-foreground">{STAGE_LABELS[stage]}</span>
          </div>
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className={cn(
                  "flex flex-col gap-2.5 rounded-xl border border-border bg-card p-[13px]",
                  i === 1 && "opacity-60",
                )}
              >
                <span className="anton-shimmer h-2.5 w-2/5 rounded" />
                <span className="anton-shimmer h-3 w-4/5 rounded" />
                <span className="anton-shimmer h-1 w-full rounded-full" />
                <div className="flex gap-1.5">
                  <span className="anton-shimmer h-4 w-13 rounded" />
                  <span className="anton-shimmer h-4 w-11 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
