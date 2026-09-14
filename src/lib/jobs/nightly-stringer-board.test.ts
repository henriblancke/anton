/**
 * The board read triage routes against (anton-ol1l). Its two failure shapes are the point: a pull
 * that can't reach the remote costs freshness, not the section — while a read that fails entirely
 * must say UNAVAILABLE out loud, because silence would read as an empty board and every signal
 * would mint a fresh orphan cluster.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bead } from "../beads/bd";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const listMock = vi.fn<(cwd: string, args: string[]) => Promise<Bead[]>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: [string]) => pullMock(...a),
      list: (...a: [string, string[]]) => listMock(...a),
    },
  };
});

const { readBoardContext } = await import("./nightly-stringer-board");

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-board-"));
  logPath = join(dir, "session.log");
  pullMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it("pulls the shared board before reading it — a bead invisible here is one triage won't dedupe", async () => {
  await readBoardContext("/tmp/repo", logPath, "sandbox");

  expect(pullMock).toHaveBeenCalledWith("/tmp/repo");
  expect(listMock).toHaveBeenCalledWith("/tmp/repo", ["--status", "all"]);
  const log = readFileSync(logPath, "utf8");
  expect(log.indexOf("board pull before read")).toBeLessThan(log.indexOf("board context:"));
});

it("keeps the section when the pull fails — freshness is the cost, not the read", async () => {
  pullMock.mockRejectedValue(new Error("remote unreachable"));

  expect(await readBoardContext("/tmp/repo", logPath, "sandbox")).not.toContain("UNAVAILABLE");
  expect(listMock).toHaveBeenCalled();
  expect(readFileSync(logPath, "utf8")).toContain("WARNING: board pull failed — remote unreachable");
});

it("says UNAVAILABLE when the read itself fails — silence would read as an empty board", async () => {
  listMock.mockRejectedValue(new Error("bd exploded"));

  const section = await readBoardContext("/tmp/repo", logPath, "sandbox");
  expect(section).toContain("UNAVAILABLE");
  expect(section).toContain("bd exploded");
  expect(readFileSync(logPath, "utf8")).toContain("WARNING: board context unavailable");
});
