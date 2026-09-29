/**
 * GitHub PR review/CI inspection via `gh` (anton-3t2.2). The review-fix job polls open PRs for
 * requested changes + failing checks; when actionable it dispatches claude to resolve, pushes, and
 * re-requests review. This module is the read/notify layer over `gh`; the binary is injectable
 * (ANTON_GH_BIN, shared with git/ops.ts) so tests point it at a fake. See DESIGN §4.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  /**
   * The PR's actual base branch on GitHub — NOT necessarily the project's configured/default
   * branch. A retargeted PR, or a project whose default branch setting changed after the PR opened,
   * leaves those two diverging; premerging the wrong one pushes an unrelated branch's history into
   * the PR (anton-091jr review, chatgpt-codex-connector). Optional only because `gh` always reports
   * it in practice — a caller building a synthetic `PrReview` (tests) may still omit it, in which
   * case callers fall back to the project's configured base branch.
   */
  baseRefName?: string;
  /**
   * The base branch's current tip commit SHA. Folded into the merge-conflict fingerprint (anton-091jr
   * review round 4, chatgpt-codex-connector): the conflict reason string is otherwise a constant, so
   * if the base branch advances while the PR head is unchanged and the conflict persists (or
   * reappears), a stale answered-fingerprint row at the same head SHA keeps matching and the new
   * conflict against the new base never re-triggers a fix round. Optional for the same reason as
   * `baseRefName` — a caller-built fixture may omit it.
   */
  baseRefOid?: string;
  /** The PR head's commit SHA — what distinguishes "same doomed input" from new commits (anton-bzm7s). */
  headSha: string;
  url: string;
  /** Submitted reviews (latest state per reviewer as gh reports them). */
  reviews: Array<{ author: string; state: string; body: string; id?: string; submittedAt?: string }>;
  /** Failing checks, by name (display text — a name alone repeats across reruns, see `failingCheckAttempts`). */
  failingChecks: string[];
  /**
   * One entry per failing check in `failingChecks`, `name@attemptIdentity` — where attemptIdentity is
   * the check's own details URL / timestamp, which changes on a rerun even when the name and
   * conclusion don't (anton-091jr review, chatgpt-codex-connector). The answered-suppression
   * fingerprint keys on this instead of `failingChecks` so a check that goes green and fails again at
   * the same head is treated as a NEW failure rather than matched against a stale "answered" row.
   */
  failingCheckAttempts: string[];
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
  /**
   * Top-level PR comments (the same surface `commentOnPr` posts to — not inline review comments),
   * oldest first. Fetched via `getPrTopLevelComments` (paginated GraphQL, not the
   * REST `gh pr view --json comments`, which caps at 100 with no cursor and would otherwise drop a
   * human reply past page 1 on a long-running PR). Lets `classifyReview` tell a genuine human reply
   * apart from anton's own posts (ANTON_MARK-prefixed, filtered the same way `threadsNeedingAttention`
   * ignores its own inline replies): a `needs-human` round is otherwise unactionable on every other
   * axis, so without this a human answering anton's request the one place it was actually posted — a
   * plain top-level reply — left the fingerprint byte-identical and the round suppressed forever (PR
   * #338 review, chatgpt-codex-connector). Optional because a caller-built fixture (tests) has no
   * reason to populate it.
   */
  comments?: Array<{ id: string; author: string; body: string }>;
  /**
   * Whether `comments` is the PR's WHOLE top-level comment history, or a degraded read — a page
   * fetch failed or returned a malformed response (see `getPrTopLevelComments`). `false` makes a
   * short or stale `comments` distinguishable from a genuinely complete one: `classifyReview` must
   * not derive its answered-suppression checkpoint from a `comments` list that might be missing the
   * very reply that would release it, and the PR #338-comment dedup checks in review-fix.ts
   * (`notifyGateParked`, `publishUnpushedSentinel`) must not read an absent match in a degraded list
   * as "definitely not posted yet" (PR #338 review round 2, chatgpt-codex-connector). Optional,
   * defaulting to "complete", for the same reason `comments` itself is optional — a caller-built
   * fixture (tests) has no reason to populate it.
   */
  commentsComplete?: boolean;
}

