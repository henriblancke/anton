/** Offline board benchmark. Requires an exported bead JSON array and a disposable SQLite snapshot.
 * node --import tsx scripts/bench-board.mts /tmp/beads.json /tmp/anton-snapshot.db anton
 * The supplied database is opened read-only and backed up again before any application imports.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import type { Bead } from "../src/lib/beads/types";

const [beadsPath, databasePath, slug] = process.argv.slice(2);
if (!beadsPath || !databasePath || !slug) {
  throw new Error("Usage: node --import tsx scripts/bench-board.mts BEADS_JSON SQLITE_SNAPSHOT PROJECT_SLUG");
}
const all: Bead[] = JSON.parse(readFileSync(beadsPath, "utf8"));
if (!Array.isArray(all)) throw new Error("Expected an exported bead array");
const directory = mkdtempSync(join(tmpdir(), "anton-board-bench-"));
const database = join(directory, "anton.db");
const source = new Database(databasePath, { readonly: true, fileMustExist: true });
try { await source.backup(database); } finally { source.close(); }
process.env.ANTON_DB = database;
process.env.ANTON_RUNNER = "off";

try {
  const { beads } = await import("../src/lib/beads/bd");
  // No bd subprocesses or remote board access. Gate listings use the same captured snapshot.
  beads.list = async () => all;
  const { getBoard, getBoardVersion, getBoardTarget, getBoardHealth } = await import("../src/lib/board");
  const { getProjectBySlug } = await import("../src/lib/projects");
  const { buildTicketRows } = await import("../src/lib/tickets");
  const { createBlockerIndex } = await import("../src/lib/epic-graph");
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error(`Unknown snapshot project: ${slug}`);
  async function measure(name: string, read: () => unknown | Promise<unknown>, samples = 10) {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await read();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(name, { samples, medianMs: +times[Math.floor(samples / 2)]!.toFixed(2), minMs: +times[0]!.toFixed(2), maxMs: +times.at(-1)!.toFixed(2) });
  }
  console.log({ issues: all.length, closed: all.filter((bead) => bead.status === "closed").length });
  await measure("cold board", () => getBoard(project), 1);
  await measure("warm board", () => getBoard(project));
  await measure("version only", () => getBoardVersion(project));
  await measure("health projection", () => getBoardHealth(project));
  await measure("ticket rows", () => buildTicketRows(all));
  await measure("shared blocker index", () => {
    const index = createBlockerIndex(all);
    for (const bead of all) { index.epic(bead.id); index.standalone(bead.id); }
  });
  const board = await getBoard(project);
  const target = board.columns.backlog[0]?.id ?? board.standalone.backlog[0]?.id;
  if (target) await measure("approval projection", () => getBoardTarget(project, all, target));
  const json = JSON.stringify(board);
  console.log("payload", { bytes: Buffer.byteLength(json), gzipBytes: gzipSync(json).length });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
