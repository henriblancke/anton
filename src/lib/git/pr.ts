/**
 * GitHub PR review/CI inspection via `gh` (anton-3t2.2). The review-fix job polls open PRs for
 * requested changes + failing checks; when actionable it dispatches claude to resolve, pushes, and
 * re-requests review. This module is the read/notify layer over `gh`; the binary is injectable
 * (ANTON_GH_BIN, shared with git/ops.ts) so tests point it at a fake. See DESIGN §4.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GH_BIN_ENV } from "./ops";

const execFileAsync = promisify(execFile);

function ghBin(): string {
  return process.env[GH_BIN_ENV] ?? "gh";
}

async function gh(repoPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(ghBin(), args, {
    cwd: repoPath,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return stdout;
}

/** Parse the PR number from a beads external-ref (`gh-123`) or a PR url. Returns undefined if none. */
export function prNumberFromRef(ref: string | undefined): number | undefined {
  if (!ref) return undefined;
  const m = ref.match(/gh-(\d+)/) ?? ref.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

export interface PrReview {
  number: number;
  /** OPEN | MERGED | CLOSED */
  state: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  reviewDecision: string | null;
  /** The PR's head branch — the branch anton pushes fixes to. */
  headRefName: string;
  url: string;
  /** Submitted reviews (latest state per reviewer as gh reports them). */
  reviews: Array<{ author: string; state: string; body: string }>;
  /** Failing checks, by name. */
  failingChecks: string[];
  pendingChecks: number;
  /** Inline review (line) comments. */
  comments: Array<{ author: string; path?: string; line?: number; body: string }>;
}

interface GhPrView {
  number: number;
  state: string;
  reviewDecision: string | null;
  headRefName: string;
  url: string;
  reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
  statusCheckRollup?: Array<{
    __typename?: string;
    name?: string;
    status?: string; // COMPLETED | IN_PROGRESS | QUEUED (checkRun)
    conclusion?: string; // SUCCESS | FAILURE | ... (checkRun)
    state?: string; // SUCCESS | FAILURE | PENDING (statusContext)
    context?: string; // statusContext name
  }>;
}

/** Is a single statusCheckRollup entry failing? Handles both checkRun + statusContext shapes. */
function isFailing(c: NonNullable<GhPrView["statusCheckRollup"]>[number]): boolean {
  const bad = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
  if (c.conclusion) return bad.has(c.conclusion);
  if (c.state) return bad.has(c.state);
  return false;
}

function isPending(c: NonNullable<GhPrView["statusCheckRollup"]>[number]): boolean {
  if (c.conclusion) return false; // completed check run
  if (c.status && c.status !== "COMPLETED") return true;
  if (c.state === "PENDING") return true;
  return false;
}

/**
 * Fetch a PR's review decision, submitted reviews, CI rollup, and inline review comments.
 * `owner/repo` is resolved once via `gh repo view` so inline comments can be pulled from the API.
 */
export async function getPrReview(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<PrReview> {
  const raw = await gh(
    repoPath,
    [
      "pr",
      "view",
      String(number),
      "--json",
      "number,state,reviewDecision,headRefName,url,reviews,statusCheckRollup",
    ],
    signal,
  );
  const view = JSON.parse(raw) as GhPrView;

  const rollup = view.statusCheckRollup ?? [];
  const failingChecks = rollup
    .filter(isFailing)
    .map((c) => c.name ?? c.context ?? "check")
    .filter(Boolean);
  const pendingChecks = rollup.filter(isPending).length;

  const reviews = (view.reviews ?? []).map((r) => ({
    author: r.author?.login ?? "unknown",
    state: r.state ?? "",
    body: r.body ?? "",
  }));

  return {
    number: view.number,
    state: view.state,
    reviewDecision: view.reviewDecision ?? null,
    headRefName: view.headRefName,
    url: view.url,
    reviews,
    failingChecks,
    pendingChecks,
    comments: await getReviewComments(repoPath, number, signal),
  };
}

/** Inline review (line) comments via the REST API. Best-effort — returns [] on any failure. */
async function getReviewComments(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<PrReview["comments"]> {
  try {
    const nwo = (
      await gh(repoPath, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], signal)
    ).trim();
    if (!nwo) return [];
    const raw = await gh(repoPath, ["api", `repos/${nwo}/pulls/${number}/comments`, "--paginate"], signal);
    const arr = JSON.parse(raw || "[]") as Array<{
      user?: { login?: string };
      path?: string;
      line?: number | null;
      original_line?: number | null;
      body?: string;
    }>;
    return arr.map((c) => ({
      author: c.user?.login ?? "unknown",
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      body: c.body ?? "",
    }));
  } catch {
    return [];
  }
}

export interface Actionable {
  actionable: boolean;
  reasons: string[];
}

/**
 * Pure classifier: does this PR need anton to act? Actionable when the PR is OPEN and either a
 * reviewer requested changes or a CI check is failing. Pending checks / approvals / a clean PR are
 * NOT actionable (nothing to fix yet). Kept pure so it's unit-testable without `gh`.
 */
export function classifyReview(pr: PrReview): Actionable {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") return { actionable: false, reasons: ["pr not open"] };

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    reasons.push("changes requested by a reviewer");
  }
  if (pr.failingChecks.length > 0) {
    reasons.push(`failing checks: ${pr.failingChecks.join(", ")}`);
  }
  return { actionable: reasons.length > 0, reasons };
}

/** Post a comment on the PR (used to note that anton pushed fixes). Best-effort. */
export async function commentOnPr(
  repoPath: string,
  number: number,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  await gh(repoPath, ["pr", "comment", String(number), "--body", body], signal);
}

/**
 * Re-request review from every reviewer who last requested changes, so the PR re-enters their
 * queue after anton's fix. Best-effort per reviewer.
 */
export async function reRequestReview(
  repoPath: string,
  number: number,
  reviewers: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (reviewers.length === 0) return;
  const nwo = (
    await gh(repoPath, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], signal)
  ).trim();
  if (!nwo) return;
  const args = ["api", "--method", "POST", `repos/${nwo}/pulls/${number}/requested_reviewers`];
  for (const r of reviewers) args.push("-f", `reviewers[]=${r}`);
  try {
    await gh(repoPath, args, signal);
  } catch {
    // reviewer can't be re-requested (e.g. is the PR author / a team) — ignore.
  }
}

/** Logins whose latest review requested changes — the set to re-request after a fix. */
export function reviewersRequestingChanges(pr: PrReview): string[] {
  const latest = new Map<string, string>();
  for (const r of pr.reviews) latest.set(r.author, r.state);
  return [...latest.entries()].filter(([, s]) => s === "CHANGES_REQUESTED").map(([a]) => a);
}