interface GhPrView {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeable?: string | null;
  headRefName: string;
  baseRefName?: string;
  baseRefOid?: string;
  headRefOid?: string;
  url: string;
  reviews?: Array<{
    author?: { login?: string };
    state?: string;
    body?: string;
    id?: string;
    submittedAt?: string;
  }>;
  statusCheckRollup?: Array<{
    __typename?: string;
    name?: string;
    status?: string; // COMPLETED | IN_PROGRESS | QUEUED (checkRun)
    conclusion?: string; // SUCCESS | FAILURE | ... (checkRun)
    state?: string; // SUCCESS | FAILURE | PENDING (statusContext)
    context?: string; // statusContext name
    detailsUrl?: string; // checkRun — points at the actual run/job, changes on rerun
    targetUrl?: string; // statusContext equivalent of detailsUrl
    completedAt?: string; // checkRun — changes on rerun even when detailsUrl is absent
    createdAt?: string; // statusContext equivalent of completedAt
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
 * Stable identity of THIS check's attempt, not just its name — a rerun of the same check keeps the
 * same name but gets a fresh `detailsUrl`/`completedAt`, which is exactly what distinguishes "the
 * failure a prior round already answered" from "a fresh failure at the same head" (anton-091jr
 * review, chatgpt-codex-connector). Composes every available signal rather than picking the first
 * truthy one (anton-091jr review round 2, chatgpt-codex-connector): a provider that reuses the same
 * `targetUrl`/`detailsUrl` across reruns still changes `completedAt`/`createdAt`, and selecting only
 * the URL would discard that and let a check that goes green then fails again at the same head match
 * a stale answered row. Falls back to "unknown" only when `gh` reports none of the four.
 */
function checkAttemptId(c: NonNullable<GhPrView["statusCheckRollup"]>[number]): string {
  const parts = [c.detailsUrl, c.targetUrl, c.completedAt, c.createdAt].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join("|") : "unknown";
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
      "number,state,reviewDecision,mergeable,headRefName,baseRefName,baseRefOid,headRefOid,url,reviews,statusCheckRollup",
    ],
    signal,
  );
  const view = JSON.parse(raw) as GhPrView;

  const rollup = view.statusCheckRollup ?? [];
  const failing = rollup.filter(isFailing);
  const failingChecks = failing.map((c) => c.name ?? c.context ?? "check");
  const failingCheckAttempts = failing.map(
    (c) => `${c.name ?? c.context ?? "check"}@${checkAttemptId(c)}`,
  );
  const pendingChecks = rollup.filter(isPending).length;

  const reviews = (view.reviews ?? []).map((r) => ({
    author: r.author?.login ?? "unknown",
    state: r.state ?? "",
    body: r.body ?? "",
    id: r.id,
    submittedAt: r.submittedAt,
  }));

  const [threadsResult, commentsResult] = await Promise.all([
    getReviewThreads(repoPath, number, signal),
    getPrTopLevelComments(repoPath, number, signal),
  ]);

  return {
    number: view.number,
    state: view.state,
    reviewDecision: view.reviewDecision ?? null,
    mergeable: view.mergeable ?? null,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    baseRefOid: view.baseRefOid,
    headSha: view.headRefOid ?? "",
    url: view.url,
    reviews,
    failingChecks,
    failingCheckAttempts,
    pendingChecks,
    comments: commentsResult.comments,
    commentsComplete: commentsResult.commentsComplete,
    ...threadsResult,
  };
}

