#!/usr/bin/env bun
/**
 * One-shot dependency-type audit (anton-igkb): report every edge already on a board whose type is
 * outside the set `beads.link` now validates against.
 *
 * The guard at the seam only stops the NEXT bad write. bd accepts any string for `--type` and stores
 * it verbatim, so an edge written before the guard — a typo, or a call site broken by a refactor —
 * is still sitting on the board looking like ordering and blocking nothing. This finds those rather
 * than assuming there are none.
 *
 *   bun scripts/audit-link-types.ts            # every project board registered in anton.db
 *   bun scripts/audit-link-types.ts /repo …    # explicit repo path(s) only
 *
 * Read-only. Exits 1 when an UNEXPLAINED stray edge exists (one no bd command anton runs writes),
 * so it can gate a check; `supersedes` edges are reported but do not fail it — bd writes those
 * itself for `bd supersede`.
 *
 * This is only the CLI shell: board resolution and reporting. The rule (which types are allowed, and
 * which strays are explained) lives in `@/lib/beads/link-types` next to the guard it mirrors.
 */
import { beads } from "@/lib/beads/bd";
import { auditLinkTypes, LINK_TYPES, unexplainedEdges } from "@/lib/beads/link-types";
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
  const args = process.argv.slice(2);
  const repos = repoPathsFromArgs(args.filter((a) => !a.startsWith("--")));

  if (repos.length === 0) {
    console.error("No boards to audit: no explicit paths given and anton.db has no projects.");
    process.exit(1);
  }

  console.log(`Auditing dependency types across ${repos.length} board(s)`);
  console.log(`Allowed: ${LINK_TYPES.join(", ")}\n`);

  let unexplained = 0;
  for (const cwd of repos) {
    // `--status all`: a stray edge on a closed bead is still a stray edge, and bd's default list
    // shows only open ones.
    const strays = auditLinkTypes(beads.edgesOf(await beads.list(cwd, ["--status", "all"])));
    unexplained += unexplainedEdges(strays).length;
    console.log(`${cwd}: ${strays.length} edge(s) outside the allowed set`);
    for (const s of strays) {
      const why = s.writtenBy ? `expected — written by ${s.writtenBy}` : "UNEXPLAINED — non-blocking";
      console.log(`  ${s.from} -> ${s.to}  type=${s.type}  (${why})`);
    }
  }

  if (unexplained > 0) {
    console.log(`\n${unexplained} unexplained edge(s). Each is non-blocking: confirm that is what`);
    console.log(`was meant, and rewrite any that was supposed to order work as \`blocks\`.`);
    process.exit(1);
  }
  console.log("\nNo unexplained edge types on any board.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
