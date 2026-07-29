#!/usr/bin/env bun
/**
 * One-shot bead-contract report (anton-odlr): every bead the run gate evaluates that falls short of
 * the contract, by bead and section. Run it before switching the hard gate on (anton-j9zs) — a
 * non-zero exit means turning the gate on today would strand a real bead.
 *
 *   bun scripts/contract-report.ts                 # every board registered in anton.db
 *   bun scripts/contract-report.ts /path/to/repo   # explicit board(s) only
 *
 * Read-only: it never writes a bead. Repair is authoring work — the report says WHICH sections are
 * missing, never what belongs in them.
 *
 * This is only the CLI shell: board resolution and exit code. The judgement lives in
 * `@/lib/beads/contract` (shared with the gate) and the tally in `@/lib/beads/contract-report`.
 */
import { buildContractReport, formatContractReport } from "@/lib/beads/contract-report";
import { loadAllIssues } from "@/lib/beads/issues";
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
    console.error("No boards to report on: no explicit paths given and anton.db has no projects.");
    process.exit(1);
  }

  let blocking = 0;
  for (const cwd of repos) {
    // The WHOLE board, closed beads included — the same `--status all` load the runner classifies
    // off. The gated set is derived from the parent graph (a closed feature child still makes its
    // parent a container), and it drops the closed and resume-skipped beads itself.
    const report = buildContractReport(await loadAllIssues(cwd));
    blocking += report.blocking;
    console.log(formatContractReport(report, repos.length > 1 ? cwd : ""));
    console.log("");
  }
  // Non-zero on a blocking gap only: advisory gaps degrade quality, they do not strand a run.
  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
