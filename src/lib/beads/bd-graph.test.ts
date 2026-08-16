/**
 * `beads.createGraph` — anton's `bd create --graph` seam, the ONE atomic multi-bead write
 * (skills/bd/SKILL.md). Driven against a real fake-`bd` script (ANTON_BD_BIN) rather than a mocked
 * child_process, because everything worth pinning here lives in the subprocess contract:
 *
 *   - bd reads the plan from a FILE, so this has to write one — and remove it, draft prose included,
 *     whatever the outcome.
 *   - bd reports a plan failure as JSON on STDOUT while exiting non-zero, so the reason has to be
 *     lifted off captured stdout; the generic message built from stderr would name no cause.
 *   - bd DROPS an unknown node field with only a warning, so an id map with a hole in it is the shape
 *     a schema drift would arrive as — and must fail loud rather than answer `undefined`.
 *
 * The rollback half of the contract — a failed plan leaves NOTHING on the board — is a property of
 * bd itself and is pinned against a real one in backlog.integration.test.ts.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { beads, type GraphPlan } from "./bd";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

let dir: string;

/** Write an executable fake `bd` and point resolveBdBin() at it. */
function fakeBd(name: string, lines: string[]): void {
  const path = join(dir, name);
  writeFileSync(path, [...lines, ""].join("\n"), "utf8");
  chmodSync(path, 0o755);
  process.env[BD_BIN_ENV] = path;
  resetBdBinCache();
}

/** Where the fake bd records the argv and the plan file it was handed. */
const argvFile = () => join(dir, "argv");
const planCopy = () => join(dir, "plan-copy.json");

const PLAN: GraphPlan = {
  nodes: [
    {
      key: "epic",
      title: "Reports are shareable outside the app",
      type: "epic",
      labels: ["area:reports"],
      description: "## Goal\n\nAn outcome.\n\n## Success Criteria\n\n- [ ] observable",
    },
    {
      key: "feature",
      title: "Export a report view to CSV",
      type: "feature",
      parent_key: "epic",
      description: "## Goal\n\nA change.\n\n## Acceptance Criteria\n\n- [ ] checkable",
    },
  ],
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-bd-graph-"));
});

afterEach(() => {
  delete process.env[BD_BIN_ENV];
  resetBdBinCache();
  rmSync(argvFile(), { force: true });
  rmSync(planCopy(), { force: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("beads.createGraph", () => {
  it("hands bd one plan file and answers its key → id map", async () => {
    fakeBd("bd-graph-ok", [
      "#!/bin/sh",
      `echo "$@" > ${argvFile()}`,
      `cp "$3" ${planCopy()}`,
      `echo '{"ids":{"epic":"p-1","feature":"p-2"},"schema_version":1}'`,
    ]);

    await expect(beads.createGraph(dir, PLAN)).resolves.toEqual({ epic: "p-1", feature: "p-2" });

    const argv = readFileSync(argvFile(), "utf8").trim().split(" ");
    expect(argv[0]).toBe("create");
    expect(argv[1]).toBe("--graph");
    expect(argv[3]).toBe("--json");
    expect(JSON.parse(readFileSync(planCopy(), "utf8"))).toEqual(PLAN);

    // The plan carried the founder's draft prose; it has no business outliving the call in $TMPDIR.
    expect(existsSync(argv[2]!)).toBe(false);
  });

  // bd exits non-zero with an EMPTY stderr here, so without lifting stdout the founder would see
  // only "Command failed: bd create --graph …" and no reason at all.
  it("lifts bd's stdout error onto the rejection, and still removes the plan file", async () => {
    fakeBd("bd-graph-fails", [
      "#!/bin/sh",
      `echo "$@" > ${argvFile()}`,
      `echo '{"error":"graph create: node \\"feature\\": issue p-nope not found","schema_version":1}'`,
      "exit 1",
    ]);

    await expect(beads.createGraph(dir, PLAN)).rejects.toThrow("issue p-nope not found");

    const planPath = readFileSync(argvFile(), "utf8").trim().split(" ")[2]!;
    expect(existsSync(planPath)).toBe(false);
  });

  it("falls back to the exec's own message when bd's stdout carries no error field", async () => {
    fakeBd("bd-graph-garbles", ["#!/bin/sh", "echo 'not json at all'", "exit 1"]);
    await expect(beads.createGraph(dir, PLAN)).rejects.toThrow("Command failed");
  });

  // A node whose key comes back with no id is what a dropped/renamed plan field looks like from
  // here. Answering the map as-is would hand the caller `undefined` where a bead id belongs.
  it("fails loud when bd's answer omits a planned node", async () => {
    fakeBd("bd-graph-partial", [
      "#!/bin/sh",
      `echo '{"ids":{"epic":"p-1"},"schema_version":1}'`,
    ]);

    await expect(beads.createGraph(dir, PLAN)).rejects.toThrow("no id came back for node(s) feature");
  });
});
