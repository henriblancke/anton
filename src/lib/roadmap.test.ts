/**
 * The roadmap rollup, over a fixture board. These pin the two things the page is for: the
 * feature/shipped counts per epic, and the "no engine designator" state that must read as
 * unroutable rather than silently fine (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
import { describe, expect, it } from "vitest";

import { buildRoadmap } from "./roadmap";
import type { Bead } from "./beads/bd";

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "task", ...over }) as Bead;

const epic = (over: Partial<Bead> & { id: string }): Bead =>
  bead({ issue_type: "epic", ...over });

const feature = (over: Partial<Bead> & { id: string; parent: string }): Bead =>
  bead({ issue_type: "feature", ...over });

describe("buildRoadmap", () => {
  it("rolls each epic's features up into a feature count and a shipped count", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1", title: "Zero-touch ingestion", labels: ["area:ingest"] }),
      feature({ id: "f-1", parent: "e-1", status: "closed" }),
      feature({ id: "f-2", parent: "e-1" }),
      // Another epic's feature must not leak into e-1's rollup.
      epic({ id: "e-2", title: "Trustworthy retrieval", labels: ["area:knowledge"] }),
      feature({ id: "f-3", parent: "e-2" }),
    ]);

    expect(rows.map((r) => [r.id, r.area, r.features, r.shipped])).toEqual([
      ["e-1", "ingest", 2, 1],
      ["e-2", "knowledge", 1, 0],
    ]);
  });

  it("counts only feature children — a legacy epic's tasks are not features", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1", labels: ["area:ops"] }),
      bead({ id: "t-1", parent: "e-1", status: "closed" }),
      bead({ id: "b-1", parent: "e-1", issue_type: "bug" }),
    ]);

    expect(rows[0]).toMatchObject({ features: 0, shipped: 0 });
  });

  it("drops abandoned features from both sides of the ratio, so a won't-do can't park an epic", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1", labels: ["area:ingest"] }),
      feature({ id: "f-1", parent: "e-1", status: "closed" }),
      feature({ id: "f-2", parent: "e-1", status: "closed", labels: ["abandoned"] }),
    ]);

    expect(rows[0]).toMatchObject({ features: 1, shipped: 1 });
  });

  it("leaves area undefined for an epic with no designator, so the row can read not synced", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1", title: "Operator ergonomics", labels: ["domain:eng", "size:m"] }),
      feature({ id: "f-1", parent: "e-1", status: "closed" }),
    ]);

    expect(rows).toEqual([
      {
        id: "e-1",
        title: "Operator ergonomics",
        area: undefined,
        features: 1,
        shipped: 1,
        linearRef: undefined,
      },
    ]);
  });

  it("surfaces a tracker ref from external_ref but never a legacy gh- PR pointer", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1", external_ref: "LIB-118" }),
      epic({ id: "e-2", external_ref: "gh-82" }),
      epic({ id: "e-3", external_ref: "https://linear.app/acme/issue/LIB-121" }),
    ]);

    expect(rows.map((r) => r.linearRef)).toEqual([
      "LIB-118",
      undefined,
      "https://linear.app/acme/issue/LIB-121",
    ]);
  });

  it("lists every epic tier bead and nothing else — features and tasks are not rows", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1" }),
      feature({ id: "f-1", parent: "e-1" }),
      bead({ id: "t-1" }),
      bead({ id: "m-1", issue_type: "molecule" }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(["e-1"]);
  });

  it("omits an abandoned epic — a won't-do decision is not in-flight work", () => {
    const rows = buildRoadmap([
      epic({ id: "e-1" }),
      epic({ id: "e-2", status: "closed", labels: ["abandoned"] }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(["e-1"]);
  });

  it("orders in-flight epics above shipped ones, then by priority and age", () => {
    const rows = buildRoadmap([
      epic({ id: "e-done", status: "closed", priority: 0, created_at: "2026-01-01" }),
      epic({ id: "e-low", priority: 3, created_at: "2026-01-01" }),
      epic({ id: "e-old", priority: 1, created_at: "2026-01-01" }),
      epic({ id: "e-new", priority: 1, created_at: "2026-06-01" }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(["e-old", "e-new", "e-low", "e-done"]);
  });

  it("returns no rows for an empty board", () => {
    expect(buildRoadmap([])).toEqual([]);
  });
});
