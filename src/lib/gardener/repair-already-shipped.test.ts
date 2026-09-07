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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bead } from "../beads/bd";

const noteMock = vi.fn<(cwd: string, id: string, text: string) => Promise<string>>(async () => "");
const tagMock = vi.fn<(cwd: string, id: string, labels: string[]) => Promise<string>>(async () => "");
const linkMock = vi.fn(async () => "");
const closeMock = vi.fn(async () => "");
const updateMock = vi.fn(async () => "");
const setPrRefMock = vi.fn(async () => "");
const supersedeMock = vi.fn<(cwd: string, id: string, replacement: string) => Promise<string>>(
  async () => "",
);
/** Every bd seam that WRITES. A check that touches one of these has stopped being a check. */
const bdWrites = [noteMock, tagMock, linkMock, closeMock, updateMock, setPrRefMock, supersedeMock];
/** The under-lock re-read the RETIREMENT makes; the check never calls it. */
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();

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
      show: showMock,
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
  setPr: (number: number, state: "OPEN" | "MERGED" | "CLOSED") => void;
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

  const prStates: Record<string, string> = {};
  const stateFile = join(dir, "pr-states.json");
  writeFileSync(stateFile, "{}");
  const fakeGh = join(binDir, "gh");
  // `pr view <selector> --json state` answers from the file, and EXITS NON-ZERO for a PR it does
  // not know — the shape of a gh that cannot reach GitHub, which must never read as a state.
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs=require('fs');
const a=process.argv.slice(2);
if(a[0]!=='pr'||a[1]!=='view'){process.exit(9)}
const states=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
const state=states[a[2]];
if(!state){process.stderr.write('could not resolve to a PullRequest\\n');process.exit(1)}
process.stdout.write(JSON.stringify({state}));
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
    setPr: (number, state) => {
      prStates[String(number)] = state;
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
  });

  afterEach(() => sb.cleanup());

  const verify = (reason: string | undefined, board: Bead[], base = "main") =>
    verifyShippedClaim({ repoPath: repo, base, targetId: TARGET, reason, board });

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
      `PR gh-85 is merged`,
    ]);
    expect((verdict as { landed: unknown }).landed).toEqual({
      [SHIPPER]: { via: "commit", sha: landed },
    });
    // The note a caller may write states what was checked AND what was not.
    expect(shippedEvidenceNote(verdict)).toContain("acceptance criteria");
  });

  it("refuses a commit the base does not contain", async () => {
    const verdict = await verify(`shipped in ${unmerged.slice(0, 8)}`, [bead(TARGET)]);

    expect(verdict.state).toBe("unverified");
    expect(verdict).toMatchObject({ why: expect.stringContaining("does not contain it") });
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
      proof: [`\`${SHIPPER}\` is in_progress, but its PR (gh-85) is merged`],
      landed: { [SHIPPER]: { via: "pr", ref: "gh-85" } },
    });
  });

  // CLOSED IS NOT LANDED (PR #238 review). An epic's children close the moment their run commits
  // them, before the feature's one pull request opens, let alone merges — so a closed bead is
  // routinely work on an unmerged branch, and retiring a live ticket against it would settle that
  // ticket on work the base does not contain.
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

  it("verifies a closed child through the MERGED pull request of the feature it rides", async () => {
    setPr(85, "MERGED");
    const feature = bead(OWNER, { issue_type: "feature", status: "closed", metadata: { pr: "gh-85" } });
    const child = bead(UNLANDED, { status: "closed" });
    (child as unknown as Record<string, unknown>).parent = OWNER;

    const verdict = await verify(`already done by ${UNLANDED}`, [bead(TARGET), feature, child]);

    expect(verdict).toEqual({
      state: "verified",
      proof: [
        `\`${UNLANDED}\` is closed on the board and the PR of \`${OWNER}\`, the run target it ` +
          `rides, (gh-85) is merged`,
      ],
      landed: { [UNLANDED]: { via: "owner-pr", ownerId: OWNER, ref: "gh-85" } },
    });
  });

  it("verifies a closed bead through its own merged pull request", async () => {
    setPr(85, "MERGED");
    const verdict = await verify(`already done by ${UNLANDED}`, [
      bead(TARGET),
      bead(UNLANDED, { status: "closed", metadata: { pr: "gh-85" } }),
    ]);

    expect(verdict).toEqual({
      state: "verified",
      proof: [`\`${UNLANDED}\` is closed on the board and its PR (gh-85) is merged`],
      landed: { [UNLANDED]: { via: "pr", ref: "gh-85" } },
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

  it("reads PRs as the `gh-<n>` ref, from a number or a url, deduped", () => {
    expect(
      claimedPullRequests("PR #85, also https://github.com/o/r/pull/85 and #12"),
    ).toEqual(["gh-85", "gh-12"]);
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
      bead: { id: TARGET },
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
    showMock.mockReset();
    // The under-lock re-read finds both ends exactly as the snapshot did.
    showMock.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "closed" }),
    );
    loadAllIssuesMock.mockClear();
    loadAllIssuesMock.mockResolvedValue(board());
  });

  afterEach(() => sb.cleanup());

  const commitProof = () =>
    `\`${SHIPPER}\` is closed on the board, and commit \`${sb.landed.slice(0, 10)}\` in the ` +
    `history of the run's base (main) names it`;

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

    // Written in the order the module promises: the statement of what anton checked lands BEFORE
    // anything is settled on the strength of it.
    const firstNote = Math.min(...noteMock.mock.invocationCallOrder);
    expect(firstNote).toBeLessThan(supersedeMock.mock.invocationCallOrder[0]!);
    expect(supersedeMock.mock.invocationCallOrder[0]!).toBeLessThan(tagMock.mock.invocationCallOrder[0]!);
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
      bead: { id: TARGET, labels: [repairLabel(TARGET, "already-shipped", NOW - 60_000)] },
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

  it("refuses under the lock when the board could not be re-read at all", async () => {
    loadAllIssuesMock.mockRejectedValue(new Error("dolt server went away"));

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "escalate" });
    expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("could not be re-read");
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it("writes nothing when either end moved between the check and the write", async () => {
    // Somebody else settled the ticket in the window — anton does not rewrite that outcome.
    showMock.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "closed" }) : bead(SHIPPER, { status: "closed" }),
    );
    const settled = await retire();
    expect(settled).toMatchObject({ action: "escalate" });
    expect((settled as { evidence: string[] }).evidence.join(" ")).toContain("already settled");

    // …and the survivor reopened: the commit naming it spoke for a closed ticket, and by the
    // human's own hand it is work in progress again.
    showMock.mockImplementation(async (_cwd, id) =>
      id === TARGET ? bead(TARGET, { status: "in_progress" }) : bead(SHIPPER, { status: "open" }),
    );
    const reopened = await retire();
    expect(reopened).toMatchObject({ action: "escalate" });
    expect((reopened as { evidence: string[] }).evidence.join(" ")).toContain("open again");

    // …and the survivor ABANDONED in the window: it is closed, so a status check alone reads it as
    // landed, but a recorded won't-do delivered nothing to be superseded by.
    showMock.mockImplementation(async (_cwd, id) =>
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
      showMock.mockImplementation(async (_cwd, id) =>
        id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!,
      );

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({
        action: "retired",
        replacementId: UNLANDED,
        proof: [`\`${UNLANDED}\` is in_progress, but its PR (gh-85) is merged`],
      });
      expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, UNLANDED);
    });

    it("refuses when its PR pointer was swapped in the window, whatever the new PR says", async () => {
      setPr(90, "MERGED");
      showMock.mockImplementation(async (_cwd, id) =>
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
      showMock.mockImplementation(async (_cwd, id) => {
        // Reread INSIDE the lock, after the check read it as merged.
        if (id === UNLANDED) setPr(85, "OPEN");
        return id === TARGET ? bead(TARGET, { status: "in_progress" }) : viaPr()[1]!;
      });

      const outcome = await retireViaPr();

      expect(outcome).toMatchObject({ action: "escalate" });
      expect((outcome as { evidence: string[] }).evidence.join(" ")).toContain("reads as open now, not merged");
      expect(supersedeMock).not.toHaveBeenCalled();
    });
  });

  it("keeps the retirement when only the STAMP failed, and says the guard is not armed for it", async () => {
    tagMock.mockRejectedValueOnce(new Error("beads db is locked"));

    const outcome = await retire();

    expect(outcome).toMatchObject({ action: "retired", replacementId: SHIPPER });
    expect((outcome as { label?: string }).label).toBeUndefined();
    expect(supersedeMock).toHaveBeenCalledWith(repo, TARGET, SHIPPER);
    const notes = noteMock.mock.calls.map((c) => c[2]);
    expect(notes.some((t) => t.includes("could not stamp it"))).toBe(true);
  });
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
