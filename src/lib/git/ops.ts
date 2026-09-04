/**
 * Git + PR operations for the execute-epic job (anton-dzh.4): commit a ticket's work in the
 * worktree, push the branch, and open one PR via `gh`. The `gh` binary is injectable
 * (ANTON_GH_BIN) so tests can point it at a fake. See DESIGN.md §4/§5.
 */
import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Override the GitHub CLI (tests point this at a fake that echoes a PR url). */
export const GH_BIN_ENV = "ANTON_GH_BIN";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Paths from a `git diff --name-only`-style query, read exactly as they are on disk.
 *
 * `-z` is not a micro-optimization. Under git's default `core.quotePath`, a path holding a non-ASCII
 * byte, a quote, or a newline is printed C-QUOTED — `src/café/page.tsx` comes back as
 * `"src/caf\303\251/page.tsx"` — and every consumer here treats the result as a real path: the review
 * gate scopes the reviewer's binding instruction files by walking each changed path's ancestors, and
 * a mangled path walks the wrong chain, silently dropping a nested AGENTS.md the diff is bound by.
 * NUL-delimited output is the literal byte sequence, and it also survives a filename containing the
 * newline this would otherwise split on. Paths are NOT trimmed for the same reason — leading and
 * trailing whitespace are legal in a filename.
 */
async function diffPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "-z", ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

/**
 * Run git and keep at most `maxChars` of its stdout, killing it the moment output overflows.
 *
 * For commands whose output has no useful upper bound. `git()` collects stdout through execFile's
 * fixed `maxBuffer` and THROWS on overflow, so a caller that means to truncate never gets the
 * chance: a generated lockfile or a vendored source update produces a patch past the cap and fails
 * the command outright. Cutting the stream puts the bound where the memory is actually spent, and
 * makes truncation the outcome rather than an error.
 *
 * The kill is not a failure: once the cap is reached the rest of the output is by definition
 * discarded, so the non-zero exit it produces is expected and `truncated` is the answer.
 */
function gitBounded(
  cwd: string,
  args: string[],
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { timeout: 120_000 });
    // Decode incrementally so the cap counts characters, not bytes, and a multi-byte sequence split
    // across two chunks is never mangled.
    const decoder = new StringDecoder("utf8");
    let text = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      act();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      text += decoder.write(chunk);
      if (text.length <= maxChars) return;
      text = text.slice(0, maxChars);
      truncated = true;
      child.stdout?.destroy();
      child.kill("SIGKILL");
    });
    // Bounded too: a command failing on every path would otherwise trade one unbounded buffer for
    // another. 4 KiB is plenty for the message a rejection carries.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });

    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => {
        if (!truncated && code !== 0) {
          reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
          return;
        }
        resolve({ text: truncated ? text : text + decoder.end(), truncated });
      }),
    );
  });
}

/** The tree mode of a symlink. Its blob holds the TARGET PATHNAME, not the linked file's content. */
const SYMLINK_MODE = "120000";

/**
 * Symlink hops followed before giving up. A rules file is one hop from its real home; a longer chain
 * — or a cycle — is not one, and returning undefined is the safe answer for every caller.
 */
const MAX_SYMLINK_HOPS = 4;

/**
 * Read one file as of `rev` (trimmed), or undefined when git reports it is not a file there.
 *
 * FAILS CLOSED: undefined means "git looked and it is absent", never "the read failed". A timeout, an
 * unreadable object, an unresolvable `rev` — anything but a successful absent answer — THROWS. The
 * callers are the review gate's trusted inputs (its reasoning contract and the rulebook it grades
 * against), and the reviewer is told the inlined rules are the only ones that grade the run: a
 * failure quietly returned as absence would swap the reviewer or drop binding rules, and pass work
 * that was never measured against them. Failing here parks the run for a human instead.
 *
 * For files the working tree must not be trusted to supply. `git show` serves the committed blob, so
 * a run that added or rewrote the path on its own branch cannot change what comes back.
 *
 * Symlinks are FOLLOWED inside the repo at the same `rev`, never returned raw: git stores a link as
 * a blob holding its target pathname, so a project that keeps `AGENTS.md` as a link to its real
 * rules file would otherwise hand the caller the one-line pathname where it asked for content — for
 * the review gate, an empty rulebook that reads as "this project states no rules".
 */
export async function readFileAtRev(
  worktreePath: string,
  rev: string,
  path: string,
): Promise<string | undefined> {
  return readBlobAtRev(worktreePath, rev, path, MAX_SYMLINK_HOPS);
}

async function readBlobAtRev(
  worktreePath: string,
  rev: string,
  path: string,
  hops: number,
): Promise<string | undefined> {
  const mode = await blobModeAtRev(worktreePath, rev, path);
  if (mode === undefined) return undefined;
  // `--` disambiguates a path that also parses as a revision. Deliberately uncaught: the tree above
  // just reported a blob at this path, so a `show` that fails is a failure to READ a file that is
  // there — a corrupt object, a timeout — and swallowing it would hand the caller the one answer it
  // must never infer, "this file does not exist".
  const text = await git(worktreePath, ["show", `${rev}:${path}`, "--"]);
  if (mode !== SYMLINK_MODE) return text;

  // Out-of-tree and runaway links resolve to nothing rather than to their pathname: there is no
  // content at `rev` to trust, and a caller that drops the path is right where one that inlines
  // "../../etc/rules.md" as the rules is not.
  if (hops <= 0) return undefined;
  const target = resolveRepoPath(path, text);
  return target ? readBlobAtRev(worktreePath, rev, target, hops - 1) : undefined;
}

/**
 * The tree mode of `path` at `rev`, or undefined when it is not a file there (missing, or a
 * directory). The mode is the only thing that tells a regular file from a symlink — both are blobs,
 * and `git show` reads them identically.
 *
 * An absent path is not an error to git: `ls-tree` exits 0 with EMPTY output for a pathspec that
 * matches nothing, which is what "not there" looks like here. So a rejection is something else
 * entirely — a rev that doesn't resolve, an unreadable object, a killed process — and it propagates
 * rather than being reported as absence (see {@link readFileAtRev}).
 */
