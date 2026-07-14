import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Rows per page for the runs/jobs lists. */
export const PAGE_SIZE = 25;

/** Clamp a raw `?page` value to a valid 1-based page for `total` rows. */
export function resolvePage(raw: string | undefined, total: number, pageSize = PAGE_SIZE): number {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), totalPages);
}

/**
 * Prev/next pager driven by a `?page` query param on `basePath`. Server-rendered links (no client
 * JS) — each page route paginates independently. Hidden when everything fits on one page.
 */
export function Pagination({
  basePath,
  page,
  total,
  pageSize = PAGE_SIZE,
}: {
  basePath: string;
  page: number; // 1-based, already clamped
  total: number;
  pageSize?: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const href = (p: number) => (p <= 1 ? basePath : `${basePath}?page=${p}`);

  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
      <span className="font-mono text-[11px] text-subtle">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <PageLink href={href(page - 1)} disabled={page <= 1} label="Previous page">
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
        </PageLink>
        <span className="px-2 font-mono text-[11px] text-muted-foreground">
          {page} / {totalPages}
        </span>
        <PageLink href={href(page + 1)} disabled={page >= totalPages} label="Next page">
          <ChevronRightIcon className="size-3.5" aria-hidden="true" />
        </PageLink>
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const base =
    "flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors";
  if (disabled) {
    return (
      <span className={cn(base, "cursor-not-allowed opacity-40")} aria-disabled="true" aria-label={label}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={cn(base, "hover:bg-card/50 hover:text-foreground")} aria-label={label}>
      {children}
    </Link>
  );
}
