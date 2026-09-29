// @vitest-environment jsdom
/**
 * The feature ledger route (anton-pu91i), driven end to end: a real bd board, a real `anton.db` with
 * real invocation rows, the real page component, rendered.
 *
 * An integration test rather than a unit one because the route's whole job is WIRING — resolving a
 * slug, resolving a bead on a real board, and handing both to the fold. Every piece has its own
 * exhaustive unit suite (`feature-ledger*.test.ts`, `ledger-panel.test.tsx`); what nothing else can
 * prove is that a bead a real `bd create` made resolves through this page to figures a real
 * `claude_invocations` row produced.
 *
 * The 404 cases are the other half, and they are not one case but three: an unknown project, an
 * unknown bead, and — the one a presence check would miss — a bead that exists but is NOT a run
 * target. That last is the trap: every bead resolves to some scope, so without the run-target gate
 * a ticket id in the URL renders its own lone spend under a page titled as a feature's total.
 *
 * Skipped without bd + git.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cleanup, render, screen } from "@testing-library/react";

import {
  describeBd,
  makeBdRepo,
  makeFileDb,
  type BdRepo,
  type FileDb,
} from "@/lib/testing/integration";

let bdRepo: BdRepo;
let fileDb: FileDb;
let LedgerPage: typeof import("./page").default;
let beads: typeof import("@/lib/beads/bd").beads;
let resetIssueSnapshots: typeof import("@/lib/beads/snapshot").resetIssueSnapshots;
let getDb: typeof import("@/lib/db").getDb;
let schema: typeof import("@/lib/db/schema");

/** Render the route the way Next calls it: both params as promises. */
const renderPage = async (slug: string, epicId: string) =>
  render(await LedgerPage({ params: Promise.resolve({ slug, epicId }) }));

/** Next's `notFound()` throws a digest-tagged error — this is what catching one looks like. */
async function expect404(slug: string, epicId: string): Promise<void> {
  await expect(renderPage(slug, epicId)).rejects.toMatchObject({
    digest: "NEXT_HTTP_ERROR_FALLBACK;404",
  });
}

describeBd("feature ledger route (temp anton.db + real bd)", () => {
  let projectId = "";
  let feature = "";
  let ticket = "";
  let childTicket = "";

  beforeAll(async () => {
    // Before any `getDb()` import: the singleton resolves ANTON_DB at import time.
    fileDb = makeFileDb();

    ({ default: LedgerPage } = await import("./page"));
    ({ beads } = await import("@/lib/beads/bd"));
    ({ resetIssueSnapshots } = await import("@/lib/beads/snapshot"));
    ({ getDb } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");

    bdRepo = makeBdRepo();
    projectId = randomUUID();
    await getDb().insert(schema.projects).values({
      id: projectId,
      slug: "metered",
      name: "metered",
      repoPath: bdRepo.repo,
    });

    feature = await beads.create(bdRepo.repo, { title: "Metered feature", type: "feature" });
    childTicket = await beads.create(bdRepo.repo, {
      title: "Its ticket",
      type: "task",
      deps: [`parent-child:${feature}`],
    });
    // A parentless task: a run target in its own right (an epic-of-one), so it HAS a ledger.
    ticket = await beads.create(bdRepo.repo, { title: "Standalone", type: "task" });

    // Two invocations across the scope, in two phases — the split is the page's whole point, so a
    // fixture spending in only one phase could not tell a working fold from a collapsed one. The
    // child's row is what proves the scope walked past the feature itself.
    await getDb()
      .insert(schema.claudeInvocations)
      .values([
        {
          id: randomUUID(),
          projectId,
          jobType: "execute-epic",
          step: "implement",
          stepHandler: "implement",
          runId: "run-1",
          beadId: childTicket,
          modelRequested: "claude-opus-5",
          modelReported: "claude-opus-5",
          endpointHost: "api.anthropic.com",
          inputTokens: 40_000,
          outputTokens: 20_000,
          outcome: "ok",
          recordedAt: new Date(Date.parse("2026-09-20T09:00:00Z")),
          durationMs: 120_000,
        },
        {
          id: randomUUID(),
          projectId,
          jobType: "execute-epic",
          step: "review",
          stepHandler: "review",
          runId: "run-1",
          beadId: feature,
          modelRequested: "claude-opus-5",
          modelReported: "claude-opus-5",
          endpointHost: "api.anthropic.com",
          inputTokens: 10_000,
          outputTokens: 5_000,
          outcome: "ok",
          recordedAt: new Date(Date.parse("2026-09-20T09:30:00Z")),
          durationMs: 60_000,
        },
      ]);

    // The page reads the board through the snapshot cache, which the creates above just dirtied.
    resetIssueSnapshots();
  });

  // Per case, not just at the end: every case asserts on the ABSENCE of something (no empty state,
  // no table), and a render left mounted by the previous one answers those queries instead.
  afterEach(cleanup);

  afterAll(() => {
    bdRepo?.cleanup();
    fileDb?.cleanup();
  });

  it("renders a seeded feature's ledger, folded over its whole scope", async () => {
    await renderPage("metered", feature);

    // The phase SPLIT, which is the answer this page exists to give: the child's implement spend and
    // the feature's own self-review spend, as separate rows rather than one merged total.
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Implement")).toBeTruthy();
    expect(screen.getByText("Self-review")).toBeTruthy();

    // The scope is stated, so a reader can check the total against something. One child ticket.
    expect(screen.getByText(new RegExp(`${feature} · feature \\+ 1 tickets`))).toBeTruthy();

    // Nothing recorded would render the empty state instead — assert we did NOT get it, or every
    // claim above could pass over a page showing no figures at all.
    expect(screen.queryByText(/Nothing recorded for this feature yet/)).toBeNull();
  });

  it("renders the empty state, not zeros, for a run target that spent nothing", async () => {
    // `ticket` is a real run target with no invocation rows — "we measured nothing", which must not
    // read as "this was free".
    await renderPage("metered", ticket);

    expect(screen.getByText(/Nothing recorded for this feature yet/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("404s an unknown project, an unknown bead, and a bead that is not a run target", async () => {
    await expect404("no-such-project", feature);
    await expect404("metered", "anton-nope");
    // The case a presence check would pass: a real bead, on the real board, whose spend belongs to
    // its parent's ledger rather than to one of its own.
    await expect404("metered", childTicket);
  });
});
