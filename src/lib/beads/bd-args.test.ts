/**
 * Direct suite for bd-args.ts (anton-ql1n): the pure argv builders for `bd update`/`batch`/`prune`,
 * tested against the module itself. Nothing here spawns bd — every case asserts the exact argv (or
 * stdin) a call would receive. The subprocess round-trip for these verbs lives in bd-batch.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  batchEnabled,
  batchOpArgs,
  BD_BATCH_ENV,
  buildPruneArgs,
  buildUpdateArgs,
  encodeBatchOps,
  isMissingBatchCommand,
  labelValueOf,
  quoteBatchValue,
} from "@/lib/beads/bd-args";

describe("labelValueOf", () => {
  it("reads the value of a single-valued prefix label", () => {
    expect(labelValueOf(["agent:nextjs", "risk:low"], "agent")).toBe("nextjs");
  });

  it("returns undefined when the prefix is absent, or labels are undefined", () => {
    expect(labelValueOf(["risk:low"], "agent")).toBeUndefined();
    expect(labelValueOf(undefined, "agent")).toBeUndefined();
  });
});

describe("buildUpdateArgs", () => {
  it("builds a title-only update", () => {
    expect(buildUpdateArgs("bd-1", { title: "New title" })).toEqual([
      "update",
      "bd-1",
      "--title",
      "New title",
    ]);
  });

  it("builds a status update", () => {
    expect(buildUpdateArgs("bd-1", { status: "in_progress" })).toEqual([
      "update",
      "bd-1",
      "--status",
      "in_progress",
    ]);
  });

  it("builds a priority update, keeping 0 (falsy but meaningful)", () => {
    expect(buildUpdateArgs("bd-1", { priority: 1 })).toEqual(["update", "bd-1", "--priority", "1"]);
    expect(buildUpdateArgs("bd-1", { priority: 0 })).toEqual(["update", "bd-1", "--priority", "0"]);
  });

  it("builds an acceptance-only update", () => {
    expect(buildUpdateArgs("bd-1", { acceptance: "- [ ] works" })).toEqual([
      "update",
      "bd-1",
      "--acceptance",
      "- [ ] works",
    ]);
  });

  it("builds a description-only update", () => {
    expect(buildUpdateArgs("bd-1", { description: "## Goal\nShip it" })).toEqual([
      "update",
      "bd-1",
      "--description",
      "## Goal\nShip it",
    ]);
  });

  it("combines every scalar flag in one call", () => {
    expect(
      buildUpdateArgs("bd-1", {
        title: "T",
        status: "open",
        priority: 2,
        acceptance: "A",
        description: "D",
      }),
    ).toEqual([
      "update",
      "bd-1",
      "--title",
      "T",
      "--status",
      "open",
      "--priority",
      "2",
      "--acceptance",
      "A",
      "--description",
      "D",
    ]);
  });

  it("diffs only the changed label prefix, moving it with remove+add, and preserves control labels", () => {
    const args = buildUpdateArgs(
      "bd-1",
      { labels: { agent: "fastapi" } },
      ["agent:nextjs", "risk:low", "approved", "stage:implementing", "source:stringer"],
    );
    expect(args).toEqual(["update", "bd-1", "--remove-label", "agent:nextjs", "--add-label", "agent:fastapi"]);
    expect(args).not.toContain("approved");
    expect(args).not.toContain("stage:implementing");
    expect(args).not.toContain("source:stringer");
    expect(args).not.toContain("risk:low");
  });

  it("adds a label with no prior value using --add-label alone", () => {
    expect(buildUpdateArgs("bd-1", { labels: { domain: "eng" } }, ["agent:nextjs"])).toEqual([
      "update",
      "bd-1",
      "--add-label",
      "domain:eng",
    ]);
  });

  it("moves every managed prefix present in one patch", () => {
    expect(
      buildUpdateArgs(
        "bd-1",
        { labels: { agent: "fastapi", risk: "high", size: "L", domain: "eng", area: "ingest" } },
        [],
      ),
    ).toEqual([
      "update",
      "bd-1",
      "--add-label",
      "agent:fastapi",
      "--add-label",
      "risk:high",
      "--add-label",
      "size:L",
      "--add-label",
      "domain:eng",
      "--add-label",
      "area:ingest",
    ]);
  });

  it("is a no-op when the label value is unchanged", () => {
    expect(buildUpdateArgs("bd-1", { labels: { agent: "nextjs" } }, ["agent:nextjs"])).toBeNull();
  });

  it("combines a scalar edit with a label diff in one invocation", () => {
    expect(buildUpdateArgs("bd-1", { title: "T", labels: { size: "L" } }, ["size:S", "approved"])).toEqual([
      "update",
      "bd-1",
      "--title",
      "T",
      "--remove-label",
      "size:S",
      "--add-label",
      "size:L",
    ]);
  });

  it("treats an empty patch as no write", () => {
    expect(buildUpdateArgs("bd-1", {})).toBeNull();
  });

  it("treats empty-string and undefined fields as no-ops", () => {
    expect(buildUpdateArgs("bd-1", { title: "", status: undefined })).toBeNull();
    expect(buildUpdateArgs("bd-1", { labels: { agent: "", risk: undefined } }, ["agent:nextjs"])).toBeNull();
  });
});

describe("buildPruneArgs", () => {
  it("previews an age window via --older-than + --dry-run by default", () => {
    expect(buildPruneArgs("30d")).toEqual(["prune", "--older-than", "30d", "--dry-run", "--json"]);
    expect(buildPruneArgs("90d")).toEqual(["prune", "--older-than", "90d", "--dry-run", "--json"]);
  });

  it("deletes an age window via --older-than + --force", () => {
    expect(buildPruneArgs("30d", { force: true })).toEqual([
      "prune",
      "--older-than",
      "30d",
      "--force",
      "--json",
    ]);
  });

  it("maps 'all' to --pattern '*' (bd's everything-closed sweep)", () => {
    expect(buildPruneArgs("all")).toEqual(["prune", "--pattern", "*", "--dry-run", "--json"]);
    expect(buildPruneArgs("all", { force: true })).toEqual([
      "prune",
      "--pattern",
      "*",
      "--force",
      "--json",
    ]);
  });
});

describe("quoteBatchValue", () => {
  it("quotes a plain value", () => {
    expect(quoteBatchValue("hello")).toBe('"hello"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(quoteBatchValue('he said "no" \\ then left')).toBe('"he said \\"no\\" \\\\ then left"');
  });

  it("collapses embedded newlines and whitespace to single spaces, and trims", () => {
    expect(quoteBatchValue("line one\nline two\n\n  line three  ")).toBe('"line one line two line three"');
  });
});

describe("encodeBatchOps", () => {
  it("renders close and update ops as newline-delimited lines, each ending in a trailing newline", () => {
    expect(
      encodeBatchOps([
        { op: "close", id: "bd-1" },
        { op: "close", id: "bd-2", reason: "duplicate" },
        { op: "update", id: "bd-3", fields: { title: "t", status: "open" } },
      ]),
    ).toBe('close bd-1\nclose bd-2 "duplicate"\nupdate bd-3 status="open" title="t"\n');
  });

  it("throws on a whitespace/quote-bearing id rather than silently splitting the command", () => {
    expect(() => encodeBatchOps([{ op: "close", id: "bd-1 close bd-2" }])).toThrow(/unusable bead id/);
    expect(() => encodeBatchOps([{ op: "close", id: "" }])).toThrow(/unusable bead id/);
  });

  it("throws when an update op sets no fields", () => {
    expect(() => encodeBatchOps([{ op: "update", id: "bd-1", fields: {} }])).toThrow(/sets no fields/);
  });
});

describe("batchOpArgs", () => {
  it("builds the sequential-fallback argv for close, with and without a reason", () => {
    expect(batchOpArgs({ op: "close", id: "bd-1" })).toEqual(["close", "bd-1"]);
    expect(batchOpArgs({ op: "close", id: "bd-1", reason: "why" })).toEqual([
      "close",
      "bd-1",
      "--reason",
      "why",
    ]);
  });

  it("builds the sequential-fallback argv for update, one flag per set field", () => {
    expect(batchOpArgs({ op: "update", id: "bd-1", fields: { priority: 2, assignee: "ada" } })).toEqual([
      "update",
      "bd-1",
      "--priority",
      "2",
      "--assignee",
      "ada",
    ]);
  });
});

describe("isMissingBatchCommand", () => {
  it("matches cobra's unknown-subcommand line, quoted operands and all", () => {
    expect(isMissingBatchCommand({ stderr: 'unknown command "batch" for "bd"' })).toBe(true);
    expect(isMissingBatchCommand({ stderr: 'Error: unknown command "batch" for "bd"\n' })).toBe(true);
    expect(isMissingBatchCommand(new Error('Command failed\nunknown command "batch" for "bd"'))).toBe(true);
  });

  it("does not match a rolled-back transaction error, even one echoing an operation", () => {
    expect(isMissingBatchCommand({ stderr: "line 2 (close bd-9): not found: issue bd-9" })).toBe(false);
    expect(isMissingBatchCommand(undefined)).toBe(false);
  });

  it("requires both quoted operands on the SAME line, not split across stderr/message", () => {
    expect(isMissingBatchCommand({ stderr: "unknown command", message: '"batch" for "bd"' })).toBe(false);
  });
});

describe("batchEnabled", () => {
  it("is enabled by default, and disabled by the documented off-values", () => {
    const prior = process.env[BD_BATCH_ENV];
    try {
      delete process.env[BD_BATCH_ENV];
      expect(batchEnabled()).toBe(true);
      for (const off of ["0", "off", "false", "no", "OFF"]) {
        process.env[BD_BATCH_ENV] = off;
        expect(batchEnabled()).toBe(false);
      }
      process.env[BD_BATCH_ENV] = "1";
      expect(batchEnabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[BD_BATCH_ENV];
      else process.env[BD_BATCH_ENV] = prior;
    }
  });
});
