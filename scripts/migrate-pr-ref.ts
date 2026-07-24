#!/usr/bin/env bun
/**
 * Cutover backfill CLI (anton-ftar): move legacy `gh-*` external_refs to `metadata.pr` across every
 * board anton knows about. Run once alongside the code repoint (T2). Idempotent — re-running is a
 * no-op — so it is safe to run again if a board was added or a first pass was interrupted.
 *
 *   bun scripts/migrate-pr-ref.ts                 # preview every project board (dry-run)
 *   bun scripts/migrate-pr-ref.ts --apply         # apply across every project board
 *   bun scripts/migrate-pr-ref.ts --apply /repo   # apply to explicit repo path(s) only
 *
 * Defaults to the projects registered in anton.db (ANTON_DB or ./anton.db); explicit repo paths
 * override that. Dry-run by default (like `bd prune`); pass --apply to write.
 */
import { getDb, schema } from "@/lib/db";
import { migratePrRefs, planPrRefMigration } from "@/lib/beads/migrate-pr-ref";
import { beads } from "@/lib/beads/bd";

function repoPathsFromArgs(paths: string[]): string[] {
  if (paths.length > 0) return paths;
  return getDb().select({ repoPath: schema.projects.repoPath }).from(schema.projects).all()
    .map((r) => r.repoPath);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const repos = repoPathsFromArgs(args.filter((a) => !a.startsWith("--")));

  if (repos.length === 0) {
    console.error("No repos to migrate: no explicit paths given and anton.db has no projects.");
    process.exit(1);
  }

  console.log(`${apply ? "Applying" : "Previewing (dry-run)"} gh-* → metadata.pr across ${repos.length} board(s)\n`);
  for (const cwd of repos) {
    // In dry-run we plan without writing; --apply performs the same plan and executes it.
    const plan = apply
      ? await migratePrRefs(cwd)
      : planPrRefMigration(await beads.list(cwd, ["--status", "open,in_progress,blocked,closed,deferred"]));
    console.log(`${cwd}: ${plan.length} bead(s)${apply ? " migrated" : " to migrate"}`);
    for (const { id, ref } of plan) console.log(`  ${id}  ${ref} → metadata.pr`);
  }
  if (!apply) console.log("\nDry-run only. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
