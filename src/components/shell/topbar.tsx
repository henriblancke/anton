"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PlusIcon, SearchIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { pageLabelFromPath } from "@/components/shell/shell-utils";

/**
 * The single screen header for the board (and any screen that wants the standard
 * breadcrumb + search + Add work bar). Screens with bespoke headers (epic detail, settings,
 * runs, shape) render their own instead — there is no global topbar, matching the design's
 * one-header-per-screen layout.
 */
export function Topbar({
  projectName,
  projectSlug,
}: {
  projectName?: string;
  projectSlug?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const pageLabel = pageLabelFromPath(pathname);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!projectSlug) return;
    const trimmed = query.trim();
    router.push(
      `/projects/${projectSlug}/tickets${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ""}`,
    );
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5 sm:px-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        <Link
          href={projectSlug ? `/projects/${projectSlug}` : "/"}
          className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={projectName ?? projectSlug ?? "Projects"}
        >
          {projectName ?? projectSlug ?? "Projects"}
        </Link>
        {pageLabel && (
          <>
            <span className="shrink-0 text-subtle" aria-hidden="true">
              /
            </span>
            <span className="truncate font-medium text-foreground">{pageLabel}</span>
          </>
        )}
      </nav>

      {projectSlug && (
        <form
          onSubmit={handleSearch}
          role="search"
          className="ml-5 hidden w-60 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 has-focus-within:border-ring/60 md:flex"
        >
          <SearchIcon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search epics & tickets"
            aria-label="Search epics and tickets"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-subtle focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1 font-mono text-[10px] text-subtle lg:inline">
            ⌘K
          </kbd>
        </form>
      )}

      <div className="ml-auto flex items-center gap-2.5">
        {projectSlug && (
          <Link href={`/projects/${projectSlug}/shape`} className={buttonVariants({ size: "sm" })}>
            <PlusIcon aria-hidden="true" />
            Add work
          </Link>
        )}
      </div>
    </header>
  );
}
