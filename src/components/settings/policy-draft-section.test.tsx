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
  { id: "anton-1", title: "crash on save", type: "bug", priority: 1, labels: ["severity:critical"] },
  { id: "anton-2", title: "flaky import", type: "bug", priority: 2, labels: ["severity:major"] },
  { id: "anton-3", title: "tidy the docs", type: "chore", priority: 2, labels: ["severity:minor"] },
  {
    id: "anton-4",
    title: "new billing flow",
    type: "feature",
    priority: 0,
    labels: ["severity:critical"],
  },
  { id: "anton-5", title: "unlabelled work", type: "bug", priority: 1, labels: [] },
];

function renderPanel(props: Partial<Parameters<typeof PolicyDraftSection>[0]> = {}) {
  return render(
    <PolicyDraftSection
      project={project}
      draft={FITTED}
      issueTypes={["bug", "chore", "feature", "task"]}
      labelVocabulary={VOCABULARY}
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
    expect(matchCount()).toBe("2 of 5 open beads match this policy");
  });

  it("moves the count as a criterion changes", () => {
    renderPanel({ candidates: CANDIDATES });
    // Widen the namespace: the chore that only carries `severity:minor` comes in.
    fireEvent.click(screen.getByRole("switch", { name: "severity:minor" }));
    expect(matchCount()).toBe("3 of 5 open beads match this policy");
    // Narrow a native field: both P2 beads fall out, leaving the one P1 bug.
    fireEvent.change(screen.getByLabelText("Minimum priority"), { target: { value: "1" } });
    expect(matchCount()).toBe("1 of 5 open beads match this policy");
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

  it("says a zero is the policy talking, not a broken pass", () => {
    // The day-one shape: a policy naming a namespace this board has never used matches nothing.
    renderPanel({
      stored: { labels: [{ namespace: "team", values: ["payments"] }] },
      candidates: CANDIDATES,
      labelVocabulary: [...VOCABULARY, { namespace: "team", labels: [] }],
    });
    expect(matchCount()).toBe("0 of 5 open beads match this policy");
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
