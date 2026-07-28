/**
 * Paging arithmetic shared by the list pages, the `Pagination` component, and the routes that have
 * to agree with them (the batch cancel cap). Kept out of the component so a server route never
 * depends on a UI module to learn the page size.
 */

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
 * Page link for `basePath`, which may already carry a query (the Jobs filters). Every other param
 * rides along untouched, so paging never silently drops the filter the counts were computed from.
 * Page 1 omits `page` entirely to keep the canonical URL clean.
 */
export function pageHref(basePath: string, page: number): string {
  const [path, query] = basePath.split("?");
  const params = new URLSearchParams(query);
  if (page <= 1) params.delete("page");
  else params.set("page", String(page));
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}
