"use client";

import Link from "next/link";
import { FolderGitIcon, LayoutDashboardIcon, ListTodoIcon, XIcon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { isNavItemActive, type ShellNavItem } from "@/components/shell/shell-utils";
import { ThemeToggle } from "@/components/shell/theme-toggle";

const PRIMARY_NAV: ShellNavItem[] = [{ label: "Projects", href: "/" }];

function projectNav(slug: string): ShellNavItem[] {
  return [
    { label: "Board", href: `/projects/${slug}` },
    { label: "Tickets", href: `/projects/${slug}/tickets` },
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
          "fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 -translate-x-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-150 lg:static lg:z-auto lg:translate-x-0",
          mobileOpen && "translate-x-0",
        )}
      >
        <div className="flex h-12 items-center justify-between gap-2 px-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1 py-1 text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="flex size-5 items-center justify-center rounded-md bg-primary text-[0.7rem] font-bold text-primary-foreground">
              a
            </span>
            anton
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

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-2">
          <ul className="flex flex-col gap-0.5">
            {PRIMARY_NAV.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} icon={FolderGitIcon} />
            ))}
          </ul>

          {projectSlug && (
            <div className="flex flex-col gap-0.5">
              <p className="truncate px-2 text-xs font-medium text-muted-foreground" title={projectName ?? projectSlug}>
                {projectName ?? projectSlug}
              </p>
              <ul className="flex flex-col gap-0.5">
                <NavLink
                  item={projectNav(projectSlug)[0]}
                  pathname={pathname}
                  icon={LayoutDashboardIcon}
                  exact
                />
                <NavLink item={projectNav(projectSlug)[1]} pathname={pathname} icon={ListTodoIcon} />
              </ul>
            </div>
          )}
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}

function NavLink({
  item,
  pathname,
  icon: Icon,
  exact = false,
}: {
  item: ShellNavItem;
  pathname: string | null;
  icon: LucideIcon;
  exact?: boolean;
}) {
  const active = exact ? pathname === item.href : isNavItemActive(pathname, item);
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {item.label}
      </Link>
    </li>
  );
}
