import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beads, LABELS, type Bead } from "@/lib/beads/bd";
import {
  invalidateIssueSnapshot,
  refreshIssueSnapshot,
  resetIssueSnapshots,
} from "@/lib/beads/snapshot";
import { proposalFingerprint } from "@/lib/gardener/detections";
import ProjectSettingsPage from "./page";

// Stub external stores and the client boundary; exercise the real snapshot cache and autonomy rules.
vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async () => ({ id: "p1", slug: "anton", name: "anton", repoPath: "/settings-test" }),
  getProjectSettingsBySlug: async () => ({}),
  resolvePickerApplyOverride: () => undefined,
}));
vi.mock("@/lib/agents-discovery", () => ({
  discoverAgents: async () => [],
  bundledAgentIds: async () => [],
}));
vi.mock("@/lib/schedules", () => ({ DEFAULT_SCHEDULES: [], listSchedules: async () => [] }));
vi.mock("@/lib/claude/system-prompt", () => ({ loadBaseSystemPrompt: async () => "" }));
vi.mock("@/lib/picker-veto", () => ({
  latestPickerTrackRecord: async () => ({ accepted: 0, declined: 0, settled: 0 }),
}));
vi.mock("@/lib/quota-spend", () => ({ quotaShareProjects: async () => [] }));
vi.mock("@/components/settings/settings-view", () => ({ SettingsView: () => null }));

function proposals(count: number, declined = 0): Bead[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `proposal-${i}`,
    title: `Proposal ${i}`,
    issue_type: "task",
    status: "closed",
    closed_at: "2026-09-23T12:00:00Z",
    labels: [
      proposalFingerprint("implied-order", `subject-${i}`),
      ...(i < declined ? [LABELS.abandoned] : []),
    ],
  }));
}

beforeEach(resetIssueSnapshots);
afterEach(() => {
  vi.restoreAllMocks();
  resetIssueSnapshots();
});

describe("settings proposal history", () => {
  it.each([
    { name: "unlocks newly earned apply", before: proposals(9), after: proposals(10), eligible: true, applied: 10 },
    { name: "locks apply after the record falls below its floor", before: proposals(10), after: proposals(10, 3), eligible: false, applied: 7 },
  ])("$name after a pending board write", async ({ before, after, eligible, applied }) => {
    await refreshIssueSnapshot("/settings-test", async () => before);
    invalidateIssueSnapshot("/settings-test", true);
    let finishRefresh!: (value: Bead[]) => void;
    const refreshed = new Promise<Bead[]>((resolve) => { finishRefresh = resolve; });
    const list = vi.spyOn(beads, "list").mockReturnValue(refreshed);
    const rendered = vi.fn();
    const page = ProjectSettingsPage({ params: Promise.resolve({ slug: "anton" }) });
    void page.then(rendered);

    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      // Rendering the retained snapshot here would expose the opposite eligibility verdict.
      expect(rendered).not.toHaveBeenCalled();
    } finally {
      finishRefresh(after);
    }

    const view = await page;
    expect(view.props.earned["implied-order"]).toMatchObject({ settled: 10, applied, eligible });
    expect(view.props.boardUnavailable).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("locks apply when the board cannot be loaded", async () => {
    vi.spyOn(beads, "list").mockRejectedValue(new Error("board unavailable"));
    const view = await ProjectSettingsPage({ params: Promise.resolve({ slug: "anton" }) });
    expect(view.props.boardUnavailable).toBe(true);
    expect(view.props.earned["implied-order"]).toMatchObject({ settled: 0, applied: 0, eligible: false });
  });
});
