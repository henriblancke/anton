/**
 * anton-287p.4 — what arming a human gate does with a board it could NOT read.
 *
 * The board read IS the idempotency decision: bd omits gate beads from every ordinary listing, so a
 * `--type gate` leg that fails hands back a board that looks bare even when this exact ask is
 * already armed. Creating on that reading makes a SECOND human gate — and two are worse than none.
 * Nothing ever auto-resolves a human gate (`bd gate check` does not evaluate one, the expiry pass
 * skips it), the park message names only the newer gate, and closing that one leaves the target
 * blocked by its twin forever, with no resume.
 *
 * So the read is strict and its failure aborts the arm. The run then settles FAILED carrying the
 * ask, which a person can still act on — recoverable, unlike a wait resolving cannot end.
 *
 * Mocked at the read, because the state under test is a bd listing that fails: the end-to-end shapes
 * of the arm live in execute-epic.needs-human.integration.test.ts against real bd.
 */
import { beforeEach, expect, it, vi } from "vitest";

const loadAllIssuesMock = vi.fn();
const gateCreateMock = vi.fn();

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...args: unknown[]) => loadAllIssuesMock(...args) };
});

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, gateCreate: (...args: unknown[]) => gateCreateMock(...args) },
  };
});

const { armHumanGate } = await import("./execute-epic");

const REPO = "/tmp/anton";
const ASK = "the staging DB password has to be rotated by a person";

beforeEach(() => {
  loadAllIssuesMock.mockReset();
  gateCreateMock.mockReset();
});

it("reads the board strictly, so a failed gate listing can never read as 'nothing armed'", async () => {
  loadAllIssuesMock.mockResolvedValue([]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASK)).resolves.toBe("g-new");
  expect(loadAllIssuesMock).toHaveBeenCalledWith(REPO, { strictGates: true });
});

it("refuses to arm on a board it could not read, rather than stacking a second wait on the same ask", async () => {
  loadAllIssuesMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASK)).rejects.toThrow("database is locked");
  expect(gateCreateMock).not.toHaveBeenCalled();
});
