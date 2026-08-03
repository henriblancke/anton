/**
 * The gardener's detectors (anton-02oc), driven over fixture boards.
 *
 * Two properties carry every case here, because each is a way a detector could do harm:
 *   • a detection is a CLAIM about someone's board, so it fires only on the shape it names — the
 *     "quiet board" case is the most important test in the file, and each detector has a near-miss
 *     twin (a task under a runnable epic, a lone parentless bead, an ordering already edged, a bead
 *     stale but not stale ENOUGH) that must stay silent.
 *   • the fingerprint is what stops a re-run duplicating a proposal (anton-9qwq), so it is asserted
 *     to be stable across passes and distinct across subjects.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "../beads/bd";
import type { HygieneFinding } from "../hygiene";
import { detectBoard, type GardenerDetection } from "./detect";
import { GARDENER_LABEL_PREFIX, concernedBeads } from "./detections";
import { RETIRE_STALE_IN_PROGRESS_DAYS, RETIRE_STALE_OPEN_DAYS } from "./retire";

const NOW = Date.parse("2026-08-03T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const bead = (id: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  updated_at: daysAgo(1),
  ...over,
});

const epic = (id: string, over: Partial<Bead> = {}) => bead(id, { issue_type: "epic", ...over });
const feature = (id: string, over: Partial<Bead> = {}) =>
  bead(id, { issue_type: "feature", ...over });

const blocks = (blocked: string, blocker: string) => ({
  issue_id: blocked,
  depends_on_id: blocker,
  type: "blocks",
});
const discoveredFrom = (discovered: string, source: string) => ({
  issue_id: discovered,
  depends_on_id: source,
  type: "discovered-from",
});

const detect = (board: Bead[], findings: HygieneFinding[] = []) =>
  detectBoard({ board, hygiene: { findings }, now: NOW });

const kinds = (detections: GardenerDetection[]) => detections.map((d) => d.kind);
const only = (detections: GardenerDetection[]): GardenerDetection => {
  expect(detections).toHaveLength(1);
  return detections[0];
};

describe("container orphans (the anton-do0q class)", () => {
  it("flags a task hanging off a container epic and names the feature to move it under", () => {
    const detections = detect([
      epic("anton-cont", { title: "Container epic" }),
      feature("anton-feat", { title: "The runnable feature", parent: "anton-cont" }),
      bead("anton-lost", { title: "Loose ticket", parent: "anton-cont" }),
    ]);

    const detection = only(detections);
    expect(detection.kind).toBe("container-orphan");
    expect(detection.move).toBe("reparent");
    expect(detection.subjects).toEqual(["anton-lost"]);
    expect(detection.target).toBe("anton-feat");
    expect(detection.evidence.join("\n")).toContain("anton-cont");
    expect(concernedBeads(detection)).toEqual(["anton-feat", "anton-lost"]);
  });

  it("suggests no single home when the container has several open features", () => {
    const detection = only(
      detect([
        epic("anton-cont"),
        feature("anton-f1", { parent: "anton-cont" }),
        feature("anton-f2", { parent: "anton-cont" }),
        bead("anton-lost", { parent: "anton-cont" }),
      ]),
    );

    expect(detection.target).toBeUndefined();
    expect(detection.summary).toContain("under one of its features");
  });

  it("stays silent for work that already rides a card", () => {
    // A childless epic IS a run target, so its tasks ride its card; a feature's tasks ride the
    // feature. Neither is misfiled.
    expect(
      detect([
        epic("anton-runnable"),
        bead("anton-t1", { parent: "anton-runnable" }),
        feature("anton-feat"),
        bead("anton-t2", { parent: "anton-feat" }),
      ]),
    ).toEqual([]);
  });

  it("flags only the topmost stranded bead, not every descendant under it", () => {
    const detections = detect([
      epic("anton-cont"),
      feature("anton-feat", { parent: "anton-cont" }),
      bead("anton-lost", { parent: "anton-cont" }),
      bead("anton-deeper", { parent: "anton-lost" }),
    ]);

    expect(only(detections).subjects).toEqual(["anton-lost"]);
  });

  it("leaves work a run is already shipping alone", () => {
    expect(
      detect([
        epic("anton-cont"),
        feature("anton-feat", { parent: "anton-cont" }),
        bead("anton-lost", { parent: "anton-cont", labels: ["stage:in-review"] }),
        bead("anton-done", { parent: "anton-cont", status: "closed" }),
      ]),
    ).toEqual([]);
  });
});

describe("parentless clusters", () => {
  const homes = [
    feature("anton-esc", { title: "Escalation settle route" }),
    feature("anton-dock", { title: "Docker image cache" }),
  ];

  it("groups parentless beads that point at exactly one open card", () => {
    const detection = only(
      detect([
        ...homes,
        bead("anton-p1", { title: "Escalation panel copy" }),
        bead("anton-p2", { title: "Escalation retry banner" }),
        bead("anton-p3", { title: "Roadmap zoom controls" }),
      ]),
    );

    expect(detection.kind).toBe("parentless-cluster");
    expect(detection.move).toBe("reparent");
    expect(detection.subjects).toEqual(["anton-p1", "anton-p2"]);
    expect(detection.target).toBe("anton-esc");
    expect(detection.evidence.join("\n")).toContain('"escalation"');
  });

  it("clusters on a shared area label when titles have nothing in common", () => {
    const detection = only(
      detect([
        feature("anton-home", { title: "Weekly digest", labels: ["area:reports"] }),
        bead("anton-a1", { title: "Backfill csv exporter", labels: ["area:reports"] }),
        bead("anton-a2", { title: "Timezone handling", labels: ["area:reports"] }),
      ]),
    );

    expect(detection.target).toBe("anton-home");
    expect(detection.subjects).toEqual(["anton-a1", "anton-a2"]);
  });

  it("says nothing about a single parentless bead — one bead is not a cluster", () => {
    expect(detect([...homes, bead("anton-p1", { title: "Escalation panel copy" })])).toEqual([]);
  });

  it("says nothing when the shared topic points at two cards", () => {
    expect(
      detect([
        ...homes,
        feature("anton-esc2", { title: "Escalation timeline" }),
        bead("anton-p1", { title: "Escalation panel copy" }),
        bead("anton-p2", { title: "Escalation retry banner" }),
      ]),
    ).toEqual([]);
  });

  it("says nothing when a bead's topics point at two different cards", () => {
    // "escalation" belongs to one card and "docker" to another: each key is distinctive, but the
    // bead carrying both has no obvious home — and a coin flip is not a proposal.
    expect(
      detect([
        ...homes,
        bead("anton-p1", { title: "Escalation docker retry" }),
        bead("anton-p2", { title: "Escalation docker banner" }),
      ]),
    ).toEqual([]);
  });

  it("ignores beads that already have a parent", () => {
    expect(
      detect([
        ...homes,
        bead("anton-p1", { title: "Escalation panel copy", parent: "anton-esc" }),
        bead("anton-p2", { title: "Escalation retry banner", parent: "anton-esc" }),
      ]),
    ).toEqual([]);
  });
});

describe("implied ordering with no blocks edge", () => {
  it("reads an ordering phrase out of a run target's body", () => {
    const detection = only(
      detect([
        feature("anton-alpha", {
          title: "Alpha",
          description: "## Context\nBlocked on anton-beta landing first.",
        }),
        feature("anton-beta", { title: "Beta" }),
      ]),
    );

    expect(detection.kind).toBe("implied-order");
    expect(detection.move).toBe("link");
    expect(detection.subjects).toEqual(["anton-alpha"]);
    expect(detection.target).toBe("anton-beta");
    expect(detection.evidence.join("\n")).toContain("Blocked on anton-beta landing first.");
  });

  it("reverses direction for a phrase that puts the writer first", () => {
    const detection = only(
      detect([
        feature("anton-alpha", { description: "This blocks anton-beta until the schema lands." }),
        feature("anton-beta"),
      ]),
    );

    expect(detection.subjects).toEqual(["anton-beta"]);
    expect(detection.target).toBe("anton-alpha");
  });

  it("stays silent when the edge already exists in either direction", () => {
    const body = "## Context\nBlocked on anton-beta landing first.";
    expect(
      detect([
        feature("anton-alpha", { description: body, dependencies: [blocks("anton-alpha", "anton-beta")] }),
        feature("anton-beta"),
      ]),
    ).toEqual([]);
    expect(
      detect([
        feature("anton-alpha", { description: body }),
        feature("anton-beta", { dependencies: [blocks("anton-beta", "anton-alpha")] }),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the named prerequisite already landed", () => {
    expect(
      detect([
        feature("anton-alpha", { description: "Blocked on anton-beta." }),
        feature("anton-beta", { status: "closed" }),
      ]),
    ).toEqual([]);
  });

  it("ignores ticket-level prose — only features and epics carry sequencing", () => {
    expect(
      detect([
        bead("anton-t1", { parent: "anton-alpha", description: "Blocked on anton-t2." }),
        bead("anton-t2", { parent: "anton-alpha" }),
        feature("anton-alpha"),
      ]),
    ).toEqual([]);
  });

  it("treats a discovered-from edge to still-open work as implied timing", () => {
    const detection = only(
      detect([
        feature("anton-child", { dependencies: [discoveredFrom("anton-child", "anton-source")] }),
        feature("anton-source"),
      ]),
    );

    expect(detection.subjects).toEqual(["anton-child"]);
    expect(detection.target).toBe("anton-source");
    expect(detection.evidence.join("\n")).toContain("discovered-from");
  });

  it("never proposes an edge between a bead and its own ancestor", () => {
    expect(
      detect([
        epic("anton-epic"),
        feature("anton-feat", {
          parent: "anton-epic",
          description: "Blocked on anton-epic being approved.",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("retirement candidates", () => {
  const duplicate = (ids: string[]): HygieneFinding => ({
    kind: "duplicate",
    key: `duplicate:${ids.join("+")}`,
    ids,
    detail: `${ids.length} beads with identical content: ${ids.join(", ")}`,
  });
  const stale = (id: string, status: "open" | "in_progress"): HygieneFinding => ({
    kind: status === "open" ? "stale-open" : "stale-in-progress",
    key: `stale:${id}`,
    beadId: id,
    detail: "untouched past its threshold",
  });
  const orphan = (id: string): HygieneFinding => ({
    kind: "orphan",
    key: `orphan:${id}`,
    beadId: id,
    detail: "named by a commit (abc1234) but still open",
  });

  it("proposes superseding an open bead whose identical twin already landed", () => {
    const detection = only(
      detect(
        [
          feature("anton-live", { title: "Ship the thing" }),
          feature("anton-landed", { title: "Ship the thing", status: "closed" }),
        ],
        [duplicate(["anton-landed", "anton-live"])],
      ),
    );

    expect(detection.kind).toBe("superseded");
    expect(detection.move).toBe("retire");
    expect(detection.retireAs).toBe("supersede");
    expect(detection.subjects).toEqual(["anton-live"]);
    expect(detection.target).toBe("anton-landed");
  });

  it("leaves a duplicate group with no landed member to the report", () => {
    expect(
      detect(
        [feature("anton-a", { title: "Same" }), feature("anton-b", { title: "Same" })],
        [duplicate(["anton-a", "anton-b"])],
      ),
    ).toEqual([]);
  });

  it("proposes deferring work silent far past its per-status threshold", () => {
    const detections = detect(
      [
        feature("anton-cold", { updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS + 10) }),
        feature("anton-dead", {
          status: "in_progress",
          assignee: "someone",
          updated_at: daysAgo(RETIRE_STALE_IN_PROGRESS_DAYS + 2),
        }),
      ],
      [stale("anton-cold", "open"), stale("anton-dead", "in_progress")],
    );

    expect(kinds(detections)).toEqual(["stale", "stale"]);
    expect(detections.every((d) => d.retireAs === "defer")).toBe(true);
    expect(detections.map((d) => d.subjects[0]).sort()).toEqual(["anton-cold", "anton-dead"]);
  });

  it("does not propose retirement for a bead the report flags but the window does not", () => {
    expect(
      detect(
        [
          feature("anton-warm", { updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS - 10) }),
          feature("anton-busy", {
            status: "in_progress",
            updated_at: daysAgo(RETIRE_STALE_IN_PROGRESS_DAYS - 5),
          }),
        ],
        [stale("anton-warm", "open"), stale("anton-busy", "in_progress")],
      ),
    ).toEqual([]);
  });

  it("does not propose retirement for a bead with no readable stamp", () => {
    expect(
      detect([feature("anton-undated", { updated_at: undefined, created_at: undefined })], [
        stale("anton-undated", "open"),
      ]),
    ).toEqual([]);
  });

  it("proposes closing work a commit already shipped", () => {
    const detection = only(detect([feature("anton-shipped")], [orphan("anton-shipped")]));

    expect(detection.kind).toBe("shipped-orphan");
    expect(detection.retireAs).toBe("close");
    expect(detection.evidence.join("\n")).toContain("abc1234");
  });

  it("keeps only the most certain claim when several fire on one bead", () => {
    const detection = only(
      detect([feature("anton-both", { updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS + 50) })], [
        orphan("anton-both"),
        stale("anton-both", "open"),
      ]),
    );

    expect(detection.kind).toBe("shipped-orphan");
  });

  it("never retires work a run is mid-flight over", () => {
    expect(
      detect(
        [
          feature("anton-inreview", {
            labels: ["stage:in-review"],
            updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS + 5),
          }),
          feature("anton-live", { labels: [`run-lease:${NOW + 60_000}`] }),
        ],
        [stale("anton-inreview", "open"), orphan("anton-inreview"), orphan("anton-live")],
      ),
    ).toEqual([]);
  });

  it("finds nothing without a hygiene report — bd owns stale/orphans/duplicates", () => {
    expect(
      detectBoard({
        board: [feature("anton-cold", { updated_at: daysAgo(500) })],
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("a board with nothing wrong", () => {
  it("yields zero detections", () => {
    const board = [
      epic("anton-epic", { title: "Container epic" }),
      feature("anton-f1", {
        title: "Escalation settle route",
        parent: "anton-epic",
        description: "## Goal\nSettle escalations from the panel.",
      }),
      feature("anton-f2", {
        title: "Docker image cache",
        parent: "anton-epic",
        dependencies: [blocks("anton-f2", "anton-f1")],
        description: "## Goal\nCache the build layers.",
      }),
      bead("anton-t1", { title: "Escalation panel copy", parent: "anton-f1" }),
      bead("anton-t2", { title: "Settle route tests", parent: "anton-f1" }),
      bead("anton-t3", { title: "Layer cache warmup", parent: "anton-f2" }),
      bead("anton-solo", { title: "One-off chore", issue_type: "chore" }),
      feature("anton-shipped", { title: "Already shipped", status: "closed" }),
    ];

    expect(detectBoard({ board, hygiene: { findings: [] }, now: NOW })).toEqual([]);
  });
});

describe("fingerprints", () => {
  const board = [
    epic("anton-cont"),
    feature("anton-feat", { parent: "anton-cont" }),
    bead("anton-lost", { parent: "anton-cont" }),
    bead("anton-lost2", { parent: "anton-cont" }),
  ];

  it("is stable across passes over an unchanged board", () => {
    expect(detect(board)).toEqual(detect(board));
  });

  it("is distinct per subject and label-shaped", () => {
    const detections = detect(board);
    expect(detections).toHaveLength(2);
    const fingerprints = detections.map((d) => d.fingerprint);
    expect(new Set(fingerprints).size).toBe(2);
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(
        new RegExp(`^${GARDENER_LABEL_PREFIX}:container-orphan:[0-9a-f]{12}$`),
      );
    }
  });

  it("does not change when an unrelated field of the subject changes", () => {
    const before = detect(board);
    const after = detect(
      board.map((b) => (b.id === "anton-lost" ? { ...b, priority: 0, title: "Renamed" } : b)),
    );
    expect(after.map((d) => d.fingerprint)).toEqual(before.map((d) => d.fingerprint));
  });

  it("changes when the proposed target changes", () => {
    const single = only(
      detect([epic("anton-cont"), feature("anton-feat", { parent: "anton-cont" }), bead("anton-lost", { parent: "anton-cont" })]),
    );
    const elsewhere = only(
      detect([epic("anton-cont"), feature("anton-other", { parent: "anton-cont" }), bead("anton-lost", { parent: "anton-cont" })]),
    );
    expect(single.fingerprint).not.toBe(elsewhere.fingerprint);
  });

  it("carries evidence on every detection it produces", () => {
    for (const detection of detect(board)) {
      expect(detection.evidence.length).toBeGreaterThan(0);
      expect(detection.summary).not.toHaveLength(0);
    }
  });
});
