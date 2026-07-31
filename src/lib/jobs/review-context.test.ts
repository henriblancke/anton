/**
 * Unit tests for the self-review protocol helpers (anton-h4v3): the reviewer prompt and its swap
 * precedence (buildReviewPrompt), the concrete run context handed to the reviewer (reviewContext),
 * and the findings report parsed back out (parseReviewFindings). Running the review and the
 * converge loop are covered by the gate module.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPrompt, parseReviewFindings, reviewContext } from "./review-context";
import type { BranchDiff } from "../git/ops";
import type { Bead } from "../beads/bd";
import type { ProjectSettings } from "../projects";

/** An id no bundled/global agent can shadow, so precedence is measured, not guessed. */
const AGENT_ID = "anton-h4v3-test-reviewer";

const epic: Bead = {
  id: "anton-x1",
  title: "Ship X",
  status: "open",
  issue_type: "epic",
  description: "## Goal\n\nMake X shippable.\n\n## Success Criteria\n\n- [ ] X ships\n",
};

const ticket: Bead = {
  id: "anton-x1.1",
  title: "Build the X widget",
  status: "closed",
  issue_type: "task",
  description: "## Goal\n\nThe widget renders.\n\n## Acceptance\n\n- [ ] widget.tsx renders X\n",
};

const diff: BranchDiff = {
  files: ["src/widget.tsx"],
  patch: "diff --git a/src/widget.tsx b/src/widget.tsx\n+export const Widget = () => null;\n",
  truncated: false,
};

describe("reviewContext", () => {
  it("states the run, its beads' Goal/Acceptance, the diff and the report format", () => {
    const out = reviewContext({ target: epic, tickets: [ticket], diff });

    expect(out).toContain("Run target: anton-x1 — Ship X");
    expect(out).toContain("### Run target: anton-x1 — Ship X");
    expect(out).toContain("Make X shippable.");
    expect(out).toContain("- [ ] X ships");
    expect(out).toContain("### Ticket: anton-x1.1 — Build the X widget");
    expect(out).toContain("The widget renders.");
    expect(out).toContain("- [ ] widget.tsx renders X");
    expect(out).toContain("Changed files (1):");
    expect(out).toContain("- src/widget.tsx");
    expect(out).toContain("+export const Widget = () => null;");
    expect(out).toContain("## Reporting format (required)");
  });

  it("marks beads with no Goal/Acceptance rather than rendering them blank", () => {
    const bare: Bead = { id: "anton-x2", title: "Bare", status: "open", issue_type: "task" };
    const out = reviewContext({ target: bare, tickets: [bare], diff });
    expect(out).toContain("(none stated)");
  });

  it("lists a standalone run's bead once (target and only ticket are the same bead)", () => {
    const out = reviewContext({ target: ticket, tickets: [ticket], diff });
    expect(out).toContain("### Run target: anton-x1.1");
    expect(out).not.toContain("### Ticket: anton-x1.1");
  });

  it("inlines the project's principles when present, and says so when absent", () => {
    const withRules = reviewContext({
      target: epic,
      tickets: [ticket],
      diff,
      principles: "- Never widen a type to `any`.",
    });
    expect(withRules).toContain(".product/principles.md");
    expect(withRules).toContain("- Never widen a type to `any`.");

    const without = reviewContext({ target: epic, tickets: [ticket], diff });
    expect(without).toContain("This project has no `.product/principles.md`");
  });

  it("flags a truncated patch and an empty diff", () => {
    const cut = reviewContext({ target: epic, tickets: [ticket], diff: { ...diff, truncated: true } });
    expect(cut).toContain("The patch below is truncated");

    const empty = reviewContext({
      target: epic,
      tickets: [ticket],
      diff: { files: [], patch: "", truncated: false },
    });
    expect(empty).toContain("NO changes against its base");
  });

  it("demands the mandatory 0-10 score in the appended context, not just in the skill", () => {
    const out = reviewContext({ target: epic, tickets: [ticket], diff });
    expect(out).toContain('"score":<integer 0-10>');
    expect(out).toContain("`score` is MANDATORY");
    expect(out).toContain("even if your instructions above describe a different format");
    expect(out).toContain('"severity":"blocking" | "advisory"');
  });
});

