/**
 * Real-bd round-trip: create an epic + ticket, read the compact board and full detail, approve.
 * Guards parent-child grouping and the detail-only acceptance contract: descriptions from
 * `bd list` retain their acceptance text even though board projections omit it.
 * Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, makeFileDb, tmpProject, type BdRepo, type FileDb } from "@/lib/testing/integration";
import { beads } from "./beads/bd";
import { getBoard } from "./board";
import { getEpicDetail } from "./epic-detail";
import type { Epic, Project } from "./types";

describeBd("board integration (real bd)", () => {
  let bdRepo: BdRepo;
  let fileDb: FileDb;
  let repo: string;
  let project: Project;

  beforeAll(() => {
    // getBoard also reads the project's hygiene report (anton-uwal); point it at a temp, migrated
    // anton.db so the suite never touches (or creates) the developer's real one.
    fileDb = makeFileDb();
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    project = tmpProject(repo);
  });

  afterAll(() => {
    bdRepo.cleanup();
    fileDb.cleanup();
  });

  const find = (epics: Record<string, Epic[]>, id: string) =>
    Object.values(epics).flat().find((e) => e.id === id);

  it("round-trips create -> compact board -> full detail -> approve", async () => {
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
    expect(epic!.acceptance, "epic acceptance is detail-only").toBeUndefined();
    expect(epic!.stage).toBe("backlog");
    expect(epic!.approved).toBe(false);

    const ticket = epic!.tickets.find((t) => t.id === ticketId);
    expect(ticket, "ticket grouped under epic (parent-child)").toBeDefined();
    expect(ticket!.agent).toBe("nextjs");
    expect(ticket!.risk).toBe("low");
    expect(ticket!.size).toBe("S");
    expect(ticket!.acceptance, "ticket acceptance is detail-only").toBeUndefined();

    // Reuse the board's snapshot: compact projections must not discard the underlying contracts
    // or poison subsequent detail reads through the shared Markdown/contract caches.
    const detail = await getEpicDetail(project, epicId);
    expect(detail.epic.acceptance, "full epic acceptance parsed from description").toMatch(/button exports/i);
    expect(detail.tickets.find((t) => t.id === ticketId)?.acceptance).toMatch(/visible on \/reports/i);

    await beads.approve(repo, epicId);
    board = await getBoard(project);
    expect(find(board.columns, epicId)!.approved, "approve flips the label").toBe(true);
  });
});