async function blobModeAtRev(
  worktreePath: string,
  rev: string,
  path: string,
): Promise<string | undefined> {
  // -z: git quotes non-ASCII paths otherwise, and a quoted entry no longer splits on a literal tab.
  // `:(literal)`, because a pathspec is PARSED before it is matched: a repo whose directory name
  // starts with pathspec magic — `:(exclude)/rules.md` — makes git read the operand as an exclusion
  // and fail the command outright, which for the review gate means parking every run touching it.
  const out = await git(worktreePath, ["ls-tree", "-z", rev, "--", `:(literal)${path}`]);
  const entry = out.split("\0")[0];
  const tab = entry?.indexOf("\t") ?? -1;
  if (!entry || tab < 0) return undefined;
  const [mode, type] = entry.slice(0, tab).split(" ");
  return type === "blob" ? mode : undefined;
}

/**
 * Where a path written INSIDE the repo — a symlink's target, a rules file's `@path` import — points,
 * as a repo-relative path. Undefined when it leaves the repository: an absolute target, or one
 * climbing above the root.
 *
 * Resolved textually against `fromPath`'s own directory, because the answer must stay inside the
 * tree a `rev` names: following it out to the filesystem would read the machine anton happens to run
 * on, not the revision being read.
 */
export function resolveRepoPath(fromPath: string, target: string): string | undefined {
  const raw = target.trim();
  if (!raw || raw.startsWith("/")) return undefined;
  const resolved: string[] = [];
  for (const segment of [...fromPath.split("/").slice(0, -1), ...raw.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.length === 0) return undefined;
    resolved.pop();
  }
  return resolved.length > 0 ? resolved.join("/") : undefined;
}

/**
 * Directories per `ls-tree` call. The command line is the bound: a diff touching thousands of
 * directories would otherwise hand the kernel an argument list past `ARG_MAX` and fail outright,
 * which for the review gate would silently mean "this project states no rules".
 */
const LS_TREE_BATCH = 500;

/**
 * Repo-relative paths of the FILES sitting directly in each of `dirs` as of `rev` — one tree read
 * per batch, so a caller can discover which of a set of files exist across many directories without
 * spawning a probe per candidate path.
 *
 * `""` reads the repo root. Directories absent at `rev` contribute nothing, and a directory NAMED
 * like the file being looked for is skipped (only blobs are returned), so a caller can treat every
 * path it gets back as readable content.
 *
 * FAILS CLOSED, like {@link readFileAtRev}: an empty result means git read the trees and found no
 * files, never that the read failed. `ls-tree` exits 0 with empty output for a directory absent at
 * `rev`, so anything that rejects — an unresolvable rev, an unreadable object, a killed process —
 * propagates. Swallowing it would tell the review gate this project states no rules, which is the
 * one conclusion it must never reach by accident.
 */
export async function listDirBlobsAtRev(
  worktreePath: string,
  rev: string,
  dirs: string[],
): Promise<string[]> {
  // `:(literal)`, for the same reason as {@link blobModeAtRev}: these operands are BUILT from the
  // diff's own directory names, and one that begins with pathspec magic (`:(exclude)/`) is parsed as
  // magic rather than matched as a directory — `fatal: outside repository`, which fails the read the
  // gate depends on instead of returning that scope's rules.
  const specs = dirs.map((dir) => `:(literal)${dir ? `${dir.replace(/\/+$/, "")}/` : "./"}`);
  const batches: string[][] = [];
  for (let i = 0; i < specs.length; i += LS_TREE_BATCH) batches.push(specs.slice(i, i + LS_TREE_BATCH));

  // -z: git quotes non-ASCII paths otherwise, and a quoted path matches nothing the caller asked for.
  const reads = await Promise.all(
    batches.map((batch) => git(worktreePath, ["ls-tree", "-z", rev, "--", ...batch])),
  );
  return reads.flatMap((text) =>
    text
      .split("\0")
      .map((line) => {
        const tab = line.indexOf("\t");
        if (tab < 0) return undefined;
        return line.slice(0, tab).split(" ")[1] === "blob" ? line.slice(tab + 1) : undefined;
      })
      .filter((path): path is string => path !== undefined),
  );
}

/**
 * The commit a branch forked from `base`, pinned as a SHA — or `base` itself when it names nothing
 * this repo can resolve, which is what the callers diffed against before and never a failure.
 *
 * Resolve ONCE and pass the SHA to everything that reads "at the base". A base like `origin/main`
 * is a MOVABLE ref: a concurrent run's fetch, or a resumed worktree, can advance it mid-review, and
 * a patch taken from the old fork point judged against rules read from the new tip is a review the
 * intervening commit silently rewrote the rules of.
 *
 * Which is why the no-merge-base case (unrelated histories — a resumed worktree whose base was
 * force-rewritten) still resolves the ref itself to a commit rather than handing the NAME back:
 * callers treat what they get as pinned, so returning `origin/main` would put every later read on
 * whatever that ref points at then, and a sibling run's fetch between two of them is exactly the
 * split baseline the pinning exists to rule out.
 *
 * A merge-base that FAILS rather than answers — a timeout, a killed process, an unreadable object —
 * THROWS when the base resolves anyway, instead of degrading to that fallback. The fallback returns
 * the base TIP, which on a base that has advanced is far past the real fork point: the gate would
 * review, and let the fixer rewrite, a diff measured against a commit the run never branched from.
 * Parking the run is the only honest answer to "I could not compute the fork point".
 */
export async function resolveMergeBase(worktreePath: string, base: string): Promise<string> {
  let brokenRead: unknown;
  try {
    return await git(worktreePath, ["merge-base", base, "HEAD"]);
  } catch (error) {
    // Exit 1 is merge-base's ANSWER — these histories share no commit — and falls through to the
    // pinning below. Any other rejection is the question failing; hold it, because the one thing
    // that still excuses it is a `base` that names nothing, which only `rev-parse` can settle.
    brokenRead = exitedWith(error, 1) ? undefined : error;
  }

  // `--verify --quiet`: exits 1 with no output when the ref doesn't resolve, instead of echoing the
  // argument back as if it were a revision. Its own operational failures propagate for the same
  // reason as merge-base's — an unpinned base name is not a safe answer to a read that broke.
  const pinned = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).catch(
    (error: unknown) => {
      if (exitedWith(error, 1)) return undefined;
      throw error;
    },
  );
  if (!pinned) return base;
  // The base DOES resolve, so a merge-base that failed was never "unrelated histories".
  if (brokenRead) throw brokenRead;
  return pinned;
}