describe("buildReviewPrompt", () => {
  let projectDir: string;

  function settings(over: Partial<ProjectSettings> = {}): ProjectSettings {
    return over;
  }

  function installAgent(id: string, body: string): void {
    const dir = join(projectDir, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.md`), `---\nname: ${id}\n---\n\n${body}\n`);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "anton-review-ctx-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("prefers the named review agent over the review prompt and the shipped skill", async () => {
    installAgent(AGENT_ID, "REVIEW AS THE NAMED AGENT.");

    const { prompt, reviewer } = await buildReviewPrompt({
      target: epic,
      tickets: [ticket],
      diff,
      settings: settings({ reviewAgent: AGENT_ID, reviewPrompt: "OPERATOR CONTRACT." }),
      projectDir,
    });

    expect(reviewer).toEqual({ kind: "agent", id: AGENT_ID });
    expect(prompt).toContain("REVIEW AS THE NAMED AGENT.");
    expect(prompt).not.toContain("OPERATOR CONTRACT.");
    // Frontmatter is stripped, and the concrete run context is appended beneath the reasoning.
    expect(prompt).not.toContain("name: " + AGENT_ID);
    expect(prompt).toContain("Run target: anton-x1 — Ship X");
  });

  it("falls back to the review prompt when the saved agent no longer resolves", async () => {
    const { prompt, reviewer } = await buildReviewPrompt({
      target: epic,
      tickets: [ticket],
      diff,
      settings: settings({ reviewAgent: AGENT_ID, reviewPrompt: "OPERATOR CONTRACT." }),
      projectDir,
    });

    expect(reviewer).toEqual({ kind: "prompt" });
    expect(prompt).toContain("OPERATOR CONTRACT.");
    expect(prompt).toContain("## Reporting format (required)");
  });

  it("uses the review prompt when set with no agent", async () => {
    const { prompt, reviewer } = await buildReviewPrompt({
      target: epic,
      tickets: [ticket],
      diff,
      settings: settings({ reviewPrompt: "  OPERATOR CONTRACT.  " }),
      projectDir,
    });

    expect(reviewer).toEqual({ kind: "prompt" });
    expect(prompt.startsWith("OPERATOR CONTRACT.")).toBe(true);
  });

  it("falls back to the shipped review skill when nothing is swapped in", async () => {
    const { prompt, reviewer } = await buildReviewPrompt({
      target: epic,
      tickets: [ticket],
      diff,
      settings: settings(),
      projectDir,
    });

    expect(reviewer).toEqual({ kind: "default" });
    expect(prompt).toContain("# Reviewing a run before its PR opens");
    expect(prompt).toContain("## Reporting format (required)");
  });

  it("reads .product/principles.md from the worktree under review", async () => {
    mkdirSync(join(projectDir, ".product"), { recursive: true });
    writeFileSync(join(projectDir, ".product", "principles.md"), "- Implement only Acceptance.\n");

    const { prompt } = await buildReviewPrompt({
      target: epic,
      tickets: [ticket],
      diff,
      settings: settings({ reviewPrompt: "OPERATOR CONTRACT." }),
      projectDir,
    });

    expect(prompt).toContain("- Implement only Acceptance.");
  });
});

describe("parseReviewFindings", () => {
  const block = (json: string) => ["Reviewed the diff.", "```json", json, "```"].join("\n");

  it("parses a valid report with blocking and advisory findings", () => {
    const result = parseReviewFindings(
      block(
        '{"score":6,"rationale":"one criterion unmet","findings":[' +
          '{"severity":"blocking","location":"src/a.ts:12","note":"drops the error path"},' +
          '{"severity":"advisory","location":"src/b.ts","note":"name could be clearer"}]}',
      ),
    );

    expect(result).toEqual({
      ok: true,
      score: 6,
      rationale: "one criterion unmet",
      findings: [
        { severity: "blocking", location: "src/a.ts:12", note: "drops the error path" },
        { severity: "advisory", location: "src/b.ts", note: "name could be clearer" },
      ],
    });
  });

  it("accepts a clean review: a valid score with no findings", () => {
    expect(parseReviewFindings(block('{"score":9,"findings":[]}'))).toEqual({
      ok: true,
      score: 9,
      findings: [],
    });
    // Scores at both ends of the scale are valid.
    expect(parseReviewFindings(block('{"score":0,"findings":[]}'))).toMatchObject({ ok: true, score: 0 });
    expect(parseReviewFindings(block('{"score":10,"findings":[]}'))).toMatchObject({ ok: true, score: 10 });
  });

  it("uses the LAST report block and skips unrelated json blocks after it", () => {
    const text = [
      "```json",
      '{"score":3,"findings":[{"severity":"blocking","location":"src/a.ts","note":"draft"}]}',
      "```",
      "after fixing my own mistake, the real report:",
      "```json",
      '{"score":8,"findings":[{"severity":"advisory","location":"src/a.ts","note":"final"}]}',
      "```",
      "for reference, the config I read:",
      "```json",
      '{"compilerOptions":{"strict":true}}',
      "```",
    ].join("\n");

    expect(parseReviewFindings(text)).toEqual({
      ok: true,
      score: 8,
      findings: [{ severity: "advisory", location: "src/a.ts", note: "final" }],
    });
  });

  it("drops malformed findings, defaults a missing location, and tolerates a non-array findings", () => {
    const result = parseReviewFindings(
      block(
        '{"score":5,"findings":[' +
          '{"severity":"blocking","location":"src/a.ts:1","note":"real"},' +
          '{"severity":"nit","location":"src/b.ts","note":"unknown severity"},' +
          '{"severity":"advisory","location":"src/c.ts","note":"   "},' +
          '{"severity":"advisory","note":"no location given"},' +
          '"junk"]}',
      ),
    );

    expect(result).toEqual({
      ok: true,
      score: 5,
      findings: [
        { severity: "blocking", location: "src/a.ts:1", note: "real" },
        { severity: "advisory", location: "(general)", note: "no location given" },
      ],
    });

    expect(parseReviewFindings(block('{"score":7,"findings":"none"}'))).toEqual({
      ok: true,
      score: 7,
      findings: [],
    });
  });

  it("reports a missing or unparseable report as a protocol violation, never as clean", () => {
    for (const text of [
      undefined,
      "The work looks good to me.",
      "```json\n{not json\n```",
      '```json\n{"threads":[{"id":"RT_1","outcome":"fixed"}]}\n```',
    ]) {
      expect(parseReviewFindings(text)).toEqual({ ok: false, violation: "no-report", findings: [] });
    }
  });

  it("reports a missing / non-integer / out-of-range score as a protocol violation", () => {
    for (const json of [
      '{"findings":[]}',
      '{"score":"eight","findings":[]}',
      '{"score":7.5,"findings":[]}',
      '{"score":11,"findings":[]}',
      '{"score":-1,"findings":[]}',
      '{"score":null,"findings":[]}',
    ]) {
      expect(parseReviewFindings(block(json))).toMatchObject({
        ok: false,
        violation: "invalid-score",
      });
    }
  });

  it("keeps the findings of a score-less report but still refuses to call it clean", () => {
    const result = parseReviewFindings(
      block('{"findings":[{"severity":"blocking","location":"src/a.ts:3","note":"leaks a token"}]}'),
    );

    expect(result).toEqual({
      ok: false,
      violation: "invalid-score",
      findings: [{ severity: "blocking", location: "src/a.ts:3", note: "leaks a token" }],
    });
  });

  it("does not fall back to an earlier valid report when the final one is broken", () => {
    const text = [
      "```json",
      '{"score":9,"findings":[]}',
      "```",
      "correction:",
      "```json",
      '{"score":"nine","findings":[]}',
      "```",
    ].join("\n");

    expect(parseReviewFindings(text)).toMatchObject({ ok: false, violation: "invalid-score" });
  });
});
