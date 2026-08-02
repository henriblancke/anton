/**
 * Unit tests for the multi-bead transaction seam (anton-aijz): the batch grammar encoder (pure),
 * and `beads.batch` at the argv/stdin level — which bd it spawns, what it pipes in, and the two
 * ways it degrades to sequential writes (the `ANTON_BD_BATCH` flag, and a bd with no `batch`
 * subcommand). `spawn` is faked so no bd is launched; the real round-trip and the rollback
 * guarantee live in bd-batch.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

// As in bd-abandon.test.ts: pin bd's resolved path to this runner's own executable so
// resolveBdBin() answers hermetically on a box with no bd.
const BD = process.execPath;

const { spawned, failWith } = vi.hoisted(() => ({
  spawned: [] as Array<{
    file: string;
    args: string[];
    options: Record<string, unknown> | undefined;
    stdin?: string;
  }>,
  // When set, `bd batch` exits non-zero with this stderr — how a rollback is induced here. Every
  // other subcommand still succeeds, so the sequential fallback's own writes land.
  failWith: { batchStderr: undefined as string | undefined },
}));

vi.mock("node:child_process", async () => {
  const { makeFakeSpawn } = await import("../testing/spawn");
  return {
    spawn: makeFakeSpawn(spawned, ({ args }) =>
      args[0] === "batch" && failWith.batchStderr !== undefined
        ? { code: 1, stderr: failWith.batchStderr }
        : undefined,
    ),
  };
});

const { beads, batchOpArgs, encodeBatchOps, isMissingBatchCommand, quoteBatchValue, BD_BATCH_ENV } =
  await import("./bd");

const calls = () => spawned.map((c) => [c.file, ...c.args]);

beforeEach(() => {
  spawned.length = 0;
  failWith.batchStderr = undefined;
  delete process.env[BD_BATCH_ENV];
  process.env[BD_BIN_ENV] = BD;
  resetBdBinCache();
});

afterEach(() => {
  delete process.env[BD_BIN_ENV];
  delete process.env[BD_BATCH_ENV];
  resetBdBinCache();
  vi.restoreAllMocks();
});

describe("batch grammar encoding", () => {
  it("emits one command per line, quoting free text", () => {
    expect(
      encodeBatchOps([
        { op: "close", id: "bd-1" },
        { op: "close", id: "bd-2", reason: "abandoned: out of scope" },
        { op: "update", id: "bd-3", fields: { status: "in_progress", title: "a b c" } },
      ]),
    ).toBe(
      'close bd-1\n' +
        'close bd-2 "abandoned: out of scope"\n' +
        'update bd-3 status="in_progress" title="a b c"\n',
    );
  });

  it("escapes the only two escapes bd's tokenizer has, and collapses newlines", () => {
    // The grammar is one command per line with no newline escape, so a multi-line reason has to
    // become one line — every word survives, the line breaks don't.
    expect(quoteBatchValue('he said "no" \\ then left')).toBe('"he said \\"no\\" \\\\ then left"');
    expect(quoteBatchValue("line one\nline two\n\n  line three  ")).toBe(
      '"line one line two line three"',
    );
  });

  it("orders update fields deterministically, whatever the literal's order", () => {
    expect(encodeBatchOps([{ op: "update", id: "bd-1", fields: { title: "t", status: "open" } }])).toBe(
      'update bd-1 status="open" title="t"\n',
    );
  });

  it("refuses an id that would tokenize into two commands, and a field-less update", () => {
    expect(() => encodeBatchOps([{ op: "close", id: "bd-1 close bd-2" }])).toThrow(/unusable bead id/);
    expect(() => encodeBatchOps([{ op: "close", id: "" }])).toThrow(/unusable bead id/);
    expect(() => encodeBatchOps([{ op: "update", id: "bd-1", fields: {} }])).toThrow(/sets no fields/);
  });

  it("maps each op back to the argv the sequential fallback runs", () => {
    expect(batchOpArgs({ op: "close", id: "bd-1" })).toEqual(["close", "bd-1"]);
    expect(batchOpArgs({ op: "close", id: "bd-1", reason: "why" })).toEqual([
      "close",
      "bd-1",
      "--reason",
      "why",
    ]);
    expect(batchOpArgs({ op: "update", id: "bd-1", fields: { priority: 2, assignee: "ada" } })).toEqual(
      ["update", "bd-1", "--priority", "2", "--assignee", "ada"],
    );
  });
});

describe("beads.batch", () => {
  it("pipes every op into ONE `bd batch`", async () => {
    await beads.batch("/repo", [
      { op: "close", id: "bd-1" },
      { op: "close", id: "bd-2" },
    ]);
    expect(calls()).toEqual([[BD, "batch", "--json"]]);
    expect(spawned[0].stdin).toBe("close bd-1\nclose bd-2\n");
  });

  it("spawns nothing for an empty op list", async () => {
    await beads.batch("/repo", []);
    expect(calls()).toEqual([]);
  });

  it("rejects on a real batch failure instead of retrying op-by-op", async () => {
    // bd rolled the transaction back, so every bead is in its prior state. Re-applying the ops one
    // at a time here is exactly how a clean no-op would become a half-applied unit.
    failWith.batchStderr = "line 2 (close bd-9): not found: issue bd-9";
    await expect(
      beads.batch("/repo", [
        { op: "close", id: "bd-1" },
        { op: "close", id: "bd-9" },
      ]),
    ).rejects.toThrow(/not found/);
    expect(calls()).toEqual([[BD, "batch", "--json"]]);
  });

  it("falls back to sequential writes on a bd with no `batch` subcommand", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failWith.batchStderr = 'Error: unknown command "batch" for "bd"';

    await beads.batch("/repo", [
      { op: "close", id: "bd-1", reason: "done" },
      { op: "update", id: "bd-2", fields: { status: "closed" } },
    ]);

    expect(calls()).toEqual([
      [BD, "batch", "--json"],
      [BD, "close", "bd-1", "--reason", "done"],
      [BD, "update", "bd-2", "--status", "closed"],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT all-or-nothing/));
  });

  it("takes the sequential path up front when ANTON_BD_BATCH is off — no batch attempted", async () => {
    for (const off of ["0", "off", "FALSE", "no"]) {
      spawned.length = 0;
      process.env[BD_BATCH_ENV] = off;
      await beads.batch("/repo", [{ op: "close", id: "bd-1" }]);
      expect(calls()).toEqual([[BD, "close", "bd-1"]]);
    }
    // Any other value (including unset) keeps the transaction.
    spawned.length = 0;
    process.env[BD_BATCH_ENV] = "1";
    await beads.batch("/repo", [{ op: "close", id: "bd-1" }]);
    expect(calls()).toEqual([[BD, "batch", "--json"]]);
  });

  it("tells a missing `batch` subcommand apart from a failed transaction", () => {
    expect(isMissingBatchCommand({ stderr: 'unknown command "batch" for "bd"' })).toBe(true);
    // Cobra's own wording, and the same line reached via bd's `Command failed: …\n<stderr>` message.
    expect(isMissingBatchCommand({ stderr: 'Error: unknown command "batch" for "bd"\n' })).toBe(true);
    expect(isMissingBatchCommand(new Error('Command failed\nunknown command "batch" for "bd"'))).toBe(
      true,
    );
    expect(isMissingBatchCommand({ stderr: "line 2 (close bd-9): not found: issue bd-9" })).toBe(false);
    expect(isMissingBatchCommand(undefined)).toBe(false);
  });

  /** Every false positive here rolls a clean rollback forward into a half-applied unit. */
  it("does not read a rolled-back transaction as a missing subcommand", () => {
    // A batch line carrying the phrase in its own text (an abandon reason, a title) is a REAL
    // failure — bd already rolled the whole unit back.
    expect(
      isMissingBatchCommand({
        stderr: 'line 1 (close bd-9): not found: issue titled unknown command "batch" fallback',
      }),
    ).toBe(false);
    // …even when it reproduces the diagnostic word for word: bd echoes the op mid-line, and only a
    // line that IS the diagnostic counts.
    expect(
      isMissingBatchCommand({
        stderr:
          'line 1 (close bd-9 "unknown command \\"batch\\" for \\"bd\\""): not found: issue bd-9',
      }),
    ).toBe(false);
    expect(
      isMissingBatchCommand({
        stderr: 'line 1 (close bd-9 unknown command "batch" for "bd"): not found: issue bd-9',
      }),
    ).toBe(false);
    // Neither field carries the phrase on its own, so joining them must not manufacture it.
    expect(isMissingBatchCommand({ stderr: "unknown command", message: '"batch" for "bd"' })).toBe(
      false,
    );
  });
});

