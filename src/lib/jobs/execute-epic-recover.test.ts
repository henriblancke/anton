/**
 * anton-gh4a9 (PR #274 review) — `refreshRunBoard` must not silently fall back to the pre-pull
 * board when the post-pull re-list — the ONLY read that carries fresh `bd dep cycles` evidence for
 * `regateRefreshedBoard`'s structure gate — itself fails. Falling back there would let a `blocks`
 * cycle the pull just landed slip past the re-check unnoticed. Mocked at the module seam: what's
 * under test is which of two board reads (`beads.pull` vs. the cycle-aware `loadAllIssues`) failed,
 * not the reads themselves.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const pullMock = vi.fn();
const showMock = vi.fn();
const loadAllIssuesMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, pull: (...args: unknown[]) => pullMock(...args), show: (...args: unknown[]) => showMock(...args) },
  };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...args: unknown[]) => loadAllIssuesMock(...args) };
});

const { refreshRunBoard } = await import("./execute-epic-recover");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-gh4a9";

const feature = (): Bead =>
  ({ id: TARGET, title: "Feature", issue_type: "feature", status: "open" }) as Bead;

/** The minimal run `refreshRunBoard` reads. */
function run(target: Bead): EpicRun {
  return {
    repo: REPO,
    targetId: TARGET,
    target,
    all: [target],
    tickets: [],
    standaloneRun: false,
  } as unknown as EpicRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  showMock.mockResolvedValue(feature());
});

it("adopts the freshly-pulled, cycle-evidenced board when the re-list succeeds", async () => {
  pullMock.mockResolvedValue(undefined);
  const fresh = [feature()];
  loadAllIssuesMock.mockResolvedValue(fresh);

  const { preCheckTrusted, leaseTarget } = await refreshRunBoard(run(feature()));

  expect(preCheckTrusted).toBe(true);
  expect(leaseTarget).toBe(fresh[0]);
});

it("throws (retry/park) when the pull succeeded but the cycle-evidenced re-list fails (PR #274 review)", async () => {
  pullMock.mockResolvedValue(undefined);
  loadAllIssuesMock.mockRejectedValue(new Error("bd dep cycles timed out"));
  const staleAll = [feature()];
  const r = run(feature());
  r.all = staleAll;

  await expect(refreshRunBoard(r)).rejects.toThrow(/could not re-list it with cycle evidence/);
  // The pre-pull snapshot must NOT be silently kept as if it were still authoritative for cycles.
  expect(r.all).toBe(staleAll);
});

it("keeps the pre-pull snapshot when the pull itself already failed — nothing new could have landed", async () => {
  pullMock.mockRejectedValue(new Error("network unreachable"));
  loadAllIssuesMock.mockRejectedValue(new Error("bd dep cycles timed out"));
  const staleAll = [feature()];
  const r = run(feature());
  r.all = staleAll;

  const { preCheckTrusted } = await refreshRunBoard(r);

  expect(preCheckTrusted).toBe(false);
  expect(r.all).toBe(staleAll);
});