/**
 * Whether a rejected git call is the command exiting with `code` — its own answer — rather than a
 * run that never got one. A process killed by a timeout carries `code: null` and a signal, and a
 * spawn failure carries a string errno, so neither is mistaken for an exit status.
 */
function exitedWith(error: unknown, code: number): boolean {
  const err = error as { code?: unknown; killed?: boolean } | null;
  return err?.code === code && err.killed !== true;
}

/**
 * Stage everything in the worktree and commit. Returns `{ committed: false }` when there is
 * nothing to commit (claude made no changes) — the caller decides whether that's acceptable.
 *
 * An empty index is NOT proof that nothing was delivered: an agent that committed its own work
 * (against the base contract, but it happens) leaves exactly the same empty index. Only HEAD tells
 * the two apart — see `commitStep`, which is the caller that has to.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean }> {
  await git(worktreePath, ["add", "-A"]);
  try {
    // Exits non-zero when there ARE staged changes → there is something to commit.
    await git(worktreePath, ["diff", "--cached", "--quiet"]);
    return { committed: false };
  } catch {
    await git(worktreePath, ["commit", "-m", message]);
    return { committed: true };
  }
}

/**
 * True when `ancestor` is reachable from `descendant` — i.e. the branch only moved FORWARD between
 * them, adding commits without dropping or rewriting any.
 *
 * `step:commit` asks this before adopting work an agent committed itself: a moved HEAD is delivery
 * only if the commit the ticket started from is still on the branch. A `git reset --hard HEAD~1` or
 * an amend moves HEAD just as visibly while REMOVING history — on a multi-ticket run, possibly an
 * earlier ticket's commits — and adopting that would open a PR missing work anton has already
 * closed the bead for.
 *
 * Only git's own "no" (exit 1) is an answer; anything else propagates rather than reading as one.
 */
export async function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(worktreePath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (e) {
    if (exitedWith(e, 1)) return false;
    throw e;
  }
}

/**
 * Record an EMPTY commit — a marker that carries a message and no diff.
 *
 * The one caller is `step:commit` adopting work an agent committed itself. Those commits are real
 * and keep their own messages, but they don't carry the `<ticketId>:` subject that
 * {@link worktreeHasCommitFor} reads, so without a marker a resume cannot see that the ticket's
 * work is already on the branch and re-runs it — onto a tree where there is nothing left to do.
 */
export async function commitMarker(worktreePath: string, message: string): Promise<void> {
  await git(worktreePath, ["commit", "--allow-empty", "-m", message]);
}

export async function hasRemote(repoPath: string, name = "origin"): Promise<boolean> {
  try {
    await git(repoPath, ["remote", "get-url", name]);
    return true;
  } catch {
    return false;
  }
}

export async function pushBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["push", "-u", "origin", branch]);
}

/** Fetch refs from origin (all refs when none given). */
export async function fetchOrigin(repoPath: string, refs: string[] = []): Promise<void> {
  await git(repoPath, ["fetch", "origin", ...refs]);
}

/**
 * Resolve the freshest usable base ref for a new worktree (anton-l0h). Fetches `origin/<base>` and
 * returns `"origin/<base>"` so the job layer can branch off the remote tip. Best-effort: if the
 * repo has no `origin` remote, or the fetch fails (offline, auth, deleted ref), it logs loudly and
 * falls back to the local `<base>` so a run is never blocked on network access. Only updates the
 * remote-tracking ref — no local branch is mutated.
 */
export async function resolveFreshBase(repoPath: string, base: string): Promise<string> {
  if (!(await hasRemote(repoPath))) {
    // No origin (e.g. a local-only repo) — nothing to fetch; branch off the local base.
    return base;
  }
  const trackingRef = `refs/remotes/origin/${base}`;
  try {
    // Explicit destination refspec: a bare `git fetch origin <base>` honours origin's configured
    // fetch refspec, so in repos with a custom or missing refspec it can succeed while only
    // updating FETCH_HEAD — leaving `origin/<base>` stale or absent. Naming the destination forces
    // the remote-tracking ref to be written; `+` allows a non-fast-forward update.
    await fetchOrigin(repoPath, [`+refs/heads/${base}:${trackingRef}`]);
    // Confirm the ref actually resolves before branching a run off it (throws → fall back).
    await git(repoPath, ["rev-parse", "--verify", "--quiet", trackingRef]);
    return `origin/${base}`;
  } catch (e) {
    console.warn(
      `[git] fetch of origin/${base} in ${repoPath} failed; falling back to local ${base}`,
      e,
    );
    return base;
  }
}

/**
 * Merge `ref` into the branch checked out in `worktreePath`. A conflicted merge is left in
 * progress (markers in the tree, MERGE_HEAD set) and the conflicted paths are returned — the
 * caller has claude resolve the markers and a later `commitAll` concludes the merge. A merge that
 * fails for any other reason (e.g. untracked files in the way) is aborted and rethrown.
 */
export async function mergeIntoCurrent(
  worktreePath: string,
  ref: string,
  opts?: { ffOnly?: boolean },
): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await git(worktreePath, ["merge", "--no-edit", ...(opts?.ffOnly ? ["--ff-only"] : []), ref]);
    return { ok: true, conflicts: [] };
  } catch (e) {
    const conflicts = await diffPaths(worktreePath, ["--name-only", "--diff-filter=U"]).catch(() => []);
    if (conflicts.length === 0) {
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      throw e;
    }
    return { ok: false, conflicts };
  }
}

/**
 * True when `branch` has local commits not yet on `origin/<branch>` — i.e. there is work to push.
 * Used by review-fix to decide whether a prior (crash/retry) fix is still unpushed even when the
 * current claude run produced no new commit. If the remote-tracking ref is unknown, assume ahead
 * (safer to attempt a no-op push than to silently skip real work).
 */
