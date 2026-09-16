/**
 * Unit tests for the clean-verdict resume key (anton-qmuyt): the merge-base, the branch tip, and
 * the reviewer-contract fingerprint, against a real tiny git repo — the same fixture pattern
 * `buildReviewPrompt`'s tests use, since the key reads real revisions the same way the prompt does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Bead } from "../beads/types";
import type { ProjectSettings } from "../projects";
import { computeReviewKey, parseRecordedAdvisories, reviewKeyToken, type ReviewKey } from "./review-key";

function bead(overrides: Partial<Bead> & Pick<Bead, "id">): Bead {
  return { title: overrides.id, status: "open", issue_type: "task", ...overrides };
}

const TARGET = bead({ id: "anton-1", description: "## Acceptance Criteria\n\n- [ ] it works\n" });

describe("reviewKeyToken", () => {
  it("joins the three components into one comparable string", () => {
    const key: ReviewKey = { baseRev: "abc123", head: "def456", fingerprint: "fp" };
    expect(reviewKeyToken(key)).toBe("abc123:def456:fp");
  });
});

describe("parseRecordedAdvisories", () => {
  it("round-trips a serialized findings array", () => {
    const findings = [{ severity: "advisory" as const, location: "a.ts:1", note: "n" }];
    expect(parseRecordedAdvisories(JSON.stringify(findings))).toEqual(findings);
  });

  it("reads absent as no advisories, never a failure", () => {
    expect(parseRecordedAdvisories(null)).toEqual([]);
    expect(parseRecordedAdvisories(undefined)).toEqual([]);
    expect(parseRecordedAdvisories("")).toEqual([]);
  });

  it("reads malformed or non-array JSON as no advisories rather than throwing", () => {
    expect(parseRecordedAdvisories("{not json")).toEqual([]);
    expect(parseRecordedAdvisories('{"not":"an array"}')).toEqual([]);
  });
});

describe("computeReviewKey", () => {
  let projectDir: string;
  // computeReviewKey now takes the already-resolved merge-base COMMIT (the gate pins it once,
  // up front, and passes the SHA — see review-gate.ts) rather than a branch name it resolves
  // itself, so every call below passes this resolved SHA in place of the old `baseBranch: BASE`.
  let baseRev: string;
  const BASE = "main";

  function git(...args: string[]): void {
    execFileSync("git", ["-C", projectDir, ...args], { stdio: "pipe" });
  }

  function commitFile(relPath: string, contents: string): void {
    const full = join(projectDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    git("add", "-A");
    git("commit", "-qm", `add ${relPath}`);
  }

  function headSha(): string {
    return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"]).toString().trim();
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "anton-review-key-"));
    git("init", "--quiet", "-b", BASE);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    commitFile("README.md", "# project\n");
    baseRev = execFileSync("git", ["-C", projectDir, "rev-parse", BASE]).toString().trim();
    git("checkout", "-qb", "feature");
    commitFile("src/widget.tsx", "export const Widget = () => null;\n");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Every call below fixes the target/tickets/stepId/carriedAdvisories that are not this test's
  // concern, so each test varies exactly one input and the assertions read as "only this changed."
  const FIXED = { target: TARGET, tickets: [TARGET], stepId: "step:review-1", carriedAdvisories: [] };

  it("keys on the merge-base and the branch tip, matching what git itself reports", async () => {
    const baseSha = execFileSync("git", ["-C", projectDir, "rev-parse", BASE]).toString().trim();
    const key = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    expect(key.baseRev).toBe(baseSha);
    expect(key.head).toBe(headSha());
  });

  it("is deterministic for an unchanged tree and contract", async () => {
    const settings: ProjectSettings = { reviewPrompt: "OPERATOR CONTRACT." };
    const a = await computeReviewKey({ worktreePath: projectDir, baseRev, settings, ...FIXED });
    const b = await computeReviewKey({ worktreePath: projectDir, baseRev, settings, ...FIXED });
    expect(reviewKeyToken(a)).toBe(reviewKeyToken(b));
  });

  it("moves the tip — and so the token — on a new commit", async () => {
    const before = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    commitFile("src/other.tsx", "export const Other = () => null;\n");
    const after = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    expect(after.head).not.toBe(before.head);
    expect(reviewKeyToken(after)).not.toBe(reviewKeyToken(before));
  });

  it("changes the fingerprint — never the base or the tip — when the reviewer contract changes", async () => {
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { reviewPrompt: "CONTRACT A." },
      ...FIXED,
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { reviewPrompt: "CONTRACT B." },
      ...FIXED,
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when maxRounds or the score alarm changes, even with the shipped contract", async () => {
    const a = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { reviewMaxRounds: 5 },
      ...FIXED,
    });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when review is toggled off, even with the tree and contract unchanged", async () => {
    const a = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { reviewEnabled: false },
      ...FIXED,
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when a verify-gate command is added, even with the tree and contract unchanged", async () => {
    const a = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { testCommand: "npm test" },
      ...FIXED,
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint — never the base or the tip — when a ticket's Acceptance changes", async () => {
    const before = bead({ id: "anton-2", description: "## Acceptance Criteria\n\n- [ ] old criterion\n" });
    const after = bead({ id: "anton-2", description: "## Acceptance Criteria\n\n- [ ] NEW criterion\n" });
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [before],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [after],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint — never the base or the tip — when a ticket's title changes", async () => {
    const before = bead({ id: "anton-2", title: "old title" });
    const after = bead({ id: "anton-2", title: "new title" });
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [before],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [after],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint between two step:review occurrences on an identical tree and contract", async () => {
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [TARGET],
      stepId: "step:review-1",
      carriedAdvisories: [],
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [TARGET],
      stepId: "step:review-2",
      carriedAdvisories: [],
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(reviewKeyToken(b)).not.toBe(reviewKeyToken(a));
  });

  it("changes the fingerprint when the carried-in advisories differ, on an identical tree, contract, and step", async () => {
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [TARGET],
      stepId: "step:review-2",
      carriedAdvisories: [{ severity: "advisory", location: "a.ts:1", note: "still open" }],
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: {},
      target: TARGET,
      tickets: [TARGET],
      stepId: "step:review-2",
      carriedAdvisories: [{ severity: "advisory", location: "b.ts:2", note: "a different set" }],
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(reviewKeyToken(b)).not.toBe(reviewKeyToken(a));
  });
});
