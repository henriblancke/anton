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
  /** The PR head's commit SHA — what distinguishes "same doomed input" from new commits (anton-bzm7s). */
  headSha: string;
  url: string;
  /** Submitted reviews (latest state per reviewer as gh reports them). */
  reviews: Array<{ author: string; state: string; body: string }>;
  /** Failing checks, by name. */
  failingChecks: string[];
  pendingChecks: number;
  /** Inline review threads (resolved ones included; filter with threadsNeedingAttention). */
  threads: ReviewThread[];
  /**
   * Whether `threads` is the PR's WHOLE inline history, or a degraded read — the GraphQL call failed
   * outright, or a later page did (see `getReviewThreads`). False makes an empty or short `threads`
   * distinguishable from a genuinely thread-free PR: a counter that persists `threads.length` without
   * checking this would report zero or understated counts indistinguishable from a clean PR.
   */
  threadsComplete: boolean;
}

interface GhPrView {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeable?: string | null;
  headRefName: string;
  headRefOid?: string;
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
      "number,state,reviewDecision,mergeable,headRefName,headRefOid,url,reviews,statusCheckRollup",
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
    headSha: view.headRefOid ?? "",
    url: view.url,
    reviews,
    failingChecks,
    pendingChecks,
    ...(await getReviewThreads(repoPath, number, signal)),
  };
}

/**
 * A PR's liveness at a glance (anton-4ks0) — state and last-activity, nothing else. Deliberately
 * NOT `PrReview`: the run-health sweep only asks "has anyone touched this?", and paying for
 * `getPrReview`'s reviews + CI rollup + GraphQL thread fetch per in-review target would make a
 * read-only health check the most expensive job on the board.
 */
export interface PrActivity {
  number: number;
  /** OPEN | MERGED | CLOSED */
  state: string;
  url: string;
  /** ms epoch of the last update GitHub recorded (push, comment, review, label). */
  updatedAtMs: number;
  isDraft: boolean;
}

