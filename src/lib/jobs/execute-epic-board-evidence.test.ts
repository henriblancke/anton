import { describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const pushMock = vi.fn<(repo: string) => Promise<string>>();
// The evidence check reads the board through `mustReadBoard` (anton-fc5x review round 2), never a
// bare `bd list --status all` — so the fixture mocks the same seam `loadAllIssues` sits behind,
// matching every other test of a `mustReadBoard` caller in this directory.
const loadAllIssuesMock = vi.fn<(repo: string, opts?: unknown) => Promise<Bead[]>>();
// `setBoardEvidencePending` shells out to `bd update` for real (bdWrite) — mocked so the cross-retry
// marker tests exercise the call, not a live `bd` process against a fake "/repo".
const setBoardEvidencePendingMock = vi.fn<
  (repo: string, id: string, ids: readonly string[], stale?: string[]) => Promise<string>
>();
// The preserved-baseline writes (PR #284 review round 8) shell out to `bd update` too — mocked for
// the same reason `setBoardEvidencePendingMock` is.
const setBoardEvidenceBaselineMock = vi.fn<
  (repo: string, id: string, fingerprint: Record<string, string>) => Promise<string>
>();
const clearBoardEvidenceBaselineMock = vi.fn<(repo: string, id: string) => Promise<string>>();
// The cleanup-push retry obligation (PR #284 review, "retain a retry obligation after cleanup
// push failure") shells out to `bd update` too — mocked for the same reason the baseline writes
// above are.
const setBoardEvidenceCleanupUnsyncedMock = vi.fn<(repo: string, id: string) => Promise<string>>();
const clearBoardEvidenceCleanupUnsyncedMock = vi.fn<(repo: string, id: string) => Promise<string>>();
// The durable delivery-confirmed marker (PR #284 review, "no record that this bead's board-only
// delivery ever happened") shells out to `bd update` too — mocked for the same reason the other
// board-evidence writes above are.
const setBoardEvidenceConfirmedMock = vi.fn<(repo: string, id: string) => Promise<string>>();
// `ensureDescription`'s fallback for a bead the LIST read omitted a description for (PR #284
// review) — mocked so the hydration tests below exercise that fallback, not a live `bd show`
// against a fake "/repo".
const showMock = vi.fn<(repo: string, id: string) => Promise<Bead | undefined>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      push: pushMock,
      setBoardEvidencePending: setBoardEvidencePendingMock,
      setBoardEvidenceBaseline: setBoardEvidenceBaselineMock,
      clearBoardEvidenceBaseline: clearBoardEvidenceBaselineMock,
      setBoardEvidenceCleanupUnsynced: setBoardEvidenceCleanupUnsyncedMock,
      clearBoardEvidenceCleanupUnsynced: clearBoardEvidenceCleanupUnsyncedMock,
      setBoardEvidenceConfirmed: setBoardEvidenceConfirmedMock,
      show: showMock,
    },
  };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (repo: string, opts?: unknown) => loadAllIssuesMock(repo, opts) };
});

const {
  boardEvidence,
  clearBoardEvidencePending,
  fingerprintBoard,
  isBoardOnlyRun,
  readBoardBaseline,
  readBoardEvidence,
} = await import("./execute-epic-board-evidence");
const { LABELS } = await import("../beads/bd");

// Every test below only cares whether the marker write HAPPENED and with what ids — never whether
// the underlying `bd update` "succeeded" — so a resolved no-op is the right default throughout.
setBoardEvidencePendingMock.mockResolvedValue("");
setBoardEvidenceBaselineMock.mockResolvedValue("");
clearBoardEvidenceBaselineMock.mockResolvedValue("");
setBoardEvidenceCleanupUnsyncedMock.mockResolvedValue("");
clearBoardEvidenceCleanupUnsyncedMock.mockResolvedValue("");
setBoardEvidenceConfirmedMock.mockResolvedValue("");

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: `title-${id}`, status: "open", description: "desc", ...over } as Bead;
}

