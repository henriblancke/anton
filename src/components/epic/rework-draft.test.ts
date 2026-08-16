/**
 * The send-back's decisions, held away from the dialog's markup (anton-wx7t): which tickets may be
 * sent back, what the route is actually POSTed, and what the founder is told landed.
 */
import { describe, expect, it } from "vitest";

import {
  findingKey,
  initialDraft,
  isDraftComplete,
  reworkCandidates,
  reworkOutcomeMessage,
  reworkPayload,
  reworkPipelineMessage,
  toggleKey,
  type ReworkDraft,
} from "@/components/epic/rework-draft";
import type { ReviewFinding, ReworkResult, Ticket } from "@/lib/types";

const ticket = (over: Partial<Ticket> & { id: string }): Ticket =>
  ({ title: over.id, status: "closed", stage: "done", abandoned: false, ...over }) as Ticket;

const BLOCKING: ReviewFinding = {
  severity: "blocking",
  location: "src/a.ts:12",
  note: "no null guard",
};
const ADVISORY: ReviewFinding = {
  severity: "advisory",
  location: "(general)",
  note: "naming drifts",
};

const DRAFT: ReworkDraft = {
  ticketId: "t-1",
  mode: "reopen",
  summary: "  not actually done  ",
  instructions: "  Add the missing test.  ",
};

const result = (over: Partial<ReworkResult> = {}): ReworkResult =>
  ({
    mode: "reopen",
    ticketId: "t-1",
    reworkedId: "t-1",
    note: "",
    applied: true,
    ...over,
  }) as ReworkResult;

describe("reworkCandidates", () => {
  it("drops abandoned tickets — nothing would pick the work back up", () => {
    const live = reworkCandidates([
      ticket({ id: "t-1" }),
      ticket({ id: "t-2", abandoned: true }),
      ticket({ id: "t-3" }),
    ]);
    expect(live.map((t) => t.id)).toEqual(["t-1", "t-3"]);
  });

  it("opens on the first live ticket, and on nothing when every ticket is abandoned", () => {
    expect(initialDraft(reworkCandidates([ticket({ id: "t-1" })]))).toEqual({
      ticketId: "t-1",
      mode: "reopen",
      summary: "",
      instructions: "",
    });
    expect(initialDraft([]).ticketId).toBe("");
  });
});

describe("isDraftComplete", () => {
  it("needs a ticket and both texts — whitespace is not a reason", () => {
    expect(isDraftComplete(DRAFT)).toBe(true);
    expect(isDraftComplete({ ...DRAFT, ticketId: "" })).toBe(false);
    expect(isDraftComplete({ ...DRAFT, summary: "   " })).toBe(false);
    expect(isDraftComplete({ ...DRAFT, instructions: "" })).toBe(false);
  });
});

describe("findingKey / toggleKey", () => {
  it("separates findings that differ only in severity, location or note", () => {
    const keys = new Set(
      [
        BLOCKING,
        { ...BLOCKING, severity: "advisory" as const },
        { ...BLOCKING, location: "src/b.ts:12" },
        { ...BLOCKING, note: "no undefined guard" },
      ].map(findingKey),
    );
    expect(keys.size).toBe(4);
  });

  it("keeps two findings apart when a location carries the separator", () => {
    // Ticking either of a colliding pair would submit both, so the fields may not run together.
    expect(findingKey({ severity: "blocking", location: "src/a b.ts:1", note: "fails" })).not.toBe(
      findingKey({ severity: "blocking", location: "src/a", note: "b.ts:1 fails" }),
    );
  });

  it("toggles without mutating the set it was handed", () => {
    const first = new Set<string>();
    const ticked = toggleKey(first, "k");
    expect(first.size).toBe(0);
    expect(ticked.has("k")).toBe(true);
    expect(toggleKey(ticked, "k").has("k")).toBe(false);
  });
});

describe("reworkPayload", () => {
  it("trims the texts and attaches only the ticked findings", () => {
    const selected = new Set([findingKey(BLOCKING)]);
    expect(reworkPayload(DRAFT, [BLOCKING, ADVISORY], selected)).toEqual({
      ticketId: "t-1",
      mode: "reopen",
      summary: "not actually done",
      instructions: "Add the missing test.",
      findings: [BLOCKING],
    });
  });

  it("sends no findings when the founder ticked none", () => {
    expect(reworkPayload(DRAFT, [BLOCKING], new Set()).findings).toEqual([]);
  });
});

describe("reworkOutcomeMessage", () => {
  it("names the reopened ticket, the follow-up it created, or the bead the first submit made", () => {
    expect(reworkOutcomeMessage(result())).toBe("t-1 reopened with instructions");
    expect(reworkOutcomeMessage(result({ mode: "follow-up", reworkedId: "new-1" }))).toBe(
      "Follow-up new-1 created from t-1",
    );
    // A double-submit wrote nothing the second time — it must not claim it did.
    expect(reworkOutcomeMessage(result({ applied: false }))).toBe(
      "Already sent back — t-1 carries these instructions",
    );
  });
});

describe("reworkPipelineMessage", () => {
  it("stays silent when no pull request stood in the way", () => {
    expect(reworkPipelineMessage(result())).toBeUndefined();
  });

  it("says the open PR is reused, not replaced — otherwise the founder expects a second one", () => {
    const message = reworkPipelineMessage(
      result({ pipeline: { outcome: "retired", pr: "gh-42", redirected: false } }),
    );
    expect(message).toContain("gh-42");
    expect(message).toContain("same branch");
  });

  it("says a merged PR sent the work to its own target, and that it needs approving", () => {
    const message = reworkPipelineMessage(
      result({
        mode: "follow-up",
        reworkedId: "new-1",
        pipeline: { outcome: "shipped", pr: "gh-42", redirected: false },
      }),
    );
    expect(message).toContain("new-1");
    expect(message).toContain("approve it to run");
  });

  it("names the redirect, so a founder who chose 'acceptance not met' isn't quietly overruled", () => {
    const message = reworkPipelineMessage(
      result({
        mode: "follow-up",
        reworkedId: "new-1",
        pipeline: { outcome: "shipped", pr: "gh-42", redirected: true },
      }),
    );
    expect(message).toContain("acceptance being unmet");
  });
});