export async function branchAheadOfRemote(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<boolean> {
  try {
    const out = await git(repoPath, ["rev-list", "--count", `${remote}/${branch}..${branch}`]);
    return Number(out.trim()) > 0;
  } catch {
    return true;
  }
}

/**
 * True when the branch checked out in `worktreePath` already contains the commit for `ticketId` —
 * a commit whose subject starts with `<ticketId>:` (the shape execute-epic's `commitAll` writes).
 *
 * execute-epic's ticket loop uses this to tell a ticket that is done AND whose work lives on THIS
 * branch apart from one merely marked done on the shared board (anton-jz1). Board state propagates
 * cross-machine via `bd sync`, but the branch is pushed only at PR time — so a ticket another
 * machine closed then crashed on (before opening the PR) has its commit solely in that machine's
 * local, never-pushed worktree. Skipping such a ticket on board state alone would open the epic's PR
 * missing that work. A run's own ticket commits are always at the branch tip, so bounding the scan
 * is safe. Fails closed to `false` (git error → treat as absent → re-run) rather than risk a skip.
 */
export async function worktreeHasCommitFor(
  worktreePath: string,
  ticketId: string,
): Promise<boolean> {
  const subjects = await git(worktreePath, ["log", "--format=%s", "-n", "1000"]).catch(() => "");
  const prefix = `${ticketId}:`;
  return subjects.split("\n").some((s) => s.startsWith(prefix));
}

/**
 * What git's history says became of `path` on this branch — the raw read behind the `ref-stale`
 * repair (anton-fzas / R5.4). It reports; it does not judge. Whether a single destination is a
 * rename anton may follow, or a pointer it must refuse to guess at, is
 * `gardener/repair-ref-stale.ts`'s call.
 */
export interface PathHistory {
  /**
   * Every DISTINCT path this one was renamed to, newest commit first. More than one means the name
   * has stood for more than one file over the branch's life — history the caller cannot resolve.
   */
  renamedTo: string[];
  /**
   * How many commits renamed the path AWAY — the occurrences behind `renamedTo`, before the
   * de-duplication (PR #223 review). Two renames to the SAME destination is not one rename: the
   * path had to be recreated in between, so the name has stood for two files exactly as two
   * distinct destinations would mean, and only the count says so.
   */
  renames: number;
  /** A commit removed the path with no rename paired to the removal. */
  deleted: boolean;
}

/** How far back the removal scan reads. A path removed more times than this is not a clean rename. */
const MAX_PATH_REMOVALS = 20;

/** `R<score>\told\tnew` / `D\told` — the only two name-status verbs this read cares about. */
const RENAME_STATUS = /^R\d*\t([^\t]+)\t([^\t]+)$/;
const DELETE_STATUS = /^D\t([^\t]+)$/;

/**
 * Follow a path that is gone from the tree to wherever git recorded it going.
 *
 * TWO commands, because pathspec filtering DISABLES git's rename detection: under `-- <path>` the
 * SOURCE side of a rename is reported as a plain `D` and the destination never appears at all. So
 * the pathspec is used only to find the commits where the path disappeared — cheap, and exactly the
 * candidate set — and each of those is re-diffed WITHOUT a pathspec, where `--find-renames` pairs
 * the delete with its add.
 *
 * `--follow` is what carries the read past a path's own earlier renames, which is why the scan is
 * ordered newest-first and bounded: a hot path removed a dozen times over is not the mechanical
 * rename this exists to resolve.
 *
 * `follow: false` reads the PATHNAME's own history instead, and the difference is not cosmetic (PR
 * #223 review). `--follow` walks backwards from whatever wears the name now, switching to the old
 * name at every rename it meets — so a file renamed INTO this path hides everything that happened to
 * the path before it arrived, including the deletion of the file that used to be there. A caller
 * asking "did this name ever stand for a different file" has to ask it of the name, not of the file.
 *
 * `core.quotePath=false` because git C-quotes a non-ASCII path by default (`"src/caf\303\251.ts"`),
 * and a quoted entry no longer splits on a literal tab — the parse would hand back a path that
 * exists nowhere. `:(literal)` for the same class of reason as {@link readFileAtRev}: a pathspec is
 * PARSED before it is matched, so a cited path that opens with pathspec magic would fail the
 * command outright rather than simply not resolving.
 */
export async function readPathHistory(
  repoPath: string,
  path: string,
  options: { follow?: boolean } = {},
): Promise<PathHistory> {
  const removals = (
    await git(repoPath, [
      "-c",
      "core.quotePath=false",
      "log",
      ...(options.follow === false ? [] : ["--follow"]),
      "--format=%H",
      "--diff-filter=D",
      "--",
      `:(literal)${path}`,
    ])
  )
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean)
    .slice(0, MAX_PATH_REMOVALS);

  // Read in parallel, but keep the newest-first ORDER of the results: `renamedTo` is ordered
  // history, and the caller reads its first entry as the most recent destination.
  const statuses = await Promise.all(
    removals.map((sha) =>
      git(repoPath, [
        "-c",
        "core.quotePath=false",
        "show",
        "--name-status",
        "--format=",
        "--find-renames",
        "--no-color",
        sha,
      ]),
    ),
  );

  const renamedTo: string[] = [];
  let renames = 0;
  let deleted = false;
  for (const status of statuses) {
    // A merge commit prints no name-status at all, so it contributes neither a rename nor a
    // delete — history the caller reads as unfollowable, which is the honest answer.
    for (const line of status.split("\n")) {
      const rename = RENAME_STATUS.exec(line);
      if (rename && rename[1] === path) {
        renames++;
        if (!renamedTo.includes(rename[2]!)) renamedTo.push(rename[2]!);
        continue;
      }
      if (DELETE_STATUS.exec(line)?.[1] === path) deleted = true;
    }
  }
  return { renamedTo, renames, deleted };
}

