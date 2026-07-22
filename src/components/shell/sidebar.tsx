"use client";

import Link from "next/link";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LinkPendingIndicator } from "@/components/ui/link-pending-indicator";
import { isNavItemActive, type ShellNavItem } from "@/components/shell/shell-utils";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { AntonWordmark } from "@/components/shell/brand";
import { UsagePill } from "@/components/usage/usage-pill";
import {
  BoardIcon,
  DependenciesIcon,
  JobsIcon,
  ProjectsIcon,
  RunsIcon,
  SettingsIcon,
  TicketsIcon,
} from "@/components/shell/icons";

type NavIcon = React.ComponentType<{ className?: string }>;
type NavEntry = ShellNavItem & { icon: NavIcon; exact?: boolean };

function projectNav(slug: string): NavEntry[] {
  return [
    { label: "Board", href: `/projects/${slug}`, icon: BoardIcon, exact: true },
    { label: "Tickets", href: `/projects/${slug}/tickets`, icon: TicketsIcon },
    { label: "Dependencies", href: `/projects/${slug}/dependencies`, icon: DependenciesIcon },
  ];
}

function workspaceNav(slug?: string): NavEntry[] {
  return [
    { label: "Projects", href: "/", icon: ProjectsIcon, exact: true },
    ...(slug
      ? ([
          { label: "Runs", href: `/projects/${slug}/runs`, icon: RunsIcon },
          { label: "Jobs", href: `/projects/${slug}/jobs`, icon: JobsIcon },
          { label: "Settings", href: `/projects/${slug}/settings`, icon: SettingsIcon },
        ] as NavEntry[])
      : []),
  ];
}

export function Sidebar({
  pathname,
  projectSlug,
  projectName,
  mobileOpen,
  onCloseMobile,
}: {
  pathname: string | null;
  projectSlug?: string;
  projectName?: string;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const label = projectName ?? projectSlug;

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onCloseMobile}
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-xs lg:hidden"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-58 shrink-0 -translate-x-full flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground transition-transform duration-150 lg:static lg:z-auto lg:translate-x-0",
          mobileOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-4">
          <Link
            href="/"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <AntonWordmark />
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onCloseMobile}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {projectSlug && (
          <Link
            href="/"
            title={`${label} — switch project`}
            className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-2.5 py-2 transition-colors hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 has-[[data-pending]]:opacity-60"
          >
            <span className="flex size-5 items-center justify-center rounded-md border border-border bg-muted font-mono text-[10px] font-medium text-primary">
              {label?.[0]?.toLowerCase() ?? "a"}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
            <LinkPendingIndicator
              className="size-3 text-muted-foreground"
              idle={<ChevronDownIcon className="size-3" aria-hidden="true" />}
            />
          </Link>
        )}

        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {projectSlug && (
            <NavGroup label="Project">
              {projectNav(projectSlug).map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </NavGroup>
          )}

          <NavGroup label="Workspace">
            {workspaceNav(projectSlug).map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </NavGroup>
        </nav>

        <div className="mt-4 flex flex-col gap-3">
          {/* Global Claude usage glance. Renders nothing until live usage resolves and hides again
              if the API reports absence — no reserved slot, so the footer never shifts. */}
          <UsagePill />
          <ThemeToggle />
          <div className="flex items-center gap-2.5 px-1">
            <span className="size-6 shrink-0 rounded-full bg-[linear-gradient(135deg,#4fc08a,#57a8f2)]" aria-hidden="true" />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs">local machine</span>
              <span className="font-mono text-[10px] text-subtle">idle</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1 font-mono text-[10px] tracking-[0.04em] text-subtle uppercase">
        {label}
      </p>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavEntry; pathname: string | null }) {
  const active = item.exact ? pathname === item.href : isNavItemActive(pathname, item);
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 has-[[data-pending]]:opacity-60",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-subtle")} />
        {item.label}
        <LinkPendingIndicator className="ml-auto text-subtle" />
      </Link>
    </li>
  );
}