/** Read a PR's state + last-activity time. Read-only; no writes, no side effects. */
export async function getPrActivity(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<PrActivity> {
  const raw = await gh(
    repoPath,
    ["pr", "view", String(number), "--json", "number,state,url,updatedAt,isDraft"],
    signal,
  );
  const view = JSON.parse(raw) as {
    number: number;
    state: string;
    url: string;
    updatedAt?: string;
    isDraft?: boolean;
  };
  const parsed = view.updatedAt ? Date.parse(view.updatedAt) : NaN;
  return {
    number: view.number,
    state: view.state,
    url: view.url,
    // An unparseable/absent timestamp reads as "just updated" so a gh quirk can never fabricate a
    // stale-PR finding out of a PR that may be perfectly active.
    updatedAtMs: Number.isFinite(parsed) ? parsed : Date.now(),
    isDraft: view.isDraft ?? false,
  };
}

/** `owner/repo` of the repo's default remote, or undefined when gh can't resolve it. */
async function nameWithOwner(repoPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const nwo = (
    await gh(repoPath, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], signal)
  ).trim();
  return nwo || undefined;
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100 after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{
        id isResolved isOutdated path line
        comments(first:50){totalCount nodes{databaseId author{login} body}}
      }
    }
  }}
}`;

interface RawReviewThreadNode {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: {
    totalCount?: number;
    nodes?: Array<{ databaseId?: number; author?: { login?: string } | null; body?: string }>;
  };
}

interface ReviewThreadsPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: RawReviewThreadNode[];
        };
      };
    };
  };
}

/**
 * Inline review threads via GraphQL — the only API that exposes thread resolution state and the
 * node ids `resolveReviewThread` needs. Best-effort — degrades to `{ threads: [], complete: false }`
 * on any failure (same contract as the old REST comment fetch), so a missing token reads as "no
 * inline feedback", not a crash.
 *
 * Paginated: a PR that has collected over 100 threads (routine on a long-running epic with a bot
 * reviewer commenting every round) used to have everything past the first page silently dropped,
 * including whichever thread was actually unresolved — `threadsNeedingAttention` never saw it, so
 * `classifyReview` reported the PR clean and the dispatcher skipped it with nothing to show for why.
 *
 * A later-page failure breaks the loop and returns the pages already fetched (marked `complete:
 * false`) rather than throwing to the outer catch and discarding every completed page — losing page
 * 1's unresolved threads would misclassify a >100-thread PR as clean the same way truncation did.
 * `classifyReview`/`threadsNeedingAttention` still act on the partial list (some feedback acted on
 * beats none), but a caller PERSISTING counts from `threads` (e.g. `recordReviewRound`) must check
 * `complete` first — a degraded read must not be indistinguishable from a genuinely thread-free PR.
 */
async function getReviewThreads(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<{ threads: ReviewThread[]; threadsComplete: boolean }> {
  const allNodes: RawReviewThreadNode[] = [];
  // Threads whose comment connection is truncated (see below) — excluded from the returned list
  // entirely rather than kept with a stale last-fetched comment, so a caller never re-triages or
  // replies against a thread it cannot see the true latest state of (PR #335 review).
  const truncatedThreadIds = new Set<string>();
  let complete = true;
  try {
    const nwo = await nameWithOwner(repoPath, signal);
    if (!nwo) return { threads: [], threadsComplete: false };
    const [owner, repo] = nwo.split("/");

    let cursor: string | undefined;
    for (;;) {
      let parsed: ReviewThreadsPage;
      try {
        const raw = await gh(
          repoPath,
          [
            "api", "graphql",
            "-f", `query=${REVIEW_THREADS_QUERY}`,
            "-f", `owner=${owner}`,
            "-f", `repo=${repo}`,
            "-F", `number=${number}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
          ],
          signal,
        );
        parsed = JSON.parse(raw) as ReviewThreadsPage;
      } catch {
        // Keep the pages already fetched, but flag the read as incomplete — a failed first page
        // still degrades to an empty, incomplete list.
        complete = false;
        break;
      }
      const page = parsed.data?.repository?.pullRequest?.reviewThreads;
      if (!page) {
        // Missing repository/pullRequest/reviewThreads is a malformed response, not "no threads" —
        // flag it so a degraded read isn't persisted as a genuinely thread-free PR.
        complete = false;
        break;
      }
      if (!Array.isArray(page.nodes)) {
        // A missing, null, or non-array `nodes` is a malformed response, not "no threads" — flag it
        // so a degraded read isn't persisted as a genuinely thread-free PR.
        complete = false;
        break;
      }
      allNodes.push(...page.nodes);
      // Each thread's comments connection is capped at first:50 with no cursor of its own — a
      // thread that has collected more comments than that (a long back-and-forth) silently drops
      // everything past comment 50, including the most recent one. threadsNeedingAttention treats
      // the last *fetched* comment as authoritative, so a truncated thread can misreport an anton
      // reply (or a human follow-up after it) as never having happened. totalCount lets us detect
      // that without a second, nested pagination loop — flag the read incomplete AND remember which
      // thread it was, so that specific thread is dropped from the returned list below rather than
      // being re-triaged, duplicate-replied to, or resolved against stale context (PR #335 review:
      // flagging the whole read incomplete wasn't enough — every consumer still saw the thread with
      // comment 50 as its latest). A thread missing `comments`/`totalCount` entirely is a DIFFERENT
      // failure (a malformed response, not a real thread with excess comments) — it still flags the
      // whole read incomplete so a caller never persists it as a genuinely thread-free/complete
      // round, but the thread itself is kept (its handful of comments, however few, are real and
      // there is no "true latest" being hidden behind a totalCount the response never reported).
      for (const n of page.nodes) {
        if (!n.comments || typeof n.comments.totalCount !== "number") {
          // comments missing entirely is a malformed response, not a real zero-comment thread — drop
          // it like the other malformed-comments cases below, so it never surfaces as an actionable
          // thread with no anchor comment to triage against (PR #335 review).
          complete = false;
          if (typeof n.id === "string") truncatedThreadIds.add(n.id);
          continue;
        }
        if (!Array.isArray(n.comments.nodes)) {
          // totalCount present but nodes isn't an array (null, missing, or malformed) — comments
          // are claimed but unreadable, so treat this like truncation: drop the thread below
          // rather than persisting it as a genuinely comment-free, complete thread.
          complete = false;
          if (typeof n.id === "string") truncatedThreadIds.add(n.id);
          continue;
        }
        if (n.comments.totalCount > n.comments.nodes.length) {
          complete = false;
          if (typeof n.id === "string") truncatedThreadIds.add(n.id);
        }
      }
      if (!page.pageInfo) {
        // No pageInfo at all is a malformed response, not "last page" — pagination could not
        // even be checked, so the read is incomplete.
        complete = false;
        break;
      }
      if (typeof page.pageInfo.hasNextPage !== "boolean") {
        // hasNextPage missing or null is a malformed response, not "last page" — pagination could
        // not be verified, so the nodes already fetched aren't confirmed as the full picture.
        complete = false;
        break;
      }
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor) {
        // hasNextPage is true but no cursor to continue with — pagination can't proceed, so the
        // nodes already fetched aren't the full picture.
        complete = false;
        break;
      }
      cursor = page.pageInfo.endCursor;
    }
  } catch {
    return { threads: [], threadsComplete: false };
  }

  const threads = allNodes
    .filter((n) => typeof n?.id === "string" && !truncatedThreadIds.has(n.id))
    .map((n) => ({
      id: n.id!,
      isResolved: n.isResolved ?? false,
      isOutdated: n.isOutdated ?? false,
      path: n.path ?? undefined,
      line: n.line ?? undefined,
      comments: (Array.isArray(n.comments?.nodes) ? n.comments.nodes : [])
        .filter((c) => typeof c?.databaseId === "number")
        .map((c) => ({
          id: c.databaseId!,
          author: c.author?.login ?? "unknown",
          body: c.body ?? "",
        })),
    }));
  return { threads, threadsComplete: complete };
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

