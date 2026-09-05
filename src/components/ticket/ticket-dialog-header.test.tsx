// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TicketDialogHeader } from "@/components/ticket/ticket-dialog-header";
import type { TicketDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const detail = (over: Partial<TicketDetail> = {}): TicketDetail =>
  ({
    id: "bd-1",
    title: "Do the thing",
    status: "open",
    stage: "backlog",
    type: "task",
    assignee: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    approved: false,
    deferred: false,
    abandoned: false,
    notes: [],
    ...over,
  }) as TicketDetail;

/** The header's only network reach is the shared operator identity ClaimControl resolves. */
const stubOperator = (operator: string | null = "hb") =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ operator }), { status: 200 })),
  );

function show(over: Partial<TicketDetail> = {}, props: { approved?: boolean } = {}) {
  const onLinked = vi.fn();
  const onClaimChanged = vi.fn();
  render(
    <TicketDialogHeader
      slug="anton"
      detail={detail(over)}
      approved={props.approved ?? false}
      onLinked={onLinked}
      onClaimChanged={onClaimChanged}
    />,
  );
  return { onLinked, onClaimChanged };
}

beforeEach(() => stubOperator());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the identity block", () => {
  it("names the ticket by id and type, with its creation credited", () => {
    show({ createdBy: "hb" });
    expect(screen.getByText("bd-1")).toBeDefined();
    expect(screen.getByText(/· task/)).toBeDefined();
    expect(screen.getByText(/by hb/)).toBeDefined();
  });

  it("keeps stage and resolution out of the header — the state bar is their one home", () => {
    show({ stage: "in-review" });
    expect(screen.queryByText(/in-review/i)).toBeNull();
  });
});

describe("the PR affordance", () => {
  it("lets a standalone task be linked or relinked", () => {
    show({ prRef: "gh-44", prUrl: "https://github.com/x/y/pull/44" });
    // PrLinkControl pre-fills the current number so submitting acts as a relink.
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("44");
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/x/y/pull/44");
  });

  it("shows a child ticket's PR read-only — it ships through its epic's PR", () => {
    show({ epicId: "anton-epic", prRef: "gh-44", prUrl: "https://github.com/x/y/pull/44" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/x/y/pull/44");
  });

  it("shows nothing at all for a child ticket with no PR yet", () => {
    show({ epicId: "anton-epic" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("who holds the ticket", () => {
  it("offers the claim control on a parentless task, which is a run target of its own", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Claim" })).toBeDefined());
    expect(screen.getByText("Unclaimed")).toBeDefined();
  });

  it("locks the claim control once approved — the claim route 409s past that point", async () => {
    show({ assignee: "someone" }, { approved: true });
    await waitFor(() => expect(screen.getByText("someone")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Steal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("surfaces a backlog take-over as the one ownership move an approved target allows", async () => {
    show({ assignee: "someone", stage: "backlog" }, { approved: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Take over" })).toBeDefined());
  });

  it("shows a child ticket's owner as inherited from its epic", () => {
    show({ epicId: "anton-epic", epicAssignee: "hb" });
    expect(screen.getByText("· inherited")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
  });

  it("shows a parentless non-run-target's owner read-only — it can never be claimed", () => {
    show({ type: "learning", assignee: "hb" });
    expect(screen.getByText("hb")).toBeDefined();
    expect(screen.queryByText("· inherited")).toBeNull();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
  });
});
