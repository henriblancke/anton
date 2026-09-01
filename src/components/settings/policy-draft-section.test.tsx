// @vitest-environment jsdom
/**
 * The work-policy panel (anton-c7iv, anton-qsr1), tested at its own boundary.
 *
 * What is pinned here is the promise the panel makes: on a project that has never been armed it
 * shows a PROPOSAL — calibrated, explained, and inert. "Inert" is the load-bearing half. An operator
 * who reads the draft, disagrees, and closes the tab must have armed nothing, so this suite asserts
 * that rendering writes nothing and that the store only moves on an explicit accept.
 *
 * The rest is legibility, and it is acceptance rather than polish (R2.6): criteria fail closed, so
 * an editor that shows a bare zero is indistinguishable from a broken pass. The match count must
 * move with the criterion being edited, "see them" must prove the count, and every bead the policy
 * refused must be able to name the criterion that refused it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";

import {
  PolicyDraftSection,
  type PolicyCandidate,
  type PolicyDraft,
} from "@/components/settings/policy-draft-section";
import {
  POLICY_BOUND_MAX,
  POLICY_CRITERION_VALUES_MAX,
  POLICY_LABEL_CRITERIA_MAX,
  POLICY_TEXT_MAX,
  POLICY_TYPES_MAX,
} from "@/lib/policy/types";
import type { Project } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// dnd-kit's sensors can't resolve a drop under jsdom's zero-size rects, so capture the panel's real
// onDragEnd and fire a synthetic drop into it — the same seam epic-board.test.tsx drives. The
// sortable module keeps its REAL arrayMove: the reorder under test is the panel's, not a stub's.
let dragEndHandler: ((e: DragEndEvent) => void) | undefined;
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (e: DragEndEvent) => void;
  }) => {
    dragEndHandler = onDragEnd;
    return children;
  },
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  closestCenter: () => [],
  useSensor: () => ({}),
  useSensors: () => [],
}));
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
vi.mock("@dnd-kit/modifiers", () => ({ restrictToVerticalAxis: {} }));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

const project: Project = {
  id: "p1",
  slug: "tmp",
  name: "tmp",
  repoPath: "/tmp/p1",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 0,
};

/** A draft fitted to a board that speaks `severity:` — a vocabulary anton ships nothing about. */
const FITTED: PolicyDraft = {
  policy: {
    types: ["bug", "chore"],
    maxPriority: 2,
    labels: [{ namespace: "severity", values: ["critical", "major"] }],
    requireUnblocked: true,
  },
  basis: "history",
  approvals: 8,
  rationale: [
    {
      criterion: "types",
      summary: "all 8 approvals were bug and chore — no other type has been approved here.",
      citedBeadIds: ["anton-a1", "anton-a2"],
    },
    {
      criterion: "priority",
      summary: "Nothing below P2 has ever been approved here (3 of 8 approvals sat at P2).",
      citedBeadIds: ["anton-a7"],
    },
    {
      criterion: "labels:severity",
      summary: "all 8 approvals carry a `severity:` label, and between them they used only critical and major.",
      citedBeadIds: ["anton-a1"],
    },
    { criterion: "blockers", summary: "A target with an unmet blocker is never started.", citedBeadIds: [] },
  ],
};

/** The same fitted draft with no type criterion — what a recovered read may legitimately propose. */
const FITTED_WITHOUT_TYPES: PolicyDraft = {
  ...FITTED,
  policy: { ...FITTED.policy, types: undefined },
};

const THIN: PolicyDraft = {
  policy: { types: ["bug", "chore"], maxPriority: 2, requireUnblocked: true },
  basis: "fallback",
  approvals: 2,
  rationale: [],
};

const VOCABULARY = [
  {
    namespace: "severity",
    labels: [
      { label: "severity:critical", count: 4 },
      { label: "severity:major", count: 6 },
      { label: "severity:minor", count: 9 },
    ],
  },
];

function stubFetch() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify({ settings: {} }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * An open board in the same foreign vocabulary. Against FITTED exactly two of the five match, and
 * each of the other three is refused by a different criterion — so a count that moved for the wrong
 * reason would be visible.
 */
const CANDIDATES: PolicyCandidate[] = [
  {
    id: "anton-1",
    title: "crash on save",
    type: "bug",
    priority: 1,
    depth: 0,
    ageDays: 10,
    labels: ["severity:critical"],
  },
  {
    id: "anton-2",
    title: "flaky import",
    type: "bug",
    priority: 2,
    depth: 1,
    ageDays: 1,
    labels: ["severity:major"],
  },
  {
    id: "anton-3",
    title: "tidy the docs",
    type: "chore",
    priority: 2,
    depth: 0,
    ageDays: 40,
    labels: ["severity:minor"],
  },
  {
    id: "anton-4",
    title: "new billing flow",
    type: "feature",
    priority: 0,
    depth: 2,
    ageDays: 3,
    labels: ["severity:critical"],
  },
  {
    id: "anton-5",
    title: "unlabelled work",
    type: "bug",
    priority: 1,
    depth: 0,
    ageDays: 0,
    labels: [],
  },
];

function renderPanel(props: Partial<Parameters<typeof PolicyDraftSection>[0]> = {}) {
  return render(
    <PolicyDraftSection
      project={project}
      draft={FITTED}
      issueTypes={["bug", "chore", "feature", "task"]}
      labelVocabulary={VOCABULARY}
      // `severity:` reads as a scale, so it is the one namespace offered a hand-ranking.
      rankingCandidates={["severity"]}
      {...props}
    />,
  );
}

/** The live match count, as the panel states it. */
const matchCount = () => screen.getByRole("status").textContent?.replace(/\s+/g, " ");

/** The disclosure whose summary starts with `text`, so a list can be read in isolation. */
const disclosure = (text: string): HTMLElement => {
  const summary = screen.getByText((_, el) => el?.tagName === "SUMMARY" && !!el.textContent?.startsWith(text));
  return summary.closest("details") as HTMLElement;
};

/** A chip's on/off state, read the way a screen reader would. */
const checked = (name: string) =>
  screen.getByRole("switch", { name }).getAttribute("aria-checked");

/** The body of the PATCH the panel sent, parsed. */
const sentPolicy = (fetchMock: ReturnType<typeof stubFetch>) =>
  JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).pickerPolicy;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dragEndHandler = undefined;
});

