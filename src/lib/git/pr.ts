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
  /**
   * The PR's actual base branch on GitHub — NOT necessarily the project's configured/default
   * branch. A retargeted PR, or a project whose default branch setting changed after the PR opened,
   * leaves those two diverging; premerging the wrong one pushes an unrelated branch's history into
   * the PR (anton-091jr review, chatgpt-codex-connector). Optional only because `gh` always reports
   * it in practice — a caller building a synthetic `PrReview` (tests) may still omit it, in which
   * case callers fall back to the project's configured base branch.
   */
  baseRefName?: string;
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
}

interface GhPrView {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeable?: string | null;
  headRefName: string;
  baseRefName?: string;
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
      "number,state,reviewDecision,mergeable,headRefName,baseRefName,headRefOid,url,reviews,statusCheckRollup",
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

  return {
    number: view.number,
    state: view.state,
    reviewDecision: view.reviewDecision ?? null,
    mergeable: view.mergeable ?? null,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    headSha: view.headRefOid ?? "",
    url: view.url,
    reviews,
    failingChecks,
    failingCheckAttempts,
    pendingChecks,
    threads: await getReviewThreads(repoPath, number, signal),
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
        comments(first:50){nodes{databaseId author{login} body}}
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
  comments?: { nodes?: Array<{ databaseId?: number; author?: { login?: string } | null; body?: string }> };
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
 * node ids `resolveReviewThread` needs. Best-effort — returns [] on any failure (same contract as
 * the old REST comment fetch), so a missing token degrades to "no inline feedback", not a crash.
 *
 * Paginated: a PR that has collected over 100 threads (routine on a long-running epic with a bot
 * reviewer commenting every round) used to have everything past the first page silently dropped,
 * including whichever thread was actually unresolved — `threadsNeedingAttention` never saw it, so
 * `classifyReview` reported the PR clean and the dispatcher skipped it with nothing to show for why.
 *
 * A later-page failure breaks the loop and returns the pages already fetched rather than throwing
 * to the outer catch and discarding every completed page — losing page 1's unresolved threads would
 * misclassify a >100-thread PR as clean the same way truncation did.
 */
async function getReviewThreads(
  repoPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewThread[]> {
  const allNodes: RawReviewThreadNode[] = [];
  try {
    const nwo = await nameWithOwner(repoPath, signal);
    if (!nwo) return [];
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
        // Keep the pages already fetched; a failed first page still degrades to [].
        break;
      }
      const page = parsed.data?.repository?.pullRequest?.reviewThreads;
      allNodes.push(...(page?.nodes ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      cursor = page.pageInfo.endCursor;
    }
  } catch {
    return [];
  }

  return allNodes
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
    // id; `submittedAt` is the fallback for a caller-built fixture that omits it.
    if (changesRequested.length > 0) {
      const ids = changesRequested
        .map((r) => `${r.id ?? r.submittedAt ?? "?"}:${r.author}`)
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
    fingerprint.push("merge conflicts with the base branch");
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
