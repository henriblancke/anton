import Link from "next/link";

import { SPEND_WINDOWS, type SpendWindow } from "@/lib/spend-breakdown";
import { cn } from "@/lib/utils";

/**
 * The chosen window (anton-1kdm), as links rather than a client-side control.
 *
 * The window is a server-side query bound — the page reads the ledger with it — so it belongs in the
 * URL, and links keep this whole surface a Server Component. It also makes a window shareable, which
 * a routing argument is normally made from.
 */
export function SpendWindowTabs({ slug, window }: { slug: string; window: SpendWindow }) {
  return (
    <nav aria-label="Spend window" className="flex flex-wrap items-center gap-1">
      {SPEND_WINDOWS.map((option) => {
        const active = option.value === window;
        return (
          <Link
            key={option.value}
            href={`/projects/${slug}/spend?window=${option.value}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "border-ring/40 bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}