describe("first arm", () => {
  it("shows the proposal, not a blank form", () => {
    renderPanel();
    expect(screen.getByRole("note").textContent).toContain("this project's own history");
    expect(screen.getByRole("note").textContent).toContain("all 8 of its approvals");
    // The criteria arrive pre-filled, in the board's own vocabulary.
    expect(checked("bug")).toBe("true");
    expect(checked("feature")).toBe("false");
    expect((screen.getByLabelText("Minimum priority") as HTMLSelectElement).value).toBe("2");
    expect(checked("severity:critical")).toBe("true");
    expect(checked("severity:minor")).toBe("false");
  });

  it("explains which past approvals motivated each criterion", () => {
    renderPanel();
    for (const r of FITTED.rationale) {
      expect(screen.getByText(new RegExp(r.summary.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    }
    expect(screen.getByText(/anton-a1, anton-a2/)).toBeTruthy();
  });

  it("applies nothing until the operator accepts it", () => {
    const fetchMock = stubFetch();
    renderPanel();
    // Rendering a proposal is not arming a project.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use this policy" })).toBeTruthy();
    expect(screen.getByText(/anton starts nothing on its own/)).toBeTruthy();
  });

  it("stores the draft only on accept", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use this policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/tmp/settings");
    expect(sentPolicy(fetchMock)).toEqual(FITTED.policy);
  });

  it("stores the operator's edits, not the proposal, when they disagree with it", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "chore" })); // drop a proposed type
    fireEvent.click(screen.getByRole("switch", { name: "severity:major" })); // narrow the namespace
    fireEvent.change(screen.getByLabelText("Minimum priority"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this policy" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual({
      types: ["bug"],
      maxPriority: 1,
      labels: [{ namespace: "severity", values: ["critical"] }],
      requireUnblocked: true,
    });
  });

  it("drops a criterion entirely rather than sending one that matches nothing", async () => {
    const fetchMock = stubFetch();
    renderPanel();
    // Criteria fail closed, so an empty value set would admit NO bead — clearing the last chip has
    // to mean "stop constraining this", which is what the operator was reaching for.
    fireEvent.click(screen.getByRole("switch", { name: "severity:critical" }));
    fireEvent.click(screen.getByRole("switch", { name: "severity:major" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this policy" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toBeUndefined();
  });

  it("says how thin the history was when it proposes the universal default instead", () => {
    renderPanel({ draft: THIN });
    const note = screen.getByRole("note").textContent ?? "";
    expect(note).toContain("conservative default");
    expect(note).toContain("Only 2 prior approvals here");
  });
});

describe("an armed project", () => {
  const stored = { types: ["feature"], maxPriority: 0, requireUnblocked: true };

  it("edits the stored policy rather than re-proposing one", () => {
    renderPanel({ stored });
    expect(screen.queryByRole("note")).toBeNull();
    expect(checked("feature")).toBe("true");
    expect(checked("bug")).toBe("false");
    expect(screen.getByRole("button", { name: "Save policy" })).toBeTruthy();
    // Calibration runs at FIRST arm only — a tuned policy is never re-explained by anton's read.
    expect(screen.queryByText(/no other type has been approved/)).toBeNull();
  });

  it("saves the edited policy", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored });
    fireEvent.click(screen.getByRole("switch", { name: "task" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).types).toEqual(["feature", "task"]);
  });
});

describe("the boundary is legible (R2.6)", () => {
  it("counts the open beads the policy admits", () => {
    renderPanel({ candidates: CANDIDATES });
    expect(matchCount()).toBe("2 of 5 startable run targets match this policy");
  });

  it("moves the count as a criterion changes", () => {
    renderPanel({ candidates: CANDIDATES });
    // Widen the namespace: the chore that only carries `severity:minor` comes in.
    fireEvent.click(screen.getByRole("switch", { name: "severity:minor" }));
    expect(matchCount()).toBe("3 of 5 startable run targets match this policy");
    // Narrow a native field: both P2 beads fall out, leaving the one P1 bug.
    fireEvent.change(screen.getByLabelText("Minimum priority"), { target: { value: "1" } });
    expect(matchCount()).toBe("1 of 5 startable run targets match this policy");
  });

  it("lists the matches behind 'See them'", () => {
    renderPanel({ candidates: CANDIDATES });
    const list = disclosure("See them");
    expect(within(list).getByText("crash on save")).toBeTruthy();
    expect(within(list).getByText("flaky import")).toBeTruthy();
    expect(within(list).queryByText("new billing flow")).toBeNull();
  });

  it("lets every refused bead name the criterion that refused it", () => {
    renderPanel({ candidates: CANDIDATES });
    const rest = disclosure("Why not the rest?");
    // The wrong type, the wrong value, and — the fail-closed case — no such label at all.
    expect(within(rest).getByText(/is a feature/).textContent).toContain("bug or chore");
    expect(within(rest).getByText(/severity:minor/).textContent).toContain("critical or major");
    expect(within(rest).getByText(/carries no `severity:` label/)).toBeTruthy();
  });

  it("explains a denominator smaller than the board rather than hiding it", () => {
    renderPanel({ candidates: CANDIDATES, notStartable: 3 });
    // The picker refuses these before any policy is consulted, so counting them as matches would
    // claim available work anton has none of — but dropping them silently reads as a smaller board.
    expect(screen.getByText(/3 more open run targets are not startable right now/)).toBeTruthy();
  });

  it("says a zero is the policy talking, not a broken pass", () => {
    // The day-one shape: a policy naming a namespace this board has never used matches nothing.
    renderPanel({
      stored: { labels: [{ namespace: "team", values: ["payments"] }] },
      candidates: CANDIDATES,
      labelVocabulary: [...VOCABULARY, { namespace: "team", labels: [] }],
    });
    expect(matchCount()).toBe("0 of 5 startable run targets match this policy");
    expect(screen.getByText(/Nothing matches — that is the policy, not a fault/)).toBeTruthy();
    expect(disclosure("Why not the rest?")).toBeTruthy();
  });

  it("states that the policy is machine-local (R2.1)", () => {
    renderPanel();
    expect(screen.getByText(/machine-local/)).toBeTruthy();
    expect(
      screen.getByText(/never shared with another machine running this repo/),
    ).toBeTruthy();
  });
});

