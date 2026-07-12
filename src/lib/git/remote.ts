/**
 * Resolve a project's GitHub web base from its `origin` remote so the UI can turn a bead's
 * external-ref (stored as `gh-<number>`, see git/ops.ts `prFromUrl`) into a clickable PR link.
 * The remote lookup is a fast local `git` call, memoized per repo path for the process lifetime.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** repoPath → resolved base (or undefined). `null` marks "resolved, but none" to avoid re-spawning. */
const cache = new Map<string, string | null>();

/**
 * Normalize a git remote URL to its web base, e.g.
 *   git@github.com:owner/repo.git        → https://github.com/owner/repo
 *   https://github.com/owner/repo.git    → https://github.com/owner/repo
 *   ssh://git@github.com/owner/repo      → https://github.com/owner/repo
 * Returns undefined when the URL can't be parsed to host + owner/repo.
 */
export function webBaseFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const url = remote.trim();
  // scp-like syntax: git@host:owner/repo(.git)
  const scp = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  // ssh://, https://, http://, git:// with an explicit scheme
  const scheme = url.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scheme) return `https://${scheme[1]}/${scheme[2]}`;
  return undefined;
}

/** Resolve (and cache) the GitHub web base for a repo's `origin`. undefined when there's no remote. */
export async function githubBaseUrl(repoPath: string): Promise<string | undefined> {
  const cached = cache.get(repoPath);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      timeout: 10_000,
    });
    const base = webBaseFromRemote(stdout) ?? null;
    cache.set(repoPath, base);
    return base ?? undefined;
  } catch {
    cache.set(repoPath, null);
    return undefined;
  }
}

/**
 * Build the browser URL for a bead's PR external-ref. A full http(s) ref is returned as-is; a
 * `gh-<number>` ref is expanded against `base` to `<base>/pull/<number>`. Returns undefined when
 * there's nothing linkable (no ref, or a short ref with no known base). Pure — unit-testable.
 */
export function prUrlFromRef(ref: string | undefined, base: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (/^https?:\/\//i.test(ref)) return ref;
  const m = ref.match(/gh-(\d+)/);
  if (m && base) return `${base}/pull/${m[1]}`;
  return undefined;
}

/** Set `prUrl` on a freshly-built ticket/epic when its `prRef` resolves to a link. Mutates + returns. */
export function attachPrUrl<T extends { prRef?: string; prUrl?: string }>(
  item: T,
  base: string | undefined,
): T {
  const url = prUrlFromRef(item.prRef, base);
  if (url) item.prUrl = url;
  return item;
}
