/**
 * Bring a project's checkout up to the tree that SHIPPED, before anything measures it (anton-qor2).
 *
 * anton pulls the BOARD before it reads it, but the working tree stays wherever the last human left
 * it: the 2026-08-06 nightly scanned a checkout 6 commits behind origin/main and spent 263 of its
 * 303 signals on code that had been merged away hours earlier. A scan of a stale tree is not a
 * cheap measurement — it re-files debt the repo no longer carries, against a tree nobody works on.
 *
 * REFUSING IS A LEGITIMATE OUTCOME. A dirty or diverged checkout is holding someone's work, and
 * anton merging, rebasing, or stashing it would be a write nobody asked for. So this only ever
 * fast-forwards, and every other shape is reported as {@link CheckoutRefresh.drift} for the caller
 * to stand down on (see jobs/nightly-stringer) rather than measured anyway.
 */
import {
  hasRemote,
  fetchOrigin,
  isAncestor,
  mergeIntoCurrent,
  readWorktreeState,
  type WorktreeState,
} from "./ops";

/** What one refresh established about the checkout — the tree to measure, or why there isn't one. */
export interface CheckoutRefresh {
  /**
   * The commit the checkout holds now. Absent only when git could not name one at all, which is
   * also drift: a caller with no SHA cannot say which tree it measured.
   */
  head?: string;
  /**
   * Why the checkout is NOT the remote default branch's tip. Absent means it is — the caller may
   * measure it and name {@link head} as the tree it measured.
   */
  drift?: string;
  /** The commit the checkout was on before this call fast-forwarded it. Absent when nothing moved. */
  advancedFrom?: string;
  /**
   * The drift is a READ that did not answer (a fetch that failed, an unreadable checkout), not a
   * state of the tree. Worth another attempt, where a dirty or diverged checkout is not: only a
   * human moves that. Lets the caller pick a retry over a park.
   */
  transient?: boolean;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Changes to TRACKED files — the working-tree state that makes a fast-forward unsafe, and the only
 * kind that represents work in progress. Untracked files are deliberately tolerated: every repo
 * accumulates scratch files and generated artifacts, standing down on them would mean never
 * scanning most checkouts, and the one case where they actually block a fast-forward (an incoming
 * commit adding that exact path) is refused by git itself and reported as drift below.
 */
function trackedDirt(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !line.startsWith("??"));
}

/**
 * Fast-forward `repoPath` onto `origin/<branch>` so a caller measures the tree that shipped.
 *
 * Never rewrites history and never touches the working tree's own state: the checkout is advanced
 * only when it is clean, on `branch`, and strictly behind the remote tip — every other case comes
 * back as `drift` with the reason a human would need to fix it.
 *
 * A checkout that already CONTAINS the remote tip is current, local commits and a detached HEAD
 * included: it is not behind anything, so its tree is the honest thing to measure.
 */
export async function refreshCheckout(
  repoPath: string,
  branch: string,
): Promise<CheckoutRefresh> {
  const trackingRef = `refs/remotes/origin/${branch}`;

  let state: WorktreeState;
  try {
    state = await readWorktreeState(repoPath);
  } catch (e) {
    return { drift: `the checkout at ${repoPath} could not be read (${reason(e)})`, transient: true };
  }
  const at = { head: state.head };

  if (!(await hasRemote(repoPath))) {
    return { ...at, drift: `no "origin" remote — nothing here names the tree that shipped` };
  }

  try {
    // Explicit destination refspec, for the reason `resolveFreshBase` documents: a bare
    // `git fetch origin <branch>` honours origin's configured refspec, so a repo with a custom or
    // missing one updates FETCH_HEAD alone and leaves the tracking ref stale — which is exactly the
    // stale answer this exists to rule out. `+` allows a non-fast-forward update of the ref.
    await fetchOrigin(repoPath, [`+refs/heads/${branch}:${trackingRef}`]);
  } catch (e) {
    return { ...at, drift: `fetching origin/${branch} failed (${reason(e)})`, transient: true };
  }

  let behind: boolean;
  try {
    if (await isAncestor(repoPath, trackingRef, "HEAD")) return at;
    behind = await isAncestor(repoPath, "HEAD", trackingRef);
  } catch (e) {
    return { ...at, drift: `comparing HEAD with origin/${branch} failed (${reason(e)})`, transient: true };
  }

  if (!behind) {
    return {
      ...at,
      drift:
        `HEAD (${state.head.slice(0, 8)}) has diverged from origin/${branch} — each side carries ` +
        `commits the other does not, and reconciling them is a human's call`,
    };
  }
  if (state.ref !== `refs/heads/${branch}`) {
    const on = state.ref ? state.ref.replace(/^refs\/heads\//, "") : "a detached HEAD";
    return { ...at, drift: `the checkout is on ${on}, not ${branch}, and is behind origin/${branch}` };
  }
  const dirt = trackedDirt(state.status);
  if (dirt.length > 0) {
    return {
      ...at,
      drift:
        `the working tree has ${dirt.length} uncommitted change(s) (${dirt.slice(0, 3).join("; ")}` +
        `${dirt.length > 3 ? ", …" : ""}) — anton does not stash or merge someone else's work`,
    };
  }

  try {
    // --ff-only: a merge commit here would be anton writing history into the project's branch.
    const merged = await mergeIntoCurrent(repoPath, trackingRef, { ffOnly: true });
    if (!merged.ok) {
      return { ...at, drift: `fast-forwarding to origin/${branch} conflicted (${merged.conflicts.join(", ")})` };
    }
  } catch (e) {
    const msg = reason(e);
    // A path the incoming commit adds and the tree already holds UNTRACKED is refused by git, not
    // conflicted — `mergeIntoCurrent` finds no conflicted paths and rethrows here. That refusal is a
    // state of the tree, permanent until a human moves the file, so it must not be retried: nightly
    // attempts would burn the runner's budget and bury the one line naming the file to remove.
    const collision = /would be overwritten by (merge|checkout)/.test(msg);
    return {
      ...at,
      drift: `fast-forwarding to origin/${branch} failed (${msg})`,
      ...(collision ? {} : { transient: true }),
    };
  }

  try {
    // Re-read rather than trust the ref: the SHA that goes on the health record must be the commit
    // the tree actually holds after the merge, not the one anton meant to move it to.
    const after = await readWorktreeState(repoPath);
    return { head: after.head, advancedFrom: state.head };
  } catch (e) {
    return {
      drift: `the checkout at ${repoPath} could not be re-read after fast-forwarding (${reason(e)})`,
      transient: true,
    };
  }
}