const PR_COMMENTS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    comments(first:100 after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id author{login} body}
    }
  }}
}`;

interface RawPrCommentNode {
  id?: string;
  author?: { login?: string } | null;
  body?: string;
}

interface PrCommentsPage {
  data?: {
    repository?: {
      pullRequest?: {
        comments?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: RawPrCommentNode[];
        };
      };
    };
  };
}

/**
 * Top-level PR comments via GraphQL, paginated the same way as `getReviewThreads` — `gh pr view
 * --json comments` issues `comments(first:100)` with no cursor, so a PR that has collected over 100
 * top-level comments silently drops everything past the first page, including whichever comment was
 * a human's actual reply. `classifyReview`'s `latestHumanComment` reads the LAST entry as the most
 * recent one, so a truncated fetch doesn't just miss a comment — it keeps returning a stale "latest"
 * and a `needs-human` round it already answered stays suppressed forever (PR #338 review,
 * chatgpt-codex-connector).
 *
 * Best-effort: a later page's fetch failing keeps the pages already fetched rather than discarding
 * everything, mirroring `getReviewThreads` — some history beats none for the dedup checks
 * (`notifyGateParked`, `publishUnpushedSentinel`) this feeds. But "some beats none" is only safe
 * when the caller can tell it apart from "all": a missing page can hide the very comment a caller is
 * checking for, so `commentsComplete: false` flags exactly that degraded case, and every caller of
 * this list (`classifyReview`'s fingerprint, the two dedup checks above) must treat a degraded read
 * as "unknown", never as "confirmed absent" (PR #338 review round 2, chatgpt-codex-connector).
 */
export async function getPrTopLevelComments(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<{ comments: Array<{ id: string; author: string; body: string }>; commentsComplete: boolean }> {
  const allNodes: RawPrCommentNode[] = [];
  let complete = true;
  try {
    const nwo = await nameWithOwner(repoPath, signal);
    if (!nwo) return { comments: [], commentsComplete: false };
    const [owner, repo] = nwo.split("/");

    let cursor: string | undefined;
    for (;;) {
      let parsed: PrCommentsPage;
      try {
        const raw = await gh(
          repoPath,
          [
            "api", "graphql",
            "-f", `query=${PR_COMMENTS_QUERY}`,
            "-f", `owner=${owner}`,
            "-f", `repo=${repo}`,
            "-F", `number=${number}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
          ],
          signal,
        );
        parsed = JSON.parse(raw) as PrCommentsPage;
      } catch {
        // Keep the pages already fetched, but flag the read as incomplete — a failed page (the exact
        // bug this fixes) still degrades to a short list rather than one silently mistaken for the
        // PR's whole comment history.
        complete = false;
        break;
      }
      const page = parsed.data?.repository?.pullRequest?.comments;
      if (!page || !Array.isArray(page.nodes)) break;
      allNodes.push(...page.nodes);
      if (!page.pageInfo?.hasNextPage) break;
      if (!page.pageInfo.endCursor) {
        // hasNextPage is true but there's no cursor to continue with — can't proceed, so the nodes
        // fetched so far aren't the full picture.
        complete = false;
        break;
      }
      cursor = page.pageInfo.endCursor;
    }
  } catch {
    return { comments: [], commentsComplete: false };
  }

  const comments = allNodes
    .filter((c): c is RawPrCommentNode & { id: string } => typeof c.id === "string")
    .map((c) => ({
      id: c.id,
      author: c.author?.login ?? "unknown",
      body: c.body ?? "",
    }));
  return { comments, commentsComplete: complete };
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
        if (typeof n?.id !== "string") {
          // A thread node with no string id can't be tracked in truncatedThreadIds and gets
          // silently dropped by the filter below — without this, threadsComplete could stay
          // true while a real thread vanished from the result (PR #335 review).
          complete = false;
          continue;
        }
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
        if (n.comments.totalCount === 0) {
          // A thread always has at least one anchor comment — totalCount: 0 is a malformed
          // response (e.g. the comments became unavailable), not a genuine comment-free thread.
          // threadsNeedingAttention would otherwise treat the missing last comment as "never
          // replied to" and dispatch it forever, while triageOutcomes can never report an
          // outcome for it (no comments[0] to anchor on) — drop it like the other malformed
          // cases so it never surfaces as actionable (PR #335 review).
          complete = false;
          if (typeof n.id === "string") truncatedThreadIds.add(n.id);
          continue;
        }
        if (n.comments.totalCount > n.comments.nodes.length) {
          complete = false;
          if (typeof n.id === "string") truncatedThreadIds.add(n.id);
          continue;
        }
        // nodes.length matches totalCount, but a node can still lack a numeric databaseId (e.g. a
        // pending/draft comment) — the mapping below silently filters those out, so a thread that
        // looks array-complete here can end up with a stale or empty comment list post-filter while
        // `complete` stays true. Catch it here so the whole read (and this thread) is flagged
        // incomplete rather than persisted as if the dropped comment never existed (PR #335 review).
        if (n.comments.nodes.some((c) => typeof c?.databaseId !== "number")) {
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
  /**
   * Stable identity of the CURRENT actionable state, for the answered-suppression fingerprint
   * (anton-091jr review, chatgpt-codex-connector). `reasons` is display text and stays coarse on
   * purpose (a count, a check-name list) — it does not change when a reviewer replies again on a
   * thread already counted, so comparing `reasons` alone lets that new reply get silently
   * suppressed by a stale "answered" row at the same head. `fingerprint` names each unresolved
   * thread by id + its last comment id, so a new reply always changes it even when the coarse count
   * doesn't. Never shown to a human — comparison-only.
   */
  fingerprint: string[];
}

