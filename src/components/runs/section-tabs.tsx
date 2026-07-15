import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Runs | Jobs switcher shown atop both the runs and jobs pages. `runs` rows are execution runs
 * (execute-epic, with a detail view); `jobs` are the raw durable queue across every type/status.
 * They're split into sibling routes so each paginates independently.
 */
export function SectionTabs({
  slug,
  active,
  runsCount,
  jobsCount,
}: {
  slug: string;
  active: "runs" | "jobs";
  runsCount?: number;
  jobsCount?: number;
}) {
  const tabs = [
    { key: "runs" as const, label: "Runs", href: `/projects/${slug}/runs`, count: runsCount },
    { key: "jobs" as const, label: "Jobs", href: `/projects/${slug}/jobs`, count: jobsCount },
  ];
  return (
    <nav className="flex items-center gap-1 border-b border-border px-4">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-2.5 text-[13px] transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="font-mono text-[10px] text-subtle">{t.count}</span>
            )}
            {isActive && (
              <span
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"
                aria-hidden="true"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
