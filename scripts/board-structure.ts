#!/usr/bin/env bun
/**
 * One-shot tier-structure report: every live bead whose place in `epic → feature → ticket` is wrong,
 * by bead and rule. The mechanical half of `/shape`'s Phase 5 — `bd children <epic-id>` prints
 * titles, not tiers, so a board of empty features renders as a healthy tree there and fails here.
 *
 *   bun scripts/board-structure.ts                 # every board registered in anton.db
 *   bun scripts/board-structure.ts /path/to/repo   # explicit board(s) only
 *   npm run board:check -- /path/to/repo
 *
 * Exit code is the point: non-zero means the board carries a DEAD bead — one no run target and no
 * ticket sweep will ever reach. Advisory faults (a feature with no epic, a feature with no tickets,
 * a feature past its ticket budget) print and exit 0; they cost later, they do not strand work.
 *
 * Read-only: it never writes a bead. Repair is authoring work — the report says which bead is in the
 * wrong place and the command that moves it, never what the right shape of the work is.
 *
 * This is only the CLI shell: board resolution and exit code. The judgement lives in
 * `@/lib/beads/structure`, shared with the approve gate, so the command and the gate agree.
 */
import { loadAllIssues } from "@/lib/beads/issues";
import { buildStructureReport, formatStructureReport } from "@/lib/beads/structure";
import { getDb, schema } from "@/lib/db";

function repoPathsFromArgs(paths: string[]): string[] {
  if (paths.length > 0) return paths;
  return getDb()
    .select({ repoPath: schema.projects.repoPath })
    .from(schema.projects)
    .all()
    .map((r) => r.repoPath);
}

async function main() {
  const repos = repoPathsFromArgs(process.argv.slice(2).filter((a) => !a.startsWith("--")));
  if (repos.length === 0) {
    console.error("No boards to check: no explicit paths given and anton.db has no projects.");
    process.exit(1);
  }

  let blocking = 0;
  for (const cwd of repos) {
    // The WHOLE board, closed beads included — container-ness is read off the parent graph, and an
    // epic whose only feature child is closed still strands its loose tickets.
    const report = buildStructureReport(await loadAllIssues(cwd));
    blocking += report.blocking;
    console.log(formatStructureReport(report, repos.length > 1 ? cwd : ""));
    console.log("");
  }
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
