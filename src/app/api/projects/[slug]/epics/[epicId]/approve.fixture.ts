/**
 * Shared fixture for the `approve-*.route.integration.test.ts` suites. The approve route's 26
 * real-db + real-bd cases are split across two sibling files so they can run in parallel — each
 * drives the REAL `POST` handler against a temp anton.db + real bd repo. Every split file builds
 * an identical seeded repo via `setupApproveSuite()` here — a blocked/blocker epic pair, a ready
 * epic with a cross-epic external blocker wired in later, and an `approvy` project row — and
 * exercises a disjoint slice of the scenarios against it.
 *
 * Test-only. Skipped suites (no bd/git) never call this.
 */
import { randomUUID } from "node:crypto";
import { makeBdRepo, makeFileDb, paramsCtx } from "@/lib/testing/integration";

/** `resolveOperator`'s memoized identity is reset by `actAs` — captured once `setupApproveSuite` resolves it. */
let resetOperatorCacheRef: typeof import("@/lib/operator").resetOperatorCache;

/** `paramsCtx({ slug, epicId })`, shorthand for the route's dynamic-params shape. */
export function ctx(slug: string, epicId: string): { params: Promise<{ slug: string; epicId: string }> } {
  return paramsCtx({ slug, epicId });
}

/** Set the resolved operator identity for the next route call (the identity is memoized). */
export function actAs(name: string): void {
  process.env.ANTON_OPERATOR = name;
  resetOperatorCacheRef();
}

/** Every execute-epic job queued for `epicId`, in any status. */
export async function executeEpicJobs(epicId: string) {
  const { getDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const rows = await getDb().select().from(schema.jobs);
  return rows.filter(
    (r) =>
      r.type === "execute-epic" &&
      (JSON.parse(r.payloadJson ?? "{}") as { epicBeadId?: string }).epicBeadId === epicId,
  );
}

/** Park a job the way an exhausted retry budget would, without running the runner. */
export async function parkJob(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDb().update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, id));
}

export interface ApproveSuiteCtx {
  fileDb: ReturnType<typeof makeFileDb>;
  bdRepo: ReturnType<typeof makeBdRepo>;
  repo: string;
  POST: typeof import("./approve/route").POST;
  beads: typeof import("@/lib/beads/bd").beads;
  resetOperatorCache: typeof import("@/lib/operator").resetOperatorCache;
  getDb: typeof import("@/lib/db").getDb;
  schema: typeof import("@/lib/db/schema");
  /** A blocked epic whose child is blocked by a separate blocker epic's child (inferred edge). */
  blocked: string;
  /** A ready epic used to prove the gate reads fresh beads, not a warm board snapshot. */
  ready: string;
  readyChild: string;
  externalBlockerChild: string;
}

/**
 * Build the shared approve-route suite: a temp anton.db, a real bd repo seeded with a
 * blocked/blocker epic pair and a ready epic (plus its later-linked external blocker), and the
 * `approvy` project row the route resolves. Pins `ANTON_OPERATOR=anton-test` before the route
 * module is imported, and preserves the original dynamic-import order (route → beads → operator →
 * db → schema) since it matters relative to the `getDb` singleton.
 */
export async function setupApproveSuite(): Promise<ApproveSuiteCtx> {
  const fileDb = makeFileDb();
  // Pin a deterministic operator identity so the claim soft-lock (owner check + auto-claim) is
  // assertable without depending on the host's global git user.name.
  process.env.ANTON_OPERATOR = "anton-test";

  const { POST } = await import("./approve/route");
  const { beads } = await import("@/lib/beads/bd");
  const { resetOperatorCache } = await import("@/lib/operator");
  const { getDb } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  resetOperatorCacheRef = resetOperatorCache;

  const bdRepo = makeBdRepo();
  const repo = bdRepo.repo;

  // blocked epic's child is blocked by blocker epic's child → inferred blocked→blocker edge.
  const blocked = await beads.create(repo, { title: "Blocked epic", type: "epic" });
  const blocker = await beads.create(repo, { title: "Blocker epic", type: "epic" });
  const t1 = await beads.create(repo, { title: "Ticket in blocked", type: "task" });
  const t2 = await beads.create(repo, { title: "Ticket in blocker", type: "task" });
  await beads.link(repo, t1, blocked, "parent-child");
  await beads.link(repo, t2, blocker, "parent-child");
  await beads.link(repo, t1, t2, "blocks");

  // A second, initially-ready epic plus a standalone blocker whose child we later wire in via a
  // raw `bd` call, simulating another process adding a cross-epic edge behind the board snapshot.
  const ready = await beads.create(repo, { title: "Ready epic", type: "epic" });
  const externalBlocker = await beads.create(repo, { title: "External blocker epic", type: "epic" });
  const readyChild = await beads.create(repo, { title: "Ticket in ready", type: "task" });
  const externalBlockerChild = await beads.create(repo, {
    title: "Ticket in external blocker",
    type: "task",
  });
  await beads.link(repo, readyChild, ready, "parent-child");
  await beads.link(repo, externalBlockerChild, externalBlocker, "parent-child");

  await getDb().insert(schema.projects).values({
    id: randomUUID(),
    slug: "approvy",
    name: "approvy",
    repoPath: repo,
  });

  return {
    fileDb,
    bdRepo,
    repo,
    POST,
    beads,
    resetOperatorCache,
    getDb,
    schema,
    blocked,
    ready,
    readyChild,
    externalBlockerChild,
  };
}
