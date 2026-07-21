/**
 * Real-bd round-trip: create an epic + ticket, read the board, approve. Guards against the
 * `bd list` shape (no acceptance/external_ref fields; acceptance parsed from description) and
 * parent-child grouping. Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./beads/bd";
import { getBoard } from "./board";
import type { Epic, Project } from "./types";

describeBd("board integration (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let project: Project;

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    project = {
      id: "x", slug: "tmp", name: "tmp", repoPath: repo,
      defaultBranch: "main", hasBeads: true, createdAt: 0,
    };
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  const find = (epics: Record<string, Epic[]>, id: string) =>
    Object.values(epics).flat().find((e) => e.id === id);

  it("round-trips create -> board -> approve", async () => {
    const epicId = await beads.create(repo, {
      title: "CSV export",
      type: "epic",
      description: "## Goal\nLet users export to CSV.\n\n## Acceptance\n- [ ] button exports the current view",
    });
    const ticketId = await beads.create(repo, {
      title: "Add export button",
      type: "task",
      description: "## Goal\nAdd the button.\n\n## Acceptance\n- [ ] visible on /reports",
    });
    await beads.link(repo, ticketId, epicId, "parent-child");
    await beads.tag(repo, ticketId, ["agent:nextjs", "risk:low", "size:S"]);

    let board = await getBoard(project);
    const epic = find(board.columns, epicId);
    expect(epic, "epic on board").toBeDefined();
    expect(epic!.goal).toMatch(/export to CSV/i);
    expect(epic!.acceptance, "acceptance parsed from description").toMatch(/button exports/i);
    expect(epic!.stage).toBe("backlog");
    expect(epic!.approved).toBe(false);

    const ticket = epic!.tickets.find((t) => t.id === ticketId);
    expect(ticket, "ticket grouped under epic (parent-child)").toBeDefined();
    expect(ticket!.agent).toBe("nextjs");
    expect(ticket!.risk).toBe("low");
    expect(ticket!.size).toBe("S");

    await beads.approve(repo, epicId);
    board = await getBoard(project);
    expect(find(board.columns, epicId)!.approved, "approve flips the label").toBe(true);
  }, 30_000);
});
