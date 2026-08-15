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

  it("says plainly that a deleted target was cleared rather than restarted", async () => {
    stubFetch({ action: "resume", detail: "target-gone" });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "Nothing to act on — this work was deleted from the board, so the alert is cleared",
      ),
    );
  });

  it("surfaces the server's reason when the escalation was already settled", async () => {
    stubFetch({ error: "This escalation has already been settled" }, 409);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("This escalation has already been settled"),
    );
    // Refreshed even on the failure path: a 409 can mean the settle LANDED and only the action
    // threw, so leaving the panel untouched would keep a resolved row on screen that errors on
    // every subsequent click. The server's answer is the authority either way.
    expect(refresh).toHaveBeenCalled();
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

describe("EscalationActions — dismiss", () => {
  it("settles the row in one click and says the sweep will re-raise it", async () => {
    // The answer for a stall anton has no verb for (a stale PR waits on a reviewer). It must read
    // as an acknowledgement, not as a fix — otherwise the panel implies the PR was dealt with.
    const fetchMock = stubFetch({ action: "dismiss", detail: "dismissed" });
    mount({ canResume: false, canDismiss: true });

    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/escalations/esc-1",
      expect.objectContaining({ body: JSON.stringify({ action: "dismiss" }) }),
    );
    expect(success).toHaveBeenCalledWith(
      "Dismissed — anton raises it again if it's still stuck at the next sweep",
    );
  });

  it("is absent unless the escalation is one anton cannot act on", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
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

  it("says retry/stop when the answer lands on a job rather than on the work", async () => {
    // "Abandon" would misdescribe cancelling a sync-push job: nothing is being closed as won't-do.
    const fetchMock = stubFetch({ action: "abandon", detail: "cancelled-job" });
    mount({ target: "job" });

    expect(screen.getByRole("button", { name: "Retry job" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stop retrying" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Stopped — the job is cancelled and won't retry"),
    );
  });

  it("names the gate, not the run, when the wait is on a person", async () => {
    // "Resume" would misdescribe it: the founder is answering "I did the thing you asked", and the
    // re-queue is the consequence, not the decision.
    const fetchMock = stubFetch({ action: "resume", detail: "enqueued" });
    mount({ target: "gate" });

    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resolve & resume" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/escalations/esc-1",
      expect.objectContaining({ body: JSON.stringify({ action: "resume" }) }),
    );
  });

  it("says plainly when closing the gate was the whole answer", async () => {
    stubFetch({ action: "resume", detail: "gate-resolved" });
    mount({ target: "gate" });

    fireEvent.click(screen.getByRole("button", { name: "Resolve & resume" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "Gate closed — the wait is over; there was no run left to restart",
      ),
    );
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