/**
 * The ordered native fields (R2.3), which is the half of the editor an operator cannot express any
 * other way: a namespace criterion is membership, so parentage, age and the urgent end of the
 * priority scale exist only as controls here. Each bound is driven against a policy that asserts
 * nothing else, so a count that moved did so for the reason under test.
 */
describe("the ordered native bounds (R2.3)", () => {
  const open = { stored: {}, candidates: CANDIDATES };

  it("withholds the urgent end of the scale from autopilot", async () => {
    const fetchMock = stubFetch();
    renderPanel(open);
    expect(matchCount()).toBe("5 of 5 startable run targets match this policy");

    fireEvent.change(screen.getByLabelText("Maximum priority"), { target: { value: "1" } });
    // The P0 feature is the work an operator wants triaged by hand, not started by a rule.
    expect(matchCount()).toBe("4 of 5 startable run targets match this policy");
    expect(screen.getByText(/more urgent than P1 is left for a human/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).minPriority).toBe(1);
  });

  it("bounds parentage at both ends", async () => {
    const fetchMock = stubFetch();
    renderPanel(open);

    // "Parentless work only" — the three top-level beads.
    fireEvent.change(screen.getByLabelText("Maximum parent depth"), { target: { value: "0" } });
    expect(matchCount()).toBe("3 of 5 startable run targets match this policy");

    // The other end: only work that sits under a parent.
    fireEvent.change(screen.getByLabelText("Maximum parent depth"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Minimum parent depth"), { target: { value: "1" } });
    expect(matchCount()).toBe("2 of 5 startable run targets match this policy");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual({ minParentDepth: 1 });
  });

  it("soaks new work and ignores stale work", async () => {
    const fetchMock = stubFetch();
    renderPanel(open);

    // The soak: nothing filed inside the last two days, so the day-old and the same-day bead go.
    fireEvent.change(screen.getByLabelText("Minimum age in days"), { target: { value: "2" } });
    expect(matchCount()).toBe("3 of 5 startable run targets match this policy");

    // And the stale end drops the 40-day-old chore the board has already ignored.
    fireEvent.change(screen.getByLabelText("Maximum age in days"), { target: { value: "30" } });
    expect(matchCount()).toBe("2 of 5 startable run targets match this policy");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual({ minAgeDays: 2, maxAgeDays: 30 });
  });

  it("clears a bound to unasserted rather than to zero", async () => {
    const fetchMock = stubFetch();
    renderPanel(open);
    fireEvent.change(screen.getByLabelText("Minimum age in days"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Minimum age in days"), { target: { value: "" } });
    // A bound stored as 0 would still be asserted, and would fail closed on a bead carrying no
    // creation date — the opposite of what emptying the box means.
    expect(matchCount()).toBe("5 of 5 startable run targets match this policy");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual({});
  });

  it("clamps a bound to the ceiling the store will accept", async () => {
    const fetchMock = stubFetch();
    renderPanel(open);

    // Above the schema's ceiling the panel would otherwise show a live match count for a policy the
    // settings route answers with a 400 — so the control holds the operator at the ceiling instead.
    fireEvent.change(screen.getByLabelText("Maximum parent depth"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Minimum age in days"), { target: { value: "9999" } });
    fireEvent.change(screen.getByLabelText("Maximum age in days"), { target: { value: "9999" } });

    const value = (name: string) => (screen.getByLabelText(name) as HTMLInputElement).value;
    expect(value("Maximum parent depth")).toBe(String(POLICY_BOUND_MAX.parentDepth));
    expect(value("Minimum age in days")).toBe(String(POLICY_BOUND_MAX.minAgeDays));
    expect(value("Maximum age in days")).toBe(String(POLICY_BOUND_MAX.maxAgeDays));

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual({
      maxParentDepth: POLICY_BOUND_MAX.parentDepth,
      minAgeDays: POLICY_BOUND_MAX.minAgeDays,
      maxAgeDays: POLICY_BOUND_MAX.maxAgeDays,
    });
  });

  it("round-trips every stored bound back into its control", async () => {
    const fetchMock = stubFetch();
    const stored = {
      maxPriority: 3,
      minPriority: 1,
      minParentDepth: 0,
      maxParentDepth: 2,
      minAgeDays: 1,
      maxAgeDays: 30,
    };
    renderPanel({ stored });

    const value = (name: string) =>
      (screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement).value;
    expect(value("Minimum priority")).toBe("3");
    expect(value("Maximum priority")).toBe("1");
    expect(value("Minimum parent depth")).toBe("0");
    expect(value("Maximum parent depth")).toBe("2");
    expect(value("Minimum age in days")).toBe("1");
    expect(value("Maximum age in days")).toBe("30");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toEqual(stored);
  });
});

describe("ranking a namespace's values (R2.3)", () => {
  const stored = { labels: [{ namespace: "severity", values: ["critical", "major"] }] };

  it("offers no ranking until the operator asks for one", () => {
    renderPanel({ stored });
    // Membership is the default and the only inference anton makes; the order is opt-in.
    expect(screen.queryByRole("button", { name: "Reorder severity:critical" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    expect(screen.getByRole("button", { name: "Reorder severity:critical" })).toBeTruthy();
  });

  it("persists the dragged order with the policy", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));

    act(() =>
      dragEndHandler?.({
        active: { id: "severity:critical" },
        over: { id: "severity:major" },
      } as unknown as DragEndEvent),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toEqual([
      { namespace: "severity", values: ["major", "critical"], ranked: true },
    ]);
  });

  it("keeps a value appended, not re-sorted, once the namespace is ranked", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    // Alphabetising here would silently throw away the rank the operator just expressed.
    fireEvent.click(screen.getByRole("switch", { name: "severity:minor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels[0].values).toEqual(["critical", "major", "minor"]);
  });

  it("drops a ranking narrowed down to a single value", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    fireEvent.click(screen.getByRole("switch", { name: "severity:major" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // An ordering of one thing is not an ordering — it is stored as plain membership.
    expect(sentPolicy(fetchMock).labels).toEqual([{ namespace: "severity", values: ["critical"] }]);
  });

  it("refuses a drop that would move a value between namespaces", () => {
    renderPanel({
      stored,
      labelVocabulary: [
        ...VOCABULARY,
        { namespace: "team", labels: [{ label: "team:payments", count: 3 }] },
      ],
    });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    act(() =>
      dragEndHandler?.({
        active: { id: "severity:critical" },
        over: { id: "team:payments" },
      } as unknown as DragEndEvent),
    );
    // Order unchanged: rank 1 is still critical.
    const ranked = screen.getByRole("button", { name: "Reorder severity:critical" }).closest("li");
    expect(ranked?.textContent).toContain("1");
  });
});

/**
 * Every way this panel could arm something the operator did not mean. The board read is the first:
 * an unreadable board and an empty one look identical downstream, and a policy accepted off the
 * former is fitted to a failure. Then the two states an editor makes reachable in one click — a
 * policy that constrains nothing, and no way back out of an armed one.
 */
describe("what it refuses to arm", () => {
  it("refuses to save at all when the board could not be read", () => {
    const fetchMock = stubFetch();
    renderPanel({ boardUnavailable: true, draft: THIN });
    expect(screen.getByRole("alert").textContent).toContain("could not be read");
    // No proposal is offered either: a draft calibrated from zero beads is a read failure quoted back.
    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByRole("button", { name: "Use this policy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says out loud when a policy asserts nothing at all", () => {
    renderPanel({ stored: {}, candidates: CANDIDATES });
    expect(screen.getByText(/admits every startable run target/)).toBeTruthy();
    // And stops saying it the moment a criterion is asserted.
    fireEvent.click(screen.getByRole("switch", { name: "bug" }));
    expect(screen.queryByText(/admits every startable run target/)).toBeNull();
  });

  it("lets an armed project be disarmed again", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: { types: ["feature"] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // null REMOVES the setting; an empty object would arm a policy that admits everything.
    expect(sentPolicy(fetchMock)).toBeNull();
  });

  it("offers no removal before anything is armed", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Remove policy" })).toBeNull();
  });
});

/**
 * The board read is the one input that can arrive WRONG and then be corrected. A failed read seeds
 * the controls from an empty board; the refresh that recovers it re-renders this component with a
 * real draft while React keeps the old state — so what the panel would arm and what its banner and
 * rationale describe must not be allowed to drift apart.
 */
describe("a recovered board read re-seeds the controls", () => {
  it("drops the failure-derived draft once the board answers again", () => {
    const { rerender } = renderPanel({ boardUnavailable: true, draft: THIN, issueTypes: [] });
    // Seeded blind: the fallback's own types, and none of the board's vocabulary to edit against.
    expect(checked("bug")).toBe("true");
    expect(screen.queryByRole("switch", { name: "feature" })).toBeNull();

    rerender(
      <PolicyDraftSection
        project={project}
        draft={FITTED_WITHOUT_TYPES}
        issueTypes={["bug", "chore", "feature", "task"]}
        labelVocabulary={VOCABULARY}
      />,
    );

    // The recovered draft asserts no type criterion, so neither may the controls — holding `bug` and
    // `chore` here would arm a policy the rationale beside it never proposed.
    expect(checked("bug")).toBe("false");
    expect(screen.getByRole("note").textContent).toContain("this project's own history");
    expect((screen.getByRole("button", { name: "Use this policy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops a fallback seeded by disarming while the board was still unreadable", async () => {
    const fetchMock = stubFetch();
    // Armed, then the board goes dark on a later refresh — so the blind seed did NOT happen at mount.
    const { rerender } = renderPanel({ stored: { types: ["feature"] } });
    rerender(
      <PolicyDraftSection
        project={project}
        draft={THIN}
        stored={{ types: ["feature"] }}
        issueTypes={[]}
        labelVocabulary={[]}
        boardUnavailable
      />,
    );

    // Disarming stays available while the board is unreadable — it removes rather than stores.
    fireEvent.click(screen.getByRole("button", { name: "Remove policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock)).toBeNull();

    // The board answers again with a real draft. What the controls hold came from the failed read,
    // so it must be replaced — otherwise the now-enabled accept arms a fallback the rationale
    // beside it never proposed.
    rerender(
      <PolicyDraftSection
        project={project}
        draft={FITTED_WITHOUT_TYPES}
        issueTypes={["bug", "chore", "feature", "task"]}
        labelVocabulary={VOCABULARY}
      />,
    );
    expect(checked("bug")).toBe("false");
    expect(checked("chore")).toBe("false");
    expect((screen.getByRole("button", { name: "Use this policy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("leaves an operator's edits alone when the board was readable all along", () => {
    const { rerender } = renderPanel({ candidates: CANDIDATES });
    fireEvent.click(screen.getByRole("switch", { name: "feature" }));
    expect(checked("feature")).toBe("true");

    // An ordinary refresh — a poll, another panel's save — must not throw away work in progress.
    rerender(
      <PolicyDraftSection
        project={project}
        draft={FITTED}
        issueTypes={["bug", "chore", "feature", "task"]}
        labelVocabulary={VOCABULARY}
        candidates={CANDIDATES}
      />,
    );
    expect(checked("feature")).toBe("true");
  });

  it("keeps an armed project's edits — the stored policy is not failure-derived", () => {
    // Armed AND dark from the first render. The controls hold the STORED policy, which came from
    // the store rather than the failed read, so recovery has nothing to correct. bd-native fields
    // stay editable through the outage (they need no vocabulary), which is what makes this reachable.
    const stored = { types: ["feature"], maxPriority: 3 };
    const { rerender } = renderPanel({
      stored,
      draft: THIN,
      issueTypes: [],
      labelVocabulary: [],
      boardUnavailable: true,
    });
    fireEvent.change(screen.getByLabelText("Minimum priority"), { target: { value: "1" } });

    rerender(
      <PolicyDraftSection
        project={project}
        draft={FITTED}
        stored={stored}
        issueTypes={["bug", "chore", "feature", "task"]}
        labelVocabulary={VOCABULARY}
      />,
    );

    // The outage is over and the edit survives it — re-seeding here would silently restore P3 over
    // the operator's P1, with Save now enabled to persist the value they had just replaced.
    expect((screen.getByLabelText("Minimum priority") as HTMLSelectElement).value).toBe("1");
  });
});

/**
 * The store's ceiling on the native membership criterion, for the same reason as the discovered
 * ones: a board with more issue types than a policy may name is a board where a 17th chip previews
 * something the accept can only come back from as a 400.
 */
describe("the type criterion stays inside what the store accepts", () => {
  const MANY_TYPES = Array.from({ length: POLICY_TYPES_MAX + 1 }, (_, i) => `t${i}`);
  const full = MANY_TYPES.slice(0, POLICY_TYPES_MAX);
  const spare = `t${POLICY_TYPES_MAX}`;

  it("refuses the type past the ceiling instead of previewing a policy that cannot be saved", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: { types: full }, issueTypes: MANY_TYPES });
    const chip = screen.getByRole("switch", { name: spare }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(spare)).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).types).toHaveLength(POLICY_TYPES_MAX);
  });

  it("says why, and reopens the refused type once another is cleared", () => {
    renderPanel({ stored: { types: full }, issueTypes: MANY_TYPES });
    expect(screen.getByText(new RegExp(`at most ${POLICY_TYPES_MAX} issue types`))).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "t0" }));
    const chip = screen.getByRole("switch", { name: spare }) as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(checked(spare)).toBe("true");
  });

  it("leaves a board under the ceiling fully selectable", () => {
    renderPanel();
    expect((screen.getByRole("switch", { name: "feature" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/at most 16 issue types/)).toBeNull();
  });
});

/**
 * WHOSE vocabulary decides what can be ranked. Discovery recognises a handful of scales anton knows
 * (`S/M/L`, `P0/P1`), and gating the ranking control on that set would make a repo's own ordinal
 * words — `showstopper` over `nice-to-have` — unrankable because anton has never heard of them. The
 * hint is offered; the declaration is the operator's.
 */
describe("ranking is the operator's declaration, not anton's recognition", () => {
  /** A scale in the repo's own words: ordered, and in none of discovery's known families. */
  const OWN_SCALE = [
    {
      namespace: "severity",
      labels: [
        { label: "severity:showstopper", count: 4 },
        { label: "severity:normal", count: 6 },
        { label: "severity:nice-to-have", count: 2 },
      ],
    },
  ];

  it("ranks a scale discovery does not recognise", async () => {
    const fetchMock = stubFetch();
    renderPanel({
      stored: { labels: [{ namespace: "severity", values: ["showstopper", "normal"] }] },
      labelVocabulary: OWN_SCALE,
      // Discovery read nothing as a scale here — these are not words anton ships.
      rankingCandidates: [],
    });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    fireEvent.change(screen.getByLabelText("Bound severity: by rank"), { target: { value: "lte" } });
    fireEvent.change(screen.getByLabelText("Bound severity: at"), {
      target: { value: "showstopper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toEqual([
      {
        namespace: "severity",
        values: ["showstopper", "normal"],
        ranked: true,
        compare: { op: "lte", value: "showstopper" },
      },
    ]);
  });

  it("says which namespaces read as a scale rather than gating on it", () => {
    renderPanel({
      stored: {
        labels: [
          { namespace: "severity", values: ["critical", "major"] },
          { namespace: "team", values: ["payments", "growth"] },
        ],
      },
      labelVocabulary: [
        ...VOCABULARY,
        {
          namespace: "team",
          labels: [
            { label: "team:payments", count: 3 },
            { label: "team:growth", count: 2 },
          ],
        },
      ],
      rankingCandidates: ["severity"],
    });
    // Both are offered; only the one discovery read as a scale carries the hint.
    const severity = screen.getByRole("group", { name: "severity:" });
    const team = screen.getByRole("group", { name: "team:" });
    expect(within(severity).getByRole("switch", { name: "Rank severity: values" })).toBeTruthy();
    expect(within(team).getByRole("switch", { name: "Rank team: values" })).toBeTruthy();
    expect(severity.textContent).toContain("these read as a scale");
    expect(team.textContent).not.toContain("these read as a scale");
  });

  it("keeps a stored ranking editable even on a namespace discovery would not offer one for", () => {
    renderPanel({
      stored: { labels: [{ namespace: "team", values: ["payments", "growth"], ranked: true }] },
      labelVocabulary: [
        ...VOCABULARY,
        {
          namespace: "team",
          labels: [
            { label: "team:payments", count: 3 },
            { label: "team:growth", count: 2 },
          ],
        },
      ],
      rankingCandidates: [],
    });
    // A ranking has to stay visible to be undoable — and draggable to be re-ordered.
    expect(checked("Rank team: values")).toBe("true");
    expect(screen.getByRole("button", { name: "Reorder team:payments" })).toBeTruthy();
  });

  it("says a ranking alone does not change what is admitted", () => {
    renderPanel({ stored: { labels: [{ namespace: "severity", values: ["critical", "major"] }] } });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    expect(screen.getByText(/every selected value still matches/)).toBeTruthy();
  });
});

/**
 * The bound over a hand-ranking (R2.3) — the one ordering a discovered namespace ever gets, and only
 * because the operator declared it. A ranking an operator can drag but never bound is a rule the
 * schema and the predicate support and the panel refuses to author.
 */
describe("bounding a hand-ranked namespace (R2.3)", () => {
  const ranked = {
    labels: [{ namespace: "severity", values: ["critical", "major", "minor"], ranked: true }],
  };

  it("authors a bound over the operator's own ranking", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: ranked });
    fireEvent.change(screen.getByLabelText("Bound severity: by rank"), {
      target: { value: "lte" },
    });
    fireEvent.change(screen.getByLabelText("Bound severity: at"), { target: { value: "major" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toEqual([
      {
        namespace: "severity",
        values: ["critical", "major", "minor"],
        ranked: true,
        compare: { op: "lte", value: "major" },
      },
    ]);
  });

  it("narrows nothing until the bound is moved", () => {
    renderPanel({ stored: ranked, candidates: CANDIDATES });
    // All three severities are selected, so membership over the ranking admits every labelled bead.
    expect(matchCount()).toBe("4 of 5 startable run targets match this policy");
    // Reaching for the control lands on the end of the ranking that admits what is already selected:
    // the policy changes when the operator moves the bound, not when they open the select.
    fireEvent.change(screen.getByLabelText("Bound severity: by rank"), {
      target: { value: "lte" },
    });
    expect(matchCount()).toBe("4 of 5 startable run targets match this policy");
  });

  it("moves the live count with the bound, and says what it admits", () => {
    renderPanel({ stored: ranked, candidates: CANDIDATES });
    fireEvent.change(screen.getByLabelText("Bound severity: by rank"), {
      target: { value: "lte" },
    });
    fireEvent.change(screen.getByLabelText("Bound severity: at"), { target: { value: "major" } });
    // severity:minor is now outside the bound, so the chore drops out.
    expect(matchCount()).toBe("3 of 5 startable run targets match this policy");
    expect(screen.getByText(/Admits severity:critical, severity:major/)).toBeTruthy();
  });

  it("clears the bound back to membership over the whole ranking", async () => {
    const fetchMock = stubFetch();
    renderPanel({
      stored: {
        labels: [
          {
            namespace: "severity",
            values: ["critical", "major", "minor"],
            ranked: true,
            compare: { op: "lte" as const, value: "major" },
          },
        ],
      },
    });
    fireEvent.change(screen.getByLabelText("Bound severity: by rank"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels[0].compare).toBeUndefined();
  });

  it("offers no bound where there is no ranking to bound", () => {
    renderPanel({ stored: { labels: [{ namespace: "severity", values: ["critical", "major"] }] } });
    // A comparison with no scale behind it refuses every bead (R2.5) and the store rejects it.
    expect(screen.queryByLabelText("Bound severity: by rank")).toBeNull();
  });

  it("names a bound that has left its ranking rather than reading it as no bound at all", () => {
    renderPanel({
      candidates: CANDIDATES,
      stored: {
        labels: [
          {
            namespace: "severity",
            values: ["critical", "major"],
            ranked: true,
            // A bound on a value the ranking no longer carries — nothing the predicate can judge.
            compare: { op: "lte" as const, value: "minor" },
          },
        ],
      },
    });
    // The panel must not describe this as admitting the whole ranking: the predicate refuses every
    // bead against it, so a widened listing would show an admitting rule where anton admits nothing.
    expect(screen.queryByText(/Admits severity:/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("is not in this ranking");
    expect(matchCount()).toBe("0 of 5 startable run targets match this policy");
    // And the controls stay, so the operator can put the bound back inside the ranking.
    expect(screen.getByLabelText("Bound severity: by rank")).toBeTruthy();
  });
});

/**
 * A `compare` NARROWS a ranked namespace, so losing it on an edit that never mentioned it silently
 * widens the policy into membership over the whole ranking — admitting work the operator had
 * excluded. It survives every edit around it, and goes only when what it depends on does.
 */
describe("a stored comparison survives editing around it", () => {
  const bounded = {
    labels: [
      {
        namespace: "severity",
        values: ["critical", "major", "minor"],
        ranked: true,
        compare: { op: "lte" as const, value: "major" },
      },
    ],
  };

  it("keeps the bound when another value is toggled", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: bounded });
    fireEvent.click(screen.getByRole("switch", { name: "severity:minor" })); // drop an unrelated value
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toEqual([
      { namespace: "severity", values: ["critical", "major"], ranked: true, compare: { op: "lte", value: "major" } },
    ]);
  });

  it("drops a bound whose own value the operator removed", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: bounded });
    fireEvent.click(screen.getByRole("switch", { name: "severity:major" })); // the bound itself
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A bound the ranking no longer carries refuses every bead, and the store rejects it outright.
    expect(sentPolicy(fetchMock).labels[0].compare).toBeUndefined();
  });

  it("drops a bound when the ranking under it is turned off", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: bounded });
    fireEvent.click(screen.getByRole("switch", { name: "Rank severity: values" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toEqual([
      { namespace: "severity", values: ["critical", "major", "minor"] },
    ]);
  });
});

/**
 * The store's own ceiling on one criterion's membership set. The panel previews a policy as valid,
 * so a selection the schema will reject is an operator spending their accept on a 400 the panel
 * cannot explain — the same reason the numeric bounds clamp to their schema maximum.
 */
describe("a criterion stays inside what the store accepts", () => {
  /** A namespace with one value more than a criterion may carry. */
  const CROWDED = [
    {
      namespace: "component",
      labels: Array.from({ length: POLICY_CRITERION_VALUES_MAX + 1 }, (_, i) => ({
        label: `component:c${i}`,
        count: 1,
      })),
    },
  ];
  const full = Array.from({ length: POLICY_CRITERION_VALUES_MAX }, (_, i) => `c${i}`);
  const last = `component:c${POLICY_CRITERION_VALUES_MAX}`;

  it("refuses the value past the ceiling instead of previewing a policy that cannot be saved", async () => {
    const fetchMock = stubFetch();
    renderPanel({
      stored: { labels: [{ namespace: "component", values: full }] },
      labelVocabulary: CROWDED,
    });
    const chip = screen.getByRole("switch", { name: last }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(last)).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels[0].values).toHaveLength(POLICY_CRITERION_VALUES_MAX);
  });

  it("says why the remaining values cannot be added", () => {
    renderPanel({
      stored: { labels: [{ namespace: "component", values: full }] },
      labelVocabulary: CROWDED,
    });
    expect(
      screen.getByText(new RegExp(`at most ${POLICY_CRITERION_VALUES_MAX} values`)),
    ).toBeTruthy();
  });

  it("leaves a namespace under the ceiling fully selectable", () => {
    renderPanel({ stored: { labels: [{ namespace: "severity", values: ["critical"] }] } });
    expect((screen.getByRole("switch", { name: "severity:minor" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/at most 32 values/)).toBeNull();
  });
});

/**
 * The store's other ceiling: how many namespaces one policy constrains. A board with more
 * authorable `ns:` groups than that is a board where the editor offers a criterion the accept can
 * only come back from as a 400 — so the chips go dead at the ceiling and say why.
 */
describe("a policy stays inside the namespace count the store accepts", () => {
  /** One namespace more than a policy may constrain, each with one value. */
  const MANY = Array.from({ length: POLICY_LABEL_CRITERIA_MAX + 1 }, (_, i) => ({
    namespace: `ns${i}`,
    labels: [{ label: `ns${i}:v`, count: 1 }],
  }));
  /** A policy already at the ceiling, leaving the last namespace of MANY unconstrained. */
  const full = {
    labels: Array.from({ length: POLICY_LABEL_CRITERIA_MAX }, (_, i) => ({
      namespace: `ns${i}`,
      values: ["v"],
    })),
  };
  const spare = `ns${POLICY_LABEL_CRITERIA_MAX}:v`;

  it("refuses the criterion past the ceiling instead of previewing a policy that cannot be saved", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: full, labelVocabulary: MANY });
    const chip = screen.getByRole("switch", { name: spare }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(spare)).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toHaveLength(POLICY_LABEL_CRITERIA_MAX);
  });

  it("says why, and keeps the namespaces already constrained editable", () => {
    renderPanel({ stored: full, labelVocabulary: MANY });
    expect(
      screen.getByText(new RegExp(`at most ${POLICY_LABEL_CRITERIA_MAX} namespaces`)),
    ).toBeTruthy();
    // Clearing one is how the operator makes room, so nothing already named goes dead.
    expect((screen.getByRole("switch", { name: "ns0:v" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("reopens the refused namespace once another is cleared", () => {
    renderPanel({ stored: full, labelVocabulary: MANY });
    fireEvent.click(screen.getByRole("switch", { name: "ns0:v" }));
    const chip = screen.getByRole("switch", { name: spare }) as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(checked(spare)).toBe("true");
  });

  it("leaves a board under the ceiling fully authorable", () => {
    renderPanel({ stored: { labels: [{ namespace: "severity", values: ["critical"] }] } });
    expect(screen.queryByText(/at most 16 namespaces/)).toBeNull();
  });
});

/**
 * anton's own bookkeeping is not this repo's vocabulary. Once a board has run anton, `stage:` and
 * `review-score:` are among its most-used namespaces — and a criterion over them is anton quoting
 * its own runs back, over a value anton itself rewrites mid-run.
 */
describe("anton's bookkeeping namespaces are not authorable criteria", () => {
  const WITH_CONTROL = [
    ...VOCABULARY,
    { namespace: "stage", labels: [{ label: "stage:implementing", count: 7 }] },
    { namespace: "review-score", labels: [{ label: "review-score:8", count: 5 }] },
    { namespace: "source", labels: [{ label: "source:stringer", count: 3 }] },
  ];

  it("offers no criterion over stage:, review-score: or source:", () => {
    renderPanel({ labelVocabulary: WITH_CONTROL });
    expect(screen.getByRole("group", { name: "severity:" })).toBeTruthy();
    for (const namespace of ["stage:", "review-score:", "source:"]) {
      expect(screen.queryByRole("group", { name: namespace })).toBeNull();
    }
  });

  it("keeps a policy that already names one visible, so it can be removed", async () => {
    const fetchMock = stubFetch();
    renderPanel({
      stored: { labels: [{ namespace: "stage", values: ["implementing"] }] },
      labelVocabulary: WITH_CONTROL,
    });
    // Hiding it would leave a criterion refusing beads with no control to un-set it.
    const group = screen.getByRole("group", { name: "stage:" });
    fireEvent.click(within(group).getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).labels).toBeUndefined();
  });
});

/**
 * The other half of "offer only what the store will keep". The count ceilings above are one way a
 * board can out-run the schema; its own STRING LENGTHS are the other. A board is free to write an
 * issue type, a namespace or a value longer than `pickerPolicySchema` bounds, and an editor that
 * previews one lets the operator build a whole policy out of offered controls and then discover, on
 * accept, a 400 no control on the panel can undo.
 */
describe("vocabulary the store would reject is never offered", () => {
  const LONG_TYPE = "t".repeat(POLICY_TEXT_MAX.type + 1);
  const LONG_NAMESPACE = "n".repeat(POLICY_TEXT_MAX.namespace + 1);
  const LONG_VALUE = "v".repeat(POLICY_TEXT_MAX.value + 1);

  it("refuses an issue type longer than the store will keep", async () => {
    const fetchMock = stubFetch();
    renderPanel({ stored: { types: ["bug"] }, issueTypes: ["bug", LONG_TYPE] });
    const chip = screen.getByRole("switch", { name: LONG_TYPE }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(LONG_TYPE)).toBe("false");
    expect(
      screen.getByText(new RegExp(`at most ${POLICY_TEXT_MAX.type} characters`)),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentPolicy(fetchMock).types).toEqual(["bug"]);
  });

  it("refuses a value longer than the store will keep, leaving the rest of its namespace live", () => {
    renderPanel({
      labelVocabulary: [
        {
          namespace: "severity",
          labels: [
            { label: "severity:critical", count: 4 },
            { label: `severity:${LONG_VALUE}`, count: 1 },
          ],
        },
      ],
    });
    const chip = screen.getByRole("switch", { name: `severity:${LONG_VALUE}` }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(`severity:${LONG_VALUE}`)).toBe("false");
    // The ceiling is per-value: the namespace stays authorable out of the words that fit.
    expect(
      (screen.getByRole("switch", { name: "severity:critical" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      screen.getByText(new RegExp(`at most ${POLICY_TEXT_MAX.value} characters`)),
    ).toBeTruthy();
  });

  it("refuses a namespace longer than the store will keep, and says why rather than hiding it", () => {
    renderPanel({
      draft: { ...FITTED, policy: {}, rationale: [] },
      labelVocabulary: [
        { namespace: LONG_NAMESPACE, labels: [{ label: `${LONG_NAMESPACE}:v`, count: 2 }] },
      ],
    });
    // Shown, because a board namespace missing from an editor generated FROM the board reads as a
    // bug rather than as a limit.
    expect(screen.getByRole("group", { name: `${LONG_NAMESPACE}:` })).toBeTruthy();
    const chip = screen.getByRole("switch", { name: `${LONG_NAMESPACE}:v` }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(checked(`${LONG_NAMESPACE}:v`)).toBe("false");
    expect(
      screen.getByText(new RegExp(`at most ${POLICY_TEXT_MAX.namespace} characters`)),
    ).toBeTruthy();
  });

  it("leaves a board whose words all fit entirely authorable", () => {
    renderPanel();
    expect(screen.queryByText(/characters/)).toBeNull();
  });
});

/**
 * Evidence belongs to the criterion it was read off. The draft's rationale explains what anton
 * PROPOSED — so the moment an operator edits a criterion, the sentence beside it is describing a
 * policy that is no longer on screen, and (since Save persists the edit) crediting anton's reading
 * for the operator's decision. Deselecting a type or a label value can make the policy refuse the
 * very approvals the summary claims it covers.
 */
describe("draft evidence goes with the criterion it explained", () => {
  /** The rationale summary for a criterion, as it is matched on screen. */
  const evidence = (criterion: string) => {
    const summary = FITTED.rationale.find((r) => r.criterion === criterion)!.summary;
    return new RegExp(summary.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  };

  it("drops the evidence for an edited criterion and keeps it for the untouched ones", () => {
    renderPanel();
    expect(screen.getByText(evidence("types"))).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "chore" }));

    expect(screen.queryByText(evidence("types"))).toBeNull();
    // The criteria the operator left alone are still anton's proposal, so their evidence stands.
    expect(screen.getByText(evidence("priority"))).toBeTruthy();
    expect(screen.getByText(evidence("labels:severity"))).toBeTruthy();
  });

  it("drops the evidence for a narrowed namespace criterion", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "severity:major" }));

    expect(screen.queryByText(evidence("labels:severity"))).toBeNull();
    expect(screen.getByText(evidence("types"))).toBeTruthy();
  });

  it("restores the evidence when the criterion is put back as proposed", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "chore" }));
    expect(screen.queryByText(evidence("types"))).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "chore" }));
    expect(screen.getByText(evidence("types"))).toBeTruthy();
  });

  it("stops claiming the policy admits every prior approval once it is edited", () => {
    renderPanel();
    expect(screen.getByRole("note").textContent).toContain("all 8 of its approvals");

    fireEvent.change(screen.getByLabelText("Minimum priority"), { target: { value: "1" } });

    const note = screen.getByRole("note").textContent ?? "";
    expect(note).not.toContain("all 8 of its approvals");
    expect(note).toContain("no longer the one anton proposed");
    // Still inert: an edited proposal arms nothing either.
    expect(note).toContain("Nothing is armed until you accept it.");
  });

  it("quotes no evidence at all once the policy is the operator's own", () => {
    renderPanel({ stored: FITTED.policy });
    expect(screen.queryByText(evidence("types"))).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

/**
 * The `Never` deep link (anton-jqvy). A veto that dumped the operator on a twelve-criterion panel
 * would be a rule change nobody makes, so the criterion arrives named — and only ever highlighted:
 * `Never` opens the policy, it does not rewrite it.
 */
describe("the criterion a Never veto opened the editor at", () => {
  const openAt = (criterion?: string) => {
    window.history.replaceState(
      null,
      "",
      criterion ? `/projects/tmp/settings?criterion=${encodeURIComponent(criterion)}#policy` : "/projects/tmp/settings#policy",
    );
  };

  afterEach(() => window.history.replaceState(null, "", "/"));

  it("highlights the native criterion the link names, and nothing else", () => {
    openAt("types");
    renderPanel();

    expect(screen.getByRole("group", { name: "Issue type" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("group", { name: "Priority" }).hasAttribute("aria-current")).toBe(false);
    // Named, so the operator knows why this control is ringed rather than guessing.
    expect(
      within(screen.getByRole("group", { name: "Issue type" })).getByText(
        /admitted the target you declined/i,
      ),
    ).toBeTruthy();
  });

  it("highlights a discovered-namespace criterion by its own name", () => {
    openAt("labels:severity");
    renderPanel();

    expect(screen.getByRole("group", { name: "severity:" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("group", { name: "Issue type" }).hasAttribute("aria-current")).toBe(false);
  });

  it("changes NOTHING about the policy — the link highlights, it never tightens", () => {
    openAt("types");
    const fetchMock = stubFetch();
    renderPanel();

    // The controls still hold exactly the proposal, and no write went out on render.
    expect(checked("bug")).toBe("true");
    expect(checked("feature")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("highlights nothing when the link names no criterion", () => {
    openAt();
    renderPanel();

    expect(
      screen.getAllByRole("group").every((g) => !g.hasAttribute("aria-current")),
    ).toBe(true);
  });
});
