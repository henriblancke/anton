// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Epic } from "@/lib/types";
import { BoardColumn } from "./board-column";

vi.mock("@dnd-kit/core", () => ({ useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }) }));
vi.mock("./draggable-epic-card", () => ({ DraggableEpicCard: ({ epic }: { epic: Epic }) => <div data-testid="card">{epic.title}</div> }));
vi.mock("./standalone-group", () => ({ StandaloneGroup: () => null }));
afterEach(cleanup);
const epics = Array.from({ length: 45 }, (_, i) => ({ id: `card-${i}`, title: `Card ${i}` }) as Epic);

it("renders completed history in accessible batches while retaining the total count", () => {
  render(<BoardColumn stage="done" epics={epics} standalone={[]} slug="test" />);
  expect(screen.getAllByTestId("card")).toHaveLength(20);
  expect(screen.getByText("45")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: /Show more completed/ }));
  expect(screen.getAllByTestId("card")).toHaveLength(40);
  fireEvent.click(screen.getByRole("button", { name: /Show more completed/ }));
  expect(screen.getAllByTestId("card")).toHaveLength(45);
  expect(screen.queryByRole("button", { name: /Show more completed/ })).toBeNull();
});

it("keeps all active cards visible", () => {
  render(<BoardColumn stage="backlog" epics={epics} standalone={[]} slug="test" />);
  expect(screen.getAllByTestId("card")).toHaveLength(45);
});
