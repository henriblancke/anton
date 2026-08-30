// @vitest-environment jsdom
/**
 * Escalations only (anton-ue90.1 / the health-page split). This used to be `attention-strip.test.tsx`
 * covering a band that also carried hygiene findings, the worst review score, and the patrol's own
 * housekeeping — that coverage moved with the behaviour to the Health page's own tests. What stays
 * is everything an escalation offered: every decision affordance, the two-clock-safe stuck timer,
 * and the "nothing stopped, render nothing" honesty rule (now a much simpler claim than the old
 * "checked, clean" vs "never checked" distinction, because this component no longer has hygiene or
 * review data to be clean ABOUT).
 *
 * Plus the request-vs-failure split (anton-mivh.2): a wait on a person is work paused on purpose,
 * and the strip has to say so — in its own colour, its own verb, and its own place in the order —
 * without softening how the four accidental stalls read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { EscalationStrip } from "@/components/board/escalation-strip";
import type { EscalationView } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const HOUR = 3_600_000;

/**
 * `since` is anchored to the real clock because the strip ages a stall as of render time. Flooring
 * to whole seconds only ever makes the gap LARGER than 4h, so the whole-hour rounding can't flake
 * down to "3h".
 */
function escalation(o: Partial<EscalationView> = {}): EscalationView {
  const startedAt = Date.now() - 4 * HOUR;
  return {
    id: "esc-1",
    findingKey: "parked-run:r-1",
    kind: "parked-run",
    reason: "parked 4h ago: agent exited 1",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    runId: "r-1",
    since: Math.floor(startedAt / 1000),
    ageMs: 4 * HOUR,
    status: "open",
    noted: true,
    raisedAt: Math.floor(startedAt / 1000),
    ...o,
  };
}

function renderStrip(escalations: EscalationView[] = []) {
  return render(<EscalationStrip slug="anton" escalations={escalations} />);
}

