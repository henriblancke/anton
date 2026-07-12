"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { MenuIcon } from "lucide-react";

import type { Project } from "@/lib/types";
import { Sidebar } from "@/components/shell/sidebar";
import { AntonWordmark } from "@/components/shell/brand";
import { extractProjectSlug } from "@/components/shell/shell-utils";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const projectSlug = extractProjectSlug(pathname);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(pathname);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((data: { projects: Project[] }) => {
        if (!cancelled) setProjects(data.projects);
      })
      .catch(() => {
        // Non-fatal: the sidebar/topbar fall back to the slug for the project label.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the mobile drawer on navigation. Adjusted during render (not an effect) per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMobileOpen(false);
  }

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);

  const projectName = projectSlug
    ? projects?.find((p) => p.slug === projectSlug)?.name
    : undefined;

  return (
    <div className="flex h-dvh w-full">
      <Sidebar
        pathname={pathname}
        projectSlug={projectSlug}
        projectName={projectName}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile-only nav bar — desktop uses each screen's own single header (design parity). */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 lg:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={openMobile}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <MenuIcon className="size-4" aria-hidden="true" />
          </button>
          <AntonWordmark size={22} textClassName="text-base" />
        </div>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
