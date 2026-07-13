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

/** Prefix on every comment anton posts — the gate that keeps a replied-to thread quiet. */
export const ANTON_MARK = "🤖";

/** One inline review thread (GraphQL), with the REST ids needed to reply. */
export interface ReviewThread {
  /** GraphQL node id — used to resolve the thread. */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  /** Comment chain, oldest first. `id` is the REST databaseId (for the replies endpoint). */
  comments: Array<{ id: number; author: string; body: string }>;
}

export interface PrReview {
  number: number;
  /** OPEN | MERGED | CLOSED */
  state: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  reviewDecision: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN | null */
  mergeable: string | null;
  /** The PR's head branch — the branch anton pushes fixes to. */
  headRefName: string;
  url: string;
  /** Submitted reviews (latest state per reviewer as gh reports them). */
  reviews: Array<{ author: string; state: string; body: string }>;
  /** Failing checks, by name. */
  failingChecks: string[];
  pendingChecks: number;
  /** Inline review threads (resolved ones included; filter with threadsNeedingAttention). */
  threads: ReviewThread[];
}

interface GhPrView {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeable?: string | null;
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
      "number,state,reviewDecision,mergeable,headRefName,url,reviews,statusCheckRollup",
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
    mergeable: view.mergeable ?? null,
    headRefName: view.headRefName,
    url: view.url,
    reviews,
    failingChecks,
    pendingChecks,
    threads: await getReviewThreads(repoPath, number, signal),
  };
}

/** `owner/repo` of the repo's default remote, or undefined when gh can't resolve it. */
async function nameWithOwner(repoPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const nwo = (
    await gh(repoPath, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], signal)
  ).trim();
  return nwo || undefined;
}

/**
 * Inline review threads via GraphQL — the only API that exposes thread resolution state and the
 * node ids `resolveReviewThread` needs. Best-effort — returns [] on any failure (same contract as
 * the old REST comment fetch), so a missing token degrades to "no inline feedback", not a crash.
 */
async function getReviewThreads(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewThread[]> {
  try {
    const nwo = await nameWithOwner(repoPath, signal);
    if (!nwo) return [];
    const [owner, repo] = nwo.split("/");
    const query = `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){pullRequest(number:$number){
        reviewThreads(first:100){nodes{
          id isResolved isOutdated path line
          comments(first:50){nodes{databaseId author{login} body}}
        }}
      }}
    }`;
    const raw = await gh(
      repoPath,
      [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${repo}`,
        "-F", `number=${number}`,
      ],
      signal,
    );
    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id?: string;
                isResolved?: boolean;
                isOutdated?: boolean;
                path?: string | null;
                line?: number | null;
                comments?: { nodes?: Array<{ databaseId?: number; author?: { login?: string } | null; body?: string }> };
              }>;
            };
          };
        };
      };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes
      .filter((n) => typeof n?.id === "string")
      .map((n) => ({
        id: n.id!,
        isResolved: n.isResolved ?? false,
        isOutdated: n.isOutdated ?? false,
        path: n.path ?? undefined,
        line: n.line ?? undefined,
        comments: (n.comments?.nodes ?? [])
          .filter((c) => typeof c?.databaseId === "number")
          .map((c) => ({
            id: c.databaseId!,
            author: c.author?.login ?? "unknown",
            body: c.body ?? "",
          })),
      }));
  } catch {
    return [];
  }
}

/**
 * Unresolved threads still waiting on anton: the last comment is not anton's. Once anton replies
 * (every anton comment starts with ANTON_MARK) the thread stops being actionable until a human
 * responds or resolves it — that's what prevents a reply loop across sweeps.
 */
export function threadsNeedingAttention(pr: PrReview): ReviewThread[] {
  return pr.threads.filter((t) => {
    if (t.isResolved) return false;
    const last = t.comments[t.comments.length - 1];
    return !last || !last.body.startsWith(ANTON_MARK);
  });
}

export interface Actionable {
  actionable: boolean;
  reasons: string[];
}

/**
 * Pure classifier: does this PR need anton to act? Actionable when the PR is OPEN and a reviewer
 * requested changes, a CI check is failing, the branch conflicts with its base, or an unresolved
 * review thread is still waiting on anton (see threadsNeedingAttention). Pending checks /
 * approvals / a clean PR are NOT actionable (nothing to fix yet). Kept pure so it's unit-testable
 * without `gh`.
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
  if (pr.mergeable === "CONFLICTING") {
    reasons.push("merge conflicts with the base branch");
  }
  const waiting = threadsNeedingAttention(pr);
  if (waiting.length > 0) {
    reasons.push(`${waiting.length} unresolved review thread(s)`);
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

/** Reply within an inline review thread (REST replies endpoint, keyed by a comment databaseId). */
export async function replyToReviewComment(
  repoPath: string,
  number: number,
  commentId: number,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  const nwo = await nameWithOwner(repoPath, signal);
  if (!nwo) return;
  await gh(
    repoPath,
    ["api", "--method", "POST", `repos/${nwo}/pulls/${number}/comments/${commentId}/replies`, "-f", `body=${body}`],
    signal,
  );
}

/** Mark a review thread resolved (GraphQL — thread ids come from getReviewThreads). */
export async function resolveReviewThread(
  repoPath: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<void> {
  const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`;
  await gh(repoPath, ["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${threadId}`], signal);
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
