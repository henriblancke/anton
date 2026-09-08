/**
 * The `already-shipped` repair (anton-9a4m, anton-5bpd) — the CHECK against a REAL seeded repository
 * and a seeded board (the two things the claim is checked against, so a test that faked either would
 * only prove the mock agrees with itself), and the RETIREMENT that acts on what it answers.
 *
 * The claims, in the order they matter:
 *   • A claim naming work that landed VERIFIES: the commit is in the base's history, the bead is
 *     closed AND something says that close landed — a commit in the base naming it, its own PR
 *     merged, or the merged PR of the run target it rides — the PR is merged.
 *   • Every other reading is a STATED failure — a commit on an unmerged branch, a commit this repo
 *     has never seen, a base git cannot resolve, a bead the board does not hold, a bead closed with
 *     nothing saying its work landed (PR #238 review: children close when their run commits, before
 *     the feature's PR merges), a bead still open with no PR or an unmerged one, a PR `gh` could
 *     not read, a claim naming nothing checkable.
 *   • NOTHING IS WRITTEN: not to bd, not to git. Asserted against the repository's refs and worktree
 *     and against every bd write seam, on the verifying path and the refusing one alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bead } from "../beads/bd";
import { formatHumanNote } from "../beads/notes";

const noteMock = vi.fn<(cwd: string, id: string, text: string) => Promise<string>>(async () => "");
const tagMock = vi.fn<(cwd: string, id: string, labels: string[]) => Promise<string>>(async () => "");
const linkMock = vi.fn(async () => "");
const closeMock = vi.fn(async () => "");
const updateMock = vi.fn(async () => "");
const setPrRefMock = vi.fn(async () => "");
const supersedeMock = vi.fn<(cwd: string, id: string, replacement: string) => Promise<string>>(
  async () => "",
);
const reopenMock = vi.fn<(cwd: string, id: string, reason?: string) => Promise<string>>(async () => "");
const unlinkMock = vi.fn<(cwd: string, a: string, b: string) => Promise<string>>(async () => "");
const untagMock = vi.fn<(cwd: string, id: string, labels: string[]) => Promise<string>>(async () => "");
/** Every bd seam that WRITES. A check that touches one of these has stopped being a check. */
const bdWrites = [noteMock, tagMock, linkMock, closeMock, updateMock, setPrRefMock, supersedeMock, reopenMock, unlinkMock, untagMock];
/** The under-lock re-reads the RETIREMENT makes — before its write and after it; the check never calls it. */
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
/** `bd history` as the check sees it — never reopened unless a case says so. */
const historyMock = vi.fn<(cwd: string, id: string) => Promise<{ at: string; status: string }[]>>(async () => []);
/**
 * What the board holds for a bead apart from THIS repair's own write. Cases script this one; the
 * retirement suite's `showMock` layers the supersede over it, so a post-write read of the ticket
 * comes back closed against the survivor the way a real `bd show` would — and a case that wants the
 * window to have moved the bead scripts `boardShow` to change its answer once `supersedeMock` fired.
 */
const boardShow = vi.fn<(cwd: string, id: string) => Promise<Bead>>();

const loadAllIssuesMock = vi.fn<(cwd: string, opts?: unknown) => Promise<Bead[]>>(async () => []);

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      note: noteMock,
      tag: tagMock,
      link: linkMock,
      close: closeMock,
      update: updateMock,
      setPrRef: setPrRefMock,
      supersede: supersedeMock,
      reopen: reopenMock,
      unlink: unlinkMock,
      untag: untagMock,
      show: showMock,
      history: historyMock,
    },
  };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: loadAllIssuesMock };
});

const {
  claimedCommits,
  claimedPullRequests,
  repairAlreadyShipped,
  resolveShipper,
  shippedEvidenceNote,
  verifyShippedClaim,
} = await import("./repair-already-shipped");
const { indexBoard } = await import("./board-index");
const { repairLabel } = await import("./repair");
const { GH_BIN_ENV } = await import("../git/ops");
const { withBeadWriteLock } = await import("../beads/claim-lock");
const { LABELS } = await import("../beads/bd");

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TARGET = "anton-9a4m";
const SHIPPER = "anton-9pkk";
/** A bead only an UNMERGED branch's commit names — closed on the board, landed nowhere. */
const UNLANDED = "anton-unld";
/** The run target {@link SHIPPER} rides in the child-of-a-feature cases. */
const OWNER = "anton-feat";

const bead = (id: string, over: Partial<Bead> = {}): Bead =>
  ({ id, title: id, status: "open", issue_type: "task", ...over }) as Bead;

/** A bead as `bd supersede <id> --with <by>` leaves it: closed, carrying the `supersedes` edge to `by`. */
const superseded = (b: Bead, by: string): Bead => ({
  ...b,
  status: "closed",
  dependencies: [...(b.dependencies ?? []), { issue_id: b.id, depends_on_id: by, type: "supersedes" }],
});

const suite = has("git") ? describe : describe.skip;

/**
 * The two things the claim is checked against, seeded for real: a git repository whose `main`
 * carries a commit that NAMES the shipper (the shape anton's own commits and squash bodies take)
 * beside an unmerged branch, and a fake `gh` answering `pr view` from a file rewritten per case.
 */
interface Sandbox {
  dir: string;
  repo: string;
  /** A commit merged into `main` whose message names {@link SHIPPER} — work that actually shipped. */
  landed: string;
  /** A commit on a branch `main` does not contain. */
  unmerged: string;
  /**
   * What gh answers for a PR — keyed by the selector `gh pr view` is handed, a number or a url. A
   * MERGED one names the commit that merged it and the branch it merged into — `landed` into `main`
   * unless the case says otherwise, since the check places the merge in the base's history rather
   * than taking the state's word for it (PR #238 review). `commit: null` is a gh that names no merge
   * commit at all. `carries` is the PR's own commit list as GitHub records it — the messages, given
   * oids by {@link carriedOid} and dated "now" unless an entry says when — which is what vouches for
   * a closed child the base names nowhere, and what dates every merged PR's work: one undated
   * commit naming nothing unless the case says otherwise, since a merged PR is never empty.
   */
  setPr: (
    selector: number | string,
    state: "OPEN" | "MERGED" | "CLOSED",
    merge?: { commit?: string | null; base?: string; carries?: (string | { message: string; at: string })[] },
  ) => void;
  /** Everything a write would move: refs, HEAD, the index and the working tree. */
  repoFingerprint: () => string;
  cleanup: () => void;
}

function openSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "anton-shipped-"));
  const repo = join(dir, "repo");
  const binDir = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(binDir);
  const g = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "anton-test"]);
  writeFileSync(join(repo, "README.md"), "# sandbox\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  writeFileSync(join(repo, "shipped.ts"), "export const shipped = true;\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", `${SHIPPER}: the work that shipped`]);
  const landed = g(["rev-parse", "HEAD"]);
  g(["checkout", "-q", "-b", "someone-elses-branch"]);
  writeFileSync(join(repo, "elsewhere.ts"), "export const elsewhere = true;\n");
  g(["add", "-A"]);
  // Names a bead too — on a branch `main` does not contain, which must prove nothing for it.
  g(["commit", "-q", "-m", `${UNLANDED}: never merged`]);
  const unmerged = g(["rev-parse", "HEAD"]);
  g(["checkout", "-q", "main"]);

  const prStates: Record<
    string,
    {
      state: string;
      mergeCommit: { oid: string } | null;
      baseRefName: string;
      commits: { oid: string; messageHeadline: string; messageBody: string; authoredDate: string; committedDate: string }[];
    }
  > = {};
  const stateFile = join(dir, "pr-states.json");
  writeFileSync(stateFile, "{}");
  const fakeGh = join(binDir, "gh");
  // `pr view <selector> --json …` answers from the file, and EXITS NON-ZERO for a PR it does not
  // know — the shape of a gh that cannot reach GitHub, which must never read as a state.
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs=require('fs');
const a=process.argv.slice(2);
if(a[0]!=='pr'||a[1]!=='view'){process.exit(9)}
const states=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
const pr=states[a[2]];
if(!pr){process.stderr.write('could not resolve to a PullRequest\\n');process.exit(1)}
process.stdout.write(JSON.stringify(pr));
`,
    { mode: 0o755 },
  );
  chmodSync(fakeGh, 0o755);
  const prevGh = process.env[GH_BIN_ENV];
  process.env[GH_BIN_ENV] = fakeGh;

  return {
    dir,
    repo,
    landed,
    unmerged,
    setPr: (selector, state, merge = {}) => {
      const commit = state === "MERGED" ? (merge.commit === undefined ? landed : merge.commit) : null;
      prStates[String(selector)] = {
        state,
        mergeCommit: commit ? { oid: commit } : null,
        baseRefName: merge.base ?? "main",
        commits: (merge.carries ?? ["chore: the work the PR carried"]).map((entry, i) => {
          const { message, at } = typeof entry === "string" ? { message: entry, at: new Date().toISOString() } : entry;
          const nl = message.indexOf("\n");
          return {
            oid: carriedOid(i),
            messageHeadline: nl < 0 ? message : message.slice(0, nl),
            messageBody: nl < 0 ? "" : message.slice(nl + 1),
            authoredDate: at,
            committedDate: at,
          };
        }),
      };
      writeFileSync(stateFile, JSON.stringify(prStates));
    },
    repoFingerprint: () =>
      [g(["show-ref", "--head"]), g(["status", "--porcelain=v1"]), g(["stash", "list"])].join("\n"),
    cleanup: () => {
      if (prevGh === undefined) delete process.env[GH_BIN_ENV];
      else process.env[GH_BIN_ENV] = prevGh;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The oid the fake gh gives the i-th commit a PR carries (`setPr`'s `carries`). */
const carriedOid = (i: number) => (i + 1).toString(16).padStart(40, "0");

/** How a refusal names the commit a bead's own PR is dated by — one committed under it or a ticket of its own. */
const ownWorkIn = (ref: string, id: string) =>
  `the newest commit in PR ${ref} committed under \`${id}\` or a ticket of its own`;

/** How a proof line ends for a PR whose merge the base contains — the evidence, not the state. */
const mergedTail = (sha: string) =>
  `, and its merge commit \`${sha.slice(0, 10)}\` is in the history of the run's base (main)`;

suite("verifyShippedClaim (real git · seeded board · fake gh)", () => {
  let sb: Sandbox;
  let repo: string;
  let landed: string;
  let unmerged: string;
  let setPr: Sandbox["setPr"];
  let repoFingerprint: Sandbox["repoFingerprint"];

  beforeEach(() => {
    sb = openSandbox();
    ({ repo, landed, unmerged, setPr, repoFingerprint } = sb);
    for (const write of bdWrites) write.mockClear();
    loadAllIssuesMock.mockClear();
    loadAllIssuesMock.mockResolvedValue([]);
    historyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => sb.cleanup());

  const verify = (reason: string | undefined, board: Bead[], base = "main") =>
    verifyShippedClaim({ repoPath: repo, base, targetId: TARGET, reason, board });

  /** A bead's versions as `bd history` lists them, newest first, from (date, status) pairs. */
  const versions = (...pairs: [string, string][]) => pairs.map(([at, status]) => ({ at, status }));
  /** A reopen an hour from now — after every commit the sandbox makes. */
  const REOPENED_AT = new Date(Date.now() + 3_600_000).toISOString();
  const RECLOSED_AT = new Date(Date.now() + 7_200_000).toISOString();
  /** Shipped once, reopened for rework, closed again — the close the board holds is the second. */
  const REWORKED = versions([RECLOSED_AT, "closed"], [REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]);
  /** Three hours from now — after {@link REOPENED_AT} and {@link RECLOSED_AT}. */
  const AFTER_REWORK = new Date(Date.now() + 3 * 3_600_000).toISOString();

  /**
   * A commit landing on `main` AFTER the reopen — the shape of a merge that happened after it,
   * whatever it carried. Dated by hand: the sandbox's own commits are all "now", before
   * {@link REOPENED_AT}. `message` defaults to a squash whose message no longer names the bead.
   */
  const landedAfterReopen = (message = "squash: the rework, id dropped from the message"): string => {
    const env = { ...process.env, GIT_AUTHOR_DATE: AFTER_REWORK, GIT_COMMITTER_DATE: AFTER_REWORK };
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", message], { env, stdio: "ignore" });
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  /** A commit in a PR's list, done after the reopen — the rework itself. */
  const reworkCarried = (message: string) => ({ message, at: AFTER_REWORK });

  it("verifies a claim whose commit, bead and PR all check out", async () => {
    setPr(85, "MERGED");
    const verdict = await verify(
      `Already implemented by ${SHIPPER} (commit ${landed.slice(0, 7)}, PR #85)`,
      [bead(TARGET), bead(SHIPPER, { status: "closed" })],
    );

    expect(verdict.state).toBe("verified");
    expect(verdict.proof).toEqual([
      `commit \`${landed.slice(0, 10)}\` is in the history of the run's base (main)`,
      `\`${SHIPPER}\` is closed on the board, and commit \`${landed.slice(0, 10)}\` in the ` +
        `history of the run's base (main) names it`,
      `PR gh-85 is merged${mergedTail(landed)}`,
    ]);
    // Every commit and PR the verdict rests on, in checkable form, deduped — the survivor's naming
    // commit is the one the prose cited too, and the write re-asks all of it under the lock.
    expect((verdict as { cited: unknown }).cited).toEqual([
      { kind: "commit", sha: landed },
      { kind: "pr", ref: "gh-85" },
    ]);
    expect((verdict as { landed: unknown }).landed).toEqual({
      [SHIPPER]: { via: "commit", sha: landed, landedAt: expect.any(String) },
    });
    // The note a caller may write states what was checked AND what was not.
    expect(shippedEvidenceNote(verdict)).toContain("acceptance criteria");
  });

  it("refuses a commit the base does not contain", async () => {
    const verdict = await verify(`shipped in ${unmerged.slice(0, 8)}`, [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("does not contain it") });
  });

  // A PR url is handed to gh WHOLE (PR #238 review), so the repository it names is the one read —
  // never this repository's PR of the same number, whatever state that one is in.
  it("checks a PR url in the repository it names, not this repository's PR of that number", async () => {
    setPr(85, "MERGED");
    const url = "https://github.com/someone-else/theirs/pull/85";
    setPr(url, "MERGED", { commit: "f".repeat(40) });

    const verdict = await verify(`shipped in ${url}`, [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(`the claim names PR ${url}, which is merged, and its merge commit`),
    });
    expect(verdict).toMatchObject({ why: expect.stringContaining("this repository has never seen") });

    const unread = await verify("shipped in https://github.com/someone-else/theirs/pull/86", [bead(TARGET)]);
    expect(unread).toMatchObject({
      state: "unverified",
      why: expect.stringContaining("could not read its state"),
    });
  });

  it("refuses a commit this repository has never seen, without fetching", async () => {
    const before = repoFingerprint();
    const verdict = await verify("shipped in 0123456789abcdef0123456789abcdef01234567", [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("no such commit is in this repository") });
    expect(repoFingerprint()).toBe(before);
  });

  it("refuses when the run's base itself cannot be resolved", async () => {
    const verdict = await verify(`shipped in ${landed.slice(0, 7)}`, [bead(TARGET)], "origin/nope");

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("could not be read") });
  });

  it("verifies a bead that is still open when its PR has merged", async () => {
    setPr(85, "MERGED");
    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict).toEqual({
      state: "verified",
      proof: [`\`${SHIPPER}\` is in_progress, but its PR (gh-85) is merged${mergedTail(landed)}`],
      landed: { [SHIPPER]: { via: "pr", ref: "gh-85", workedAt: expect.any(String) } },
      cited: [{ kind: "pr", ref: "gh-85" }],
    });
    // An open bead has no `closed_at` to settle the cycle question by, so its history is always
    // asked — and a never-reopened one stands.
    expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
  });

  // PR #238 review: a bead shipped once and REOPENED for rework keeps its merged PR pointer, and
  // that merge speaks for the work it was reopened from. Accepted as-is, another live ticket would
  // be retired against work the survivor is still redoing.
  it("refuses a bead still open whose merged PR's commits all predate its last reopen", async () => {
    setPr(85, "MERGED", { carries: [`${SHIPPER}: as first shipped`] });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(`\`${SHIPPER}\` is in_progress and its PR (gh-85) is merged — but`),
    });
    expect(verdict).toMatchObject({ why: expect.stringContaining(ownWorkIn("gh-85", SHIPPER) + " is dated") });
    expect(verdict).toMatchObject({ why: expect.stringContaining(`the board reopened \`${SHIPPER}\` at ${REOPENED_AT}`) });
    expect(verdict).toMatchObject({ why: expect.stringContaining("is later work still in_progress") });
  });

  // PR #238 review: the PR was still OPEN when the bead was reopened, and merged unchanged after —
  // its merge postdates the reopen, and every commit in it predates it. The merge's date says the
  // rework landed; the PR's own commits say nothing of the current cycle is in it.
  it("refuses an open bead's PR merged after its last reopen when every commit in it predates the reopen", async () => {
    setPr(85, "MERGED", { commit: landedAfterReopen(), carries: [`${SHIPPER}: as first shipped`] });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining(ownWorkIn("gh-85", SHIPPER) + " is dated") });
    expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
  });

  // PR #238 review: the PR kept across the reopen is one anyone can still push to, and GitHub's
  // "Update branch" adds a merge from the base dated whenever it was clicked — after the reopen,
  // here — under a subject that names the bead through its branch. The rework is dated by a commit
  // committed UNDER the bead, and a merge from the base is not one, however new it is.
  it("refuses an open bead's PR whose only post-reopen commit is a merge from the base, not its own", async () => {
    setPr(85, "MERGED", {
      commit: landedAfterReopen(),
      carries: [`${SHIPPER}: as first shipped`, reworkCarried(`Merge branch 'main' into anton/${SHIPPER}`)],
    });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining(ownWorkIn("gh-85", SHIPPER) + " is dated") });
    expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
  });

  it("refuses a reopened bead's PR carrying no commit of its own at all — nothing in it can date the rework", async () => {
    setPr(85, "MERGED", {
      commit: landedAfterReopen(),
      carries: ["chore: as first shipped", reworkCarried(`Merge branch 'main' into anton/${SHIPPER}`)],
    });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(
        `the board reopened \`${SHIPPER}\` at ${REOPENED_AT}, and none of the 2 commits GitHub records in it ` +
          `is committed under \`${SHIPPER}\` or a ticket of its own — its newest, \`${carriedOid(1).slice(0, 10)}\` ` +
          `dated ${AFTER_REWORK}, is not that rework`,
      ),
    });
    expect(verdict).toMatchObject({ why: expect.stringContaining("is later work still in_progress") });
  });

  // A run target's PR carries its tickets' `<child>: …` commits, and a review round's under its
  // own id — the rework of a reopened feature is committed under a ticket beneath it.
  it("verifies a reopened bead's merged PR when a post-reopen commit is committed under a ticket beneath it", async () => {
    setPr(85, "MERGED", {
      commit: landedAfterReopen(),
      carries: [`${SHIPPER}: as first shipped`, reworkCarried("anton-kid1: the rework")],
    });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", issue_type: "feature", metadata: { pr: "gh-85" } }),
      bead("anton-kid1", { status: "closed", parent: SHIPPER }),
    ]);

    expect(verdict.state).toBe("verified");
    expect((verdict as { landed: unknown }).landed).toEqual({
      [SHIPPER]: { via: "pr", ref: "gh-85", workedAt: AFTER_REWORK },
    });
  });

  // Everything in a bead's own PR is its work: a PR whose commits were never committed under the
  // bead — a hand-made one — still speaks for a bead that was never reopened.
  it("verifies a never-reopened bead's merged PR carrying no commit under its id", async () => {
    setPr(85, "MERGED", { carries: ["feat: written by hand, under no bead"] });

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("verified");
    expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
  });

  it("verifies an open bead's merged PR when a commit in it postdates the reopen — the rework is in it", async () => {
    setPr(85, "MERGED", {
      commit: landedAfterReopen(),
      carries: [`${SHIPPER}: as first shipped`, reworkCarried(`${SHIPPER}: the rework`)],
    });
    historyMock.mockResolvedValue(versions([REOPENED_AT, "in_progress"], ["2020-01-01T00:00:00Z", "closed"]));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("verified");
    expect((verdict as { landed: unknown }).landed).toEqual({
      [SHIPPER]: { via: "pr", ref: "gh-85", workedAt: AFTER_REWORK },
    });
  });

  it("refuses an open bead's merged PR whose commit list cannot be read — undated work is unchecked", async () => {
    setPr(85, "MERGED");
    historyMock.mockRejectedValue(new Error("must not be read"));
    // A gh that answers the PR's state but not its commits: the file the fake reads is rewritten to
    // a PR with no commit list at all.
    const stateFile = join(sb.dir, "pr-states.json");
    const states = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>>;
    delete states["85"]!.commits;
    writeFileSync(stateFile, JSON.stringify(states));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining("the commits GitHub records for it could not be read"),
    });
    expect(historyMock).not.toHaveBeenCalled();
  });

  it("refuses an open bead's merged PR when its history cannot be read — no `closed_at` answers for it", async () => {
    setPr(85, "MERGED");
    historyMock.mockRejectedValue(new Error("dolt: connection refused"));

    const verdict = await verify(`superseded by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(`whether \`${SHIPPER}\` was reopened since could not be read (dolt: connection refused)`),
    });
  });

  // CLOSED IS NOT LANDED (PR #238 review). An epic's children close the moment their run commits
  // them, before the feature's one pull request opens, let alone merges — so a closed bead is
  // routinely work on an unmerged branch, and retiring a live ticket against it would settle that
  // ticket on work the base does not contain.
  // The log format splits sha from body on `\x1f`; a body that itself carries that byte must not
  // lose whatever names the bead behind it (PR #238 review).
  it("reads a naming commit whose body itself carries the log format's separator byte", async () => {
    const g = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    writeFileSync(join(repo, "separated.ts"), "export const separated = true;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "odd\x1fbody", "-m", "anton-sepr: shipped behind the separator"]);
    const sha = g(["rev-parse", "HEAD"]);

    const verdict = await verify("already done by anton-sepr", [
      bead(TARGET),
      bead("anton-sepr", { status: "closed" }),
    ]);

    expect(verdict).toMatchObject({ state: "verified", landed: { "anton-sepr": { via: "commit", sha } } });
  });

  it("refuses a bead that is closed with nothing saying its work landed", async () => {
    const verdict = await verify(`already done by ${UNLANDED}`, [
      bead(TARGET),
      bead(UNLANDED, { status: "closed" }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("nothing says its work LANDED") });
    expect(verdict).toMatchObject({ why: expect.stringContaining("no commit in main names it") });
  });

  it("refuses a closed child of a feature whose pull request has NOT merged", async () => {
    setPr(85, "OPEN");
    const feature = bead(OWNER, { issue_type: "feature", status: "in_progress", metadata: { pr: "gh-85" } });
    const child = bead(UNLANDED, { status: "closed" });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(`the PR of \`${OWNER}\`, the run target it rides, (gh-85) is open, not merged`),
    });
  });

  it("verifies a closed child through the MERGED pull request of the feature it rides, when that PR's commits name it", async () => {
    setPr(85, "MERGED", { carries: ["feat: unrelated", `${UNLANDED}: the child's own commit`] });
    const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
    const child = bead(UNLANDED, { status: "closed" });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict).toEqual({
      state: "verified",
      proof: [
        `\`${UNLANDED}\` is closed on the board and the PR of \`${OWNER}\`, the run target it ` +
          `rides, (gh-85) is merged${mergedTail(landed)}, and GitHub records commit ` +
          `\`${carriedOid(1).slice(0, 10)}\` in that PR naming it`,
      ],
      landed: { [UNLANDED]: { via: "owner-pr", ownerId: OWNER, ref: "gh-85", workedAt: expect.any(String) } },
      cited: [{ kind: "pr", ref: "gh-85" }],
    });
  });

  // Parentage is read off the board NOW (PR #238 review): a bead re-homed under a feature after
  // that feature's PR merged rides it today and was carried by nothing of it. The PR's own commit
  // list is GitHub's record of what it held, and a merged owner PR that never named the bead is no
  // evidence for it — whatever another closed child of the same feature would prove.
  it("refuses a closed child whose feature's merged PR never carried a commit naming it", async () => {
    setPr(85, "MERGED", { carries: ["anton-sibl: a sibling that did ride this PR"] });
    const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
    const child = bead(UNLANDED, { status: "closed" });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({
      why: expect.stringContaining(
        `(gh-85) is merged, but none of the commits GitHub records for that PR names \`${UNLANDED}\``,
      ),
    });
    expect(verdict).toMatchObject({ why: expect.stringContaining("nothing says it did when that PR merged") });
  });

  it("refuses a closed child through a merged owner PR whose commit list a dotted child of it names, not it", async () => {
    setPr(85, "MERGED", { carries: [`${UNLANDED}.1: the child's child`] });
    const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
    const child = bead(UNLANDED, { status: "closed" });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("none of the commits GitHub records") });
  });

  it("verifies a closed bead through its own merged pull request", async () => {
    setPr(85, "MERGED");
    const verdict = await verify(`already done by ${UNLANDED}`, [
      bead(TARGET),
      bead(UNLANDED, { status: "closed", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict).toEqual({
      state: "verified",
      proof: [`\`${UNLANDED}\` is closed on the board and its PR (gh-85) is merged${mergedTail(landed)}`],
      landed: { [UNLANDED]: { via: "pr", ref: "gh-85", workedAt: expect.any(String) } },
      cited: [{ kind: "pr", ref: "gh-85" }],
    });
  });

  // PR #238 review: a bead that shipped once, was reopened for rework, and was closed again by a run
  // whose PR has not merged still has its FIRST landing in the base. That landing is an earlier
  // cycle's, and a ticket must not be retired against it while the survivor's latest work is unmerged.
  describe("a closed bead's landing is held to its current closure", () => {
    it("refuses a naming commit in the base that predates the bead's last reopen", async () => {
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({ why: expect.stringContaining("nothing says its CURRENT work LANDED") });
      // The stale commit rides into the refusal: a human reads every route anton tried.
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`commit \`${landed.slice(0, 10)}\` in the history of the run's base (main) names it, but`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining(`the board reopened \`${SHIPPER}\` at ${REOPENED_AT}`) });
      expect(verdict).toMatchObject({ why: expect.stringContaining("nothing says THAT work landed") });
      expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
    });

    // PR #238 review: the naming commit was DISCOVERED, not cited, so one that fails the cycle bar
    // is a route that gave nothing — the bead's merged PR, whose commits postdate the reopen, still
    // speaks. The rework landed through a squash whose message no longer names the bead, so the
    // old naming commit is still the newest match in the base.
    it("falls through a stale naming commit to the bead's own PR when that PR carries work from after the reopen", async () => {
      const rework = landedAfterReopen();
      setPr(85, "MERGED", { commit: rework, carries: [reworkCarried(`${SHIPPER}: the rework`)] });
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("verified");
      expect(verdict.proof).toEqual([
        `\`${SHIPPER}\` is closed on the board and its PR (gh-85) is merged${mergedTail(rework)}`,
      ]);
      expect((verdict as { landed: unknown }).landed).toEqual({
        [SHIPPER]: { via: "pr", ref: "gh-85", workedAt: expect.any(String) },
      });
    });

    it("carries the stale naming commit into the refusal when the PR route fails too", async () => {
      setPr(85, "CLOSED");
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({ why: expect.stringContaining("its PR (gh-85) is closed, not merged") });
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`commit \`${landed.slice(0, 10)}\` in the history of the run's base (main) names it, but`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
    });

    // Every other unreadable signal here fails closed; a reopen the history dates with something
    // that is not a date is one more of them, not a "never reopened" (PR #238 review).
    it("refuses when the history dates the last reopen with something that is not a date", async () => {
      historyMock.mockResolvedValue(
        versions([RECLOSED_AT, "closed"], ["yesterday-ish", "in_progress"], ["2020-01-01T00:00:00Z", "closed"]),
      );

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`dates \`${SHIPPER}\`'s last reopen as "yesterday-ish", which is not a date`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining("could not be read") });
    });

    // The shortcut is the bead's OWN commit at or after its close; a commit under no bead — a merge
    // from the base, say — is dated after the close just as easily and settles nothing.
    it("verifies a PR whose own work is at or after the close the board holds without reading the history", async () => {
      setPr(85, "MERGED", { carries: [`${UNLANDED}: the work`] });
      historyMock.mockRejectedValue(new Error("must not be read"));

      const verdict = await verify(`already done by ${UNLANDED}`, [
        bead(TARGET),
        bead(UNLANDED, { status: "closed", closed_at: "2020-01-01T00:00:00Z", metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("verified");
      expect(historyMock).not.toHaveBeenCalled();
    });

    // PR #238 review: a naming commit in the base is dated when it MERGED — for a squash, that is
    // all it is dated by — and a PR left open across the reopen and merged unchanged lands one dated
    // after both the reopen and the second close. So `closed_at` settles nothing for the commit
    // route: the history is read, and once it shows a reopen the commit cannot say which cycle it
    // holds. A survivor with no PR to ask is refused, with what the commit said in the refusal.
    it("reads the history for a naming commit even after the close, and refuses once the bead was ever reopened", async () => {
      historyMock.mockResolvedValue(
        versions(["2020-02-01T00:00:00Z", "closed"], ["2020-01-15T00:00:00Z", "in_progress"], ["2020-01-01T00:00:00Z", "closed"]),
      );

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: "2020-02-01T00:00:00Z" }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
      expect(verdict).toMatchObject({ why: expect.stringContaining("nothing says its CURRENT work LANDED") });
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`the board reopened \`${SHIPPER}\` at 2020-01-15T00:00:00Z, and commit \`${landed.slice(0, 10)}\` dates its merge`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining("only the pull request's own commits can say") });
    });

    it("verifies a landing that predates the close when the bead was never reopened — a hand close after the merge", async () => {
      historyMock.mockResolvedValue(
        versions([RECLOSED_AT, "closed"], ["2020-01-02T00:00:00Z", "in_progress"], ["2020-01-01T00:00:00Z", "open"]),
      );

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT }),
      ]);

      expect(verdict.state).toBe("verified");
      expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
    });

    it("verifies through the bead's PR when its commits postdate the reopen — a naming commit after it is not proof on its own", async () => {
      setPr(85, "MERGED", { carries: [`${SHIPPER}: the rework`] });
      historyMock.mockResolvedValue(
        versions([RECLOSED_AT, "closed"], ["2020-06-01T00:00:00Z", "in_progress"], ["2020-01-01T00:00:00Z", "closed"]),
      );

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("verified");
      expect(verdict.proof).toEqual([
        `\`${SHIPPER}\` is closed on the board and its PR (gh-85) is merged${mergedTail(landed)}`,
      ]);
    });

    it("refuses when the history cannot be read and the landing predates the close — unread is unchecked", async () => {
      historyMock.mockRejectedValue(new Error("dolt: connection refused"));

      const verdict = await verify(`already done by ${SHIPPER}`, [
        bead(TARGET),
        bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`whether \`${SHIPPER}\` was reopened since could not be read (dolt: connection refused)`),
      });
    });

    it("refuses a bead's own merged PR whose commits all predate its last reopen", async () => {
      setPr(85, "MERGED", { carries: [`${UNLANDED}: as first shipped`] });
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${UNLANDED}`, [
        bead(TARGET),
        bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`\`${UNLANDED}\` is closed on the board and its PR (gh-85) is merged — but`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
    });

    // PR #238 review: the merge postdates the reopen — and even the second close — while every
    // commit in the PR predates it. The PR was open when the bead was reopened and merged unchanged.
    it("refuses a bead's own PR merged after its reopen and re-close when every commit in it predates the reopen", async () => {
      setPr(85, "MERGED", { commit: landedAfterReopen(), carries: [`${UNLANDED}: as first shipped`] });
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${UNLANDED}`, [
        bead(TARGET),
        bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({
        why: expect.stringContaining(`\`${UNLANDED}\` is closed on the board and its PR (gh-85) is merged — but`),
      });
      expect(verdict).toMatchObject({ why: expect.stringContaining(ownWorkIn("gh-85", UNLANDED) + " is dated") });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is later work under that close") });
    });

    // PR #238 review: a merge from the base after the re-close is dated after the close too, so the
    // `closed_at` shortcut would pass it on its date alone — it is not a commit under the bead, so
    // it never reaches that shortcut.
    it("refuses a re-closed bead's PR whose only commit after the close is a merge from the base", async () => {
      setPr(85, "MERGED", {
        commit: landedAfterReopen(),
        carries: [`${UNLANDED}: as first shipped`, reworkCarried(`Merge branch 'main' into anton/${UNLANDED}`)],
      });
      historyMock.mockResolvedValue(REWORKED);

      const verdict = await verify(`already done by ${UNLANDED}`, [
        bead(TARGET),
        bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT, metadata: { pr: "gh-85" } }),
      ]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({ why: expect.stringContaining(ownWorkIn("gh-85", UNLANDED) + " is dated") });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is later work under that close") });
    });

    it("refuses the merged PR of the run target a child rides when that merge predates the child's last reopen", async () => {
      setPr(85, "MERGED", { carries: [`${UNLANDED}: the child's first commit`] });
      historyMock.mockResolvedValue(REWORKED);
      const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
      const child = bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT });
      (child as unknown as Record<string, unknown>).parent = OWNER;

      const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({
        why: expect.stringContaining(
          `(gh-85) is merged, and GitHub records commit \`${carriedOid(0).slice(0, 10)}\` in that PR naming it — but`,
        ),
      });
      expect(historyMock).toHaveBeenCalledWith(repo, UNLANDED);
    });

    it("refuses the run target's PR merged after the child's reopen when its commits naming the child all predate it", async () => {
      setPr(85, "MERGED", {
        commit: landedAfterReopen(),
        // A sibling's rework after the reopen does not date THIS child's work.
        carries: [`${UNLANDED}: the child's first commit`, reworkCarried("anton-sibl: a sibling's rework")],
      });
      historyMock.mockResolvedValue(REWORKED);
      const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
      const child = bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT });
      (child as unknown as Record<string, unknown>).parent = OWNER;

      const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

      expect(verdict.state).toBe("unverified");
      expect(verdict).toMatchObject({ why: expect.stringContaining("the newest commit in PR gh-85 naming it is dated") });
      expect(verdict).toMatchObject({ why: expect.stringContaining("is an earlier cycle's") });
    });

    it("verifies a child through the run target's PR when the newest commit naming it postdates the reopen", async () => {
      setPr(85, "MERGED", {
        commit: landedAfterReopen(),
        carries: [`${UNLANDED}: the child's first commit`, reworkCarried(`${UNLANDED}: the child's rework`)],
      });
      historyMock.mockResolvedValue(REWORKED);
      const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
      const child = bead(UNLANDED, { status: "closed", closed_at: RECLOSED_AT });
      (child as unknown as Record<string, unknown>).parent = OWNER;

      const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

      expect(verdict.state).toBe("verified");
      // The proof names the rework — the newest commit naming the child — and the landing is dated by it.
      expect(verdict.proof[0]).toContain(`GitHub records commit \`${carriedOid(1).slice(0, 10)}\` in that PR naming it`);
      expect((verdict as { landed: unknown }).landed).toEqual({
        [UNLANDED]: { via: "owner-pr", ownerId: OWNER, ref: "gh-85", workedAt: AFTER_REWORK },
      });
    });
  });

  it("refuses a closed bead whose own pull request is not merged, before asking its feature", async () => {
    setPr(85, "CLOSED");
    setPr(86, "MERGED");
    const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-86" } });
    const child = bead(UNLANDED, { status: "closed", metadata: { pr: "gh-85" } });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("its PR (gh-85) is closed, not merged") });
  });

  it("refuses a bead the board does not hold", async () => {
    const verdict = await verify("already done by anton-zzzz", [bead(TARGET), bead(SHIPPER)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("no such bead") });
  });

  it("refuses a bead that is still open and points at no PR", async () => {
    const verdict = await verify(`already done by ${SHIPPER}`, [bead(TARGET), bead(SHIPPER)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("points at no PR") });
  });

  it("refuses a bead whose PR is open rather than merged", async () => {
    setPr(85, "OPEN");
    const verdict = await verify(`already done by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("is open, not merged") });
  });

  it("refuses a bead closed as abandoned — dropped work is not shipped work", async () => {
    const verdict = await verify(`already done by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "closed", labels: ["abandoned"] }),
    ]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("abandoned") });
  });

  it("refuses a PR gh could not read — an unreadable PR is an unchecked claim", async () => {
    const verdict = await verify("shipped in PR #85", [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("could not read its state") });
  });

  it("refuses a PR that is closed without merging", async () => {
    setPr(85, "CLOSED");
    const verdict = await verify("shipped in PR #85", [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("is closed, not merged") });
  });

  // MERGED IS NOT LANDED (PR #238 review): a repository that merges into `develop` or a release
  // line has merged PRs whose work `main` does not contain, and `gh` calls them merged all the same.
  it("refuses a PR merged into a branch whose history the run's base does not share", async () => {
    setPr(85, "MERGED", { commit: unmerged, base: "develop" });
    const verdict = await verify("shipped in PR #85", [bead(TARGET)]);
    expect(verdict).toMatchObject({
      state: "unverified",
      why: expect.stringContaining("is merged elsewhere than the run's base (main) — into `develop`"),
    });
    expect((verdict as { why: string }).why).toContain(unmerged.slice(0, 10));
  });

  it("refuses a bead whose PR merged elsewhere than the base, closed or not", async () => {
    setPr(85, "MERGED", { commit: unmerged, base: "release/1.x" });
    const open = await verify(`done by ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ]);
    expect(open).toMatchObject({
      why: expect.stringContaining(`\`${SHIPPER}\` is in_progress and its PR (gh-85) is merged elsewhere`),
    });
    const closed = await verify(`done by ${UNLANDED}`, [
      bead(TARGET),
      bead(UNLANDED, { status: "closed", metadata: { pr: "gh-85" } }),
    ]);
    expect(closed).toMatchObject({
      why: expect.stringContaining(`\`${UNLANDED}\` is closed on the board, but its PR (gh-85) is merged elsewhere`),
    });
  });

  it("refuses a merged PR gh names no merge commit for — unplaced is not landed", async () => {
    setPr(85, "MERGED", { commit: null });
    const verdict = await verify("shipped in PR #85", [bead(TARGET)]);
    expect(verdict).toMatchObject({
      state: "unverified",
      why: expect.stringContaining("gh named no commit for the merge"),
    });
  });

  it("refuses a merged PR whose merge commit this repository has never seen, without fetching", async () => {
    setPr(85, "MERGED", { commit: "f".repeat(40) });
    const before = repoFingerprint();
    const verdict = await verify("shipped in PR #85", [bead(TARGET)]);
    expect(verdict).toMatchObject({
      state: "unverified",
      why: expect.stringContaining("is one this repository has never seen"),
    });
    expect(repoFingerprint()).toBe(before);
  });

  it("refuses one bad check even when the rest of the claim holds, keeping the passed checks", async () => {
    setPr(85, "MERGED");
    const verdict = await verify(
      `Already implemented by ${SHIPPER} (commit ${unmerged.slice(0, 8)}, PR #85)`,
      [bead(TARGET), bead(SHIPPER, { status: "closed" })],
    );

    expect(verdict.state).toBe("unverified");
    expect(verdict.proof).toEqual([]);
    expect(verdict).toMatchObject({ why: expect.stringContaining("does not contain it") });
  });

  it("refuses a claim that names nothing checkable, and one that names only the ticket itself", async () => {
    const nothing = await verify("this was already implemented some time ago", [bead(TARGET)]);
    expect(nothing.state).toBe("unverified");
    expect(nothing).toMatchObject({ why: expect.stringContaining("names no commit, bead or PR") });

    const itself = await verify(`${TARGET} is already implemented`, [bead(TARGET)]);
    expect(itself.state).toBe("unverified");
    expect(itself).toMatchObject({ why: expect.stringContaining("names no commit, bead or PR") });

    const silent = await verify(undefined, [bead(TARGET)]);
    expect(silent).toMatchObject({ why: expect.stringContaining("named nothing that shipped it") });
  });

  it("reads hyphenated prose as prose, not as a bead id that missed", async () => {
    const verdict = await verify(`the zero-diff gate already covers this — see ${SHIPPER}`, [
      bead(TARGET),
      bead(SHIPPER, { status: "closed" }),
    ]);

    expect(verdict).toMatchObject({ state: "verified", landed: { [SHIPPER]: { via: "commit", sha: landed } } });
  });

  it("reads the board itself when the caller hands it none", async () => {
    loadAllIssuesMock.mockResolvedValue([bead(TARGET), bead(SHIPPER, { status: "closed" })]);

    const verdict = await verifyShippedClaim({
      repoPath: repo,
      base: "main",
      targetId: TARGET,
      reason: `already done by ${SHIPPER}`,
    });

    expect(verdict.state).toBe("verified");
    expect(loadAllIssuesMock).toHaveBeenCalledWith(repo, { strictGates: true });
  });

  it("writes nothing — to bd or to git — whichever way the check goes", async () => {
    setPr(85, "MERGED");
    const before = repoFingerprint();
    const board = [bead(TARGET), bead(SHIPPER, { status: "closed" })];

    const verified = await verify(
      `Already implemented by ${SHIPPER} (commit ${landed.slice(0, 7)}, PR #85)`,
      board,
    );
    const refused = await verify(`shipped in ${unmerged.slice(0, 8)}`, board);

    expect(verified.state).toBe("verified");
    expect(refused.state).toBe("unverified");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
    expect(repoFingerprint()).toBe(before);
  });
});