/**
 * Existing top-level PR comments (the same surface `commentOnPr` posts to — not inline review
 * comments), oldest first. Lets a caller dedupe its own status posts before adding another.
 */
export async function getPrComments(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const raw = await gh(repoPath, ["pr", "view", String(number), "--json", "comments"], signal);
  const view = JSON.parse(raw) as { comments?: Array<{ body?: string }> };
  return (view.comments ?? []).map((c) => c.body ?? "");
}

/**
 * Reply within an inline review thread (REST replies endpoint, keyed by a comment databaseId).
 *
 * Throws rather than no-oping when the repo's `nameWithOwner` can't be resolved — the sole caller
 * (`recordThreadOutcome`, review-fix.ts) wraps this in `safe()`, which reports whether the reply
 * actually reached GitHub. A silent early return would report `true` for a reply nobody sent,
 * miscounting an actionable thread as delivered (PR #335 review).
 */
export async function replyToReviewComment(
  repoPath: string,
  number: number,
  commentId: number,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  const nwo = await nameWithOwner(repoPath, signal);
  if (!nwo) throw new Error(`replyToReviewComment: could not resolve nameWithOwner for ${repoPath}`);
  await gh(
    repoPath,
    ["api", "--method", "POST", `repos/${nwo}/pulls/${number}/comments/${commentId}/replies`, "-f", `body=${body}`],
    signal,
  );
}

/** Reaction content the reactions endpoint accepts for a triaged finding's outcome. */
export type PrReactionContent = "+1" | "-1" | "eyes";

/**
 * React to an inline review comment (REST reactions endpoint, keyed by the same databaseId the
 * reply path uses). The free calibration signal reviewers ask for on every finding — `+1` for
 * fixed, `-1` for declined, `eyes` for needs-human. Best-effort, matching replyToReviewComment: a
 * failed reaction must never fail the run, since the reply (not the reaction) is what stops
 * re-triage.
 */
export async function reactToReviewComment(
  repoPath: string,
  commentId: number,
  content: PrReactionContent,
  signal?: AbortSignal,
): Promise<void> {
  const nwo = await nameWithOwner(repoPath, signal);
  if (!nwo) return;
  await gh(
    repoPath,
    ["api", "--method", "POST", `repos/${nwo}/pulls/comments/${commentId}/reactions`, "-f", `content=${content}`],
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