/** Short, edit-sensitive stand-in for a review body in the fingerprint — full text is unbounded. */
function hashReviewBody(body: string): string {
  return createHash("sha1").update(body).digest("hex").slice(0, 12);
}

/**
 * The most recent top-level PR comment that isn't one of anton's own posts (ANTON_MARK-prefixed) —
 * a `needs-human` round's one reply channel. Shared by `classifyReview`'s fingerprint and the
 * review-fix prompt's human-comments section (review-fix-context.ts) so both agree on which single
 * comment answers a prior request, rather than the prompt rendering every top-level comment a
 * long-running PR has ever collected (PR #338 review, chatgpt-codex-connector).
 */
export function latestHumanComment(
  comments: Array<{ id: string; author: string; body: string }> | undefined,
): { id: string; author: string; body: string } | undefined {
  return [...(comments ?? [])].reverse().find((c) => !c.body.startsWith(ANTON_MARK));
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
  const fingerprint: string[] = [];
  if (pr.state !== "OPEN") return { actionable: false, reasons: ["pr not open"], fingerprint: [] };

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    // Fold in the count of CHANGES_REQUESTED review events (not just the decision, which stays
    // CHANGES_REQUESTED across a second/repeat review from the same reviewer) so a genuinely new
    // review bumps `reasons` even when its body adds no inline comments — otherwise
    // enqueueReviewFixPrIfAbsent's answered-unchanged suppression (anton-dfuvz) would keep treating
    // a repeat review as already-answered. Omitted when zero (fixtures that set reviewDecision
    // without a matching reviews entry) to keep the plain form for those.
    const changesRequested = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED");
    const reason =
      changesRequested.length > 0
        ? `changes requested by a reviewer (${changesRequested.length} review(s))`
        : "changes requested by a reviewer";
    reasons.push(reason);
    // Keyed on each requesting review's own identity, not the count (anton-091jr review round 2,
    // chatgpt-codex-connector): if an answered review is dismissed and a DIFFERENT reviewer then
    // requests changes at the same head, the count alone can return to the same value and match a
    // stale answered row even though the actual requester changed. `id` is gh's stable review node
    // id; `submittedAt` is the fallback for a caller-built fixture that omits it. Also folds in a
    // hash of the review body (anton-091jr review round 3, chatgpt-codex-connector): a reviewer can
    // edit an already-submitted CHANGES_REQUESTED review's body without touching its id, author,
    // submittedAt, or the PR head, so without this the amended feedback would match a stale
    // answered row and get suppressed forever.
    if (changesRequested.length > 0) {
      const ids = changesRequested
        .map((r) => `${r.id ?? r.submittedAt ?? "?"}:${r.author}:${hashReviewBody(r.body)}`)
        .sort();
      for (const id of ids) fingerprint.push(`review:${id}`);
    } else {
      fingerprint.push(reason);
    }
  }
  if (pr.failingChecks.length > 0) {
    reasons.push(`failing checks: ${pr.failingChecks.join(", ")}`);
    // Keyed on the attempt identity, not the name — a check that goes green and fails again at
    // the same PR head gets a fresh `detailsUrl`/`completedAt`, so this changes the fingerprint
    // even though `failingChecks`' display names read identically to the prior failure. Falls back
    // to the plain names when a caller-built fixture leaves `failingCheckAttempts` empty; sorted so
    // ordering never depends on `gh`'s own rollup order.
    const attempts =
      pr.failingCheckAttempts.length > 0 ? pr.failingCheckAttempts : pr.failingChecks;
    for (const id of [...attempts].sort()) fingerprint.push(`check:${id}`);
  }
  if (pr.mergeable === "CONFLICTING") {
    reasons.push("merge conflicts with the base branch");
    // Non-`base:*`/`thread:*` entry (anton-091jr review, chatgpt-codex-connector): without one,
    // `fingerprintHasNonThreadReasons` (review-fix.ts) sees only the `base:*` cache-busting entry
    // appended below for every actionable reason and treats a conflict-only round as having NO
    // non-thread reason. `allWaitingThreadsAnswered` then never demands the conflict sentinel, so a
    // premerge that fails (or otherwise leaves no commit) lets `report` cover only threads and the
    // round is recorded as fully answered — suppressing the unresolved conflict on every later sweep
    // at the same head/base. Keyed on `headSha` so a new push always changes it too.
    fingerprint.push(`conflict:${pr.headSha}`);
  }
  const waiting = threadsNeedingAttention(pr);
  if (waiting.length > 0) {
    reasons.push(`${waiting.length} unresolved review thread(s)`);
    // One entry per thread (sorted for a stable fingerprint regardless of GraphQL ordering), keyed
    // on its last comment so a fresh reply on an already-counted thread still changes this.
    for (const t of [...waiting].sort((a, b) => a.id.localeCompare(b.id))) {
      const last = t.comments[t.comments.length - 1];
      fingerprint.push(`thread:${t.id}:${last?.id ?? "none"}`);
    }
  }
  if (reasons.length > 0) {
    // Keyed on the base branch's current tip for EVERY actionable reason, not just CONFLICTING
    // (anton-091jr review round 5, chatgpt-codex-connector): the review-fix worker unconditionally
    // premerges the base before running gates, so a base that advances while the head and the
    // actionable reasons stay put is still a changed execution input. Without this, a mergeable PR
    // with an answered/no-push round would keep matching the stale answered row forever even though
    // the next run would premerge a different base. Falls back to the plain reason when a
    // caller-built fixture omits `baseRefOid`.
    fingerprint.push(`base:${pr.baseRefOid ?? "unknown"}`);
    // Folds in the latest top-level PR comment that ISN'T one of anton's own posts (ANTON_MARK
    // prefix, same filter `threadsNeedingAttention` applies to inline replies) — a `needs-human`
    // round is deliberately unactionable on every other axis, so a human answering anton's request
    // the one place it was actually posted (a plain top-level reply, not a review or an inline
    // thread) otherwise leaves the fingerprint byte-identical and the round suppressed forever (PR
    // #338 review, chatgpt-codex-connector). Omitted entirely when there is no such comment yet, to
    // leave the fingerprint of the (overwhelmingly common) comment-free PR unchanged.
    if (pr.commentsComplete === false) {
      // A degraded top-level-comment read (a later GraphQL page failed — `getPrTopLevelComments`)
      // can't be trusted to name the true latest human reply: the very reply that would release a
      // needs-human suppression might be sitting on the page that failed, in which case the stale
      // fallback below would compute the SAME fingerprint entry as before and match a stale answered
      // row even though something genuinely changed. A fixed, distinct marker instead of a
      // `comment:*` entry means this checkpoint can never match an answered row recorded while the
      // read was complete (PR #338 review round 2, chatgpt-codex-connector).
      fingerprint.push("comments:incomplete");
    } else {
      const humanComment = latestHumanComment(pr.comments);
      // Hashes the body too, not just the id (PR #338 review, chatgpt-codex-connector): GitHub
      // preserves a comment's id across an edit, so a human editing their answered top-level reply —
      // the exact input meant to release the needs-human suppression — would otherwise leave this
      // fingerprint byte-identical to the stale answered row and stay suppressed forever, mirroring
      // why `changesRequested` above hashes a review's body rather than trusting its id alone.
      if (humanComment) {
        fingerprint.push(`comment:${humanComment.id}:${hashReviewBody(humanComment.body)}`);
      }
    }
  }
  return { actionable: reasons.length > 0, reasons, fingerprint };
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
