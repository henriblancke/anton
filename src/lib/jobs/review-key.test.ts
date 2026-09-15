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
import type { ProjectSettings } from "../projects";
import { computeReviewKey, parseRecordedAdvisories, reviewKeyToken, type ReviewKey } from "./review-key";

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
    git("checkout", "-qb", "feature");
    commitFile("src/widget.tsx", "export const Widget = () => null;\n");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("keys on the merge-base and the branch tip, matching what git itself reports", async () => {
    const baseSha = execFileSync("git", ["-C", projectDir, "rev-parse", BASE]).toString().trim();
    const key = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings: {} });
    expect(key.baseRev).toBe(baseSha);
    expect(key.head).toBe(headSha());
  });

  it("is deterministic for an unchanged tree and contract", async () => {
    const settings: ProjectSettings = { reviewPrompt: "OPERATOR CONTRACT." };
    const a = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings });
    const b = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings });
    expect(reviewKeyToken(a)).toBe(reviewKeyToken(b));
  });

  it("moves the tip — and so the token — on a new commit", async () => {
    const before = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings: {} });
    commitFile("src/other.tsx", "export const Other = () => null;\n");
    const after = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings: {} });
    expect(after.head).not.toBe(before.head);
    expect(reviewKeyToken(after)).not.toBe(reviewKeyToken(before));
  });

  it("changes the fingerprint — never the base or the tip — when the reviewer contract changes", async () => {
    const a = await computeReviewKey({
      worktreePath: projectDir,
      baseBranch: BASE,
      settings: { reviewPrompt: "CONTRACT A." },
    });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseBranch: BASE,
      settings: { reviewPrompt: "CONTRACT B." },
    });
    expect(b.baseRev).toBe(a.baseRev);
    expect(b.head).toBe(a.head);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when maxRounds or the score alarm changes, even with the shipped contract", async () => {
    const a = await computeReviewKey({ worktreePath: projectDir, baseBranch: BASE, settings: {} });
    const b = await computeReviewKey({
      worktreePath: projectDir,
      baseBranch: BASE,
      settings: { reviewMaxRounds: 5 },
    });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});
