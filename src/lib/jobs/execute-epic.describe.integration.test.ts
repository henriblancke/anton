/**
 * End-to-end proof that `step:describe`'s narrative reaches the pull request (anton-aucch /
 * anton-7x273): the describer runs on the committed diff, reports a narrative, and the body `gh pr
 * create` is invoked with OPENS with it — summary, spotlight, risks — ahead of anton's own
 * boilerplate, with the run target's `## Out of scope` read off the bead beside it.
 *
 * This suite exists because of the seam its siblings rely on. `fakeClaudeReadingStdin` answers every
 * describe dispatch with a canned no-narrative result, which is what keeps the other suites' dispatch
 * ledgers and PR bodies identical to what they were before the step existed — and which also makes
 * this path unreachable from any of them. `describeNarrativeClaude` is the one fake that answers the
 * dispatch for real, so this is the only place the narrative's whole route — describer → step facts →
 * run-phase carry → PR body — is driven end to end against real bd/git.
 *
 * Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beads } from "../beads/bd";
import { getJob } from "./queue";
import * as schema from "../db/schema";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  describeNarrativeClaude,
  createExecuteEpicSandbox,
  makeEpicRunner,
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

const SUMMARY = "SUMMARY_MARKER_AUCCH — rewired the describer onto the committed diff.";
const SPOTLIGHT = "SPOTLIGHT_MARKER_AUCCH — start with the step registry entry.";
const RISKS = "RISKS_MARKER_AUCCH — a describer that times out costs the narrative, nothing else.";
const OUT_OF_SCOPE = "OUT_OF_SCOPE_MARKER_AUCCH — the merge gate is untouched.";

describeBd("execute-epic e2e — the describer's narrative reaches the PR (real handler · real bd/git)", () => {
  let sandbox: string;
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ sandbox, repo, binDir, tdb, clock, projectId } = ctx);
  });

  afterAll(() => {
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    await resetPerCaseState(tdb);
  });

  /** A `gh` that dumps the `--body` it was handed; reports no open PR, like the fixture's default. */
  const capturingGh = (name: string, bodyDump: string) =>
    writeBin(
      binDir,
      name,
      `const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='list'){console.log('[]');process.exit(0);}
const i=a.indexOf('--body');if(i>=0){fs.writeFileSync(${JSON.stringify(bodyDump)},a[i+1]);}
console.log('https://github.com/acme/repo/pull/42');process.exit(0);`,
    );

  it("opens the PR body with the narrative the describer reported, ahead of anton's boilerplate", async () => {
    const targetId = await beads.create(repo, {
      title: "Narrated run",
      type: "bug",
      acceptance: "work file exists",
      description: `## Goal\nProve the narrative lands.\n\n## Out of scope\n${OUT_OF_SCOPE}`,
    });
    await beads.approve(repo, targetId);

    const bodyDump = join(sandbox, "narrative-pr-body.txt");
    const okGh = process.env.ANTON_GH_BIN!;
    const okClaude = process.env.ANTON_CLAUDE_BIN!;
    process.env.ANTON_GH_BIN = capturingGh("gh-narrative", bodyDump);
    process.env.ANTON_CLAUDE_BIN = describeNarrativeClaude(binDir, "claude-narrative", {
      summary: SUMMARY,
      spotlight: SPOTLIGHT,
      risks: RISKS,
    });

    try {
      const jobId = await driveEpicRun(makeEpicRunner(ctx), { projectId, epicBeadId: targetId });
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      expect(beads.getPrRef(await beads.show(repo, targetId))).toBe("gh-42");

      const body = readFileSync(bodyDump, "utf8");
      // The narrative LEADS the body: what changed and why, before anton's own "Autonomous run for"
      // line, because that opening is the whole point — a founder reading the PR reads it first.
      expect(body).toContain(SUMMARY);
      expect(body).toContain(`### Review these first\n\n${SPOTLIGHT}`);
      expect(body).toContain(`### Risks\n\n${RISKS}`);
      expect(body.indexOf(SUMMARY)).toBeLessThan(body.indexOf(`Autonomous run for **${targetId}**`));
      // Out of scope rides with the narrative and is read off the BEAD, never the describer — so a
      // swapped reasoning contract cannot change what the PR claims was deliberately left out.
      expect(body).toContain(`## Out of scope\n\n${OUT_OF_SCOPE}`);

      // The narrative is persisted on the run row, which is what a resumed run restores it from
      // (anton-fpkk8) when its own describer reports nothing.
      const run = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;
      expect(JSON.parse(run.narrative!)).toEqual({
        summary: SUMMARY,
        spotlight: SPOTLIGHT,
        risks: RISKS,
      });

      // The describer's session is NOT an `execute` one: an `execute` session settled `done` reads as
      // delivery evidence (`listDeliveriesByBead` in runs.ts), and the describer delivered nothing.
      const sessions = (await tdb.db.select().from(schema.sessions)).filter((s) => s.runId === run.id);
      expect(sessions.filter((s) => s.kind === "describe")).toHaveLength(1);
      expect(sessions.filter((s) => s.kind === "execute")).toHaveLength(1);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
      process.env.ANTON_CLAUDE_BIN = okClaude;
    }
  });
});