/** A branch's change set against its base: the changed paths plus the (possibly truncated) patch. */
export interface BranchDiff {
  /**
   * Paths the branch changed since it diverged from the base. Always complete — a rename lists BOTH
   * its old and its new path, since callers scope rules by path (see {@link diffAgainstBase}).
   */
  files: string[];
  /** Unified patch for those changes, cut at `maxPatchChars`. */
  patch: string;
  /** True when `patch` was cut short — the file list still names everything that changed. */
  truncated: boolean;
  /**
   * The DELETIONS-only patch, collected separately and only when `patch` was cut short: what the
   * truncated patch omits is recoverable from the worktree except for a file the branch removed,
   * which is gone from it. Its budget is spent per deleted file rather than as one stream, so the
   * first large removal cannot crowd out the ones after it. Absent when nothing was deleted (or
   * nothing was truncated).
   */
  deletions?: string;
  /**
   * True when the deletion rescue pass FAILED — git errored before it could collect (all of) the
   * removals. Reported rather than swallowed: the reviewer cannot open a deleted file and has no
   * `git` to fetch one, so a silent absence here reads as "this run deleted nothing" and the
   * removals it did make are approved by nobody. The caller must tell the reviewer instead.
   */
  deletionsIncomplete?: boolean;
  /**
   * How many deleted files the budget could only NAME — their content was never quoted. Zero-cost
   * when the budget stretches to every removal, but it cannot always: a floor slice worth reading
   * times the number of deletions can exceed the whole budget, and past that point some removals are
   * unreviewable however the share is cut. Reported as a count rather than left implicit in the
   * patch text, because the caller has to turn it into unverified-scope guidance — otherwise the
   * reviewer returns a clean verdict over removals it never saw.
   */
  deletionsUnshown?: number;
}

/**
 * Cap on the patch text {@link diffAgainstBase} returns. Generous enough to carry a whole run's
 * diff into a review prompt, bounded so one pathological change (a lockfile, a vendored blob)
 * can't blow the context window.
 */
export const DEFAULT_DIFF_PATCH_CHARS = 200_000;

/**
 * Cap on the deletions-only patch {@link diffAgainstBase} adds when the main patch is truncated,
 * shared out across the deleted files. Deliberately a fraction of the main cap: this is a rescue of
 * content the reviewer has no other way to see, not a second copy of the diff, and a run that
 * deletes a vendored tree must not blow the budget the surviving code needs.
 */
export const DEFAULT_DELETION_PATCH_CHARS = 40_000;

/**
 * The work a branch added on top of `base`: the changed files and the unified patch, for the
 * pre-PR self-review gate (anton-3apm) to review.
 *
 * Diffs from the MERGE BASE, not from the base tip, so commits that landed on the base after the
 * run branched are never mistaken for the run's own work. When no merge base exists (unrelated
 * histories) it falls back to diffing against `base` directly rather than failing the review.
 * A caller that also reads FILES at the base should resolve it once with {@link resolveMergeBase}
 * and pass that SHA here, so the patch and those files come from the same commit.
 *
 * The patch is cut at the source (`gitBounded`) rather than after collection: a run that touched a
 * lockfile or vendored tree can produce a patch of any size, and buffering it whole only to slice it
 * would fail the review on the exact change truncation exists for.
 *
 * The FILE LIST is collected with rename detection off, though the patch keeps it: a detected rename
 * names only its destination, and the list is what scopes the instruction files the reviewer is
 * judged against (`readInstructions` walks each path's ancestors). Code moved OUT of a directory
 * would take that directory's rules with it — while the reviewer is told the inlined rules are the
 * only ones binding the diff. Listing the rename as its removal plus its addition keeps both scopes.
 *
 * Truncation is survivable because the reviewer can open what the cut omits — with one exception: a
 * file the branch DELETED is not in the worktree to open, and the reviewer is denied `git` (see
 * `REVIEW_DENIED_TOOLS`), so a removed route or validation past the cut would be reviewed by nobody.
 * So a truncated patch is followed by a second pass over the deletions alone, bounded per deleted
 * file so that every removal is represented (see {@link deletionPatch}). That pass turns rename
 * detection off too, for the same reason the file list does: the old side of a rename is content the
 * branch removed, and with detection on it is not classified as a deletion to rescue.
 */
export async function diffAgainstBase(
  worktreePath: string,
  base: string,
  opts: { maxPatchChars?: number; maxDeletionChars?: number } = {},
): Promise<BranchDiff> {
  const from = await resolveMergeBase(worktreePath, base);
  const files = await diffPaths(worktreePath, ["--name-only", "--no-renames", from, "HEAD"]);

  const max = opts.maxPatchChars ?? DEFAULT_DIFF_PATCH_CHARS;
  const { text, truncated } = await gitBounded(worktreePath, ["diff", from, "HEAD"], max);
  if (!truncated) return { files, patch: text.trim(), truncated: false };

  const { patch: deletions, incomplete, unshown } = await deletionPatch(
    worktreePath,
    from,
    opts.maxDeletionChars ?? DEFAULT_DELETION_PATCH_CHARS,
  );
  return {
    files,
    patch: `${text}\n… [patch truncated at ${max} chars — read the files directly]`,
    truncated: true,
    ...(deletions ? { deletions } : {}),
    ...(incomplete ? { deletionsIncomplete: true } : {}),
    ...(unshown ? { deletionsUnshown: unshown } : {}),
  };
}

/**
 * Smallest slice of the deletion budget worth spending on one file: under this a "patch" is a diff
 * header and a line or two — a filename dressed up as content. It is a FLOOR on each slice, not a
 * cutoff on the even share: once what is LEFT of the budget can no longer buy this much, the files
 * still to come are NAMED instead, so the reviewer sees what it was not shown rather than reading a
 * partial list as the whole set.
 */
const MIN_DELETION_SLICE_CHARS = 500;

