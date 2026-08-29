// @vitest-environment jsdom
/**
 * The work-policy panel (anton-c7iv), tested at its own boundary.
 *
 * What is pinned here is the promise the panel makes: on a project that has never been armed it
 * shows a PROPOSAL — calibrated, explained, and inert. "Inert" is the load-bearing half. An operator
 * who reads the draft, disagrees, and closes the tab must have armed nothing, so this suite asserts
 * that rendering writes nothing and that the store only moves on an explicit accept.
 *
 * The rest is legibility: each criterion carries the approvals that motivated it, and a project with
 * too little history is told so rather than handed a fitted policy it should not trust.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PolicyDraftSection, type PolicyDraft } from "@/components/settings/policy-draft-section";
import type { Project } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

/** A chip's on/off state, read the way a screen reader would. */
const checked = (name: string) =>
  screen.getByRole("switch", { name }).getAttribute("aria-checked");

/** The body of the PATCH the panel sent, parsed. */
const sentPolicy = (fetchMock: ReturnType<typeof stubFetch>) =>
  JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).pickerPolicy;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
