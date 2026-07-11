/**
 * Pure helpers for the app shell. Kept dependency-free so they're trivially testable
 * (see shell-utils.test.ts) and reusable from the shell's client components.
 */

/** Extracts the project slug from a pathname like `/projects/acme/tickets`, or undefined
 * outside project-scoped routes. */
export function extractProjectSlug(pathname: string | null | undefined): string | undefined {
  if (!pathname) return undefined;
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  return match?.[1];
}

export interface ShellNavItem {
  label: string;
  href: string;
}

/** Whether a nav link should render as active for the current pathname. Exact match for
 * the project root (Board), prefix match for nested sections (Tickets, epics, ...). */
export function isNavItemActive(pathname: string | null | undefined, item: ShellNavItem): boolean {
  if (!pathname) return false;
  if (pathname === item.href) return true;
  if (item.href === "/") return false;
  return pathname.startsWith(`${item.href}/`);
}
