/**
 * `.github/scripts/pr-comment.sh` — the review agent's only route to a PR comment (anton-9zzu).
 *
 * The behaviour worth pinning is not "it posts a comment", it is WHICH BRANCH it takes when the edit
 * does not go through. The bug this script replaced turned every failed edit into a new comment, so
 * a permission gate nobody could see produced 52 summaries on one PR while the job stayed green.
 * Here: a 404 (a human deleted the summary) re-creates, and any other failure is loud and creates
 * NOTHING — a duplicate must not be reachable by falling over.
 *
 * `gh` is stubbed on PATH: the script's contract is the calls it makes, not GitHub's responses. The
 * create/edit round-trip against the real API was verified by hand on a throwaway issue.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), ".github/scripts/pr-comment.sh");

/** `gh api --paginate --slurp` hands jq an array of PAGES, each an array of comments. */
const page = (...comments: Array<Record<string, unknown>>) => JSON.stringify([comments]);

const MARKER = "<!-- claude-review-summary -->";
const bot = (id: number, body: string) => ({ id, user: { login: "claude[bot]" }, body });

/** A stub that records every `gh` invocation and answers by endpoint. */
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *"/comments -X GET"*) cat "$GH_LIST" ;;
  *"issues/comments/"*"-X PATCH"*)
    cat > "$GH_BODY"
    if [[ "$GH_PATCH" == "ok" ]]; then echo "https://example.test/edited"; else echo "gh: $GH_PATCH" >&2; exit 1; fi ;;
  *"/comments -X POST"*) cat > "$GH_BODY"; echo "https://example.test/created" ;;
  *"/replies"*) echo "https://example.test/reply" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`;

let dir: string;

const run = (args: string[], env: Record<string, string>, stdin = "### Merge confidence: 8/10\n") =>
  spawnSync("bash", [SCRIPT, ...args], {
    input: stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      REPO: "owner/repo",
      PR_NUMBER: "42",
      BOT_LOGIN: "claude[bot]",
      GH_LOG: join(dir, "calls.log"),
      GH_LIST: join(dir, "list.json"),
      GH_BODY: join(dir, "body.md"),
      GH_PATCH: "ok",
      GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
      ...env,
    },
  });

const calls = (): string[] =>
  readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);

const stepSummary = (): string => readFileSync(join(dir, "step-summary.md"), "utf8");

/** What the script actually sent as the comment body. */
const sentBody = (): string => readFileSync(join(dir, "body.md"), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-comment-"));
  writeFileSync(join(dir, "gh"), GH_STUB);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(dir, "list.json"), page());
  writeFileSync(join(dir, "step-summary.md"), "");
  writeFileSync(join(dir, "body.md"), "");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pr-comment.sh sticky", () => {
  it("creates the summary when the PR has none", () => {
    const result = run(["sticky"], {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("created summary");
    expect(calls().some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("edits the existing summary in place instead of adding another", () => {
    writeFileSync(join(dir, "list.json"), page(bot(111, `${MARKER}\nold summary`)));
    const result = run(["sticky"], {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("edited summary 111");
    expect(calls().some((c) => c.includes("-X POST"))).toBe(false);
  });

  it("edits the newest marker comment and leaves a PR's earlier duplicates alone", () => {
    writeFileSync(
      join(dir, "list.json"),
      page(
        bot(100, `${MARKER}\nfirst`),
        { id: 101, user: { login: "henriblancke" }, body: `${MARKER}\nan impostor` },
        { id: 102, user: { login: "claude[bot]" }, body: null },
        bot(103, `${MARKER}\nnewest`),
        bot(104, "a plain review remark, no marker"),
      ),
    );
    const result = run(["sticky"], {});
    expect(result.stdout).toContain("edited summary 103");
  });

  it("re-creates the summary when the comment it should edit is gone (404)", () => {
    writeFileSync(join(dir, "list.json"), page(bot(111, `${MARKER}\nold summary`)));
    const result = run(["sticky"], { GH_PATCH: "Not Found (HTTP 404)" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::");
    expect(result.stdout).toContain("created summary");
    expect(stepSummary()).toContain("is gone");
  });

  it("fails loudly and creates NOTHING when the edit is refused for any other reason", () => {
    writeFileSync(join(dir, "list.json"), page(bot(111, `${MARKER}\nold summary`)));
    const result = run(["sticky"], { GH_PATCH: "Forbidden (HTTP 403)" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::");
    expect(calls().some((c) => c.includes("-X POST"))).toBe(false);
    // The agent's stdout never reaches the run log, so the job summary is where a human sees this.
    expect(stepSummary()).toContain("FAILED");
  });

  it("owns the marker: it leads the body exactly once, however the agent typed it", () => {
    for (const typed of ["### Merge confidence: 8/10\n", `${MARKER}\nbody\n`, `   ${MARKER}\nbody\n`]) {
      expect(run(["sticky"], {}, typed).status).toBe(0);
      // An indented or repeated marker is a comment the next run cannot find — a summary per push.
      expect(sentBody().startsWith(`${MARKER}\n`)).toBe(true);
      expect(sentBody().split(MARKER).length - 1).toBe(1);
    }
  });
});

describe("pr-comment.sh reply", () => {
  it("replies in the thread of the review comment it is given", () => {
    const result = run(["reply", "555", "Still unresolved — see original comment."], {});
    expect(result.status).toBe(0);
    expect(calls()[0]).toContain("repos/owner/repo/pulls/42/comments/555/replies");
  });

  it("refuses a non-numeric comment id", () => {
    const result = run(["reply", "$(rm -rf /)", "hi"], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("numeric review-comment id");
  });
});

describe("pr-comment.sh environment", () => {
  it("refuses to run without the bot login, rather than matching no comment and duplicating", () => {
    const result = run(["sticky"], { BOT_LOGIN: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BOT_LOGIN");
  });

  it("takes the PR from the workflow env, so PR content cannot retarget the write", () => {
    const result = run(["sticky"], { PR_NUMBER: "not-a-number" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PR_NUMBER");
  });
});
