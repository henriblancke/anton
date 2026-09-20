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
import {
  computeReviewKey,
  parseRecordedAdvisories,
  parseRecordedNarrative,
  recordNarrative,
  restorableNarrative,
  reviewKeyToken,
  type ReviewKey,
} from "./review-key";

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

describe("parseRecordedNarrative", () => {
  it("round-trips a serialized narrative, and the tip it was written against", () => {
    const narrative = { summary: "what changed", spotlight: "look here", risks: "none found" };
    expect(parseRecordedNarrative(recordNarrative(narrative, "head1"))).toEqual({
      narrative,
      head: "head1",
    });
  });

  it("reads a row written without a tip as a narrative with no binding", () => {
    // Rows written before the head was recorded, and rows whose HEAD read failed at write time —
    // both parse fine, and `restorableNarrative` is what declines to restore them.
    const narrative = { summary: "what changed" };
    expect(parseRecordedNarrative(JSON.stringify(narrative))).toEqual({ narrative });
  });

  it("reads absent as no narrative, never a failure", () => {
    expect(parseRecordedNarrative(null)).toBeUndefined();
    expect(parseRecordedNarrative(undefined)).toBeUndefined();
    expect(parseRecordedNarrative("")).toBeUndefined();
  });

  it("reads malformed, non-object, or shape-missing JSON as no narrative rather than throwing", () => {
    expect(parseRecordedNarrative("{not json")).toBeUndefined();
    expect(parseRecordedNarrative("[1,2,3]")).toBeUndefined();
    expect(parseRecordedNarrative("null")).toBeUndefined();
    expect(parseRecordedNarrative('{"spotlight":"no summary field"}')).toBeUndefined();
    expect(parseRecordedNarrative('{"summary":""}')).toBeUndefined();
    // Whitespace-only reads the same as empty, matching `isRunNarrative`'s trimmed check on a fresh
    // report (PR #303 review): a blank summary restored as valid would open the PR body with nothing.
    expect(parseRecordedNarrative('{"summary":"   "}')).toBeUndefined();
    expect(parseRecordedNarrative('{"summary":"\\n\\t"}')).toBeUndefined();
  });
});

describe("restorableNarrative", () => {
  let projectDir: string;

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

  const NARRATIVE = { summary: "what this run changed" };

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "anton-narrative-"));
    git("init", "--quiet", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    commitFile("README.md", "# project\n");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("restores a narrative bound to the tip the branch still stands on", async () => {
    const raw = recordNarrative(NARRATIVE, headSha());
    await expect(restorableNarrative(projectDir, raw)).resolves.toEqual(NARRATIVE);
  });

  it("discards a narrative whose tip has moved — a human amended or added commits", async () => {
    // THE case this binding exists for (PR #303 review): a run reached `describe`, failed opening
    // the PR, and a human fixed the branch before resuming. `runDescribeStep` keeps this restored
    // value when the next describe reports nothing, so an unbound restore would open the PR with
    // prose describing code that is no longer on the branch.
    const raw = recordNarrative(NARRATIVE, headSha());
    commitFile("src/widget.tsx", "export const Widget = () => null;\n");
    await expect(restorableNarrative(projectDir, raw)).resolves.toBeUndefined();
  });

  it("discards an amended tip, not just an added commit", async () => {
    const raw = recordNarrative(NARRATIVE, headSha());
    git("commit", "-q", "--amend", "-m", "reworded");
    await expect(restorableNarrative(projectDir, raw)).resolves.toBeUndefined();
  });

  it("discards a record carrying no tip at all — it cannot be bound to anything", async () => {
    await expect(restorableNarrative(projectDir, JSON.stringify(NARRATIVE))).resolves.toBeUndefined();
  });

  it("reads an absent or unparseable record as no narrative, never a failure", async () => {
    await expect(restorableNarrative(projectDir, null)).resolves.toBeUndefined();
    await expect(restorableNarrative(projectDir, "{not json")).resolves.toBeUndefined();
  });

  it("discards rather than throws when HEAD cannot be read at all", async () => {
    // The fallback is today's PR body — a nicer opening lost, never a run.
    const raw = recordNarrative(NARRATIVE, "0".repeat(40));
    await expect(restorableNarrative(join(tmpdir(), "anton-not-a-repo"), raw)).resolves.toBeUndefined();
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

  it("changes the fingerprint when the resolved reviewer model changes, even with the same contract shape", async () => {
    // review-gate.ts picks the reviewer model with resolveModel({jobType: "execute-epic",
    // step: "review", labels}) — a route added after a clean verdict must move this key even
    // though `reviewer.kind` (agent/prompt/default) itself never changes (PR #280 review).
    const a = await computeReviewKey({ worktreePath: projectDir, baseRev, settings: {}, ...FIXED });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings: { modelRoutes: [{ jobType: "execute-epic", step: "review", model: "claude-opus-5" }] },
      ...FIXED,
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when a label-scoped model route now matches the target's labels", async () => {
    const settings: ProjectSettings = {
      modelRoutes: [{ jobType: "execute-epic", step: "review", label: "risk:high", model: "claude-opus-5" }],
    };
    const plain = bead({ id: "anton-1", description: TARGET.description, labels: [] });
    const risky = bead({ id: "anton-1", description: TARGET.description, labels: ["risk:high"] });
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings,
      target: plain,
      tickets: [plain],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseRev,
      settings,
      target: risky,
      tickets: [risky],
      stepId: FIXED.stepId,
      carriedAdvisories: [],
    });
    expect(b.fingerprint).not.toBe(a.fingerprint);
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
