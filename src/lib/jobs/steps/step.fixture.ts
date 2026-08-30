/**
 * The shared harness for the step suites: a real in-memory anton.db, a temp worktree, and a
 * {@link StepContext} pointed at both.
 *
 * Real db, fake claude — the same seam the registry suite uses. "The step recorded a session" is
 * then asserted on the rows the UI reads rather than on a spy that can agree with a broken step.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schema } from "../../db";
import { makeTestDb, type TestDb } from "../../db/testing";
import type { Bead } from "../../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../../claude/driver";
import type { Clock } from "../queue";
import type { StepContext } from "./context";

export const BRANCH = "anton/anton-8d0f";

export class FixedClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

export const clock = new FixedClock(1_700_000_000_000);

export const target: Bead = {
  id: "anton-8d0f",
  title: "Decompose the step registry",
  status: "in_progress",
  issue_type: "feature",
  description: "## Goal\n\nThe registry wires.\n\n## Acceptance\n\n- [ ] it does\n",
};

/** A fake claude driver: scripted replies plus the options each dispatch actually received. */
export function fakeClaude(...replies: Array<string | ClaudeResult | Error>) {
  const calls: RunClaudeOptions[] = [];
  const run = async (options: RunClaudeOptions): Promise<ClaudeResult> => {
    calls.push(options);
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error(`unscripted claude dispatch #${calls.length}`);
    if (next instanceof Error) throw next;
    return typeof next === "string" ? { ok: true, text: next } : next;
  };
  return { run, calls };
}

export interface StepSandbox {
  dir: string;
  tdb: TestDb;
  projectId: string;
  runId: string;
  context: (overrides?: Partial<StepContext>) => StepContext;
}

/**
 * Stand up the sandbox. The caller owns teardown via {@link closeSandbox} — sessions write under
 * `ANTON_SESSIONS_ROOT`, which is redirected into the temp dir so no suite touches the real one.
 */
export async function openSandbox(name: string): Promise<StepSandbox & { priorSessionsRoot?: string }> {
  const dir = mkdtempSync(join(tmpdir(), `anton-${name}-`));
  const priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  const tdb = makeTestDb();
  const projectId = randomUUID();
  const runId = randomUUID();
  await tdb.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: dir,
    defaultBranch: "main",
  });
  await tdb.db.insert(schema.runs).values({
    id: runId,
    projectId,
    epicBeadId: target.id,
    branch: BRANCH,
    status: "running",
  });

  const context = (overrides: Partial<StepContext> = {}): StepContext => ({
    db: tdb.db,
    clock,
    ctx: { signal: new AbortController().signal, heartbeat: async () => {}, report: () => {} },
    projectId,
    runId,
    repoPath: dir,
    worktreePath: dir,
    branch: BRANCH,
    baseBranch: "main",
    baseRef: "origin/main",
    target,
    tickets: [target],
    settings: {},
    ...overrides,
  });

  return { dir, tdb, projectId, runId, context, priorSessionsRoot };
}

export function closeSandbox(sandbox: { dir: string; tdb: TestDb; priorSessionsRoot?: string }): void {
  sandbox.tdb.close();
  if (sandbox.priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = sandbox.priorSessionsRoot;
  rmSync(sandbox.dir, { recursive: true, force: true });
}