describe("beads.abandonAll", () => {
  it("labels every bead first, then closes the whole unit in one transaction", async () => {
    await beads.abandonAll("/repo", [
      { id: "bd-2", reason: "parent bd-1 abandoned" },
      { id: "bd-1", reason: "not worth building" },
    ]);

    // Labels can't ride the transaction (bd's batch grammar has no label key), so they land first —
    // the only crash state that leaves is "open + abandoned", which no run picks up.
    expect(calls()).toEqual([
      [BD, "update", "bd-2", "--add-label", "abandoned", "--remove-label", "stage:implementing", "--remove-label", "stage:in-review"],
      [BD, "update", "bd-1", "--add-label", "abandoned", "--remove-label", "stage:implementing", "--remove-label", "stage:in-review"],
      [BD, "batch", "--json"],
    ]);
    expect(spawned[2].stdin).toBe(
      'close bd-2 "abandoned: parent bd-1 abandoned"\nclose bd-1 "abandoned: not worth building"\n',
    );
  });

  it("validates every reason before the first write", async () => {
    await expect(
      beads.abandonAll("/repo", [{ id: "bd-1", reason: "fine" }, { id: "bd-2", reason: "  " }]),
    ).rejects.toThrow(/reason/i);
    expect(calls()).toEqual([]);
  });

  it("writes nothing for an empty unit", async () => {
    await beads.abandonAll("/repo", []);
    expect(calls()).toEqual([]);
  });
});
