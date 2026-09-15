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

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, push: pushMock, setBoardEvidencePending: setBoardEvidencePendingMock },
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

  it("ignores bookkeeping-label, assignee and note churn — anton's own writes, not the agent's work", () => {
    const before = fingerprintBoard([
      bead("a", { labels: ["stage:implementing"], assignee: "op-1", notes: "old" }),
    ]);
    const after = fingerprintBoard([
      bead("a", {
        labels: ["run-lease:123", "review-score:8"],
        assignee: "op-2",
        notes: "anton: something",
      }),
    ]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

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

  const ticket = bead("t-1");

  it(
    "reports evidenceUnavailable rather than throwing when the post-run read fails all its retries " +
      "(anton-fc5x review round 2) — a thrown error here would skip the board-only NoDeliveryError " +
      "path and fall to generic release handling",
    async () => {
      loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
      const baseline = (await readBoardBaseline("/repo"))!;
      rejectEveryRetry();
      await expect(readBoardEvidence("/repo", baseline, ticket)).resolves.toEqual({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
      });
      expect(pushMock).not.toHaveBeenCalled();
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
      await expect(readBoardEvidence("/repo", baseline, resumedTicket)).resolves.toEqual({
        found: true,
        ids: ["a"],
        synced: false,
        evidenceUnavailable: true,
      });
      expect(pushMock).not.toHaveBeenCalled();
    },
  );

  it("reports not-found and skips the sync probe when nothing changed", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a")]);
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: false, ids: [], synced: false });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("reports found + synced once a real write lands and the push confirms it", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("synced");
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: true, ids: ["a"], synced: true });
  });

  it("reports found on a shared Dolt server too — propagation is inherent there", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("shared-server");
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result.synced).toBe(true);
  });

  it("reports found but UNSYNCED when the push cannot confirm it — never trusts presence alone", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("not-wired");
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: true, ids: ["a"], synced: false });
  });

  it("reports found but unsynced when the push itself throws, rather than crashing the ticket walk", async () => {
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    loadAllIssuesMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockRejectedValueOnce(new Error("push failed: auth"));
    const result = await readBoardEvidence("/repo", baseline, ticket);
    expect(result).toEqual({ found: true, ids: ["a"], synced: false });
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
      expect(result).toEqual({ found: true, ids: ["a"], synced: false });
      // First attempt rejected, second (the retry) landed — both targeted the same write.
      const calls = setBoardEvidencePendingMock.mock.calls.slice(-2);
      expect(calls[0]).toEqual(["/repo", ticket.id, ["a"], []]);
      expect(calls[1]).toEqual(["/repo", ticket.id, ["a"], []]);
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
      await clearBoardEvidencePending("/repo", "t-1", ["a"]);
      expect(setBoardEvidencePendingMock).toHaveBeenCalledWith("/repo", "t-1", [], [
        LABELS.boardEvidencePending(["a"]),
      ]);
    },
  );

  it("clearBoardEvidencePending is a no-op for an empty id set", async () => {
    const callsBefore = setBoardEvidencePendingMock.mock.calls.length;
    await clearBoardEvidencePending("/repo", "t-1", []);
    expect(setBoardEvidencePendingMock.mock.calls.length).toBe(callsBefore);
  });

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
      expect(firstAttempt).toEqual({ found: true, ids: ["a"], synced: false });

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