/**
 * The branch's deletions as their own bounded patch — `{}` when it deleted nothing.
 *
 * "Deleted" is judged with rename detection OFF. A file git scores as a rename is one `R*` entry
 * naming only its destination, so its old side is not a deletion and this pass would return nothing
 * for it — while the move may have dropped a guard or a route on the way, and the truncated patch is
 * the reviewer's only sight of the source it cannot open.
 *
 * The budget is allocated PER DELETED FILE, not spent as one stream: a single stream is exhausted by
 * whichever removal git emits first, leaving every route, guard, or validation deleted after it
 * represented by a filename alone — unreviewable, since those files are neither in the worktree nor
 * reachable without `git` (see `REVIEW_DENIED_TOOLS`). Each file draws an even share of what is left
 * — floored at {@link MIN_DELETION_SLICE_CHARS} — so a small removal hands its surplus to the ones
 * behind it and one huge removal costs only its own slice.
 *
 * The floor and the budget can still conflict: `max / MIN_DELETION_SLICE_CHARS` files is all a
 * usable slice buys, and a run that deletes more than that leaves the tail NAMED only — no cut of
 * the share fixes that, it is the budget being smaller than the content. Those files are counted out
 * (`unshown`) as well as named, so the caller can tell the reviewer its coverage was incomplete
 * instead of letting a clean verdict cover removals nobody read.
 *
 * A failure does not fail the review that already has the (truncated) patch it was mainly after —
 * but it is REPORTED (`incomplete`), never swallowed. The reviewer has no other route to a deleted
 * file, so an empty result it isn't warned about reads as "nothing was removed", and the removals it
 * never saw are approved by its verdict. Whatever the pass collected before the failure still ships.
 */
async function deletionPatch(
  worktreePath: string,
  from: string,
  max: number,
): Promise<{ patch?: string; incomplete?: boolean; unshown?: number }> {
  const parts: string[] = [];
  try {
    // `--no-renames`, to match the changed-file list: with detection on, a rename is one `R*` entry
    // and its old side is not a deletion at all, so the source of a moved file would be rescued by
    // nobody — the reviewer can open the destination but not what the move dropped on the way.
    const deleted = await diffPaths(worktreePath, [
      "--name-only",
      "--diff-filter=D",
      "--no-renames",
      from,
      "HEAD",
    ]);
    if (deleted.length === 0) return {};

    let remaining = max;
    let i = 0;
    for (; i < deleted.length; i++) {
      // The first file is always quoted, however small the budget: a caller that asks for less than
      // one slice wants the deletions bounded, not withheld.
      if (i > 0 && remaining < MIN_DELETION_SLICE_CHARS) break;
      // An even share under the floor buys a header, not content — so spend the floor rather than
      // stop at it. Stopping made the split cliff-edged: 81 deletions of the default 40k budget put
      // the even share at 493, which quoted ONE file and named the other eighty, when the budget can
      // in fact pay a usable slice for every one of them. Capped by what is left, so a caller whose
      // whole budget is under one slice still gets it honoured.
      const share = Math.max(
        Math.min(remaining, MIN_DELETION_SLICE_CHARS),
        Math.floor(remaining / (deleted.length - i)),
      );
      const path = deleted[i]!;
      const { text, truncated } = await gitBounded(
        worktreePath,
        // `:(literal)`, because a pathspec globs by default: these names come from git itself and
        // are exact, but one holding `*` or `[…]` would also match its NEIGHBOURS and spend this
        // file's slice of the budget quoting them.
        ["diff", "--diff-filter=D", "--no-renames", from, "HEAD", "--", `:(literal)${path}`],
        share,
      );
      if (!text.trim()) continue;
      remaining -= text.length;
      parts.push(truncated ? `${text}\n… [deletion of ${path} truncated at ${share} chars]` : text.trim());
    }

    const unshown = deleted.slice(i);
    if (unshown.length > 0) {
      parts.push(
        `… [${unshown.length} further deleted file(s) not shown — deletion budget of ${max} chars` +
          ` exhausted: ${unshown.join(", ")}]`,
      );
    }
    return {
      ...(parts.length > 0 ? { patch: parts.join("\n") } : {}),
      ...(unshown.length > 0 ? { unshown: unshown.length } : {}),
    };
  } catch (e) {
    console.warn(
      `[git] could not collect the deletions of ${from}..HEAD in ${worktreePath}: ${String(e)} — the` +
        ` review is told its deletion list is incomplete`,
    );
    return { ...(parts.length > 0 ? { patch: parts.join("\n") } : {}), incomplete: true };
  }
}

/** A worktree's checked-out branch and committed tip plus its working-tree dirt — the fingerprint a read-only phase guards. */
export interface WorktreeState {
  head: string;
  /**
   * The symbolic ref HEAD points at (`refs/heads/<branch>`), absent on a detached HEAD.
   *
   * Fingerprinted alongside `head` because a phase can move off the run's branch without moving
   * the commit: `git checkout -b scratch` leaves HEAD and the status identical, so a commit-only
   * fingerprint reads it as untouched — while every later commit lands on a branch the PR push
   * never sees.
   */
  ref?: string;
  /** `git status --porcelain` output; empty on a clean tree. */
  status: string;
}

/** True when two fingerprints describe the same branch, commit, and working-tree dirt. */
export function sameWorktreeState(a: WorktreeState, b: WorktreeState): boolean {
  return a.head === b.head && a.status === b.status && a.ref === b.ref;
}

/**
 * Fingerprint the worktree, so a phase that must not write can be caught having written.
 *
 * Scoped to git-visible state on purpose. Ignored paths are NOT fingerprinted: they never reach the
 * PR (the branch carries HEAD, and a finished run force-removes the worktree), and a read-only phase
 * is explicitly allowed to run the project's own checks — which rewrite exactly those paths
 * (`.next/`, `.eslintcache`, `*.tsbuildinfo`, coverage). Hashing them would fail every honest review
 * instead of catching a dishonest one.
 *
 * Scoped to this WORKTREE, too. The repository's other refs are deliberately absent: sibling
 * worktrees of concurrent runs share one ref store and churn it constantly, so a fingerprint there
 * could not tell their branches from a rogue phase's. A phase that must not write refs is denied
 * `git` instead — see `REVIEW_DENIED_TOOLS` in jobs/review-gate.
 */
export async function readWorktreeState(worktreePath: string): Promise<WorktreeState> {
  const [head, status, ref] = await Promise.all([
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["status", "--porcelain"]),
    symbolicHeadRef(worktreePath),
  ]);
  return { head, status, ...(ref ? { ref } : {}) };
}