describe("what a claim NAMES", () => {
  it("reads commit shas standing alone, never one buried in a longer token", () => {
    expect(claimedCommits("commit 9c51510 and 0123456789ABCDEF0")).toEqual([
      "9c51510",
      "0123456789abcdef0",
    ]);
    // A bead id's suffix, a hyphenated identifier, and a run of hex too short to be a sha.
    expect(claimedCommits("anton-deadbee shipped abc-1234567 in 9c515")).toEqual([]);
  });

  // A url's owner or repository can be seven hex letters wide (PR #238 review), and read as a commit
  // it fails a claim the repository would otherwise verify. Only the sha under `/commit/` is one.
  it("reads no sha out of a url's segments, but does read the one a commit url names", () => {
    expect(claimedCommits("see https://github.com/abcdefg/widgets/pull/85 and 9c51510")).toEqual([
      "9c51510",
    ]);
    expect(
      claimedCommits(
        "https://github.com/abcdefg/r/commit/0123456789ABCDEF0, then https://github.com/o/r/pull/85/commits/9c51510a",
      ),
    ).toEqual(["0123456789abcdef0", "9c51510a"]);
    expect(claimedCommits("https://abcdefg.example/deadbeef/x")).toEqual([]);
  });

  // A url swallowing the citation glued to it by punctuation (PR #238 review) hides that citation
  // from the check, and the claim verifies on the half that was read.
  it("reads every citation separated from a url by punctuation alone", () => {
    expect(claimedCommits("https://github.com/o/r/commit/aaaaaaa,bbbbbbb")).toEqual([
      "aaaaaaa",
      "bbbbbbb",
    ]);
    expect(
      claimedCommits(
        "[a](https://github.com/o/r/commit/aaaaaaa)[b](https://github.com/o/r/commit/bbbbbbb)",
      ),
    ).toEqual(["aaaaaaa", "bbbbbbb"]);
    expect(claimedCommits("https://github.com/o/r/commit/aaaaaaa;https://github.com/o/r/pull/9/commits/bbbbbbb.")).toEqual([
      "aaaaaaa",
      "bbbbbbb",
    ]);
    // The url's own segments stay unread once the token is cut short of its neighbour.
    expect(claimedCommits("(https://github.com/abcdefg/r/pull/85),9c51510")).toEqual(["9c51510"]);
    expect(
      claimedPullRequests(
        "[a](https://github.com/o/r/pull/85)[b](https://github.com/o/r/pull/86),#12",
      ),
    ).toEqual(["https://github.com/o/r/pull/85", "https://github.com/o/r/pull/86", "gh-12"]);
  });

  // A url keeps its repository (PR #238 review): reduced to `gh-85`, another repository's PR would
  // be read as whatever this one holds under that number.
  it("reads a bare number as the `gh-<n>` ref and keeps a url whole, deduped", () => {
    expect(
      claimedPullRequests("PR #85, also https://github.com/o/r/pull/85 (#85 again) and #12"),
    ).toEqual(["gh-85", "https://github.com/o/r/pull/85", "gh-12"]);
    expect(claimedPullRequests("see https://github.com/o/r/pull/85/files and https://github.com/o/r/pull/85#issuecomment-1")).toEqual([
      "https://github.com/o/r/pull/85",
    ]);
    expect(claimedPullRequests(undefined)).toEqual([]);
  });
});