describe("EscalationStrip", () => {
  it("renders nothing when nothing has stopped", () => {
    // The old merged strip's "board clean" empty state does not move here: hygiene and review data
    // are gone from this component, so it has no basis for that claim any more — the Health pill
    // makes it now. This component says nothing at all rather than repeat it secondhand.
    const { container } = renderStrip([]);
    expect(container.innerHTML).toBe("");
  });

  it("leads with what stalled, for how long, and why", () => {
    renderStrip([escalation()]);
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Parked run")).toBeTruthy();
    expect(screen.getByText("stuck 4h")).toBeTruthy();
    expect(screen.getByText("parked 4h ago: agent exited 1")).toBeTruthy();
    expect(screen.getByText("1 stopped")).toBeTruthy();
  });

  it("falls back to the sweep's frozen age when the finding recorded no start time", () => {
    renderStrip([escalation({ since: undefined, ageMs: 2 * HOUR })]);
    expect(screen.getByText("stuck 2h")).toBeTruthy();
  });

  it("shows the frozen age until hydration, so the two renders can't disagree", () => {
    // The strip is a Client Component: it renders once on the server and again when the browser
    // hydrates. Reading the clock in both would print two different ages for any stall sitting on
    // a minute boundary, and React discards a subtree that hydrates to different text. The first
    // render therefore has to use server data — the age the sweep froze — and only reach for the
    // live clock in the effect that runs after hydration.
    const sweptAt = Date.now() - 9 * HOUR;
    const { rerender } = render(
      <EscalationStrip
        slug="anton"
        escalations={[escalation({ since: Math.floor(sweptAt / 1000), ageMs: 2 * HOUR })]}
      />,
    );
    // Effects have flushed by now, so this is the post-hydration value: aged as of NOW (9h), not
    // the 2h the sweep recorded. The pre-hydration value is asserted through the pure helper in
    // escalation-age.test.ts, which is where the two-clock rule actually lives.
    expect(screen.getByText("stuck 9h")).toBeTruthy();
    rerender(
      <EscalationStrip
        slug="anton"
        escalations={[escalation({ since: Math.floor(sweptAt / 1000), ageMs: 2 * HOUR })]}
      />,
    );
    expect(screen.getByText("stuck 9h")).toBeTruthy();
  });

  it("links the epic a resume would target, and the PR when the stall is a review", () => {
    renderStrip([
      escalation({
        kind: "stale-pr",
        reason: "PR #42 has had no activity for 3d",
        prNumber: 42,
        prUrl: "https://github.com/o/r/pull/42",
      }),
    ]);

    expect(screen.getByText("Stale PR")).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-e1" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-e1",
    );
    expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toBe(
      "https://github.com/o/r/pull/42",
    );
  });

  it("offers Dismiss instead of Resume on a stale PR — re-running the epic would change nothing", () => {
    renderStrip([escalation({ kind: "stale-pr", prNumber: 42 })]);
    expect(screen.getByText("Dismiss")).toBeTruthy();
    expect(screen.queryByText("Resume")).toBeNull();
    expect(screen.getByText("Abandon")).toBeTruthy();
  });

  it("hides Resume when no epic can be re-enqueued and Abandon when no bead can be closed", () => {
    const { unmount } = renderStrip([escalation({ epicBeadId: undefined })]);
    expect(screen.queryByText("Resume")).toBeNull();
    unmount();

    renderStrip([escalation({ beadId: undefined })]);
    expect(screen.queryByText("Abandon")).toBeNull();
    expect(screen.getByText("Resume")).toBeTruthy();
  });

  it("renders a wait on a person as a request, with its ask in full and its own age", () => {
    const ask =
      "waiting on a human 4h: check the pricing copy against the deck before this ships, " +
      "including the annual tier, because the last two launches shipped a number nobody had read";
    const { container } = renderStrip([
      escalation({ kind: "needs-human", gateId: "g-1", runId: undefined, reason: ask }),
    ]);

    expect(screen.getByText("Waiting on you")).toBeTruthy();
    // Verbatim and whole: the ask is the sentence the founder acts on, and a clipped one sends them
    // to bd to read the rest.
    expect(screen.getByText(ask)).toBeTruthy();
    expect(screen.getByText("waiting 4h")).toBeTruthy();
    // A request is not a failure: it is never counted as stopped, and never drawn in the
    // destructive red the four accidental stalls earn.
    expect(screen.getByText("1 to answer")).toBeTruthy();
    expect(screen.queryByText(/stopped/)).toBeNull();
    expect(screen.queryByText(/^stuck /)).toBeNull();
    expect(screen.getByText("Waiting on you").className).toContain("stage-in-review");
    expect(container.querySelector("section")?.className).not.toContain("destructive");
  });

  it("keeps the failure classes reading as failures when a request shares the strip", () => {
    const { container } = renderStrip([
      escalation(),
      escalation({ id: "esc-2", kind: "needs-human", gateId: "g-1" }),
    ]);

    expect(screen.getByText("Parked run").className).toContain("risk-high");
    expect(screen.getByText("stuck 4h")).toBeTruthy();
    expect(screen.getByText("1 stopped")).toBeTruthy();
    expect(screen.getByText("1 to answer")).toBeTruthy();
    expect(container.querySelector("section")?.className).toContain("destructive");
  });

  it("leads with the requests, so a thirty-second answer isn't buried under investigations", () => {
    renderStrip([
      escalation({ id: "esc-1", kind: "parked-run" }),
      escalation({ id: "esc-2", kind: "needs-human", gateId: "g-1" }),
      escalation({ id: "esc-3", kind: "stale-pr", prNumber: 42 }),
      escalation({ id: "esc-4", kind: "needs-human", gateId: "g-2" }),
    ]);

    // getAllByText returns document order, which is the reading order the row grouping is about.
    const labels = screen
      .getAllByText(/^(Waiting on you|Parked run|Stale PR)$/)
      .map((chip) => chip.textContent);
    expect(labels).toEqual(["Waiting on you", "Waiting on you", "Parked run", "Stale PR"]);
  });

  it("tells the founder where an ANSWER goes, on the request rows and only there", () => {
    // Resume closes the gate and re-queues the work; it carries nothing back (PR #205 review). So an
    // ask that is a decision resolves into a session with the same inputs, which asks it again —
    // unless the answer is left where that session reads it, on the ticket as a note.
    renderStrip([
      escalation({ id: "esc-1", kind: "needs-human", gateId: "g-1", runId: undefined }),
      escalation({ id: "esc-2", kind: "parked-run" }),
    ]);

    const hints = screen.getAllByText(/belongs on the ticket\s+as a note before you resume/);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.textContent).toContain("resolving the gate carries no answer back");
  });

  it("NAMES the ticket the answer goes on when the gate recorded it", () => {
    // "the ticket" is ambiguous the moment a feature has more than one child, and the note only
    // steers the resumed session from the child that raised the ask — one left on the feature
    // reaches no dispatch at all, so the same question comes back on resume.
    renderStrip([
      escalation({ kind: "needs-human", gateId: "g-1", askBeadId: "anton-9k", runId: undefined }),
    ]);

    const hint = screen.getByText(/belongs on/).textContent ?? "";
    expect(hint).toContain("anton-9k");
    expect(hint).not.toContain("belongs on the ticket");
  });

  it("answers a wait on a person with resolve-and-resume, and never with Dismiss", () => {
    // Dismiss would settle the row while leaving the gate open — an acknowledged wait that nothing
    // ends, re-raised on every sweep. Abandon stays: "I'm not doing this" is a real answer.
    renderStrip([escalation({ kind: "needs-human", gateId: "g-1", runId: undefined })]);
    expect(screen.getByText("Resolve & resume")).toBeTruthy();
    expect(screen.queryByText("Dismiss")).toBeNull();
    expect(screen.getByText("Abandon")).toBeTruthy();
  });

  it("still offers the resolve when the gate blocks work anton doesn't run", () => {
    // No run target above the gated bead, so there is nothing to re-enqueue — but the person is
    // still being waited on, and only they can end it.
    renderStrip([
      escalation({ kind: "needs-human", gateId: "g-1", epicBeadId: undefined, runId: undefined }),
    ]);
    expect(screen.getByText("Resolve & resume")).toBeTruthy();
  });

  it("still offers the abandon when the gate blocks work that isn't on the board", () => {
    // No bead and no job to close — but "I'm not going to do this" is an answer to the wait, and
    // closing the gate is the whole of it. Without this the only button is resolve-and-resume, which
    // records the founder's refusal as a resolution.
    renderStrip([
      escalation({
        kind: "needs-human",
        gateId: "g-1",
        beadId: undefined,
        epicBeadId: undefined,
        runId: undefined,
        jobId: undefined,
      }),
    ]);
    expect(screen.getByText("Abandon")).toBeTruthy();
  });

  it("offers job-level answers for a stall that names no bead at all", () => {
    renderStrip([
      escalation({
        kind: "exhausted-job",
        beadId: undefined,
        epicBeadId: undefined,
        runId: undefined,
        jobId: "j-1",
      }),
    ]);
    expect(screen.getByText("Retry job")).toBeTruthy();
    expect(screen.getByText("Stop retrying")).toBeTruthy();
  });

  it("says so when the board-native bd note has not landed yet, and only when there is a bead", () => {
    const { unmount } = renderStrip([escalation({ noted: false })]);
    expect(screen.getByText(/hasn't landed yet/)).toBeTruthy();
    unmount();

    renderStrip([escalation({ noted: false, beadId: undefined })]);
    expect(screen.queryByText(/landed yet/)).toBeNull();
  });

  it("is announced as its own labelled region", () => {
    const { container } = renderStrip([escalation()]);
    const section = container.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
  });
});
