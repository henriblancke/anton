// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EscalationActions } from "@/components/board/escalation-actions";

const refresh = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(over: Partial<Parameters<typeof EscalationActions>[0]> = {}) {
  render(
    <EscalationActions slug="anton" escalationId="esc-1" canResume canAbandon {...over} />,
  );
}

describe("EscalationActions — resume", () => {
  it("POSTs the resume decision and refreshes the server-rendered panel", async () => {
    const fetchMock = stubFetch({ action: "resume", detail: "enqueued" });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/escalations/esc-1",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "resume" }) }),
    );
  });

  it("reports what actually happened, so 'resumed' never overstates a no-op", async () => {
    stubFetch({ action: "resume", detail: "already-active" });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(success).toHaveBeenCalledWith("Already running — nothing to restart"));
  });

  it("surfaces the server's reason when the escalation was already settled", async () => {
    stubFetch({ error: "This escalation has already been settled" }, 409);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("This escalation has already been settled"),
    );
    expect(refresh).not.toHaveBeenCalled();
    // Re-enabled: the operator can retry once they know why it failed.
    expect(screen.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("EscalationActions — abandon", () => {
  it("requires a confirm step before closing the work", async () => {
    const fetchMock = stubFetch({ action: "abandon", detail: "abandoned" });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    expect(fetchMock).not.toHaveBeenCalled(); // arming is not acting

    fireEvent.click(screen.getByRole("button", { name: "Confirm abandon" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/escalations/esc-1",
      expect.objectContaining({ body: JSON.stringify({ action: "abandon" }) }),
    );
  });

  it("can be backed out of without sending anything", async () => {
    const fetchMock = stubFetch({});
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Abandon" })).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("EscalationActions — what the escalation can support", () => {
  it("offers only the answers the finding names a target for", () => {
    mount({ canResume: false });
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abandon" })).toBeDefined();

    cleanup();
    mount({ canAbandon: false });
    expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
  });

  it("locks both buttons while a decision is in flight, so one click means one action", async () => {
    stubFetch({ action: "resume", detail: "enqueued" });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resuming…" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Abandon" }).hasAttribute("disabled")).toBe(true);
  });
});