describe("fingerprintBoard / boardEvidence (anton-fc5x)", () => {
  it("reports nothing changed between two identical reads", () => {
    const before = fingerprintBoard([bead("a"), bead("b")]);
    const after = fingerprintBoard([bead("a"), bead("b")]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it("catches an edited description — the anton-f5f3 vocabulary-sweep shape", () => {
    const before = fingerprintBoard([bead("a", { description: "old wording" })]);
    const after = fingerprintBoard([bead("a", { description: "new wording" })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("catches a newly created bead", () => {
    const before = fingerprintBoard([bead("a")]);
    const after = fingerprintBoard([bead("a"), bead("b")]);
    expect(boardEvidence(before, after)).toEqual(["b"]);
  });

  it("catches a bead that disappeared (deleted or superseded away)", () => {
    const before = fingerprintBoard([bead("a"), bead("b")]);
    const after = fingerprintBoard([bead("a")]);
    expect(boardEvidence(before, after)).toEqual(["b"]);
  });

  it("catches a status change (e.g. a superseded bead closed)", () => {
    const before = fingerprintBoard([bead("a", { status: "open" })]);
    const after = fingerprintBoard([bead("a", { status: "closed" })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("ignores bookkeeping-label and note churn — anton's own writes, not the agent's work", () => {
    const before = fingerprintBoard([
      bead("a", { labels: ["stage:implementing"], notes: "old" }),
    ]);
    const after = fingerprintBoard([
      bead("a", {
        labels: ["run-lease:123", "review-score:8"],
        notes: "anton: something",
      }),
    ]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it(
    "ignores the DISPATCHED ticket's own assignee churn — anton's claim/heartbeat rewrites it " +
      "regardless of what the agent did",
    () => {
      const before = fingerprintBoard([bead("a", { assignee: "op-1" })], "a");
      const after = fingerprintBoard([bead("a", { assignee: "op-2" })], "a");
      expect(boardEvidence(before, after)).toEqual([]);
    },
  );

  it(
    "catches an assignee change on any OTHER bead — reserving/reassigning another bead via `bd " +
      "assign` is a supported board-only deliverable that touches no other field (anton-fc5x " +
      "follow-up review)",
    () => {
      const before = fingerprintBoard([bead("a", { assignee: "" })], "dispatched-ticket");
      const after = fingerprintBoard([bead("a", { assignee: "some-other-owner" })], "dispatched-ticket");
      expect(boardEvidence(before, after)).toEqual(["a"]);
    },
  );

  it("catches a priority change — a board-only ticket may exist to reprioritize a batch (anton-fc5x review round 1)", () => {
    const before = fingerprintBoard([bead("a", { priority: 2 })]);
    const after = fingerprintBoard([bead("a", { priority: 0 })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it(
    "catches an acceptance-criteria change — `bd update --acceptance` is a supported board-only " +
      "write that touches neither status nor description (anton-fc5x review round 3)",
    () => {
      const before = fingerprintBoard([bead("a", { acceptance_criteria: "- [ ] old rubric" })]);
      const after = fingerprintBoard([bead("a", { acceptance_criteria: "- [ ] repaired rubric" })]);
      expect(boardEvidence(before, after)).toEqual(["a"]);
    },
  );

  it(
    "catches an external_ref change — attaching/changing a tracker reference is a supported " +
      "board-only write that touches neither status, description nor labels (anton-fc5x review round 4)",
    () => {
      const before = fingerprintBoard([bead("a", { external_ref: undefined })]);
      const after = fingerprintBoard([bead("a", { external_ref: "LIN-123" })]);
      expect(boardEvidence(before, after)).toEqual(["a"]);
    },
  );

  it(
    "catches an issue_type change — `bd update <id> --type task` is a supported board-only " +
      "repair (tiers.mjs) that touches neither status, description nor labels (anton-fc5x review round 5)",
    () => {
      const before = fingerprintBoard([bead("a", { issue_type: "bug" })]);
      const after = fingerprintBoard([bead("a", { issue_type: "task" })]);
      expect(boardEvidence(before, after)).toEqual(["a"]);
    },
  );

  it(
    "catches a content-metadata change — `bd update --set-metadata k=v` is a supported board-only " +
      "write with no other field it necessarily touches (anton-fc5x review round 6)",
    () => {
      const before = fingerprintBoard([bead("a", { metadata: { owner: "team-a" } })]);
      const after = fingerprintBoard([bead("a", { metadata: { owner: "team-b" } })]);
      expect(boardEvidence(before, after)).toEqual(["a"]);
    },
  );

  it(
    "ignores anton's own metadata bookkeeping (pr, retiredPr, boardEvidenceBaseline) churn on top " +
      "of unchanged content metadata (anton-fc5x review round 6)",
    () => {
      const before = fingerprintBoard([
        bead("a", { metadata: { owner: "team-a", pr: "gh-1" } }),
      ]);
      const after = fingerprintBoard([
        bead("a", {
          metadata: { owner: "team-a", pr: "gh-2", retiredPr: "gh-1", boardEvidenceBaseline: "{}" },
        }),
      ]);
      expect(boardEvidence(before, after)).toEqual([]);
    },
  );

  it("catches a content label change — a board-only ticket may exist to relabel/reparent (anton-fc5x review round 1)", () => {
    const before = fingerprintBoard([bead("a", { labels: ["domain:eng"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "size:M"] })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("still ignores bookkeeping labels layered on top of a real content-label change", () => {
    const before = fingerprintBoard([bead("a", { labels: ["domain:eng", "stage:implementing"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "run-lease:123"] })]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it("does not read a reordering of the same labels as a change", () => {
    const before = fingerprintBoard([bead("a", { labels: ["size:M", "domain:eng"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "size:M"] })]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it(
    "KNOWN GAP (anton-fc5x review round 1, finding 2): a write landing on the board from anything " +
      "other than this ticket's own agent — a sibling run, a gardener apply pass — is indistinguishable " +
      "from this ticket's own evidence, because bd exposes no per-edit actor to filter on (see the module " +
      "docstring). Pinned here so a future bd capability that closes this gap is a deliberate change to " +
      "this test, not a silent behavior shift.",
    () => {
      const before = fingerprintBoard([bead("unrelated", { priority: 2 })]);
      // A write this ticket's agent never made — e.g. a concurrent gardener repriotization pass.
      const after = fingerprintBoard([bead("unrelated", { priority: 0 })]);
      expect(boardEvidence(before, after)).toEqual(["unrelated"]);
    },
  );

  it("catches a reparent — a board-only ticket may exist to move a bead under a new parent (anton-fc5x review round 2)", () => {
    const before = fingerprintBoard([bead("a", { parent_id: "epic-1" })]);
    const after = fingerprintBoard([bead("a", { parent_id: "epic-2" })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("catches a dependency edge add/remove — a board-only ticket may exist to `bd dep add`/`bd supersede` (anton-fc5x review round 2)", () => {
    const before = fingerprintBoard([bead("a", { dependencies: [] })]);
    const after = fingerprintBoard([
      bead("a", { dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks" }] }),
    ]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("does not read a reordering of the same dependency edges as a change", () => {
    const deps = [
      { issue_id: "a", depends_on_id: "b", type: "blocks" },
      { issue_id: "a", depends_on_id: "c", type: "related" },
    ];
    const before = fingerprintBoard([bead("a", { dependencies: deps })]);
    const after = fingerprintBoard([bead("a", { dependencies: [...deps].reverse() })]);
    expect(boardEvidence(before, after)).toEqual([]);
  });
});

describe("readBoardBaseline / readBoardEvidence (anton-fc5x)", () => {
  /** mustReadBoard's default retry budget (execute-epic-persist.ts) — queued as distinct
   * rejections (never a persistent `mockRejectedValue`) so the failure does not leak into a
   * later test's mock queue once this call's retries are exhausted. */
  const rejectEveryRetry = () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      loadAllIssuesMock.mockRejectedValueOnce(new Error("bd unreachable"));
    }
  };

  it("returns null when the baseline read fails, so the caller fails closed rather than skip the check", async () => {
    rejectEveryRetry();
    await expect(readBoardBaseline("/repo")).resolves.toBeNull();
  });

  it(
    "reuses a preserved baseline off the ticket instead of taking a fresh read (PR #284 review " +
      "round 8) — a resumed attempt must anchor to the ORIGINAL pre-dispatch board, not one a " +
      "sync pass may have already moved on",
    async () => {
      const preserved = { a: "preserved-hash" };
      const ticketWithBaseline = bead("t-preserved", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      const callsBefore = loadAllIssuesMock.mock.calls.length;
      const baseline = await readBoardBaseline("/repo", ticketWithBaseline);
      expect(baseline).toEqual({ beads: new Map(Object.entries(preserved)) });
      expect(loadAllIssuesMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it("still takes a fresh read when the ticket carries no preserved baseline", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("z")]);
    const baseline = await readBoardBaseline("/repo", bead("t-fresh"));
    expect(baseline).toEqual(fingerprintBoard([bead("z")]));
  });

  it(
    "hydrates a bead's description via `bd show` before fingerprinting when the list read omits " +
      "it (PR #284 review) — a bd variant that drops `description` from `bd list --json` must not " +
      "fold every bead's description to the same empty string",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("hydrate-a", { description: undefined })]);
      showMock.mockResolvedValueOnce(bead("hydrate-a", { description: "real description" }));
      const baseline = await readBoardBaseline("/repo");
      expect(baseline).toEqual(
        fingerprintBoard([bead("hydrate-a", { description: "real description" })]),
      );
      expect(showMock).toHaveBeenCalledWith("/repo", "hydrate-a");
    },
  );

  it(
    "catches a description-only edit end-to-end even though the list read omits the field on both " +
      "sides (PR #284 review) — the exact false negative a board-only ticket whose sole deliverable " +
      "is a description edit would otherwise hit, and why hydration must re-read fresh rather than " +
      "reuse `ensureDescription`'s memo across the baseline and post-run reads",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("hydrate-b", { description: undefined })]);
      showMock.mockResolvedValueOnce(bead("hydrate-b", { description: "before" }));
      const baseline = (await readBoardBaseline("/repo"))!;

      loadAllIssuesMock.mockResolvedValueOnce([bead("hydrate-b", { description: undefined })]);
      showMock.mockResolvedValueOnce(bead("hydrate-b", { description: "after" }));
      pushMock.mockResolvedValueOnce("synced");
      await expect(
        readBoardEvidence("/repo", baseline, bead("t-hydrate")),
      ).resolves.toEqual({ found: true, ids: ["hydrate-b"], synced: true });
    },
  );

  it(
    "treats a description hydration that fails all its retries as an unreadable board, not a " +
      "fabricated empty description (PR #284 review round 11) — a real description on the other " +
      "side of the comparison must never diff against a synthetic '' just because one side's `bd " +
      "show` was flaky",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("hydrate-c", { description: "real description" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      expect(baseline).toEqual(
        fingerprintBoard([bead("hydrate-c", { description: "real description" })]),
      );

      loadAllIssuesMock.mockResolvedValueOnce([bead("hydrate-c", { description: undefined })]);
      showMock.mockRejectedValueOnce(new Error("bd unreachable"));
      showMock.mockRejectedValueOnce(new Error("bd unreachable"));
      showMock.mockRejectedValueOnce(new Error("bd unreachable"));
      pushMock.mockResolvedValueOnce("synced");
      await expect(readBoardEvidence("/repo", baseline, bead("t-hydrate-fail"))).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
    },
  );

  it(
    "bounds concurrent `bd show` hydration reads instead of firing one subprocess per bead at " +
      "once (PR #284 review round 12) — a board with more beads needing hydration than the " +
      "concurrency limit must never have more than the limit in flight simultaneously",
    async () => {
      const needHydration = Array.from({ length: 10 }, (_, i) => bead(`bulk-${i}`, { description: undefined }));
      loadAllIssuesMock.mockResolvedValueOnce(needHydration);
      showMock.mockReset();

      let inFlight = 0;
      let maxInFlight = 0;
      showMock.mockImplementation(async (_repo: string, id: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return bead(id, { description: `resolved-${id}` });
      });

      await readBoardBaseline("/repo");

      expect(showMock).toHaveBeenCalledTimes(10);
      expect(maxInFlight).toBeLessThan(10);
      showMock.mockReset();
    },
  );

  const ticket = bead("t-1");

  it(
    "reports evidenceUnavailable rather than throwing when the post-run read fails all its retries " +
      "(anton-fc5x review round 2) — a thrown error here would skip the board-only NoDeliveryError " +
      "path and fall to generic release handling",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      // The recovery baseline write must now be persisted AND confirmed synced before this reads as
      // plain `evidenceUnavailable` rather than the sharper `baselineUnconfirmed` (PR #284 review
      // round 9) — both succeed here.
      pushMock.mockResolvedValueOnce("synced");
      await expect(readBoardEvidence("/repo", baseline, ticket)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "surfaces a PRIOR attempt's already-confirmed pending ids even when THIS attempt's post-run " +
      "read fails (PR #284 review) — the marker must not be silently dropped just because this " +
      "attempt could not read the board at all",
    async () => {
      const resumedTicket = bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      pushMock.mockResolvedValueOnce("synced");
      await expect(readBoardEvidence("/repo", baseline, resumedTicket)).resolves.toEqual({
        found: true,
        ids: ["a"],
        synced: false,
        evidenceUnavailable: true,
      });
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "preserves this attempt's baseline on the ticket when the post-run read fails outright and " +
      "nothing was pending before (PR #284 review round 8) — the one case a resumed attempt's " +
      "fresh baseline would otherwise silently absorb this ticket's own already-synced writes",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      pushMock.mockResolvedValueOnce("synced");
      const freshTicket = bead("t-baseline");
      await readBoardEvidence("/repo", baseline, freshTicket);
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-baseline",
        Object.fromEntries(baseline.beads),
      );
    },
  );

  it(
    "reports baselineUnconfirmed rather than a plain evidenceUnavailable when the recovery " +
      "baseline is persisted but the confirming push cannot verify it synced (PR #284 review " +
      "round 9) — a baseline that only landed locally does not help a resume on ANOTHER machine",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      const freshTicket = bead("t-baseline-unsynced");
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(readBoardEvidence("/repo", baseline, freshTicket)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
        baselineUnconfirmed: true,
      });
    },
  );

  it(
    "reports baselineUnpersisted, never baselineUnconfirmed, when the recovery baseline write " +
      "itself fails every retry — the push is never reached, and with nothing persisted anywhere " +
      "(not even locally) a same-machine resume is not specially safe the way baselineUnconfirmed's " +
      "is (anton-fc5x review round 7)",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      const freshTicket = bead("t-baseline-unpersisted");
      const pushCallsBefore = pushMock.mock.calls.length;
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(readBoardEvidence("/repo", baseline, freshTicket)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
        baselineUnpersisted: true,
      });
      expect(pushMock.mock.calls.length).toBe(pushCallsBefore);
    },
  );

  it(
    "does not re-persist the baseline when the ticket already carries one — a repeated read " +
      "failure must not churn the write every attempt — but still retries the confirming push and " +
      "still reports baselineUnconfirmed (chatgpt-codex-connector, PR #284 review, \"track whether " +
      "preserved baselines were synced\") rather than silently dropping the flag now that the write " +
      "itself is skipped",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-baseline-again", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      const callsBefore = setBoardEvidenceBaselineMock.mock.calls.length;
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(readBoardEvidence("/repo", baseline, ticketWithBaseline)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
        baselineUnconfirmed: true,
      });
      expect(setBoardEvidenceBaselineMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "confirms an already-preserved baseline as synced once a retried push succeeds " +
      "(chatgpt-codex-connector, PR #284 review) — a same-machine retry must keep trying to confirm " +
      "the recovery baseline, not give up after the first failed push",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-baseline-retry-ok", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      pushMock.mockResolvedValueOnce("synced");
      await expect(readBoardEvidence("/repo", baseline, ticketWithBaseline)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
    },
  );

  it("reports not-found and skips the sync probe when nothing changed", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
    // Mocks in this suite accumulate call history across tests (no per-test reset), so "the sync
    // probe was skipped" is a delta assertion, not an absolute one.
    const callsBefore = pushMock.mock.calls.length;
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: false, ids: [], synced: false });
    expect(pushMock.mock.calls.length).toBe(callsBefore);
  });

  it(
    "recovers evidence after a total post-run read failure with no prior pending ids, across a " +
      "park/resume, even though an independent sync pass already lands this ticket's write before " +
      "the resumed attempt starts (PR #284 review round 8) — the exact stranding the preserved " +
      "baseline exists to prevent",
    async () => {
      // Attempt 1: the agent's write lands locally, but the post-run read fails outright — no
      // prior pending ids exist yet, so `pending` alone cannot carry the evidence forward.
      loadAllIssuesMock.mockResolvedValueOnce([bead("z", { description: "old" })]);
      const firstBaseline = (await readBoardBaseline("/repo"))!;
      const firstTicket = bead("t-recover");
      rejectEveryRetry();
      pushMock.mockResolvedValueOnce("synced");
      const firstAttempt = await readBoardEvidence("/repo", firstBaseline, firstTicket);
      expect(firstAttempt).toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
      const preserved = Object.fromEntries(firstBaseline.beads);
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith("/repo", "t-recover", preserved);

      // Resume: a heartbeat/backstop sync (outside this check) already pushed the write, so a
      // FRESH board read alone would show no diff at all. But the ticket now carries the baseline
      // attempt 1 preserved, and `readBoardBaseline` reuses it instead of reading fresh.
      const resumedTicket = bead("t-recover", { metadata: { boardEvidenceBaseline: JSON.stringify(preserved) } });
      const secondBaseline = (await readBoardBaseline("/repo", resumedTicket))!;
      expect(secondBaseline).toEqual(firstBaseline);
      loadAllIssuesMock.mockResolvedValueOnce([bead("z", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      const secondAttempt = await readBoardEvidence("/repo", secondBaseline, resumedTicket);
      expect(secondAttempt).toEqual({ found: true, ids: ["z"], synced: true });
    },
  );

  it("reports found + synced once a real write lands and the push confirms it", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("synced");
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: true, ids: ["a"], synced: true });
  });

  it(
    "writes the pending marker BEFORE the confirming push, not after (PR #284 review round 7) — on " +
      "a non-server Dolt board the push is what makes a local write visible to another machine, so " +
      "a push taken first would confirm the content edits without ever covering the recovery marker",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      const order: string[] = [];
      setBoardEvidencePendingMock.mockImplementationOnce(() => {
        order.push("marker");
        return Promise.resolve("");
      });
      pushMock.mockImplementationOnce(() => {
        order.push("push");
        return Promise.resolve("synced");
      });
      const result = await readBoardEvidence("/repo", baseline, ticket);
      expect(result).toEqual({ found: true, ids: ["a"], synced: true });
      expect(order).toEqual(["marker", "push"]);
    },
  );

  it("reports found on a shared Dolt server too — propagation is inherent there", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("shared-server");
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result.synced).toBe(true);
  });

  it(
    "reports found but UNSYNCED when the push cannot confirm it — never trusts presence alone — and " +
      "preserves a recovery baseline for the resume (PR #284 review round 13, thread on " +
      "execute-epic-board-evidence.ts:504)",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      const result = await readBoardEvidence("/repo", baseline, ticket);
      expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
    },
  );

  it("reports found but unsynced when the push itself throws, rather than crashing the ticket walk", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockRejectedValueOnce(new Error("push failed: auth"));
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
  });

  it("persists the found-but-unsynced ids on the ticket as a `board-evidence-pending:*` label", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("not-wired");
    await readBoardEvidence("/repo", baseline, ticket);
    expect(setBoardEvidencePendingMock).toHaveBeenCalledWith("/repo", ticket.id, ["a"], []);
  });

  it(
    "preserves this attempt's baseline when the CONFIRMING push fails, even on the fast path where " +
      "the marker already matched `ids` going in and nothing else this call wrote anything (thread " +
      "on execute-epic-board-evidence.ts:504, \"persist recovery state when evidence sync fails\") " +
      "— otherwise a resume on a different machine, where an independent sync channel already " +
      "published this ticket's content, would see that content folded into a fresh baseline as " +
      "pre-existing and reject an idempotent retry as unchanged",
    async () => {
      const wasPending = bead("t-fast-path-baseline", { labels: [LABELS.boardEvidencePending(["a"])] });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      const result = await readBoardEvidence("/repo", baseline, wasPending);
      expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-fast-path-baseline",
        Object.fromEntries(baseline.beads),
      );
    },
  );

  it(
    "does not re-persist the baseline on a confirming-push failure when the ticket already carries " +
      "one — a repeated push failure must not churn the write every attempt — but still reports " +
      "baselineUnconfirmed (chatgpt-codex-connector, PR #284 review, \"track whether preserved " +
      "baselines were synced\"): this shortcut used to return bare `synced: false` with neither flag " +
      "set, silently dropping the same-machine-safe warning for a baseline that survived from an " +
      "earlier attempt",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-fast-path-baseline-again", {
        labels: [LABELS.boardEvidencePending(["a"])],
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      const callsBefore = setBoardEvidenceBaselineMock.mock.calls.length;
      const result = await readBoardEvidence("/repo", baseline, ticketWithBaseline);
      expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
      expect(setBoardEvidenceBaselineMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "retries the marker write through `mustPersist` rather than swallowing the first failure (PR " +
      "#284 review) — a single contended Dolt write must not permanently strand this evidence",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockResolvedValueOnce("");
      const result = await readBoardEvidence("/repo", baseline, ticket);
      expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
      // First attempt rejected, second (the retry) landed — both targeted the same write.
      const calls = setBoardEvidencePendingMock.mock.calls.slice(-2);
      expect(calls[0]).toEqual(["/repo", ticket.id, ["a"], []]);
      expect(calls[1]).toEqual(["/repo", ticket.id, ["a"], []]);
    },
  );

  it(
    "reports markerUnpersisted rather than a plain found+synced verdict when every marker-write " +
      "retry fails (PR #284 review round 5) — the marker is the only durable record of this evidence, " +
      "so the caller must stop here instead of treating this attempt as settled",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      const freshTicket = bead("t-marker-unpersisted");
      const result = await readBoardEvidence("/repo", baseline, freshTicket);
      expect(result).toEqual({
        found: true,
        ids: ["a"],
        synced: true,
        markerUnpersisted: true,
      });
    },
  );

  it(
    "preserves this attempt's baseline when the marker write exhausts every retry (thread on PR " +
      "#284 line 360) — freshIds is real but neither the marker nor a baseline would otherwise carry " +
      "it forward, and a resumed attempt's fresh baseline would then diff an already-changed board " +
      "against itself and find nothing",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      const freshTicket = bead("t-marker-unpersisted-baseline");
      await readBoardEvidence("/repo", baseline, freshTicket);
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-marker-unpersisted-baseline",
        Object.fromEntries(baseline.beads),
      );
    },
  );

  it(
    "does not re-persist the baseline on a marker-write failure when the ticket already carries " +
      "one — a repeated failure must not churn the write every attempt",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-marker-unpersisted-again", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      const callsBefore = setBoardEvidenceBaselineMock.mock.calls.length;
      await readBoardEvidence("/repo", baseline, ticketWithBaseline);
      expect(setBoardEvidenceBaselineMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "retains a matching `board-evidence-pending:*` label once the sync confirms, rather than " +
      "clearing it (anton-fc5x review round 4) — the handoff (attribution + close) hasn't happened " +
      "yet, so the caller must clear it explicitly once it has",
    async () => {
      const wasPending = bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      // Mocks in this suite accumulate call history across tests (no per-test reset), so a "nothing
      // NEW happened" assertion snapshots the count rather than asserting zero calls ever.
      const callsBefore = setBoardEvidencePendingMock.mock.calls.length;
      const result = await readBoardEvidence("/repo", baseline, wasPending);
      expect(result).toEqual({ found: true, ids: ["a"], synced: true });
      // The marker already names exactly this id set, so there's nothing new to persist.
      expect(setBoardEvidencePendingMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "clearBoardEvidencePending releases the marker only once the caller says the handoff finished",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", "t-1", ["a"]);
      expect(setBoardEvidencePendingMock).toHaveBeenCalledWith("/repo", "t-1", [], [
        LABELS.boardEvidencePending(["a"]),
      ]);
    },
  );

  it(
    "clearBoardEvidencePending also releases a preserved baseline (PR #284 review round 8) — its " +
      "recovery job is done once the marker it backs is cleared",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", "t-1", ["a"]);
      expect(clearBoardEvidenceBaselineMock).toHaveBeenCalledWith("/repo", "t-1");
    },
  );

  it(
    "clearBoardEvidencePending confirms the cleanup reached the remote (thread on PR #284 line " +
      "406) — the two writes only clear LOCAL state on a non-server Dolt board, so the push is what " +
      "makes the cleanup itself visible to another machine",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", "t-1", ["a"]);
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "clearBoardEvidencePending throws rather than resolving quietly when both writes land locally " +
      "but the confirming push cannot verify they reached the remote (thread on PR #284 line 406) — " +
      "another machine's pull would otherwise still see the stale marker and baseline as current " +
      "evidence on an already-closed ticket",
    async () => {
      pushMock.mockResolvedValueOnce("not-wired");
      // The retry-obligation marker this failure writes gets its own confirming push too.
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(clearBoardEvidencePending("/repo", "t-cleanup-unsynced", ["a"])).rejects.toThrow(
        /t-cleanup-unsynced/,
      );
    },
  );

  it(
    "persists a cleanup-sync retry obligation before throwing when both writes land locally but " +
      "the push cannot confirm (PR #284 review, \"retain a retry obligation after cleanup push " +
      "failure\") — neither the pending marker nor the preserved baseline survives that failure to " +
      "tell a same-machine resume there is still work to retry, so this is the only trace left",
    async () => {
      pushMock.mockResolvedValueOnce("not-wired");
      // The retry-obligation marker this failure writes gets its own confirming push too.
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-obligation", ["a"]),
      ).rejects.toThrow(/t-cleanup-obligation/);
      expect(setBoardEvidenceCleanupUnsyncedMock).toHaveBeenCalledWith(
        "/repo",
        "t-cleanup-obligation",
        ["a"],
      );
    },
  );

  it(
    "warns that a resume will not auto-retry when the cleanup-sync obligation write itself also " +
      "fails to persist (PR #284 review, \"require the cleanup obligation write to succeed\") — " +
      "with both writes cleared locally and no obligation marker to find, a same-machine resume " +
      "would otherwise see nothing pending and silently skip the retry forever",
    async () => {
      pushMock.mockResolvedValueOnce("not-wired");
      setBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-obligation-lost", ["a"]),
      ).rejects.toThrow(/will NOT automatically retry/);
    },
  );

  it(
    "does not persist a cleanup-sync retry obligation when the local writes themselves never " +
      "landed — that failure is already covered by the surviving marker/baseline",
    async () => {
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      const callsBefore = setBoardEvidenceCleanupUnsyncedMock.mock.calls.length;
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-no-obligation", ["a"]),
      ).rejects.toThrow(/t-cleanup-no-obligation/);
      expect(setBoardEvidenceCleanupUnsyncedMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "persists AND confirms syncing a cleanup-sync retry obligation when the marker and baseline " +
      "clear locally but `setBoardEvidenceConfirmed` alone exhausts its retries (PR #284 review, " +
      "\"preserve an obligation when confirmation persistence fails\" / \"confirm the cleanup-retry " +
      "obligation reaches the remote before throwing\") — the marker and baseline are both gone from " +
      "the board at that point, so a same-machine resume checking only those two survivors would " +
      "otherwise see nothing pending, and a resume on a DIFFERENT machine sees nothing at all unless " +
      "this brand-new obligation write is itself confirmed synced — the earlier combined push never " +
      "ran to cover it, since `cleared` was already false",
    async () => {
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      pushMock.mockResolvedValueOnce("synced");
      const pushCallsBefore = pushMock.mock.calls.length;
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-confirm-failed", ["a"]),
      ).rejects.toThrow(/t-cleanup-confirm-failed/);
      expect(setBoardEvidenceCleanupUnsyncedMock).toHaveBeenCalledWith(
        "/repo",
        "t-cleanup-confirm-failed",
        ["a"],
      );
      expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 1);
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "warns that a cross-machine resume will not see the obligation when its own confirming push " +
      "cannot verify it synced (PR #284 review, \"confirm the cleanup-retry obligation reaches the " +
      "remote before throwing\") — a resume on THIS machine still finds the obligation locally, but " +
      "one on a fresh worktree relies entirely on it having reached the remote",
    async () => {
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidenceConfirmedMock.mockRejectedValueOnce(new Error("dolt contention"));
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-confirm-failed-unsynced", ["a"]),
      ).rejects.toThrow(/resuming elsewhere/);
    },
  );

  it(
    "retries just the confirming push, and releases the obligation once it lands, when called with " +
      "`hasCleanupObligation` even though nothing else is pending (PR #284 review) — the resume path " +
      "for a prior attempt whose two writes both succeeded locally but never confirmed syncing",
    async () => {
      // Two pushes now: one confirming the marker/baseline clear, one confirming the obligation
      // release itself (thread on PR #284 line 618) — the second is exactly what this test asserts.
      pushMock.mockResolvedValueOnce("synced");
      pushMock.mockResolvedValueOnce("synced");
      const markerCallsBefore = setBoardEvidencePendingMock.mock.calls.length;
      const pushCallsBefore = pushMock.mock.calls.length;
      await clearBoardEvidencePending("/repo", "t-cleanup-retry-push", [], false, true);
      expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 2);
      expect(pushMock).toHaveBeenCalledWith("/repo");
      // No pending ids means nothing for the marker write to remove.
      expect(setBoardEvidencePendingMock.mock.calls.length).toBe(markerCallsBefore);
      expect(clearBoardEvidenceCleanupUnsyncedMock).toHaveBeenCalledWith("/repo", "t-cleanup-retry-push");
    },
  );

  it(
    "throws, without treating the obligation as released, when the local clear itself is refused " +
      "(thread on PR #284 line 618) — a swallowed `mustPersist` failure here would leave the " +
      "obligation marker set locally with no error raised, and the caller would move on believing " +
      "cleanup was done",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      clearBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceCleanupUnsyncedMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-release-refused", [], false, true),
      ).rejects.toThrow(/t-cleanup-release-refused/);
    },
  );

  it(
    "throws, without treating the obligation as released, when the local clear lands but the " +
      "confirming push cannot verify it reached the remote (thread on PR #284 line 618) — otherwise " +
      "a later machine still sees the obligation on the board and unnecessarily retries an " +
      "already-settled cleanup",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-release-unsynced", [], false, true),
      ).rejects.toThrow(/t-cleanup-release-unsynced/);
    },
  );

  it(
    "throws again, without releasing the obligation, when a resumed cleanup-only retry's push " +
      "still cannot confirm (PR #284 review)",
    async () => {
      pushMock.mockResolvedValueOnce("not-wired");
      // The retry-obligation marker this failure re-writes gets its own confirming push too.
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-retry-fails", [], false, true),
      ).rejects.toThrow(/t-cleanup-retry-fails/);
      expect(clearBoardEvidenceCleanupUnsyncedMock).not.toHaveBeenCalledWith(
        "/repo",
        "t-cleanup-retry-fails",
      );
    },
  );

  it(
    "clearBoardEvidencePending throws when the confirming push itself throws, rather than crashing " +
      "the ticket walk (thread on PR #284 line 406)",
    async () => {
      pushMock.mockRejectedValueOnce(new Error("push failed: auth"));
      // The retry-obligation marker this failure writes gets its own confirming push too.
      pushMock.mockRejectedValueOnce(new Error("push failed: auth"));
      await expect(clearBoardEvidencePending("/repo", "t-cleanup-push-throws", ["a"])).rejects.toThrow(
        /t-cleanup-push-throws/,
      );
    },
  );

  it(
    "clearBoardEvidencePending does not call push when the local writes never landed — nothing to " +
      "confirm syncing when the writes themselves failed",
    async () => {
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      const callsBefore = pushMock.mock.calls.length;
      await expect(
        clearBoardEvidencePending("/repo", "t-cleanup-no-local-write", ["a"]),
      ).rejects.toThrow(/t-cleanup-no-local-write/);
      expect(pushMock.mock.calls.length).toBe(callsBefore);
    },
  );

  it(
    "retries the marker-clear through mustPersist rather than swallowing the first failure (PR " +
      "#284 review round 8) — a single contended Dolt write must not permanently strand a stale " +
      "marker on an already-closed bead",
    async () => {
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", "t-retry-clear", ["a"]);
      const calls = setBoardEvidencePendingMock.mock.calls.slice(-2);
      expect(calls[0]).toEqual([
        "/repo",
        "t-retry-clear",
        [],
        [LABELS.boardEvidencePending(["a"])],
      ]);
      expect(calls[1]).toEqual([
        "/repo",
        "t-retry-clear",
        [],
        [LABELS.boardEvidencePending(["a"])],
      ]);
    },
  );

  it("clearBoardEvidencePending is a no-op for an empty id set with no preserved baseline", async () => {
    const callsBefore = setBoardEvidencePendingMock.mock.calls.length;
    const baselineCallsBefore = clearBoardEvidenceBaselineMock.mock.calls.length;
    await clearBoardEvidencePending("/repo", "t-1", []);
    expect(setBoardEvidencePendingMock.mock.calls.length).toBe(callsBefore);
    expect(clearBoardEvidenceBaselineMock.mock.calls.length).toBe(baselineCallsBefore);
  });

  it(
    "clearBoardEvidencePending still clears a surviving preserved baseline when no ids are pending " +
      "(PR #284 review) — a prior call can clear the marker and then exhaust its retries on the " +
      "baseline alone, so `hasBaseline` must reach the cleanup even with an empty id set",
    async () => {
      const callsBefore = setBoardEvidencePendingMock.mock.calls.length;
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", "t-baseline-only", [], true);
      expect(clearBoardEvidenceBaselineMock).toHaveBeenCalledWith("/repo", "t-baseline-only");
      // No pending ids means nothing for the marker write to remove — it must not be called at all.
      expect(setBoardEvidencePendingMock.mock.calls.length).toBe(callsBefore);
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "clearBoardEvidencePending throws when clearing a surviving baseline alone exhausts every " +
      "retry (PR #284 review) — the same halt-for-a-human contract as the marker-only failure",
    async () => {
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(
        clearBoardEvidencePending("/repo", "t-baseline-only-stranded", [], true),
      ).rejects.toThrow(/t-baseline-only-stranded/);
    },
  );

  it(
    "throws rather than resolving quietly when the marker-clear exhausts every retry (PR #284 " +
      "review round 9) — a swallowed failure here leaves a stale marker on an already-closed bead " +
      "that a later reopen could read as current evidence for no new work",
    async () => {
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(clearBoardEvidencePending("/repo", "t-marker-stranded", ["a"])).rejects.toThrow(
        /t-marker-stranded/,
      );
    },
  );

  it(
    "throws when the baseline-clear exhausts every retry, even though the marker itself cleared " +
      "fine (PR #284 review round 9) — a surviving preserved baseline anchors a future reopening of " +
      "this ticket to a stale board snapshot",
    async () => {
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
      await expect(clearBoardEvidencePending("/repo", "t-baseline-stranded", ["a"])).rejects.toThrow(
        /t-baseline-stranded/,
      );
    },
  );

  it(
    "a synced check that finds NEW ids beyond the stale marker still writes the expanded set",
    async () => {
      const wasPending = bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" }), bead("b", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([
        bead("a", { description: "swept" }),
        bead("b", { description: "also swept" }),
      ]);
      pushMock.mockResolvedValueOnce("synced");
      const result = await readBoardEvidence("/repo", baseline, wasPending);
      expect(result).toEqual({ found: true, ids: ["a", "b"], synced: true });
      expect(setBoardEvidencePendingMock).toHaveBeenCalledWith("/repo", "t-1", ["a", "b"], [
        LABELS.boardEvidencePending(["a"]),
      ]);
    },
  );

  it(
    "recovers a prior attempt's unsynced evidence across a park/resume, even though the RESUMED " +
      "attempt's own fresh baseline shows no further diff (anton-fc5x follow-up) — the prior " +
      "writes already landed on the board before this attempt's baseline was even read, so only " +
      "the ticket's persisted `board-evidence-pending:*` marker still names them",
    async () => {
      // Attempt 1: the agent's write lands but the push cannot confirm it synced.
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const firstBaseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      const firstAttempt = await readBoardEvidence("/repo", firstBaseline, ticket);
      expect(firstAttempt).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });

      // Resume: a NEW baseline is read against the board as it now stands — already carrying
      // attempt 1's write — and the ticket bead comes back with the marker attempt 1 persisted.
      const resumedTicket = bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      const secondBaseline = (await readBoardBaseline("/repo"))!;
      // The resumed agent makes no further board writes — the work is already done.
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      const secondAttempt = await readBoardEvidence("/repo", secondBaseline, resumedTicket);
      expect(secondAttempt).toEqual({ found: true, ids: ["a"], synced: true });
    },
  );
});

describe("isBoardOnlyRun — reads the label from the ticket OR its run target (anton-fc5x review round 2)", () => {
  const child = bead("anton-child", { labels: [] });

  it("is true when the dispatched TICKET itself carries `delivery:board`", () => {
    const labelledChild = bead("anton-child", { labels: [LABELS.boardOnly] });
    const unlabelledTarget = bead("anton-epic", { labels: [] });
    expect(isBoardOnlyRun({ target: unlabelledTarget }, labelledChild)).toBe(true);
  });

  it(
    "is true when only the run TARGET carries `delivery:board` — the documented shape " +
      "(skills/bd/SKILL.md: the label goes 'on a run target') for a legacy epic or feature whose " +
      "children never carry it themselves",
    () => {
      const labelledTarget = bead("anton-epic", { labels: [LABELS.boardOnly] });
      expect(isBoardOnlyRun({ target: labelledTarget }, child)).toBe(true);
    },
  );

  it("is false when neither the ticket nor its run target carries the label", () => {
    const unlabelledTarget = bead("anton-epic", { labels: [] });
    expect(isBoardOnlyRun({ target: unlabelledTarget }, child)).toBe(false);
  });

  it("is true for a standalone run, where the ticket IS the run target", () => {
    const standalone = bead("anton-standalone", { labels: [LABELS.boardOnly] });
    expect(isBoardOnlyRun({ target: standalone }, standalone)).toBe(true);
  });
});
