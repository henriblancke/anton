"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import type { Project } from "@/lib/types";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
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
    <div className="flex min-h-screen w-full">
      <Sidebar
        pathname={pathname}
        projectSlug={projectSlug}
        projectName={projectName}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar projectSlug={projectSlug} projectName={projectName} onOpenMobile={openMobile} />
        <main className="flex flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col">{children}</div>
        </main>
      </div>
    </div>
  );
}
