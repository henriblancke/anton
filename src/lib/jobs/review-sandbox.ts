/**
 * OS-level filesystem containment for the pre-PR review session (anton-t6tu).
 *
 * The review runs unattended under `bypassPermissions` and keeps `Bash`, because the review
 * contract asks it to run the project's own read-only checks. Denying the write-capable TOOLS
 * closes every tool-shaped write (see `REVIEW_DENIED_TOOLS`), but a shell writes bytes without any
 * of them: `printf <sha> > <repo>/.git/refs/heads/anton/<future-bead>` plants a branch that
 * `createWorktree` later ADOPTS, so reviewer-chosen commits ride into an unrelated run's PR — and
 * the worktree fingerprint, which covers only this worktree, never sees it. No tool-name filter can
 * close that. Claude Code's Bash sandbox can: it confines every sandboxed command AND its children
 * at the OS level (Seatbelt on macOS, bubblewrap on Linux/WSL2).
 *
 * The settings are delivered on `--settings`, which outranks the user, project and local settings
 * files. That precedence is the point: neither the operator's machine config nor the branch under
 * review can switch the reviewer's sandbox back off.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { PoisonError } from "./errors";

/**
 * The `--settings` payload for a review session — Claude Code's `sandbox` block, nothing else.
 *
 * The three booleans are Claude Code's own documented lockdown triple, and each closes a different
 * way out:
 *   - `enabled` turns the Bash sandbox on for the session. Sandboxing is orthogonal to the
 *     permission mode — a mode decides WHETHER a tool call runs, the sandbox decides what the
 *     command can touch once it does — so `bypassPermissions` does not lift it.
 *   - `failIfUnavailable` decides the unavailable case explicitly, and decides it CLOSED: on a
 *     platform or host where the sandbox cannot start (native Windows, a Linux box missing
 *     bubblewrap) Claude Code refuses to start at all instead of its default of warning and running
 *     the commands unsandboxed. anton surfaces that as a failed review rather than silently
 *     grading the run with the hole open — a review that cannot be contained is worth less than no
 *     review, because the PR ships either way.
 *   - `allowUnsandboxedCommands: false` removes the model-facing escape hatch: a command that fails
 *     under the sandbox cannot be retried with `dangerouslyDisableSandbox`, which under
 *     `bypassPermissions` would otherwise re-run it unprompted and unconfined.
 *
 * Only `denyWrite` is set under `filesystem`. Reads stay open — the reviewer has to read the tree
 * it is judging — and the sandbox's default write scope (the cwd plus the session temp dir) already
 * lets the project's checks write their caches and temp files.
 */
export interface ReviewSandboxSettings {
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    filesystem: { denyWrite: string[] };
  };
}

/** Platforms where Claude Code has no Bash sandbox at all — WSL2 reports as `linux`, and is fine. */
const UNSANDBOXABLE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(["win32"]);

/**
 * Refuse to review at all on a platform whose sandbox can never exist.
 *
 * `failIfUnavailable` already makes Claude Code fail closed there, so this changes no outcome —
 * it changes the DIAGNOSIS. Without it the run parks on a `claude exited with code 1` whose text
 * blames a sandbox the operator never asked for; with it the reason names the platform and the
 * remedy (run anton under WSL2). Poison, because no retry makes a host sandboxable.
 */
export function assertReviewSandboxSupported(platform: NodeJS.Platform = process.platform): void {
  if (!UNSANDBOXABLE_PLATFORMS.has(platform)) return;
  throw new PoisonError(
    `the pre-PR review cannot be sandboxed on ${platform}: Claude Code's Bash sandbox does not run on native Windows, ` +
      "and anton will not review a run under an unsandboxed shell. Run anton inside WSL2, or disable the review gate " +
      "(reviewEnabled: false) to ship without one.",
  );
}

/**
 * Paths a review session's shell must not be able to write, given the worktree it reviews.
 *
 * `gitCommonDir` is the ref store shared by every worktree of the repository — where a planted
 * branch would live, and outside the worktree the read-only fingerprint covers.
 *
 * The worktree's own `.git` goes with it. In a linked worktree that is a one-line FILE naming the
 * admin dir, and it is what every later `git -C <worktree>` resolves through: repoint it and the
 * read-only guard's own `readWorktreeState` reads some other repository, so the "the reviewer wrote
 * nothing" verdict is fabricated rather than earned. Denying it costs nothing legitimate — git's
 * writes go to the admin dir under the common dir, which is denied anyway.
 */
export function reviewSandboxDenyWrite(worktreePath: string, gitCommonDir: string): string[] {
  return [...new Set([gitCommonDir, join(worktreePath, ".git")])];
}

/** The review session's `sandbox` block — what the driver hands Claude Code on `--settings`. */
export function reviewSandboxSettings(denyWrite: string[]): ReviewSandboxSettings {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite },
    },
  };
}

/**
 * Each path plus its symlink-resolved form, deduped.
 *
 * A deny rule only bites the path the kernel actually evaluates, and the two forms diverge in
 * exactly the environments anton runs in: on macOS `/var/folders/…` is a symlink to
 * `/private/var/folders/…`, and git reports the resolved form while a configured repo path may
 * carry the symlinked one. Listing both is cheap and collapses to one entry whenever they agree;
 * guessing which one the sandbox matches on is how a guard silently stops guarding.
 *
 * A path that cannot be resolved keeps its literal form — it is still the rule git just named.
 */
async function withRealPaths(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (p) => [p, await realpath(p).catch(() => p)] as const),
  );
  return [...new Set(resolved.flat())];
}

/**
 * Everything a review dispatch needs to run contained: fail loud on a platform that cannot be
 * sandboxed, then pin the repository's ref store shut for the session.
 *
 * `readGitCommonDir` is injected so the gate's unit tests can drive the resolution without a
 * repository; production passes `gitCommonDir` from git/ops. A failure to read it PROPAGATES: a
 * sandbox scoped to a common dir anton could not resolve is a guard with a hole in it.
 */
export async function resolveReviewSandbox(args: {
  worktreePath: string;
  readGitCommonDir: (worktreePath: string) => Promise<string>;
  platform?: NodeJS.Platform;
}): Promise<ReviewSandboxSettings> {
  assertReviewSandboxSupported(args.platform);
  const commonDir = await args.readGitCommonDir(args.worktreePath);
  return reviewSandboxSettings(await withRealPaths(reviewSandboxDenyWrite(args.worktreePath, commonDir)));
}
