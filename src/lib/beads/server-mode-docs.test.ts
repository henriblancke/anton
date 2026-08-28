/**
 * The embedded → server move is documented in four places (README, DESIGN §3a, `/setup`, and the
 * runbook itself), and the failure mode is drift: a doc that still teaches `bd export` → `bd import`
 * hands a teammate a path that moves the issues and silently DROPS the board's Dolt commit history
 * (anton-yvjd). So the load-bearing halves of that story are gated here rather than left to prose.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNBOOK = "docs/runbooks/embedded-board-to-shared-dolt-server.md";

/** Docs wrap mid-sentence, so match against a single-spaced copy rather than raw lines. */
const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\s+/g, " ");

/** The docs that summarise the move and must hand the reader on to the runbook. */
const POINTERS: Array<[string, string]> = [
  ["README.md", read("README.md")],
  ["DESIGN.md", read("DESIGN.md")],
  ["skills/setup/SKILL.md", read("skills/setup/SKILL.md")],
];

/** Those, plus the runbook itself: every doc a reader could follow to move a board. */
const DOCS: Array<[string, string]> = [...POINTERS, [RUNBOOK, read(RUNBOOK)]];

describe("the embedded → server move is documented the same way everywhere", () => {
  for (const [where, doc] of POINTERS) {
    describe(where, () => {
      // The data half is a human-run copy of the Dolt database directory; nothing else preserves
      // history, so a doc that describes the move without pointing at the runbook is incomplete.
      it("points at the validated runbook", () => {
        expect(doc).toContain("embedded-board-to-shared-dolt-server.md");
      });

      it("names `anton server-mode` as the config half", () => {
        expect(doc).toMatch(/anton server-mode/);
      });
    });
  }

  for (const [where, doc] of DOCS) {
    describe(where, () => {
      it("never prescribes `bd export` → `bd import` as the move", () => {
        const REFUSAL = /not a substitute|Do \*\*not\*\* substitute|Neither can|Nor is|drops? .{0,30}history/i;
        const windows = [...doc.matchAll(/`bd import`/g)].map((m) =>
          doc.slice(Math.max(0, m.index - 200), m.index + 200),
        );
        expect(windows.length, "no `bd import` mention to check").toBeGreaterThan(0);
        for (const window of windows) {
          expect(window, `\`bd import\` taught without the history warning: …${window}…`).toMatch(
            REFUSAL,
          );
        }
      });
    });
  }
});
