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
  ensureBoardBaselinePersisted,
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
    "ignores `not-delivered` churn on ANY bead — anton clears it on every claim and sets it on " +
      "nearly every timeout/no-delivery/retirement path, so routine dispatch traffic on an " +
      "unrelated ticket must never fingerprint as this ticket's own board-only evidence (PR #284 review)",
    () => {
      const before = fingerprintBoard([bead("a", { labels: [] })]);
      const after = fingerprintBoard([bead("a", { labels: [LABELS.notDelivered] })]);
      expect(boardEvidence(before, after)).toEqual([]);
    },
  );

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
    "catches a design change — `bd update <id> --design` is a supported board-only write that " +
      "touches neither status, description nor acceptance criteria (PR #284 review, \"Include the " +
      "design field in board fingerprints\")",
    () => {
      const before = fingerprintBoard([bead("a", { design: "old approach" })]);
      const after = fingerprintBoard([bead("a", { design: "revised approach" })]);
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

  it(
    "keeps each bead's fingerprint a fixed-size digest regardless of description length, so a " +
      "mature board's baseline stays well under argv limits when persisted as one --set-metadata " +
      "value (PR #284 review round 16)",
    () => {
      const huge = fingerprintBoard([bead("a", { description: "x".repeat(200_000) })]);
      const tiny = fingerprintBoard([bead("a", { description: "short" })]);
      const [hugeHash] = huge.beads.values();
      const [tinyHash] = tiny.beads.values();
      expect(hugeHash).toHaveLength(16);
      expect(tinyHash).toHaveLength(16);
      expect(hugeHash).not.toEqual(tinyHash);
    },
  );
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
        true,
        true,
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
    "does not re-persist the baseline when the ticket already carries a LOCKED one — a repeated " +
      "read failure must not churn the write every attempt — but still retries the confirming push " +
      "and still reports baselineUnconfirmed (chatgpt-codex-connector, PR #284 review, \"track " +
      "whether preserved baselines were synced\") rather than silently dropping the flag now that " +
      "the write itself is skipped",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-baseline-again", {
        metadata: {
          boardEvidenceBaseline: JSON.stringify(preserved),
          boardEvidenceBaselineLocked: "1",
          boardEvidenceBaselineVerified: "1",
        },
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
    "UPGRADES an existing UNLOCKED baseline to locked rather than skipping the write " +
      "(chatgpt-codex-connector, PR #284 review, \"Set the recovery lock when a baseline already " +
      "exists\") — the pre-dispatch path always leaves an unlocked baseline behind, so treating " +
      "`alreadyPreserved` alone as \"nothing to do\" would let a NEXT attempt's " +
      "`ensureBoardBaselinePersisted` keep refreshing it across a confirming pull, folding in this " +
      "attempt's own delivery and permanently rejecting an idempotent retry as unchanged",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithUnlockedBaseline = bead("t-baseline-upgrade", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      pushMock.mockResolvedValueOnce("synced");
      await expect(readBoardEvidence("/repo", baseline, ticketWithUnlockedBaseline)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-baseline-upgrade",
        Object.fromEntries(baseline.beads),
        true,
        true,
      );
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
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith("/repo", "t-recover", preserved, true, true);

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
        true,
        true,
      );
    },
  );

  it(
    "does not re-persist the baseline on a confirming-push failure when the ticket already carries " +
      "a LOCKED one — a repeated push failure must not churn the write every attempt — but still " +
      "reports baselineUnconfirmed (chatgpt-codex-connector, PR #284 review, \"track whether " +
      "preserved baselines were synced\"): this shortcut used to return bare `synced: false` with " +
      "neither flag set, silently dropping the same-machine-safe warning for a baseline that " +
      "survived from an earlier attempt",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-fast-path-baseline-again", {
        labels: [LABELS.boardEvidencePending(["a"])],
        metadata: {
          boardEvidenceBaseline: JSON.stringify(preserved),
          boardEvidenceBaselineLocked: "1",
          boardEvidenceBaselineVerified: "1",
        },
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
    "UPGRADES an existing UNLOCKED baseline to locked on a confirming-push failure too " +
      "(chatgpt-codex-connector, PR #284 review, \"Set the recovery lock when a baseline already " +
      "exists\") — every recovery-preserve attempt in this function must upgrade an unlocked " +
      "baseline rather than treat its mere presence as nothing left to do",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithUnlockedBaseline = bead("t-fast-path-baseline-upgrade", {
        labels: [LABELS.boardEvidencePending(["a"])],
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("not-wired");
      const result = await readBoardEvidence("/repo", baseline, ticketWithUnlockedBaseline);
      expect(result).toEqual({ found: true, ids: ["a"], synced: false, baselineUnconfirmed: true });
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-fast-path-baseline-upgrade",
        Object.fromEntries(baseline.beads),
        true,
        true,
      );
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
        true,
        true,
      );
    },
  );

  it(
    "does not re-persist the baseline on a marker-write failure when the ticket already carries a " +
      "LOCKED one — a repeated failure must not churn the write every attempt",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithBaseline = bead("t-marker-unpersisted-again", {
        metadata: {
          boardEvidenceBaseline: JSON.stringify(preserved),
          boardEvidenceBaselineLocked: "1",
          boardEvidenceBaselineVerified: "1",
        },
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
    "UPGRADES an existing UNLOCKED baseline to locked on a marker-write failure too " +
      "(chatgpt-codex-connector, PR #284 review, \"Set the recovery lock when a baseline already " +
      "exists\")",
    async () => {
      const preserved = { a: "already-preserved-hash" };
      const ticketWithUnlockedBaseline = bead("t-marker-unpersisted-upgrade", {
        metadata: { boardEvidenceBaseline: JSON.stringify(preserved) },
      });
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
      const baseline = (await readBoardBaseline("/repo"))!;
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
      pushMock.mockResolvedValueOnce("synced");
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      setBoardEvidencePendingMock.mockRejectedValueOnce(new Error("dolt contention"));
      await readBoardEvidence("/repo", baseline, ticketWithUnlockedBaseline);
      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-marker-unpersisted-upgrade",
        Object.fromEntries(baseline.beads),
        true,
        true,
      );
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
      await clearBoardEvidencePending(
        "/repo",
        bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] }),
        ["a"],
      );
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
      await clearBoardEvidencePending(
        "/repo",
        bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] }),
        ["a"],
      );
      expect(clearBoardEvidenceBaselineMock).toHaveBeenCalledWith("/repo", "t-1");
    },
  );

  it(
    "clearBoardEvidencePending confirms the cleanup reached the remote (thread on PR #284 line " +
      "406) — the two writes only clear LOCAL state on a non-server Dolt board, so the push is what " +
      "makes the cleanup itself visible to another machine",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending(
        "/repo",
        bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] }),
        ["a"],
      );
      expect(pushMock).toHaveBeenCalledWith("/repo");
    },
  );

  it(
    "clearBoardEvidencePending persists the confirmation BEFORE clearing either recovery signal " +
      "(chatgpt-codex-connector, PR #284 review, \"Persist confirmation before clearing recovery " +
      "evidence\") — a death between the two clears must never be able to strand a ticket with " +
      "neither the pending marker, the preserved baseline, nor a confirmation behind it",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      const order: string[] = [];
      setBoardEvidenceConfirmedMock.mockImplementationOnce(() => {
        order.push("confirmed");
        return Promise.resolve("");
      });
      setBoardEvidencePendingMock.mockImplementationOnce(() => {
        order.push("marker");
        return Promise.resolve("");
      });
      clearBoardEvidenceBaselineMock.mockImplementationOnce(() => {
        order.push("baseline");
        return Promise.resolve("");
      });
      await clearBoardEvidencePending(
        "/repo",
        bead("t-1", { labels: [LABELS.boardEvidencePending(["a"])] }),
        ["a"],
      );
      expect(order).toEqual(["confirmed", "marker", "baseline"]);
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
      await expect(
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-unsynced", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
      ).rejects.toThrow(/t-cleanup-unsynced/);
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-obligation", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-obligation-lost", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-no-obligation", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-confirm-failed", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-confirm-failed-unsynced", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
      await clearBoardEvidencePending("/repo", bead("t-cleanup-retry-push"), [], false, true);
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
        clearBoardEvidencePending("/repo", bead("t-cleanup-release-refused"), [], false, true),
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
        clearBoardEvidencePending("/repo", bead("t-cleanup-release-unsynced"), [], false, true),
      ).rejects.toThrow(/t-cleanup-release-unsynced/);
    },
  );

  it(
    "re-persists the obligation locally before throwing when its own clear lands but the " +
      "confirming push cannot verify it reached the remote (chatgpt-codex-connector, PR #284 " +
      "review, \"Re-persist the obligation when its clear cannot sync\") — otherwise a " +
      "same-machine resume reads the locally-cleared state as nothing left to retry, while the " +
      "remote may still carry the obligation for a later machine to rediscover and union its ids " +
      "into an unrelated reopened delivery",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      pushMock.mockResolvedValueOnce("not-wired");
      await expect(
        clearBoardEvidencePending("/repo", bead("t-cleanup-resync-obligation"), ["a"], false, true),
      ).rejects.toThrow(/t-cleanup-resync-obligation/);
      expect(setBoardEvidenceCleanupUnsyncedMock).toHaveBeenCalledWith(
        "/repo",
        "t-cleanup-resync-obligation",
        ["a"],
      );
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
        clearBoardEvidencePending("/repo", bead("t-cleanup-retry-fails"), [], false, true),
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
      await expect(
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-push-throws", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
      ).rejects.toThrow(/t-cleanup-push-throws/);
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
        clearBoardEvidencePending(
          "/repo",
          bead("t-cleanup-no-local-write", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
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
      await clearBoardEvidencePending(
        "/repo",
        bead("t-retry-clear", { labels: [LABELS.boardEvidencePending(["a"])] }),
        ["a"],
      );
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
    await clearBoardEvidencePending("/repo", bead("t-1"), []);
    expect(setBoardEvidencePendingMock.mock.calls.length).toBe(callsBefore);
    expect(clearBoardEvidenceBaselineMock.mock.calls.length).toBe(baselineCallsBefore);
  });

  it(
    "removes the ticket's OWN pending label, not one synthesized from `ids` (PR #284 review round " +
      "16) — a cleanup-retry call site passes a UNION of pending + cleanup-unsynced + confirmed ids " +
      "into `ids` for the confirmed-evidence write, which is wider than what the bead's live " +
      "`board-evidence-pending:*` label actually holds; building `--remove-label` from that union " +
      "instead of the real label would target a value the bead never carries",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      const ticket = bead("t-union-recover", { labels: [LABELS.boardEvidencePending(["a"])] });
      // The union passed for `setBoardEvidenceConfirmed` includes ids the pending label never held.
      await clearBoardEvidencePending("/repo", ticket, ["a", "b", "c"]);
      expect(setBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/repo",
        "t-union-recover",
        [],
        [LABELS.boardEvidencePending(["a"])],
      );
      expect(setBoardEvidenceConfirmedMock).toHaveBeenCalledWith("/repo", "t-union-recover", [
        "a",
        "b",
        "c",
      ]);
    },
  );

  it(
    "skips the marker write entirely when the ticket carries no pending label at all, even with a " +
      "non-empty `ids` (PR #284 review round 16) — nothing on the bead matches, so there is nothing " +
      "for `--remove-label` to target",
    async () => {
      pushMock.mockResolvedValueOnce("synced");
      const markerCallsBefore = setBoardEvidencePendingMock.mock.calls.length;
      await clearBoardEvidencePending("/repo", bead("t-nothing-pending"), ["a", "b"]);
      expect(setBoardEvidencePendingMock.mock.calls.length).toBe(markerCallsBefore);
    },
  );

  it(
    "clearBoardEvidencePending still clears a surviving preserved baseline when no ids are pending " +
      "(PR #284 review) — a prior call can clear the marker and then exhaust its retries on the " +
      "baseline alone, so `hasBaseline` must reach the cleanup even with an empty id set",
    async () => {
      const callsBefore = setBoardEvidencePendingMock.mock.calls.length;
      pushMock.mockResolvedValueOnce("synced");
      await clearBoardEvidencePending("/repo", bead("t-baseline-only"), [], true);
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
        clearBoardEvidencePending("/repo", bead("t-baseline-only-stranded"), [], true),
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
      await expect(
        clearBoardEvidencePending(
          "/repo",
          bead("t-marker-stranded", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
      ).rejects.toThrow(/t-marker-stranded/);
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
      await expect(
        clearBoardEvidencePending(
          "/repo",
          bead("t-baseline-stranded", { labels: [LABELS.boardEvidencePending(["a"])] }),
          ["a"],
        ),
      ).rejects.toThrow(/t-baseline-stranded/);
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

describe(
  "ensureBoardBaselinePersisted — durably anchors a fresh baseline before dispatch (PR #284 review, " +
    "\"Persist the board baseline before dispatch\")",
  () => {
    it("persists and confirms synced when the ticket carries no preserved baseline yet, and returns " +
      "the same baseline when the confirming push's pull found nothing new", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("synced");
      // The post-push refresh read (chatgpt-codex-connector, PR #284 review, "Refresh the baseline
      // after the confirming pull") finds the board unchanged, so no second persist/push is expected
      // before the settled baseline is locked for dispatch.
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the lock write
      pushMock.mockResolvedValueOnce("synced"); // the lock's confirming push
      // The lock's own post-push stability re-read (chatgpt-codex-connector, PR #284 review, "Re-read
      // the board after syncing the baseline lock") finds nothing further, so the lock is handed back
      // without another round.
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      // Verified once the lock's own stability re-read comes back stable (chatgpt-codex-connector,
      // PR #284 review, "Distinguish tentative locks before trusting them on resume") — a second
      // write, distinct from the tentative lock write above.
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("synced"); // the verified-marking write's own confirming push
      // That confirming push's own post-push stability re-read (chatgpt-codex-connector, PR #284
      // review, "Re-read after syncing the verified baseline marker") finds nothing further either.
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const pushCallsBefore = pushMock.mock.calls.length;

      await expect(ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline)).resolves.toEqual(
        baseline,
      );

      expect(setBoardEvidenceBaselineMock).toHaveBeenCalledWith(
        "/repo",
        "t-fresh",
        Object.fromEntries(baseline.beads),
      );
      // The final write (chatgpt-codex-connector, PR #284 review, "Lock the baseline before starting
      // dispatch" / "Distinguish tentative locks before trusting them on resume") marks the settled
      // baseline both locked AND verified, before this function ever hands it back for dispatch.
      expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
        "/repo",
        "t-fresh",
        Object.fromEntries(baseline.beads),
        true,
        true,
      );
      expect(pushMock).toHaveBeenCalledWith("/repo");
      // The initial confirming push, the lock's own confirming push, and the verified-marking
      // write's own confirming push (chatgpt-codex-connector, PR #284 review, "Sync the verified
      // baseline marker before dispatch") — that last one confirms the marker reaches the remote
      // BEFORE dispatch, not left for whatever push happens to follow.
      expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 3);
    });

    it("skips re-persisting the ORIGINAL baseline when the ticket already carries a preserved one, " +
      "but still reconfirms sync (chatgpt-codex-connector, PR #284 review, \"Reconfirm a preserved " +
      "baseline before dispatching a retry\") — and still locks it for dispatch, since an unlocked " +
      "preserved baseline is exactly what left the pre-dispatch crash window open", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      const ticketWithBaseline = bead("t-preserved", {
        metadata: { boardEvidenceBaseline: JSON.stringify({ a: "preserved-hash" }) },
      });
      const setCallsBefore = setBoardEvidenceBaselineMock.mock.calls.length;
      pushMock.mockResolvedValueOnce("synced");
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the tentative lock write
      pushMock.mockResolvedValueOnce("synced"); // the lock's confirming push
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]); // the lock's own stability re-read: stable
      setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the verified-marking write
      pushMock.mockResolvedValueOnce("synced"); // the verified-marking write's own confirming push
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]); // that push's own stability re-read: stable

      await expect(
        ensureBoardBaselinePersisted("/repo", ticketWithBaseline, baseline),
      ).resolves.toEqual(baseline);

      // The only writes are the tentative lock and its verified upgrade — no re-persist of the
      // unlocked original.
      expect(setBoardEvidenceBaselineMock.mock.calls.length).toBe(setCallsBefore + 2);
      expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
        "/repo",
        "t-preserved",
        Object.fromEntries(baseline.beads),
        true,
        true,
      );
      expect(pushMock).toHaveBeenCalledWith("/repo");
    });

    it(
      "refreshes and re-persists the baseline when the confirming push's pull (runDoltSync: pull -> " +
        "commit -> push) brought in a remote change the original baseline predates (chatgpt-codex-" +
        "connector, PR #284 review, \"Refresh the baseline after the confirming pull\") — otherwise " +
        "the post-run diff would credit that pulled bead to this ticket's own, no-op delivery",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "before the pull" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced"); // the confirming push, which absorbs the pull below
        // The board, re-read AFTER that push, already reflects a bead another machine changed.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "after the pull" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the refreshed persist
        pushMock.mockResolvedValueOnce("synced"); // the refreshed confirming push
        // The stabilizing re-read after THAT push finds nothing further, so the loop stops here.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "after the pull" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the tentative lock write
        pushMock.mockResolvedValueOnce("synced"); // the lock's confirming push
        // The lock's own post-push stability re-read finds nothing further either.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "after the pull" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // the verified-marking write's own confirming push
        // That confirming push's own post-push stability re-read finds nothing further either.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "after the pull" })]);
        const pushCallsBefore = pushMock.mock.calls.length;

        const refreshed = await ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline);

        expect(refreshed).toEqual(fingerprintBoard([bead("a", { description: "after the pull" })]));
        // The last write marks the REFRESHED baseline locked AND verified, not the original.
        expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
          "/repo",
          "t-fresh",
          Object.fromEntries(refreshed!.beads),
          true,
          true,
        );
        // Only ONE refresh round actually changed anything (one extra persist/push), plus the lock's
        // own confirming push, plus the verified-marking write's own confirming push.
        expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 4);
      },
    );

    it(
      "keeps refreshing across MULTIPLE confirming pushes when each one's own pull absorbs yet " +
        "another remote change (chatgpt-codex-connector, PR #284 review, \"Re-read after the " +
        "refreshed-baseline push\") — a single refresh round would return a baseline that already " +
        "misses a change its OWN confirming push just pulled in, crediting that pre-dispatch change " +
        "to a no-op agent as if it were the agent's own delivery",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]); // round 1 read: drifted
        pushMock.mockResolvedValueOnce("synced"); // round 1's confirming push, which itself pulls v2
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]); // round 2 read: drifted again
        pushMock.mockResolvedValueOnce("synced"); // round 2's confirming push, which finds nothing further
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]); // round 3 read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the lock write
        pushMock.mockResolvedValueOnce("synced"); // the lock's confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]); // lock's own stability re-read: stable
        // (setBoardEvidenceBaselineMock falls back to its global default for the verified-marking
        // write, which this test doesn't otherwise assert on.)
        pushMock.mockResolvedValueOnce("synced"); // the verified-marking write's own confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]); // that push's own stability re-read: stable
        const pushCallsBefore = pushMock.mock.calls.length;

        const refreshed = await ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline);

        expect(refreshed).toEqual(fingerprintBoard([bead("a", { description: "v2" })]));
        // Initial confirming push, plus one more push per round that actually found a diff (rounds
        // 1 and 2), plus the lock's own confirming push once round 3's read comes back stable, plus
        // the verified-marking write's own confirming push.
        expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 5);
      },
    );

    it(
      "fails closed (returns null) rather than dispatch when the board keeps drifting across every " +
        "bounded refresh round — a board under continuous unrelated churn must never let this loop " +
        "run forever chasing a moving target",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        // Every round's read finds a NEW value and every confirming push succeeds — the board never
        // stabilizes within the bounded number of rounds, queued explicitly (this file shares mocks
        // across `it` blocks with no `afterEach` reset, so a persistent `mockImplementation`/
        // `mockResolvedValue` here would leak into every test that runs after it).
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]);
        pushMock.mockResolvedValueOnce("synced");
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]);
        pushMock.mockResolvedValueOnce("synced");
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v3" })]);
        pushMock.mockResolvedValueOnce("synced");

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
      },
    );

    it("returns null when the refreshed baseline's own confirming push never syncs", async () => {
      const baseline = fingerprintBoard([bead("a", { description: "before the pull" })]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("synced");
      loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "after the pull" })]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("not-wired");

      await expect(ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline)).resolves.toBeNull();
    });

    it("returns null when the post-push refresh read cannot be trusted (after retries), rather " +
      "than dispatch against a baseline that may already be stale", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("synced");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        loadAllIssuesMock.mockRejectedValueOnce(new Error("bd unreachable"));
      }

      await expect(ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline)).resolves.toBeNull();
    });

    it("returns null when a preserved baseline's confirming push was never actually synced " +
      "(same bug, resumed-retry shape: the first attempt's write landed but its push failed, so " +
      "this attempt must not skip confirmation just because metadata presence looks done)", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      const ticketWithBaseline = bead("t-preserved", {
        metadata: { boardEvidenceBaseline: JSON.stringify({ a: "preserved-hash" }) },
      });
      pushMock.mockResolvedValueOnce("not-wired");

      await expect(
        ensureBoardBaselinePersisted("/repo", ticketWithBaseline, baseline),
      ).resolves.toBeNull();
    });

    it("returns null, never throws, when the persist itself exhausts every retry", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused"));
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused"));
      setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused"));
      const pushCallsBefore = pushMock.mock.calls.length;

      await expect(ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline)).resolves.toBeNull();
      expect(pushMock.mock.calls.length).toBe(pushCallsBefore);
    });

    it("returns null when the persist lands locally but the confirming push never syncs", async () => {
      const baseline = fingerprintBoard([bead("a")]);
      setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
      pushMock.mockResolvedValueOnce("not-wired");

      await expect(ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline)).resolves.toBeNull();
    });

    it(
      "never refreshes a RECOVERY baseline past a prior dispatched attempt's own writes " +
        "(chatgpt-codex-connector, PR #284 review round 17, \"Preserve recovery baselines when " +
        "resuming dispatched tickets\") — the confirming pull can legitimately surface that SAME " +
        "prior attempt's own not-yet-confirmed delivery, and folding it into a refreshed baseline " +
        "would erase the only pre-delivery snapshot a resumed idempotent agent's evidence check " +
        "needs to diff against",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "before dispatch" })]);
        // VERIFIED, not just locked (chatgpt-codex-connector, PR #284 review, "Distinguish
        // tentative locks before trusting them on resume") — this represents a lock
        // `lockDispatchBaseline` already finished proving stable before the prior attempt ever
        // dispatched, the only shape that is safe to trust untouched here. A locked-but-unverified
        // ticket is the DIFFERENT, unsafe case covered by its own test below.
        const recoveryTicket = bead("t-recovery-locked", {
          metadata: {
            boardEvidenceBaseline: JSON.stringify(Object.fromEntries(baseline.beads)),
            boardEvidenceBaselineLocked: "1",
            boardEvidenceBaselineVerified: "1",
          },
        });
        pushMock.mockResolvedValueOnce("synced");
        const setCallsBefore = setBoardEvidenceBaselineMock.mock.calls.length;
        const loadCallsBefore = loadAllIssuesMock.mock.calls.length;

        // Deliberately no `loadAllIssuesMock` stub queued: were this baseline NOT locked and
        // verified, the confirming pull's post-push refresh read would consume one here (reflecting
        // the prior dispatched attempt's own delivery, still landing) and fold it into a "refreshed"
        // baseline, erasing this recovery snapshot. Locked and verified, that read must never happen
        // at all.

        await expect(
          ensureBoardBaselinePersisted("/repo", recoveryTicket, baseline),
        ).resolves.toEqual(baseline);

        // No refresh read or re-persist — the baseline is returned untouched.
        expect(setBoardEvidenceBaselineMock.mock.calls.length).toBe(setCallsBefore);
        expect(loadAllIssuesMock.mock.calls.length).toBe(loadCallsBefore);
        expect(pushMock).toHaveBeenCalledWith("/repo");
      },
    );

    it(
      "locks the baseline it hands back BEFORE the caller ever dispatches (chatgpt-codex-connector, " +
        "PR #284 review, \"Lock the baseline before starting dispatch\") — so a host death during the " +
        "agent session that follows (writes land, `readBoardEvidence` never runs to set its own lock) " +
        "still leaves a resumed attempt with a locked, never-refreshed baseline to diff the agent's " +
        "idempotent retry against, instead of one a stale unlocked write left free to absorb exactly " +
        "the writes that attempt already made",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "before dispatch" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist, attempt 1
        pushMock.mockResolvedValueOnce("synced"); // attempt 1's confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "before dispatch" })]); // stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // attempt 1's tentative lock write
        pushMock.mockResolvedValueOnce("synced"); // attempt 1's lock-confirming push
        // Attempt 1's lock's own post-push stability re-read finds nothing further.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "before dispatch" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // attempt 1's verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // attempt 1's verified-marking write's own confirming push
        // That confirming push's own post-push stability re-read finds nothing further either.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "before dispatch" })]);

        const attempt1 = await ensureBoardBaselinePersisted("/repo", bead("t-crash"), baseline);
        expect(attempt1).toEqual(baseline);

        // The process dies here, mid-agent-session — after the fixer's own writes land on the board,
        // before this ticket ever reaches `readBoardEvidence`. A resumed attempt reads the LOCKED AND
        // VERIFIED baseline this call just persisted (never a fresh read that would already absorb
        // those writes), and its confirming pull would otherwise pull them straight in.
        const resumedTicket = bead("t-crash", {
          metadata: {
            boardEvidenceBaseline: JSON.stringify(Object.fromEntries(baseline.beads)),
            boardEvidenceBaselineLocked: "1",
            boardEvidenceBaselineVerified: "1",
          },
        });
        pushMock.mockResolvedValueOnce("synced"); // attempt 2's reconfirm push
        const loadCallsBefore = loadAllIssuesMock.mock.calls.length;

        const attempt2 = await ensureBoardBaselinePersisted("/repo", resumedTicket, baseline);

        // Returned untouched — never refreshed against the board the dead attempt's own writes
        // already changed, which is exactly what an unlocked baseline would have folded in.
        expect(attempt2).toEqual(baseline);
        expect(loadAllIssuesMock.mock.calls.length).toBe(loadCallsBefore);
      },
    );

    it(
      "treats a lock left LOCKED-BUT-UNVERIFIED as refreshable, never as a settled recovery baseline " +
        "(chatgpt-codex-connector, PR #284 review, \"Distinguish tentative locks before trusting them " +
        "on resume\") — a process death between `lockDispatchBaseline` persisting its tentative lock " +
        "and that SAME round's own confirming push/re-read proving it stable leaves exactly this " +
        "shape on the board. Blindly trusting it (as a bare `boardEvidenceBaselineLocked` check used " +
        "to) would skip re-reading the board entirely, and a concurrent write landing in that crash " +
        "window would then be credited to a no-op agent as its own delivery once the post-run diff " +
        "runs against this untouched value",
      async () => {
        const staleCandidate = fingerprintBoard([bead("a", { description: "v0" })]);
        const tentativelyLockedTicket = bead("t-tentative", {
          metadata: {
            boardEvidenceBaseline: JSON.stringify(Object.fromEntries(staleCandidate.beads)),
            boardEvidenceBaselineLocked: "1",
            // Deliberately no `boardEvidenceBaselineVerified` — this is the exact tentative shape
            // `lockDispatchBaseline` can leave behind mid-round.
          },
        });
        pushMock.mockResolvedValueOnce("synced"); // ensureBoardBaselinePersisted's own confirming push
        // `lockDispatchBaseline` is re-entered directly (never the free-refresh loop, which would
        // leave a stale `locked` flag behind — see that branch's own comment) and re-verifies the
        // candidate from scratch: its OWN confirming push pulls in a write from the crash window.
        pushMock.mockResolvedValueOnce("synced"); // round 0's lock-confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1 — landed during the crash window" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 1's re-persisted lock, now onto v1
        pushMock.mockResolvedValueOnce("synced"); // round 1's lock-confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1 — landed during the crash window" })]); // stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 1's verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // round 1's verified-marking write's own confirming push
        // That confirming push's own post-push stability re-read finds nothing further either.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1 — landed during the crash window" })]);

        const result = await ensureBoardBaselinePersisted("/repo", tentativelyLockedTicket, staleCandidate);

        // Never the stale tentative value — the concurrent write is folded in, not silently trusted
        // away, so a no-op agent dispatched against this baseline can never be credited with it.
        expect(result).toEqual(fingerprintBoard([bead("a", { description: "v1 — landed during the crash window" })]));
        expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
          "/repo",
          "t-tentative",
          Object.fromEntries(result!.beads),
          true,
          true,
        );
      },
    );

    it(
      "re-locks onto a REFRESHED baseline when the lock's OWN confirming push pulls in a further " +
        "change (chatgpt-codex-connector, PR #284 review, \"Re-read the board after syncing the " +
        "baseline lock\") — `beads.push` is a pull -> commit -> push pass, so this push can itself " +
        "absorb a write that landed after the refresh loop's last stable read, and locking the STALE " +
        "value would let the post-run diff credit that pulled change to a no-op agent",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 1's lock write
        pushMock.mockResolvedValueOnce("synced"); // round 1's lock-confirming push, which pulls in v1
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]); // round 1's stability re-read: drifted
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 2's re-persisted lock, now onto v1
        pushMock.mockResolvedValueOnce("synced"); // round 2's lock-confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]); // round 2's stability re-read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 2's verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // round 2's verified-marking write's own confirming push
        // That confirming push's own post-push stability re-read finds nothing further either.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]);

        const locked = await ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline);

        expect(locked).toEqual(fingerprintBoard([bead("a", { description: "v1" })]));
        expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
          "/repo",
          "t-fresh",
          Object.fromEntries(locked!.beads),
          true,
          true,
        );
      },
    );

    it(
      "re-locks onto a REFRESHED baseline when the VERIFIED-MARKING write's OWN confirming push " +
        "pulls in a further change (chatgpt-codex-connector, PR #284 review, \"Re-read after syncing " +
        "the verified baseline marker\") — that push is a pull -> commit -> push pass too, so a change " +
        "landing between the stability comparison and this push would otherwise land locally while " +
        "the function still returns the stale pre-drift candidate, crediting a no-op agent with it",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 0's tentative lock write
        pushMock.mockResolvedValueOnce("synced"); // round 0's lock-confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // round 0's stability re-read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 0's verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // round 0's verified-marking write's own confirming push
        // That confirming push itself pulled in a concurrent change — the old code returned the STALE
        // `candidate` (v0) right here without ever checking for this.
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 1's re-persisted (unverified) lock, now onto v1
        pushMock.mockResolvedValueOnce("synced"); // round 1's lock-confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]); // round 1's stability re-read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // round 1's verified-marking write
        pushMock.mockResolvedValueOnce("synced"); // round 1's verified-marking write's own confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]); // that push's own stability re-read: stable

        const locked = await ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline);

        // Never the stale v0 candidate the verified-marking push's own pull just invalidated.
        expect(locked).toEqual(fingerprintBoard([bead("a", { description: "v1" })]));
        expect(setBoardEvidenceBaselineMock).toHaveBeenLastCalledWith(
          "/repo",
          "t-fresh",
          Object.fromEntries(locked!.beads),
          true,
          true,
        );
      },
    );

    it(
      "fails closed (returns null) when the lock's own confirming push keeps pulling in further " +
        "drift across every bounded stability round, rather than hand back a locked baseline that " +
        "may still omit a change landing right now",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        // Every lock round's push pulls in yet another change, forever.
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced");
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v1" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced");
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v2" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce("");
        pushMock.mockResolvedValueOnce("synced");
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v3" })]);
        pushMock.mockResolvedValueOnce("synced"); // abandonDispatchBaseline's own confirming clear-push

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        // The exhausted loop locked a candidate every round (each round persists BEFORE its own
        // stability re-read confirms it) — the last of those never-confirmed values must not survive
        // this refusal to dispatch, or the next attempt's `recoveryBaseline` fast path would trust it
        // without ever re-reading the board (chatgpt-codex-connector, PR #284 review, "Refresh locks
        // left by failed pre-dispatch attempts").
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
      },
    );

    it(
      "clears the locked baseline it just wrote when the lock's OWN confirming push never syncs " +
        "(chatgpt-codex-connector, PR #284 review, \"Refresh locks left by failed pre-dispatch " +
        "attempts\") — otherwise a NEXT attempt's `recoveryBaseline` fast path would hand back this " +
        "unconfirmed value for dispatch without ever re-verifying it against the board",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's persist
        pushMock.mockResolvedValueOnce("not-wired"); // lock round 0's confirming push never syncs
        pushMock.mockResolvedValueOnce("synced"); // abandonDispatchBaseline's own confirming clear-push

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
      },
    );

    it(
      "clears the locked baseline it just wrote when the VERIFIED-marking write's own confirming " +
        "push never syncs (chatgpt-codex-connector, PR #284 review, \"Sync the verified baseline " +
        "marker before dispatch\") — a locked-but-unverified value left on the remote would let a " +
        "fresh-machine resume re-verify it against a board the about-to-be-dispatched agent already " +
        "changed, folding that delivery into the baseline and rejecting an idempotent retry as unchanged",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's tentative persist
        pushMock.mockResolvedValueOnce("synced"); // lock round 0's confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // lock's own stability re-read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the verified-marking write, lands locally
        pushMock.mockResolvedValueOnce("not-wired"); // but its own confirming push never syncs
        pushMock.mockResolvedValueOnce("synced"); // abandonDispatchBaseline's own confirming clear-push

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        // Never handed back for dispatch on an unconfirmed verified marker — and the stray locked
        // value this call itself just wrote is cleared rather than left for a later attempt to trust.
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
      },
    );

    it(
      "pushes the clear, not just writing it locally, when the VERIFIED marker's own confirming " +
        "push already landed on the remote and only the POST-verify re-read then fails " +
        "(chatgpt-codex-connector, PR #284 review, \"Confirm abandoned lock removal before " +
        "retrying\") — a local-only clear here would leave the remote still holding the stale " +
        "verified/locked value for a same-machine resume's next pull to reintroduce, or a " +
        "fresh-machine resume to read directly, either crediting later board drift to a no-op agent",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's tentative persist
        pushMock.mockResolvedValueOnce("synced"); // lock round 0's confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // lock's own stability re-read: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // the verified-marking write, lands locally
        pushMock.mockResolvedValueOnce("synced"); // and its own confirming push DOES sync — the verified marker is now live on the remote
        for (let attempt = 0; attempt < 3; attempt += 1) {
          loadAllIssuesMock.mockRejectedValueOnce(new Error("bd unreachable")); // the post-verify re-read exhausts its retries
        }
        pushMock.mockResolvedValueOnce("synced"); // abandonDispatchBaseline's own confirming clear-push, now required to succeed
        const pushCallsBefore = pushMock.mock.calls.length;

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
        // Initial confirming push, the lock's own confirming push, the verified-marking write's own
        // confirming push, plus the clear's own push once the post-verify re-read fails — the clear
        // itself is pushed, not left local-only, since the remote already carries the verified marker
        // this call is trying to invalidate.
        expect(pushMock.mock.calls.length).toBe(pushCallsBefore + 4);
        expect(pushMock).toHaveBeenLastCalledWith("/repo");
      },
    );

    it(
      "clears the locked baseline it just wrote when the lock's OWN post-push stability re-read " +
        "cannot be trusted (after retries), rather than leave a locked-but-never-verified value for " +
        "a later attempt to trust without re-reading the board",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's persist
        pushMock.mockResolvedValueOnce("synced"); // lock round 0's confirming push
        for (let attempt = 0; attempt < 3; attempt += 1) {
          loadAllIssuesMock.mockRejectedValueOnce(new Error("bd unreachable"));
        }
        pushMock.mockResolvedValueOnce("synced"); // abandonDispatchBaseline's own confirming clear-push

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
      },
    );

    it(
      "does NOT attempt to clear a baseline it never actually locked, when the very first lock " +
        "round's own persist fails every retry before `locked` is ever set — nothing was written, " +
        "so there is nothing this call could have left stray",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused")); // lock round 0's persist
        setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused"));
        setBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("bd refused"));
        const clearCallsBefore = clearBoardEvidenceBaselineMock.mock.calls.length;

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).resolves.toBeNull();
        expect(clearBoardEvidenceBaselineMock.mock.calls.length).toBe(clearCallsBefore);
      },
    );

    it(
      "throws rather than silently returning null when abandoning a stale locked baseline exhausts " +
        "every retry on the clear itself (chatgpt-codex-connector, PR #284 review, \"Confirm " +
        "abandoned lock removal before retrying\" — round 2) — a swallowed failure here leaves the " +
        "possibly-verified candidate this round already knows is stale locked on the board for a " +
        "later resume to trust unchecked",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's persist
        pushMock.mockResolvedValueOnce("not-wired"); // lock round 0's confirming push never syncs
        clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
        clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));
        clearBoardEvidenceBaselineMock.mockRejectedValueOnce(new Error("dolt contention"));

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).rejects.toThrow(/t-fresh/);
      },
    );

    it(
      "throws rather than silently returning null when the abandon clear lands locally but its own " +
        "confirming push cannot verify it reached the remote (chatgpt-codex-connector, PR #284 " +
        "review, \"Confirm abandoned lock removal before retrying\" — round 2) — a same-machine " +
        "resume's next pull-first push would otherwise PULL the stale remote lock straight back in, " +
        "undoing the local clear before the resume ever looks at it",
      async () => {
        const baseline = fingerprintBoard([bead("a", { description: "v0" })]);
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // fresh persist
        pushMock.mockResolvedValueOnce("synced"); // initial confirming push
        loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "v0" })]); // refresh loop: stable
        setBoardEvidenceBaselineMock.mockResolvedValueOnce(""); // lock round 0's persist
        pushMock.mockResolvedValueOnce("not-wired"); // lock round 0's confirming push never syncs
        pushMock.mockResolvedValueOnce("not-wired"); // abandonDispatchBaseline's own confirming clear-push never syncs either

        await expect(
          ensureBoardBaselinePersisted("/repo", bead("t-fresh"), baseline),
        ).rejects.toThrow(/t-fresh/);
        expect(clearBoardEvidenceBaselineMock).toHaveBeenLastCalledWith("/repo", "t-fresh");
      },
    );
  },
);

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