/**
 * The branch HEAD points at (`refs/heads/<branch>`), or `""` when HEAD is detached.
 *
 * Only git's "HEAD is not a symbolic ref" answer counts as detached: `symbolic-ref --quiet` prints
 * nothing and exits 1 for that, while an unusable repository exits 128 and a timeout or a spawn
 * failure carries no exit status at all. Reading those as "detached" writes a false baseline — the
 * post-review read then succeeds, the fingerprint differs on `ref` alone, and the gate reverts a
 * worktree nobody wrote to, detaching the run's branch on the way. Everything but exit 1 propagates
 * so the run parks instead.
 */
async function symbolicHeadRef(worktreePath: string): Promise<string> {
  try {
    return await git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch (e) {
    // execFile reports a clean non-zero exit as a numeric `code`; a spawn error carries the string
    // errno (`ENOENT`) and a timeout kills the process, leaving `code` null with a `signal` set.
    if ((e as { code?: unknown } | null)?.code === 1) return "";
    throw e;
  }
}

/**
 * Throw away everything the worktree gained since `state` was read: back onto that branch and
 * commit, then drop the untracked files left behind. Ignored paths (`node_modules`, build caches)
 * are deliberately kept — `clean -fd` without `-x` — so undoing a stray edit never costs a full
 * reinstall.
 *
 * Assumes `state` was captured on a COMMITTED tree (which is where the review gate runs): restoring
 * onto a dirty baseline would discard that dirt too.
 */
export async function restoreWorktreeState(
  worktreePath: string,
  state: WorktreeState,
): Promise<void> {
  // Same classification as the read above: an operational failure here must not pass for a detached
  // HEAD, or the restore skips the checkout that puts the run back on its branch.
  const current = await symbolicHeadRef(worktreePath);
  if (current !== (state.ref ?? "")) {
    // Back onto the recorded branch first — a reset alone would re-pin the commit while leaving
    // HEAD on whatever branch the stray checkout created, so later commits still miss the PR.
    // `--force` drops the stray checkout's edits; the reset below re-pins the commit either way.
    // A short name is required: `git checkout refs/heads/x` detaches instead of attaching.
    await git(
      worktreePath,
      state.ref
        ? ["checkout", "--force", state.ref.replace(/^refs\/heads\//, "")]
        : ["checkout", "--force", "--detach", state.head],
    );
  }
  await git(worktreePath, ["reset", "--hard", state.head]);
  await git(worktreePath, ["clean", "-fd"]);
}

export interface PullRequest {
  url: string;
  /** beads external-ref form: `gh-<number>` when the number is parseable, else the url. */
  ref: string;
  number?: number;
  /** Whether GitHub reports the PR as a draft — see {@link markPullRequestDraft}. */
  isDraft?: boolean;
  /**
   * Set when a REUSED PR still shows an earlier attempt's title/body because the refresh failed
   * (see {@link openPullRequest}). The body is where this run's advisory findings meet the founder,
   * so a caller holding them must put them somewhere that outlives the run rather than assume the PR
   * carries them.
   */
  bodyStale?: boolean;
}

function prFromUrl(url: string): PullRequest {
  const m = url.match(/\/pull\/(\d+)/);
  const number = m ? Number(m[1]) : undefined;
  // `gh pr create` is called without `--draft`, so a PR parsed out of its output is ready to merge.
  return { url, ref: number ? `gh-${number}` : url, number, isDraft: false };
}

/** What a lookup of a branch's open PR actually established — see {@link lookupOpenPullRequest}. */
export interface OpenPullRequestLookup {
  /** The open PR tracking the branch. Absent when gh answered and there is none, or when it failed. */
  pr?: PullRequest;
  /**
   * True when `gh` could not answer at all — auth, network, a missing binary, unparseable output.
   * Deliberately NOT folded into "no PR": the branch may well have one, and a caller that defuses an
   * orphaned PR before parking would otherwise report "no PR was opened" over a live, mergeable PR
   * carrying un-reviewed work.
   */
  failed?: boolean;
}

/**
 * Look up the open PR tracking `branch`, distinguishing "there is none" from "gh could not tell us".
 *
 * Uses `gh pr list` rather than `gh pr view <branch>` precisely for that: `pr view` exits non-zero
 * BOTH when the branch has no PR and when the call itself failed, so every transient error read as a
 * clean "no PR". `pr list` exits 0 with an empty array for a branch that has none, which makes an
 * absent PR something gh confirmed instead of something inferred from a failure.
 *
 * Idempotency guard for openPullRequest: a resumed execute-epic run re-reaches the PR step against a
 * branch whose PR already exists (the first run opened it), and `gh pr create` would otherwise error.
 *
 * Also how a run RECONCILES a PR the board lost (anton-3apm): `gh pr create` can land server-side
 * with its response — or the follow-up `setPrRef` — lost, leaving a live PR no bead ref points at.
 * The branch is the only surviving handle on it, so it's the one this looks up by.
 */
export async function lookupOpenPullRequest(
  repoPath: string,
  branch: string,
): Promise<OpenPullRequestLookup> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "url,number,isDraft"],
      { cwd: repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const [pr] = JSON.parse(stdout) as Array<{ url?: string; number?: number; isDraft?: boolean }>;
    if (!pr?.url) return {}; // gh looked and the branch has no open PR
    return {
      pr: {
        url: pr.url,
        ref: pr.number ? `gh-${pr.number}` : pr.url,
        number: pr.number,
        isDraft: pr.isDraft === true,
      },
    };
  } catch (e) {
    console.warn(
      `[git] could not check for an open PR on ${branch}: ${String(e)} — treated as UNKNOWN, not as` +
        ` "no PR"`,
    );
    return { failed: true };
  }
}

/**
 * The open PR tracking `branch`, or undefined when there is none — for callers whose next move is
 * the same either way. {@link openPullRequest} is one: it creates a PR when it finds none, and a
 * lookup that failed surfaces as the `gh pr create` error rather than as a silent skip. A caller
 * that must not mistake a failed lookup for an absent PR uses {@link lookupOpenPullRequest}.
 */
export async function findOpenPullRequest(
  repoPath: string,
  branch: string,
): Promise<PullRequest | undefined> {
  return (await lookupOpenPullRequest(repoPath, branch)).pr;
}

/** `gh pr ready [--undo]`, best-effort — returns whether GitHub confirmed the flip. */
async function setPullRequestDraft(
  repoPath: string,
  selector: string,
  draft: boolean,
): Promise<boolean> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  // gh takes a number, url, or branch as the selector; the beads `gh-<n>` form is neither.
  const target = selector.startsWith("gh-") ? selector.slice(3) : selector;
  if (!target) return false;
  try {
    await execFileAsync(gh, ["pr", "ready", target, ...(draft ? ["--undo"] : [])], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Overwrite an existing PR's title and body, best-effort — returns whether gh confirmed the edit.
 *
 * The body is the founder's merge-gate surface: the review gate reports its advisories there and
 * nowhere else on the PR. A reused PR still carries the text of the attempt that OPENED it, and a
 * later attempt re-reviews from scratch — so inheriting that text would show the founder a stale
 * finding list while this run's advisories reach nobody.
 */
async function updatePullRequest(
  repoPath: string,
  selector: string,
  fields: { title: string; body: string },
): Promise<boolean> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  // gh takes a number, url, or branch as the selector; the beads `gh-<n>` form is neither.
  const target = selector.startsWith("gh-") ? selector.slice(3) : selector;
  if (!target) return false;
  try {
    await execFileAsync(gh, ["pr", "edit", target, "--title", fields.title, "--body", fields.body], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a PR to a draft. Returns whether GitHub confirmed it, so a caller can say so rather than
 * assume it (a failure here leaves the PR mergeable, which is the thing worth reporting).
 *
 * How the review gate defuses a PR the board lost (anton-3apm): a run that parks on blocking
 * findings must not leave un-reviewed work sitting mergeable at the founder's merge gate — the exact
 * state the gate exists to prevent. Draft rather than close, so the PR keeps its number, body, and
 * review threads and {@link openPullRequest} can hand it back ready once the gate passes.
 */
export async function markPullRequestDraft(repoPath: string, selector: string): Promise<boolean> {
  return setPullRequestDraft(repoPath, selector, true);
}

/** Lifecycle state of a GitHub PR, plus `unknown` when it can't be read (no remote/gh error). */
export type PullRequestState = "open" | "merged" | "closed" | "unknown";

/**
 * Report the lifecycle state of the PR named by a beads external ref (`gh-<n>`, a bare number, or
 * a PR url). Returns `"unknown"` when the state can't be determined — no `gh`, a network/CLI error,
 * or an unparseable ref — so callers can fail closed rather than mistake a transient failure for a
 * definitive state.
 *
 * Used by execute-epic to tell a STALE ref (a PR that was closed WITHOUT merging — which review-fix
 * deliberately leaves on the bead so a Run/Force run can recover the epic) apart from a ref that
 * proves another run already finished the epic (its PR is open or merged) (anton-jz1).
 */
export async function pullRequestState(
  repoPath: string,
  ref: string,
): Promise<PullRequestState> {
  // `gh pr view` accepts a number or url; `gh-<n>` is the beads form, so strip the prefix.
  const selector = ref.startsWith("gh-") ? ref.slice(3) : ref;
  if (!selector) return "unknown";
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(gh, ["pr", "view", selector, "--json", "state"], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // gh reports state as OPEN | CLOSED | MERGED (a closed-then-merged PR reports MERGED).
    const state = (JSON.parse(stdout) as { state?: string }).state?.toUpperCase();
    if (state === "OPEN") return "open";
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Push the branch and open a PR with `gh`. Requires an `origin` remote. Parses the PR number
 * from the returned URL (…/pull/<n>). Throws a clear Error when there is no remote.
 *
 * Idempotent: if an open PR already tracks the branch (a resumed run that re-reaches this step),
 * the branch is still pushed (to carry any new commits) and the existing PR is reused instead of
 * calling `gh pr create`, which would error on a duplicate. A reused PR has its title and body
 * rewritten to this attempt's (see {@link updatePullRequest}) — the review that just ran is the one
 * the founder must read. A refresh `gh` refuses is REPORTED (`bodyStale`) rather than warned about
 * and dropped: the body is the only place the run's advisory findings are written, so the caller
 * holding them has to persist them somewhere that survives the run. A reused PR is also taken OUT of
 * draft:
 * reaching this step means the run's self-review passed, so a PR an earlier parked attempt drafted
 * (see {@link markPullRequestDraft}) must become mergeable again or the epic finishes un-mergeable.
 */
export async function openPullRequest(opts: {
  repoPath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  if (!(await hasRemote(opts.repoPath))) {
    throw new Error(
      `no "origin" remote in ${opts.repoPath}; cannot open a PR. Add a remote or open it manually.`,
    );
  }
  await pushBranch(opts.repoPath, opts.branch);

  const existing = await findOpenPullRequest(opts.repoPath, opts.branch);
  if (existing) {
    // Refresh before returning it, drafted or not: this attempt re-ran the review, so the title and
    // body it was handed are the current ones and the PR's are the previous attempt's.
    const refreshed = await updatePullRequest(opts.repoPath, existing.ref, {
      title: opts.title,
      body: opts.body,
    });
    if (!refreshed) {
      console.warn(
        `[git] could not refresh the title/body of ${existing.url}; it still shows an earlier ` +
          `attempt's text — reported as bodyStale so the caller can preserve this run's findings`,
      );
    }
    if (!existing.isDraft) return { ...existing, bodyStale: !refreshed };
    // Report what actually happened: a flip gh refused leaves a draft PR the founder must ready by
    // hand, and the work is on the branch either way — not worth failing the run over. Logged as well
    // as returned, because the run goes on to finish `done` with the bead `in-review`: without a line
    // here the only visible trace of an un-mergeable PR is the draft badge on GitHub.
    const ready = await setPullRequestDraft(opts.repoPath, existing.ref, false);
    if (!ready) {
      console.warn(
        `[git] could not take ${existing.url} out of draft; the run's work is on ${opts.branch} but ` +
          `the PR stays un-mergeable until it is readied by hand`,
      );
    }
    return { ...existing, isDraft: !ready, bodyStale: !refreshed };
  }

  const gh = process.env[GH_BIN_ENV] ?? "gh";
  const { stdout } = await execFileAsync(
    gh,
    [
      "pr",
      "create",
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    { cwd: opts.repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const url = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return prFromUrl(url);
}