/**
 * The RETIREMENT (anton-5bpd) — what anton does with the check's answer, and everything it refuses
 * to do with anything less than a verified one.
 *
 * A bead-only claim throughout: it exercises every gate without a repository, because what these
 * assert is the DECISION, and the git half of the evidence has its own suite above.
 */
suite("repairAlreadyShipped — the retirement (real git · seeded board · fake gh)", () => {
  let sb: Sandbox;
  let repo: string;
  let setPr: Sandbox["setPr"];
  const NOW = 1_700_000_000_000;
  /** The claim the epic's own motivating example makes, minus the parts that need a repository. */
  const CLAIM = `Already implemented by ${SHIPPER}`;
  /** The survivor closed, with `main` carrying the commit that names it (the sandbox's `landed`). */
  const board = (over: Partial<Bead> = {}) => [
    bead(TARGET, { status: "in_progress" }),
    bead(SHIPPER, { status: "closed", ...over }),
  ];

  const retire = (args: Partial<Parameters<typeof repairAlreadyShipped>[0]> = {}) =>
    repairAlreadyShipped({
      repoPath: repo,
      base: "main",
      bead: bead(TARGET, { status: "in_progress" }),
      block: { reason: CLAIM },
      committed: false,
      now: NOW,
      autonomy: "apply",
      board: board(),
      ...args,
    });

  beforeEach(() => {
    sb = openSandbox();
    ({ repo, setPr } = sb);
    for (const write of bdWrites) write.mockClear();
    boardShow.mockReset();
    // The under-lock re-read finds both ends exactly as the snapshot did.
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" }),
    );
    // `bd show` as the module sees it: the board's answer, with this repair's own supersede layered
    // over it once written — the post-write fence reads the ticket closed against its survivor.
    showMock.mockReset();
    showMock.mockImplementation(async (cwd, id) => {
      const read = await boardShow(cwd, id);
      const written = supersedeMock.mock.calls.find(([, target]) => target === id);
      const base = written ? superseded(read, written[2]) : read;
      // The `not-delivered` marker is a separate `bd label` write; the post-marker reread must find
      // it on the board, or the marker fence (`markerOvertaken`) would read every retirement as
      // stripped. Cleared again when a withdraw untags it.
      const tagged = tagMock.mock.calls.some(([, id2, labels]) => id2 === id && labels.includes(LABELS.notDelivered));
      const cleared = untagMock.mock.calls.some(([, id2, labels]) => id2 === id && labels.includes(LABELS.notDelivered));
      return tagged && !cleared ? ({ ...base, labels: [...(base.labels ?? []), LABELS.notDelivered] } as Bead) : base;
    });
    loadAllIssuesMock.mockClear();
    loadAllIssuesMock.mockResolvedValue(board());
    historyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => sb.cleanup());

  /** A reopen an hour from now — after every commit the sandbox makes — and the close that followed it. */
  const REOPENED_AT = new Date(Date.now() + 3_600_000).toISOString();
  const RECLOSED_AT = new Date(Date.now() + 7_200_000).toISOString();
  /** `bd history` of a survivor shipped once, reopened for rework, and closed again. */
  const REWORKED = [
    { at: RECLOSED_AT, status: "closed" },
    { at: REOPENED_AT, status: "in_progress" },
    { at: "2020-01-01T00:00:00Z", status: "closed" },
  ];

  const commitProof = () =>
    `\`${SHIPPER}\` is closed on the board, and commit \`${sb.landed.slice(0, 10)}\` in the ` +
    `history of the run's base (main) names it`;

  /** When the tag write carrying `labels` fired — the marker and the stamp are two `bd label` calls. */
  const tagOrder = (matches: (label: string) => boolean) =>
    tagMock.mock.invocationCallOrder[tagMock.mock.calls.findIndex(([, , labels]) => labels.some(matches))]!;
  const markerOrder = () => tagOrder((l) => l === LABELS.notDelivered);
  const stampOrder = () => tagOrder((l) => l.startsWith("repair:"));

  it("retires the ticket as superseded, with the evidence on the bead and the stamp beside it", async () => {
    const outcome = await retire();

    expect(outcome).toMatchObject({
      action: "retired",
      replacementId: SHIPPER,
      label: repairLabel(TARGET, "already-shipped", NOW),
      proof: [commitProof()],
    });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);

    // The EVIDENCE note (the acceptance's "with the evidence in a note"), and it is ONE line — the
    // notes blob is line-delimited, so a multi-line note would parse back unattributed.
    const evidence = noteMock.mock.calls.map((c) => c[2]).find((t) => t.includes("verified"))!;
    expect(evidence).toContain(SHIPPER);
    expect(evidence).toContain("acceptance criteria");
    expect(evidence.split("\n")).toHaveLength(1);

    // The STAMP, so a repeat escalates rather than repairing again (R5.6).
    expect(tagMock).toHaveBeenCalledWith(repo, TARGET, [repairLabel(TARGET, "already-shipped", NOW)]);

    // The `not-delivered` MARKER, written as part of the settlement rather than by the caller after
    // it releases the claim (PR #238 review): merge finalization's one way to tell a retired ticket
    // reopened in review from one the run's PR carries, and it has to be on the bead before any
    // other run can snapshot it.
    expect(tagMock).toHaveBeenCalledWith(repo, TARGET, [LABELS.notDelivered]);
    expect((outcome as { marked: boolean }).marked).toBe(true);

    // Written in the order the module promises: the statement of what anton checked lands BEFORE
    // anything is settled on the strength of it, and the marker lands before the stamp — the
    // marker guards this run's merge, the stamp only the next block.
    const firstNote = Math.min(...noteMock.mock.invocationCallOrder);
    expect(firstNote).toBeLessThan(supersedeMock.mock.invocationCallOrder[0]!);
    expect(supersedeMock.mock.invocationCallOrder[0]!).toBeLessThan(markerOrder());
    expect(markerOrder()).toBeLessThan(stampOrder());
  });

  it("at `shadow` — the shipped default — works the retirement out and writes NOTHING", async () => {
    const outcome = await retire({ autonomy: "shadow" });

    expect(outcome).toMatchObject({
      action: "shadow",
      replacementId: SHIPPER,
      proof: [commitProof()],
    });
    expect((outcome as { attempted: string }).attempted).toContain(`bd supersede ${TARGET} --with ${SHIPPER}`);
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("at `propose` it escalates without resolving anything", async () => {
    const outcome = await retire({ autonomy: "propose" });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("not armed to repair");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("escalates the SECOND block on a ticket it already retired (R5.6)", async () => {
    const outcome = await retire({
      bead: bead(TARGET, { status: "in_progress", labels: [repairLabel(TARGET, "already-shipped", NOW - 60_000)] }),
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("already repaired it");
    expect((outcome as { prior?: { klass: string } }).prior?.klass).toBe("already-shipped");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("retires NOTHING when the claim does not verify — the ticket blocks as it does today", async () => {
    // The named bead is still open and points at no PR: nothing there says its work landed.
    const outcome = await retire({ board: board({ status: "open" }) });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("could NOT verify");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("nothing there says its work landed");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("retires NOTHING against a bead that is merely closed — a child committed on an unmerged branch", async () => {
    const outcome = await retire({
      block: { reason: `Already implemented by ${UNLANDED}` },
      board: [bead(TARGET, { status: "in_progress" }), bead(UNLANDED, { status: "closed" })],
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("nothing says its work LANDED");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("refuses a claim its own run's diff contradicts, before it reads anything", async () => {
    const outcome = await retire({ committed: true });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("committed changes");
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("refuses to pick a survivor: no bead named, or more than one", async () => {
    const noBead = await retire({ block: { reason: "already done, see commit 9c51510" } });
    expect(noBead).toMatchObject({ action: "escalate" });
    expect((noBead as { evidence: string[] }).evidence.join(" ")).toContain("names no bead id");

    const two = await retire({
      block: { reason: `shipped by ${SHIPPER} and anton-zzzz` },
      board: [...board(), bead("anton-zzzz", { status: "closed" })],
    });
    expect(two).toMatchObject({ action: "escalate" });
    expect((two as { evidence: string[] }).evidence.join(" ")).toContain("2 bead ids");

    // A bead id in a URL's owner/repo segment is not a survivor the claim names (PR #238 review):
    // it would otherwise retire the target against a bead the reason only mentions inside a link.
    const inUrl = await retire({
      block: { reason: `already done, see https://github.com/${SHIPPER}/widgets/pull/85` },
    });
    expect(inUrl).toMatchObject({ action: "escalate" });
    expect((inUrl as { evidence: string[] }).evidence.join(" ")).toContain("names no bead id");

    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  it("refuses to strand open work beneath the ticket it would close", async () => {
    const child = bead("anton-kid", { status: "open" });
    (child as unknown as Record<string, unknown>).parent = TARGET;
    const outcome = await retire({ board: [...board(), child] });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("strand");
    for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
  });

  // The snapshot check above cannot see a re-parent landing in the window (PR #238 review): the
  // gardener's re-parent takes the new home's lock, so the ordering is decidable — but only if the
  // subtree is re-asked INSIDE the lock, against a fresh board rather than the one the decision read.
  it("refuses under the lock when open work was attached beneath the ticket since the check", async () => {
    const child = bead("anton-kid", { status: "open" });
    (child as unknown as Record<string, unknown>).parent = TARGET;
    loadAllIssuesMock.mockResolvedValue([...board(), child]);

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("the board moved");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("attached beneath");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("anton-kid");
    expect(loadAllIssuesMock).toHaveBeenCalledWith(repo, { strictGates: true });
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  // A re-parent contends on its new HOME's lock, not on every ancestor's (apply-steps
  // `lockedBeads`), so work attached under a CLOSED descendant of the ticket never touches the
  // ticket's own lock (PR #238 review). The retirement holds the whole subtree the check read: an
  // attach either lands before this read — a newcomer it refuses, open or not — or queues behind it.
  it("refuses under the lock when a bead was attached beneath a descendant since the check", async () => {
    const closedChild = bead("anton-kid", { status: "closed" });
    (closedChild as unknown as Record<string, unknown>).parent = TARGET;
    const newcomer = bead("anton-new", { status: "closed" });
    (newcomer as unknown as Record<string, unknown>).parent = "anton-kid";
    loadAllIssuesMock.mockResolvedValue([...board(), closedChild, newcomer]);

    const outcome = await retire({ board: [...board(), closedChild] });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("the board moved");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("attached beneath");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("anton-new");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  it("holds every descendant's lock, so its locked read queues behind a write on one of them", async () => {
    const closedChild = bead("anton-kid", { status: "closed" });
    (closedChild as unknown as Record<string, unknown>).parent = TARGET;
    let readAt = 0;
    loadAllIssuesMock.mockImplementation(async () => {
      readAt = Date.now();
      return [...board(), closedChild];
    });
    let releasedAt = 0;
    const holding = withBeadWriteLock(repo, "anton-kid", async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      releasedAt = Date.now();
    });

    const outcome = await retire({ board: [...board(), closedChild] });
    await holding;

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(readAt).toBeGreaterThanOrEqual(releasedAt);
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("refuses under the lock when the board could not be re-read at all", async () => {
    loadAllIssuesMock.mockRejectedValue(new Error("dolt server went away"));

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("could not be re-read");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // Open is not enough for the TARGET either (PR #238 review): a ticket whose acceptance was
  // rewritten in the window is open exactly as before, and the supersede would close the ticket the
  // human just redefined on a claim verified about the one they replaced.
  it("refuses under the lock when the ticket's contract was rewritten since the check", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", description: "## Acceptance\n- [ ] one more thing" })
        : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("the board moved");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("rewritten since the check");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("description");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  // The board row the check ran against can omit `description` on some bd versions (issues.ts
  // `ensureDescription`); the fence compares the caller's `bd show` read with the under-lock one, so
  // a description the listing never carried is not a rewrite (PR #238 review).
  it("fences the contract on the full read, not on a board row that dropped the description", async () => {
    const contract = "## Goal\nShip the thing.\n## Acceptance\n- [ ] it ships";
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress", description: contract }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({ bead: bead(TARGET, { status: "in_progress", description: contract }) });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  // The claim is about the ticket the AGENT read (PR #238 review). The caller's `bead` is read after
  // the report, so an edit landing while the agent ran is already in it — and a fence that starts
  // there compares the rewritten ticket with itself. The dispatch snapshot is the earlier read.
  it("refuses a claim made about a ticket that was rewritten while the agent was running", async () => {
    const rewritten = "## Acceptance\n- [ ] it ships\n- [ ] AND it ships in the other app too";
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress", description: rewritten }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "## Acceptance\n- [ ] it ships" }),
      bead: bead(TARGET, { status: "in_progress", description: rewritten }),
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("rewritten while the agent was running");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("description changed while it ran");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
    // Refused on the two reads in hand — nothing was checked against git or the board.
    expect(showMock).not.toHaveBeenCalled();
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
  });

  /** A note the operator left on the ticket, as the board stores it. */
  const humanNote = (text: string) => formatHumanNote(text, "Henri", new Date("2026-09-07T10:00:00Z"));
  const MACHINE_NOTE = "anton: run failed after 1 attempt";

  // A human note is task intent the prompt hands the agent as a binding refinement (PR #238 review).
  // One appended after the prompt was built is an instruction the agent never saw, and the claim
  // was made without it — the dispatch-time read is what carries the notes the agent DID see.
  it("refuses a claim when a human note was appended after the agent was prompted", async () => {
    const steered = `${MACHINE_NOTE}\n${humanNote("also cover the other app")}`;
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress", notes: steered }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "", notes: MACHINE_NOTE }),
      bead: bead(TARGET, { status: "in_progress", notes: steered }),
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("rewritten while the agent was running");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("human notes changed while it ran");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("still retires on a note the agent already read, and on anton's own lines added since", async () => {
    const read = humanNote("keep it small");
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", notes: `${read}\n${MACHINE_NOTE}` })
        : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "", notes: read }),
      bead: bead(TARGET, { status: "in_progress", notes: `${read}\n${MACHINE_NOTE}` }),
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("refuses under the lock when a human note was appended since the check", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", notes: humanNote("wait — do the migration first") })
        : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("rewritten since the check");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("human notes");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // The dispatch read carries the description over from `bd show` when the listing dropped it
  // (steps/agent.ts `readForDispatch`), so a snapshot still without one is a dispatch whose full
  // read FAILED — the agent was prompted without the contract's body (PR #238 review). Skipping
  // the field would let a claim made blind close the ticket against the contract it never saw.
  it("refuses a claim when the dispatch snapshot never carried the description", async () => {
    const contract = "## Goal\nShip the thing.\n## Acceptance\n- [ ] it ships";
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress", description: contract }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress" }),
      bead: bead(TARGET, { status: "in_progress", description: contract }),
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("never carried its description");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
  });

  it("still retires when the dispatch read carried an empty description and the ticket has none", async () => {
    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "" }),
      bead: bead(TARGET, { status: "in_progress" }),
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  // A field the snapshot carried as ABSENT is held exactly like one it carried as text: an
  // acceptance list written onto a bare ticket while the agent ran is a contract it never read.
  it("refuses a claim when a contract field was added to the ticket while the agent was running", async () => {
    const added = bead(TARGET, { status: "in_progress", description: "", acceptance_criteria: "- [ ] it ships" });
    boardShow.mockImplementation(async (_cwd, id) => (id === TARGET ? added : bead(SHIPPER, { status: "closed" })));

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "" }),
      bead: added,
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("acceptance_criteria changed while it ran");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // The fences under the lock compare the write's read with the CHECK's, and both are read after
  // the report — so a re-parent landing while the agent ran is the baseline they start from, and
  // the supersede would close the ticket inside the run it rode into (PR #238 review). The dispatch
  // snapshot is the one read from before the move.
  it("refuses a claim when the ticket was re-homed while the agent was running", async () => {
    const OTHER = "anton-othr";
    const feature = (id: string) => bead(id, { issue_type: "feature", status: "in_progress" });
    const moved = [
      bead(TARGET, { status: "in_progress", parent: OTHER }),
      feature(OWNER),
      feature(OTHER),
      bead(SHIPPER, { status: "closed" }),
    ];
    boardShow.mockImplementation(async (_cwd, id) => moved.find((b) => b.id === id)!);

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", parent: OWNER, description: "" }),
      bead: bead(TARGET, { status: "in_progress", parent: OTHER }),
      board: moved,
      runTargetId: OWNER,
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("re-homed while the agent was running");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`hung under \`${OWNER}\` when the agent was dispatched`);
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`hangs under \`${OTHER}\` now`);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    // Refused on the two reads in hand — nothing was checked against git or the board.
    expect(showMock).not.toHaveBeenCalled();
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
  });

  // The parent field cannot see this one: an ANCESTOR's move hands the ticket to another run target
  // with nothing written to the ticket. Only the run's own knowledge of which card it dispatched
  // for — `runTargetId` — can, against whose card the post-report board says the ticket rides.
  it("refuses a claim when an ancestor's move handed the ticket to another run target while the agent was running", async () => {
    const OTHER = "anton-othr";
    const CARRIER = "anton-carr";
    const feature = (id: string) => bead(id, { issue_type: "feature", status: "in_progress" });
    const viaCarrier = (home: string) => [
      bead(TARGET, { status: "in_progress", parent: CARRIER }),
      bead(CARRIER, { status: "in_progress", parent: home }),
      feature(OWNER),
      feature(OTHER),
      bead(SHIPPER, { status: "closed" }),
    ];
    boardShow.mockImplementation(async (_cwd, id) => viaCarrier(OTHER).find((b) => b.id === id)!);

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", parent: CARRIER, description: "" }),
      bead: bead(TARGET, { status: "in_progress", parent: CARRIER }),
      board: viaCarrier(OTHER),
      runTargetId: OWNER,
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("re-homed while the agent was running");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`no longer rides \`${OWNER}\`, the run target it was dispatched under`);
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`rides \`${OTHER}\` now`);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("still retires a ticket that hangs where it was dispatched, parent and run target alike", async () => {
    const CARRIER = "anton-carr";
    const viaCarrier = [
      bead(TARGET, { status: "in_progress", parent: CARRIER }),
      bead(CARRIER, { status: "in_progress", parent: OWNER }),
      bead(OWNER, { issue_type: "feature", status: "in_progress" }),
      bead(SHIPPER, { status: "closed" }),
    ];
    loadAllIssuesMock.mockResolvedValue(viaCarrier);
    boardShow.mockImplementation(async (_cwd, id) => viaCarrier.find((b) => b.id === id)!);

    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", parent: CARRIER, description: "" }),
      bead: bead(TARGET, { status: "in_progress", parent: CARRIER }),
      board: viaCarrier,
      runTargetId: OWNER,
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("still retires a standalone ticket that is its own run target", async () => {
    const outcome = await retire({
      dispatched: bead(TARGET, { status: "in_progress", description: "" }),
      runTargetId: TARGET,
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  // anton claimed the ticket in_progress before the run; an operator returning it to open, blocking,
  // or deferring it while the agent ran is a globally visible decision the supersede would stomp. The
  // change is already in `bead`, so the under-lock lifecycle fence starts from it and sees nothing,
  // and `isOpenWork` passes open/blocked/deferred alike — only the dispatch-time claim predates it.
  it("refuses a claim when an operator moved the ticket's lifecycle off in_progress while the agent was running", async () => {
    for (const status of ["open", "blocked", "deferred"]) {
      supersedeMock.mockClear();
      const outcome = await retire({ bead: bead(TARGET, { status }) });

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("lifecycle or claim changed while the agent");
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `is ${status} now, not in_progress as anton claimed it`,
      );
      expect(supersedeMock).not.toHaveBeenCalled();
      // Refused on the read in hand — nothing was resolved against git or the board.
      expect(showMock).not.toHaveBeenCalled();
      expect(loadAllIssuesMock).not.toHaveBeenCalled();
    }
  });

  // A reassignment leaves the ticket in_progress under another name, which no lifecycle field on the
  // bead can tell from anton's own claim — only the run's operator can. Its status half stands; the
  // claim half is asked against `operator`.
  it("refuses a claim when the ticket was reassigned away from the run's operator while the agent was running", async () => {
    const outcome = await retire({
      bead: bead(TARGET, { status: "in_progress", assignee: "someone-else" }),
      operator: "anton@runner",
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("lifecycle or claim changed while the agent");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
      "claimed by `someone-else` now, not held for `anton@runner`",
    );
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("still retires a ticket the run's operator still holds in_progress", async () => {
    // The under-lock reread carries the same claim, so the lifecycle fence there passes too.
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", assignee: "anton@runner" })
        : bead(SHIPPER, { status: "closed" }),
    );
    const outcome = await retire({
      bead: bead(TARGET, { status: "in_progress", assignee: "anton@runner" }),
      operator: "anton@runner",
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("still retires when the run resolved no operator — the status half stands, the claim half is not asked", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", assignee: "someone-else" })
        : bead(SHIPPER, { status: "closed" }),
    );
    const outcome = await retire({
      bead: bead(TARGET, { status: "in_progress", assignee: "someone-else" }),
    });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("still retires when the window only stamped the ticket — a label or a timestamp is not a rewrite", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", labels: ["gardener:seen"], updated_at: "2026-09-07T00:00:00Z" })
        : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  // A re-parent of the TICKET itself finishes before these locks are held, and leaves it open with
  // its contract intact — so status and contract rereads both pass it (PR #238 review). The
  // supersede would then close it inside the feature it now rides, while this run records it as
  // retired from its own ticket set. Its home is compared with the snapshot's before the write.
  it("refuses under the lock when the ticket itself was re-homed since the check", async () => {
    const OTHER = "anton-othr";
    const feature = (id: string) => bead(id, { issue_type: "feature", status: "in_progress" });
    const snapshot = [
      bead(TARGET, { status: "in_progress", parent: OWNER }),
      feature(OWNER),
      feature(OTHER),
      bead(SHIPPER, { status: "closed" }),
    ];
    const moved = snapshot.map((b) =>
      b.id === TARGET ? bead(TARGET, { status: "in_progress", parent: OTHER }) : b,
    );
    loadAllIssuesMock.mockResolvedValue(moved);
    boardShow.mockImplementation(async (_cwd, id) => moved.find((b) => b.id === id)!);

    const outcome = await retire({ board: snapshot });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { why: string }).why).toContain("the board moved");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("was re-homed since the check");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`hung under \`${OWNER}\``);
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`hangs under \`${OTHER}\` now`);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  // The parent field alone cannot see this one: a `feature → task → subtask` subtask changes run
  // targets when the TASK is re-homed, and nothing writes the subtask (board-index `ticketPathOf`).
  it("refuses under the lock when an ancestor's move handed the ticket to another run target", async () => {
    const OTHER = "anton-othr";
    const CARRIER = "anton-carr";
    const feature = (id: string) => bead(id, { issue_type: "feature", status: "in_progress" });
    const viaCarrier = (home: string) => [
      bead(TARGET, { status: "in_progress", parent: CARRIER }),
      bead(CARRIER, { status: "in_progress", parent: home }),
      feature(OWNER),
      feature(OTHER),
      bead(SHIPPER, { status: "closed" }),
    ];
    loadAllIssuesMock.mockResolvedValue(viaCarrier(OTHER));
    boardShow.mockImplementation(async (_cwd, id) => viaCarrier(OTHER).find((b) => b.id === id)!);

    const outcome = await retire({ board: viaCarrier(OWNER) });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`no longer rides \`${OWNER}\``);
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`rides \`${OTHER}\` now`);
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // The reread above only ORDERS against a move that holds a lock this retirement also holds. A
  // re-parent takes the moved bead's lock and its new home's, and moving an ancestor carries the
  // ticket with nothing written to it — so the ticket's own lock orders nothing against it. Every
  // ancestor through the run target is held too (PR #238 review), and this is that hold in action.
  it("holds the ancestors' locks through the run target, so its locked read queues behind a move of one", async () => {
    const CARRIER = "anton-carr";
    const viaCarrier = [
      bead(TARGET, { status: "in_progress", parent: CARRIER }),
      bead(CARRIER, { status: "in_progress", parent: OWNER }),
      bead(OWNER, { issue_type: "feature", status: "in_progress" }),
      bead(SHIPPER, { status: "closed" }),
    ];
    let readAt = 0;
    loadAllIssuesMock.mockImplementation(async () => {
      readAt = Date.now();
      return viaCarrier;
    });
    boardShow.mockImplementation(async (_cwd, id) => viaCarrier.find((b) => b.id === id)!);
    const releasedAt: Record<string, number> = {};
    const holding = Promise.all(
      [CARRIER, OWNER].map((id) =>
        withBeadWriteLock(repo, id, async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          releasedAt[id] = Date.now();
        }),
      ),
    );

    const outcome = await retire({ board: viaCarrier });
    await holding;

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(readAt).toBeGreaterThanOrEqual(releasedAt[CARRIER]!);
    expect(readAt).toBeGreaterThanOrEqual(releasedAt[OWNER]!);
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("still retires a ticket that hangs where the check found it, parent and run target alike", async () => {
    const snapshot = [
      bead(TARGET, { status: "in_progress", parent: OWNER }),
      bead(OWNER, { issue_type: "feature", status: "in_progress" }),
      bead(SHIPPER, { status: "closed" }),
    ];
    loadAllIssuesMock.mockResolvedValue(snapshot);
    boardShow.mockImplementation(async (_cwd, id) => snapshot.find((b) => b.id === id)!);

    const outcome = await retire({ board: snapshot });

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
  });

  it("writes nothing when either end moved between the check and the write", async () => {
    // Somebody else settled the ticket in the window — anton does not rewrite that outcome.
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "closed" }) : bead(SHIPPER, { status: "closed" }),
    );
    const settled = await retire();
    expect(settled).toMatchObject({ action: "escalate" });
    expect((settled as { evidence: string[] }).evidence.join(" ")).toContain("already settled");

    // …and the survivor reopened: the commit naming it spoke for a closed ticket, and by the
    // human's own hand it is work in progress again.
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "open" }),
    );
    const reopened = await retire();
    expect(reopened).toMatchObject({ action: "escalate" });
    expect((reopened as { evidence: string[] }).evidence.join(" ")).toContain("open again");

    // …and the survivor ABANDONED in the window: it is closed, so a status check alone reads it as
    // landed, but a recorded won't-do delivered nothing to be superseded by.
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress" })
        : bead(SHIPPER, { status: "closed", labels: ["abandoned"] }),
    );
    const killed = await retire();
    expect(killed).toMatchObject({ action: "escalate" });
    expect((killed as { evidence: string[] }).evidence.join(" ")).toContain("has been abandoned");

    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  // isOpenWork passes every non-closed, non-abandoned status, and a reclaim/park touches no field
  // the contract or home fences read — so the lifecycle and claim are compared to the check's own
  // read (PR #238 review). The supersede would otherwise close work the board just took back.
  it("refuses when an operator returned the ticket to open in the window", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "open" }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("its lifecycle moved while anton ran");
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  it("refuses when an operator parked the ticket (blocked/deferred) in the window", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "blocked" }) : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("reclaimed or parked this ticket");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it("refuses when the ticket's assignee changed in the window", async () => {
    boardShow.mockImplementation(async (_cwd, id) =>
      id === TARGET
        ? bead(TARGET, { status: "in_progress", assignee: "other-box" })
        : bead(SHIPPER, { status: "closed" }),
    );

    const outcome = await retire({ bead: bead(TARGET, { status: "in_progress", assignee: "anton-box" }) });

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("its claim changed while anton ran");
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("claimed by `other-box`");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // A survivor verified through a commit NAMING it is re-verified against the base's history at the
  // write (PR #238 review). The base is a movable ref: another run force-fetching `origin/main`
  // while this repair waits on its locks can drop the naming commit from it, and "still closed"
  // says nothing about that — the evidence has to be re-asked of the base, not of the board.
  describe("a survivor verified through a commit naming it in the base", () => {
    it("refuses when the base no longer contains the naming commit at the write", async () => {
      const before = execFileSync("git", ["-C", repo, "rev-parse", `${sb.landed}^`], { encoding: "utf8" }).trim();
      boardShow.mockImplementation(async (_cwd, id) => {
        // Lands during the under-lock re-read: `main` rewound past the commit the check found.
        if (id === SHIPPER) execFileSync("git", ["-C", repo, "update-ref", "refs/heads/main", before]);
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
      });

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("the board moved");
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `commit \`${sb.landed.slice(0, 10)}\` is no longer in the history of the run's base (main)`,
      );
      expect(supersedeMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    // Reopened AND closed again before the locks were taken: closed on the reread, its naming commit
    // still in the base, and a status reread would call that held (PR #238 review). The close the
    // board holds now is a later cycle's, and the check's own cycle question is re-asked of it.
    it("refuses when the survivor was reopened and closed again since the check", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress" })
          : bead(SHIPPER, { status: "closed", closed_at: RECLOSED_AT }),
      );
      // The check read the board's row (no reopen yet); the fence's reread finds the rework.
      historyMock.mockImplementation(async () => (boardShow.mock.calls.length > 0 ? REWORKED : []));

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("the board moved");
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `\`${SHIPPER}\` is not closed on the evidence anton verified`,
      );
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`the board reopened \`${SHIPPER}\` at ${REOPENED_AT}`);
      expect(historyMock).toHaveBeenCalledWith(repo, SHIPPER);
      expect(supersedeMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("refuses when whether the naming commit still reaches the base cannot be read at the write", async () => {
      boardShow.mockImplementation(async (_cwd, id) => {
        // The base ref itself gone in the window — git cannot answer, and no answer is a refusal.
        if (id === SHIPPER) {
          execFileSync("git", ["-C", repo, "checkout", "-q", "--detach"]);
          execFileSync("git", ["-C", repo, "update-ref", "-d", "refs/heads/main"]);
        }
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
      });

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `whether commit \`${sb.landed.slice(0, 10)}\` still reaches the run's base (main) could not be read`,
      );
      expect(supersedeMock).not.toHaveBeenCalled();
    });
  });

  // The claim verified as a WHOLE, and it is re-asked as a whole (PR #238 review): a commit or PR
  // cited BESIDE the survivor is evidence the check would fail without, so a base that dropped it
  // in the window takes the verification back exactly as it would the survivor's own landing.
  describe("commits and PRs cited beside the survivor", () => {
    let extra: string;
    const g = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const survivorStillClosed = async (_cwd: string, id: string) =>
      id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });

    beforeEach(() => {
      // A second commit on `main`, after the one naming the survivor: cited by the claim, and the
      // one a rewind can drop while the survivor's naming commit stays in the base.
      g(["commit", "-q", "--allow-empty", "-m", "unrelated follow-up"]);
      extra = g(["rev-parse", "HEAD"]);
      setPr(85, "MERGED");
    });

    const retireCiting = () =>
      retire({ block: { reason: `Already implemented by ${SHIPPER} (commit ${extra.slice(0, 7)}, PR #85)` } });

    it("retires while every cited commit and PR still lands in the base", async () => {
      boardShow.mockImplementation(survivorStillClosed);

      const outcome = await retireCiting();

      expect(outcome).toMatchObject({
        action: "retired",
        replacementId: SHIPPER,
        proof: [
          `commit \`${extra.slice(0, 10)}\` is in the history of the run's base (main)`,
          commitProof(),
          `PR gh-85 is merged${mergedTail(sb.landed)}`,
        ],
      });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
    });

    it("refuses when the base no longer contains a cited commit at the write, though the survivor's still lands", async () => {
      boardShow.mockImplementation(async (cwd, id) => {
        // `main` rewound to the naming commit: the survivor's evidence holds, the cited commit's does not.
        if (id === SHIPPER) g(["update-ref", "refs/heads/main", sb.landed]);
        return survivorStillClosed(cwd, id);
      });

      const outcome = await retireCiting();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("the board moved");
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `commit \`${extra.slice(0, 10)}\` is no longer in the history of the run's base (main)`,
      );
      expect(supersedeMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("refuses when a cited PR's merge is no longer in the base at the write", async () => {
      boardShow.mockImplementation(async (cwd, id) => {
        if (id === SHIPPER) setPr(85, "MERGED", { commit: sb.unmerged, base: "develop" });
        return survivorStillClosed(cwd, id);
      });

      const outcome = await retireCiting();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        "the cited PR gh-85 is merged elsewhere than the run's base (main) — into `develop`",
      );
      expect(supersedeMock).not.toHaveBeenCalled();
    });
  });

  // A survivor verified through its PR is re-verified through THAT PR (PR #238 review). "Has some
  // PR" is what the window can fake: the pointer swapped for an open PR, or the bead reopened with an
  // unmerged one attached, and a status-and-pointer reread accepts both.
  describe("a survivor verified through its merged pull request", () => {
    const viaPr = () => [
      bead(TARGET, { status: "in_progress" }),
      bead(UNLANDED, { status: "in_progress", metadata: { pr: "gh-85" } }),
    ];
    const retireViaPr = () =>
      retire({ block: { reason: `Already implemented by ${UNLANDED}` }, board: viaPr() });

    beforeEach(() => {
      setPr(85, "MERGED");
      loadAllIssuesMock.mockResolvedValue(viaPr());
    });

    it("retires against it while it is still the same PR and still merged", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!,
      );

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({
        action: "retired",
        replacementId: UNLANDED,
        proof: [`\`${UNLANDED}\` is in_progress, but its PR (gh-85) is merged${mergedTail(sb.landed)}`],
      });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
    });

    // The pointer kept and the PR still merged is what a reopen for rework looks like (PR #238
    // review): the same bead holding the same merged PR, and nothing but its history saying the
    // work it holds now is not what that merge shipped. The fence never asks an open survivor's
    // status, so the cycle question has to be asked of it whatever it reads as.
    it("refuses when it was reopened after its merge in the window — same PR, still merged", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!,
      );
      historyMock.mockImplementation(async () =>
        boardShow.mock.calls.length > 0
          ? [
              { at: REOPENED_AT, status: "in_progress" },
              { at: "2020-01-01T00:00:00Z", status: "closed" },
            ]
          : [],
      );

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        `\`${UNLANDED}\` is not in_progress on the evidence anton verified`,
      );
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("is an earlier cycle's");
      expect(historyMock).toHaveBeenCalledWith(repo, UNLANDED);
      expect(supersedeMock).not.toHaveBeenCalled();
    });

    it("refuses when its PR pointer was swapped in the window, whatever the new PR says", async () => {
      setPr(90, "MERGED");
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress" })
          : bead(UNLANDED, { status: "in_progress", metadata: { pr: "gh-90" } }),
      );

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        "no longer points at the PR anton verified (gh-85)",
      );
      expect(supersedeMock).not.toHaveBeenCalled();
    });

    it("refuses when the PR it verified is no longer merged at the write", async () => {
      boardShow.mockImplementation(async (_cwd, id) => {
        // Reread INSIDE the lock, after the check read it as merged.
        if (id === UNLANDED) setPr(85, "OPEN");
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!;
      });

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("reads as open now, not merged");
      expect(supersedeMock).not.toHaveBeenCalled();
    });

    it("refuses when the base no longer contains the PR's merge at the write — still merged is not enough", async () => {
      boardShow.mockImplementation(async (_cwd, id) => {
        if (id === UNLANDED) setPr(85, "MERGED", { commit: sb.unmerged, base: "develop" });
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!;
      });

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(
        "is merged elsewhere than the run's base (main) — into `develop`",
      );
      expect(supersedeMock).not.toHaveBeenCalled();
    });
  });

  // The settlement path reads the job's abort ONCE before handing the ticket here, and this repair
  // then reads git, asks GitHub and waits on locks (PR #238 review). A kill landing in that window
  // must not become a closed ticket: the live signal is re-read inside the locks, immediately
  // before the first write, and a cancellation there writes nothing at all.
  describe("the job's live abort signal", () => {
    it("writes nothing when the job was cancelled while it was checking, and says so", async () => {
      const controller = new AbortController();
      boardShow.mockImplementation(async (_cwd, id) => {
        // Lands during the under-lock re-read — after every check has passed, before any write.
        controller.abort();
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
      });

      const outcome = await retire({ signal: controller.signal });

      expect(outcome).toMatchObject({ action: "cancelled" });
      expect((outcome as { why: string }).why).toContain("the job was cancelled");
      expect((outcome as { why: string }).why).toContain(`bd supersede ${TARGET} --with ${SHIPPER}`);
      for (const write of bdWrites) expect(write).not.toHaveBeenCalled();
    });

    it("retires as usual under a signal that never fires", async () => {
      const outcome = await retire({ signal: new AbortController().signal });

      expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
    });
  });

  // A survivor verified through the PR of the run target it RIDES is re-verified as still riding it
  // (PR #238 review). A re-parent takes the survivor's lock, so it serializes against this write —
  // but serialized is not refused: re-homed under another card, or detached, the survivor's work is
  // no longer what the verified PR carried, and rereading that PR by id would re-verify evidence
  // that stopped being about the survivor.
  describe("a survivor verified through the merged pull request of the run target it rides", () => {
    const OTHER = "anton-othr";
    const feature = (id: string, pr: string) =>
      bead(id, { issue_type: "feature", status: "closed", metadata: { pr } });
    /** `null` detaches the survivor — an explicit `undefined` would only re-apply the default. */
    const viaOwner = (parent: string | null = OWNER) => [
      bead(TARGET, { status: "in_progress" }),
      feature(OWNER, "gh-85"),
      feature(OTHER, "gh-90"),
      bead(UNLANDED, { status: "closed", ...(parent ? { parent } : {}) }),
    ];
    const retireViaOwner = () =>
      retire({ block: { reason: `Already implemented by ${UNLANDED}` }, board: viaOwner() });

    beforeEach(() => {
      setPr(85, "MERGED", { carries: [`${UNLANDED}: the survivor's commit`] });
      setPr(90, "MERGED", { carries: [`${UNLANDED}: the survivor's commit`] });
      loadAllIssuesMock.mockResolvedValue(viaOwner());
      boardShow.mockImplementation(async (_cwd, id) => viaOwner().find((b) => b.id === id)!);
    });

    it("retires against it while it still rides that run target and the PR is still merged", async () => {
      const outcome = await retireViaOwner();

      expect(outcome).toMatchObject({
        action: "retired",
        replacementId: UNLANDED,
        proof: [
          `\`${UNLANDED}\` is closed on the board and the PR of \`${OWNER}\`, the run target it ` +
            `rides, (gh-85) is merged${mergedTail(sb.landed)}, and GitHub records commit ` +
            `\`${carriedOid(0).slice(0, 10)}\` in that PR naming it`,
        ],
      });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
    });

    // The PR-ref writers (pr-link.ts, the run's `pr` step) take the holder's lock, so the owner's
    // pointer is what this lock set has to cover: outside it, a swap could land between the reread
    // and the supersede with nothing to order the two (PR #238 review).
    it("holds the run target's lock too, so its locked read queues behind a PR-ref write on it", async () => {
      let readAt = 0;
      loadAllIssuesMock.mockImplementation(async () => {
        readAt = Date.now();
        return viaOwner();
      });
      let releasedAt = 0;
      const holding = withBeadWriteLock(repo, OWNER, async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        releasedAt = Date.now();
      });

      const outcome = await retireViaOwner();
      await holding;

      expect(outcome).toMatchObject({ action: "retired", replacementId: UNLANDED });
      expect(readAt).toBeGreaterThanOrEqual(releasedAt);
    });

    it("refuses when it was re-homed under another run target in the window, whatever that one's PR says", async () => {
      loadAllIssuesMock.mockResolvedValue(viaOwner(OTHER));

      const outcome = await retireViaOwner();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("the board moved");
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`no longer rides \`${OWNER}\``);
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`rides \`${OTHER}\` now`);
      expect(supersedeMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("refuses when it was detached from its run target in the window", async () => {
      loadAllIssuesMock.mockResolvedValue(viaOwner(null));

      const outcome = await retireViaOwner();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain(`no longer rides \`${OWNER}\``);
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("rides no run target now");
      expect(supersedeMock).not.toHaveBeenCalled();
    });
  });

  // The locks order only THIS process's writers (beads/claim-lock.ts). On a shared-server board
  // another anton, or a teammate's `bd` from a shell, can move either end between the locked reread
  // and the supersede, and nothing orders the two (PR #238 review). The write's own post-write read
  // is the one read that can have seen them, so the retirement is held to the check's bar once more
  // against it — and taken back when it fails, but only while the close is still anton's own.
  describe("the fence after the write — a writer in another process", () => {
    /** Has this repair's supersede been written yet? What a cross-process write in the window keys on. */
    const written = () => supersedeMock.mock.calls.length > 0;
    const evidenceOf = (outcome: unknown) => (outcome as { evidence: string[] }).evidence.join(" ");

    it("re-reads both ends and the board after the supersede, then the ticket once more after the marker, before stamping", async () => {
      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
      const wrote = supersedeMock.mock.invocationCallOrder[0]!;
      const readsIn = (lo: number, hi: number) =>
        showMock.mock.calls
          .filter((_c, i) => showMock.mock.invocationCallOrder[i]! > lo && showMock.mock.invocationCallOrder[i]! < hi)
          .map((c) => c[1]);
      // The post-write fence reads both ends and the board, and holds the marker until it has.
      const beforeMarker = readsIn(wrote, markerOrder());
      expect(beforeMarker.length).toBeGreaterThanOrEqual(2);
      expect(beforeMarker).toEqual(expect.arrayContaining([TARGET, SHIPPER]));
      expect(loadAllIssuesMock).toHaveBeenCalledTimes(2);
      // The marker-and-ownership reread the marker's own window needs (PR #238 review): the ticket is
      // read once more with the marker on the board, before the stamp, to catch a reopen that raced it.
      const afterMarker = readsIn(markerOrder(), stampOrder());
      expect(afterMarker).toContain(TARGET);
      for (const write of [reopenMock, unlinkMock, untagMock]) expect(write).not.toHaveBeenCalled();
    });

    // The window the marker opens on its own (PR #238 review): the pre-write fence held, the supersede
    // and the marker both landed, and only THEN did another process reopen and reclaim the ticket. The
    // marker now sits on live work a later merge would carry as undelivered, so the ticket is read once
    // more with the marker on the board — reopened, the marker is cleared and the retirement taken back.
    it("clears the marker and takes the retirement back when the ticket was reopened after the marker landed", async () => {
      const markerLanded = () => tagMock.mock.calls.some(([, , labels]) => labels.includes(LABELS.notDelivered));
      showMock.mockImplementation(async (cwd, id) => {
        // Open and reclaimed the instant the marker lands — the pre-write reread saw it superseded.
        if (id === TARGET && markerLanded()) return bead(TARGET, { status: "in_progress", assignee: "other-box" });
        const read = await boardShow(cwd, id);
        const wrote = supersedeMock.mock.calls.find(([, target]) => target === id);
        return wrote ? superseded(read, wrote[2]) : read;
      });

      const outcome = await retire();

      // `overtaken`, not `escalate` (PR #238 review): the caller must not release the claim the new
      // hand holds — an `escalate` would flow into `releaseFailedTicket` and block-and-unassign it.
      expect(outcome).toMatchObject({ action: "overtaken" });
      expect((outcome as { why: string }).why).toContain("between the retirement and its `not-delivered` marker");
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(tagMock).toHaveBeenCalledWith(repo, TARGET, [LABELS.notDelivered]);
      // The marker is cleared off the live ticket, and the retirement is left to whoever reopened it —
      // anton does not reopen it (that is somebody else's decision) and does not stamp it.
      expect(untagMock).toHaveBeenCalledWith(repo, TARGET, [LABELS.notDelivered]);
      expect(evidenceOf(outcome)).toContain("reopened or reclaimed");
      expect(evidenceOf(outcome)).toContain(`cleared the \`${LABELS.notDelivered}\` marker`);
      expect(reopenMock).not.toHaveBeenCalled();
      expect(tagMock.mock.calls.some(([, , labels]) => labels.some((l) => l.startsWith("repair:")))).toBe(false);
    });

    // The other way the marker window is overtaken (PR #238 review): the ticket stays closed as
    // anton's own supersede, but a concurrent writer STRIPS the `not-delivered` marker after it
    // landed. The retirement is valid, so nothing is reopened — but unmarked it is invisible to merge
    // finalization, which could close a reopen of it as shipped by this run's PR, so the run must stop
    // rather than open one. The supersede-only check would have read it as a whole, marked retirement.
    it("stops without stamping when the marker is stripped after it landed but the close still stands", async () => {
      const markerLanded = () => tagMock.mock.calls.some(([, , labels]) => labels.includes(LABELS.notDelivered));
      showMock.mockImplementation(async (cwd, id) => {
        const read = await boardShow(cwd, id);
        const wrote = supersedeMock.mock.calls.find(([, target]) => target === id);
        const base = wrote ? superseded(read, wrote[2]) : read;
        // Superseded by anton the whole time; the marker never sticks — the concurrent strip.
        return base;
      });

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "overtaken" });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(tagMock).toHaveBeenCalledWith(repo, TARGET, [LABELS.notDelivered]);
      expect(evidenceOf(outcome)).toContain("marker was stripped");
      // Nothing is taken back or stamped: the close is valid, it is only unmarked.
      expect(reopenMock).not.toHaveBeenCalled();
      expect(untagMock).not.toHaveBeenCalled();
      expect(markerLanded()).toBe(true);
      expect(tagMock.mock.calls.some(([, , labels]) => labels.some((l) => l.startsWith("repair:")))).toBe(false);
    });

    it("withdraws a retirement that closed a ticket rewritten in the window, and does not stamp it", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, {
              status: "in_progress",
              ...(written() ? { description: "## Acceptance\n- [ ] one more thing" } : {}),
            })
          : bead(SHIPPER, { status: "closed" }),
      );

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("moved between the check and the write");
      expect(evidenceOf(outcome)).toContain("was rewritten since the check");
      expect(evidenceOf(outcome)).toContain(`withdrew the retirement: ${TARGET} is open again`);
      expect(evidenceOf(outcome)).toContain(`bd supersede ${TARGET} --with ${SHIPPER}`);
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.stringContaining("board moved"));
      expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      // Open FIRST — that is what puts the ticket back in front of a human — then the edge.
      expect(reopenMock.mock.invocationCallOrder[0]!).toBeLessThan(unlinkMock.mock.invocationCallOrder[0]!);
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("withdraws when the ticket was re-homed in the window", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress", ...(written() ? { parent: "anton-othr" } : {}) })
          : bead(SHIPPER, { status: "closed" }),
      );

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain("was re-homed since the check");
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
      expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("withdraws when open work was attached beneath the ticket in the window", async () => {
      const newcomer = bead("anton-newk", { status: "open" });
      (newcomer as unknown as Record<string, unknown>).parent = TARGET;
      loadAllIssuesMock.mockImplementation(async () => (written() ? [...board(), newcomer] : board()));

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain(`open work was attached beneath ${TARGET} since the check (anton-newk)`);
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("withdraws when the survivor was reopened in the window", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress" })
          : bead(SHIPPER, { status: written() ? "open" : "closed" }),
      );

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain("is open again");
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
      expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(tagMock).not.toHaveBeenCalled();
    });

    // A reopen the window also CLOSED again reads `closed` after the write, its naming commit still
    // in the base — only the closure moved (PR #238 review). The post-write fence re-asks the
    // check's cycle question, exactly as the pre-write one does.
    it("withdraws when the survivor was reopened and closed again in the window", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress" })
          : bead(SHIPPER, { status: "closed", ...(written() ? { closed_at: RECLOSED_AT } : {}) }),
      );
      historyMock.mockImplementation(async () => (written() ? REWORKED : []));

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { why: string }).why).toContain("moved between the check and the write");
      expect(evidenceOf(outcome)).toContain(`\`${SHIPPER}\` is not closed on the evidence anton verified`);
      expect(evidenceOf(outcome)).toContain("is an earlier cycle's");
      expect(evidenceOf(outcome)).toContain(`withdrew the retirement: ${TARGET} is open again`);
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
      expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      expect(tagMock).not.toHaveBeenCalled();
    });

    describe("a survivor verified through its merged pull request", () => {
      const viaPr = (ref = "gh-85") => [
        bead(TARGET, { status: "in_progress" }),
        bead(UNLANDED, { status: "in_progress", metadata: { pr: ref } }),
      ];
      const retireViaPr = () =>
        retire({ block: { reason: `Already implemented by ${UNLANDED}` }, board: viaPr() });

      beforeEach(() => {
        setPr(85, "MERGED");
        loadAllIssuesMock.mockResolvedValue(viaPr());
      });

      it("withdraws when it was reopened after its merge in the window — same PR, still merged", async () => {
        boardShow.mockImplementation(async (_cwd, id) =>
          id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!,
        );
        historyMock.mockImplementation(async () =>
          written()
            ? [
                { at: REOPENED_AT, status: "in_progress" },
                { at: "2020-01-01T00:00:00Z", status: "closed" },
              ]
            : [],
        );

        const outcome = await retireViaPr();

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain(`\`${UNLANDED}\` is not in_progress on the evidence anton verified`);
        expect(evidenceOf(outcome)).toContain("is an earlier cycle's");
        expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
        expect(tagMock).not.toHaveBeenCalled();
      });

      it("withdraws when its PR pointer was swapped in the window, whatever the new PR says", async () => {
        setPr(90, "MERGED");
        boardShow.mockImplementation(async (_cwd, id) =>
          id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr(written() ? "gh-90" : "gh-85")[1]!,
        );

        const outcome = await retireViaPr();

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain("no longer points at the PR anton verified (gh-85)");
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
        expect(tagMock).not.toHaveBeenCalled();
      });

      // The pointer is not the evidence — the merge in the base is, and no bead lock holds the base
      // (PR #238 review). A pointer unchanged after the write can still name a PR that gh no longer
      // calls merged, or a merge the base no longer contains, so both are asked again.
      it("withdraws when the PR it verified is no longer merged after the write, pointer unchanged", async () => {
        boardShow.mockImplementation(async (_cwd, id) => {
          if (written()) setPr(85, "OPEN");
          return id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!;
        });

        const outcome = await retireViaPr();

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain("reads as open now, not merged");
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
        expect(tagMock).not.toHaveBeenCalled();
      });

      it("withdraws when the base no longer contains the PR's merge after the write — still merged is not enough", async () => {
        boardShow.mockImplementation(async (_cwd, id) => {
          if (written()) setPr(85, "MERGED", { commit: sb.unmerged, base: "develop" });
          return id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!;
        });

        const outcome = await retireViaPr();

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain("is merged elsewhere than the run's base (main) — into `develop`");
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
        expect(tagMock).not.toHaveBeenCalled();
      });
    });

    // The base is a movable ref that another run's fetch or reset can rewind at any moment, with
    // nothing on the board changing (PR #238 review). The post-write fence asks git again for the
    // survivor's naming commit and for every commit and PR the claim cited beside it.
    describe("a survivor verified through a commit naming it in the base", () => {
      const g = (args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

      it("withdraws when the base no longer contains the naming commit after the write", async () => {
        const before = g(["rev-parse", `${sb.landed}^`]);
        boardShow.mockImplementation(async (_cwd, id) => {
          // `main` rewound past the commit the check found, after the supersede landed.
          if (written()) g(["update-ref", "refs/heads/main", before]);
          return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
        });

        const outcome = await retire();

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain(
          `commit \`${sb.landed.slice(0, 10)}\` is no longer in the history of the run's base (main)`,
        );
        expect(evidenceOf(outcome)).toContain(`withdrew the retirement: ${TARGET} is open again`);
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
        expect(tagMock).not.toHaveBeenCalled();
      });

      it("withdraws when the base no longer contains a cited commit after the write, though the survivor's still lands", async () => {
        g(["commit", "-q", "--allow-empty", "-m", "unrelated follow-up"]);
        const extra = g(["rev-parse", "HEAD"]);
        boardShow.mockImplementation(async (_cwd, id) => {
          // `main` rewound to the naming commit: the survivor's evidence holds, the cited commit's does not.
          if (written()) g(["update-ref", "refs/heads/main", sb.landed]);
          return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
        });

        const outcome = await retire({
          block: { reason: `Already implemented by ${SHIPPER} (commit ${extra.slice(0, 7)})` },
        });

        expect(outcome).toMatchObject({ action: "escalate" });
        expect(evidenceOf(outcome)).toContain(
          `commit \`${extra.slice(0, 10)}\` is no longer in the history of the run's base (main)`,
        );
        expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
        expect(unlinkMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
        expect(tagMock).not.toHaveBeenCalled();
      });
    });

    it("leaves a retirement somebody else has already decided over — the ticket reopened by another hand", async () => {
      // Bypasses the supersede layer on purpose: the board says OPEN after the write, so the close
      // anton wrote is not what the ticket reads as any more.
      showMock.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: written() ? "open" : "in_progress" })
          : bead(SHIPPER, { status: "closed" }),
      );

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain("no longer reads as the close anton wrote");
      expect(evidenceOf(outcome)).toContain("that decision stands");
      for (const write of [reopenMock, unlinkMock, tagMock]) expect(write).not.toHaveBeenCalled();
    });

    it("reports a retirement it could not re-read as unsettled, names the check, and takes nothing back", async () => {
      showMock.mockImplementation(async (_cwd, id) => {
        if (written() && id === TARGET) throw new Error("dolt server went away");
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" });
      });

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain("could not be re-read after the retirement");
      expect(evidenceOf(outcome)).toContain("took nothing back");
      expect(evidenceOf(outcome)).toContain(`bd show ${TARGET}`);
      for (const write of [reopenMock, unlinkMock, tagMock]) expect(write).not.toHaveBeenCalled();
    });

    it("says the ticket stands closed when the withdrawal itself fails, and names the command a human runs", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress", ...(written() ? { title: "renamed" } : {}) })
          : bead(SHIPPER, { status: "closed" }),
      );
      reopenMock.mockRejectedValueOnce(new Error("beads db is locked"));

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(evidenceOf(outcome)).toContain("could NOT withdraw the retirement (beads db is locked)");
      expect(evidenceOf(outcome)).toContain(`bd reopen ${TARGET}`);
      for (const write of [unlinkMock, tagMock]) expect(write).not.toHaveBeenCalled();
    });

    it("keeps the ticket open when only the edge could not be removed, and says the edge is inert", async () => {
      boardShow.mockImplementation(async (_cwd, id) =>
        id === TARGET
          ? bead(TARGET, { status: "in_progress", ...(written() ? { title: "renamed" } : {}) })
          : bead(SHIPPER, { status: "closed" }),
      );
      unlinkMock.mockRejectedValueOnce(new Error("no such dependency"));

      const outcome = await retire();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect(reopenMock).toHaveBeenCalledWith(repo, TARGET, expect.any(String));
      expect(evidenceOf(outcome)).toContain(`${TARGET} is open again`);
      expect(evidenceOf(outcome)).toContain("could not be removed (no such dependency)");
      expect(tagMock).not.toHaveBeenCalled();
    });
  });

  it("keeps the retirement when only the STAMP failed, and says the guard is not armed for it", async () => {
    // The marker is the first tag write and lands; the stamp, second, is what bd refuses.
    tagMock.mockImplementationOnce(async () => "").mockRejectedValueOnce(new Error("beads db is locked"));

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER, marked: true });
    expect((outcome as { label?: string }).label).toBeUndefined();
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
    const notes = noteMock.mock.calls.map((c) => c[2]);
    expect(notes.some((t) => t.includes("could not stamp it"))).toBe(true);
  });

  // The retirement is never taken back on judgement, and a refused marker is not evidence that the
  // check was wrong — but the caller must not release a ticket, or open a PR, on it (PR #238 review).
  it("keeps the retirement when the MARKER is refused every time, and reports it unmarked", async () => {
    tagMock.mockImplementation(async (_cwd, _id, labels) => {
      if (labels.includes(LABELS.notDelivered)) throw new Error("beads db is locked");
      return "";
    });
    try {
      const outcome = await retire();

      expect(outcome).toMatchObject({
        action: "retired",
        replacementId: SHIPPER,
        marked: false,
        label: repairLabel(TARGET, "already-shipped", NOW),
      });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
      // Retried before it was allowed to fail, like the skip path's marker.
      expect(tagMock.mock.calls.filter(([, , labels]) => labels.includes(LABELS.notDelivered)).length).toBe(3);
      expect(reopenMock).not.toHaveBeenCalled();
    } finally {
      tagMock.mockImplementation(async () => "");
    }
  }, 10_000);
});

describe("resolveShipper", () => {
  const index = (beadsOnBoard: Bead[]) => indexBoard(beadsOnBoard);

  it("resolves exactly one named bead the board holds, never the ticket itself", () => {
    const board = [bead(TARGET), bead(SHIPPER, { status: "closed" })];
    expect(resolveShipper(index(board), TARGET, `shipped by ${SHIPPER}, not ${TARGET}`)).toEqual({
      state: "resolved",
      id: SHIPPER,
    });
  });

  it("refuses a bead id with this board's prefix that nobody filed", () => {
    const verdict = resolveShipper(index([bead(TARGET)]), TARGET, "shipped by anton-ghost");
    expect(verdict).toMatchObject({ state: "unresolved" });
    expect((verdict as { why: string }).why).toContain("the board holds no such bead");
  });
});
