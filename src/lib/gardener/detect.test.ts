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

import { LABELS, type Bead } from "../beads/bd";
import type { HygieneFinding } from "../hygiene";
import { detectBoard, type GardenerDetection } from "./detect";
import { concernedBeads, namespaceOf } from "./detections";
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

  // A mid-run feature has already selected the tickets its run will work through, so a bead moved
  // under it now would never be dispatched and would strand when the run settles the card. Rather
  // than name it, the ask goes to the approver with no target — the same answer as an ambiguous home.
  it("names no home when the container's only feature is mid-run", () => {
    for (const busy of [{ labels: ["stage:in-review"] }, { labels: [LABELS.runLease(NOW + 60_000, "run-9")] }]) {
      const detection = only(
        detect([
          epic("anton-cont"),
          feature("anton-feat", { parent: "anton-cont", ...busy }),
          feature("anton-shipped", { parent: "anton-cont", status: "closed" }),
          bead("anton-lost", { parent: "anton-cont" }),
        ]),
      );
      expect(detection.kind).toBe("container-orphan");
      expect(detection.target).toBeUndefined();
    }
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

  // The window no liveness signal covers: `bd update --claim` writes the assignee and `in_progress`,
  // and the lease only appears once the execute job publishes it. Proposing a move in between hands
  // an approver work another machine already owns.
  it("leaves a bead a run has claimed but not yet leased alone", () => {
    expect(
      detect([
        epic("anton-cont"),
        feature("anton-feat", { parent: "anton-cont" }),
        bead("anton-lost", { parent: "anton-cont", status: "in_progress", assignee: "box-2" }),
      ]),
    ).toEqual([]);
  });

  it("names no home when the container's only feature is claimed but not yet leased", () => {
    const detection = only(
      detect([
        epic("anton-cont"),
        feature("anton-feat", { parent: "anton-cont", status: "in_progress", assignee: "box-2" }),
        bead("anton-lost", { parent: "anton-cont" }),
      ]),
    );

    expect(detection.kind).toBe("container-orphan");
    expect(detection.target).toBeUndefined();
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

  // The card is a legal home on paper, but its run has already picked up its tickets: moving beads
  // under it now would leave them undispatched beneath a card about to settle, which apply refuses.
  it("says nothing when the only matching card is mid-run", () => {
    expect(
      detect([
        feature("anton-esc", { title: "Escalation settle route", labels: ["stage:in-review"] }),
        bead("anton-p1", { title: "Escalation panel copy" }),
        bead("anton-p2", { title: "Escalation retry banner" }),
      ]),
    ).toEqual([]);
  });

  // A parentless task IS a run target, so an `in_progress` claim on one is a machine that has picked
  // it up — its lease just hasn't been published yet. Regrouping it makes it somebody's child, and
  // the queued execute job parks when it refreshes the board and no longer finds a run target.
  it("drops a member a run has claimed but not yet leased", () => {
    expect(
      detect([
        ...homes,
        bead("anton-p1", { title: "Escalation panel copy" }),
        bead("anton-p2", {
          title: "Escalation retry banner",
          status: "in_progress",
          assignee: "box-2",
        }),
      ]),
    ).toEqual([]); // one free bead left is not a cluster
  });

  it("says nothing when the only matching card is claimed but not yet leased", () => {
    expect(
      detect([
        feature("anton-esc", {
          title: "Escalation settle route",
          status: "in_progress",
          assignee: "box-2",
        }),
        bead("anton-p1", { title: "Escalation panel copy" }),
        bead("anton-p2", { title: "Escalation retry banner" }),
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

  // The pair has no direct edge, so it reads as unrelated — but bd refuses to write an edge that
  // closes a blocking cycle, so filing this would put a proposal on the board that can never apply.
  it("stays silent when the edge would close a cycle through other beads", () => {
    expect(
      detect([
        feature("anton-alpha", { description: "## Context\nBlocked on anton-beta landing first." }),
        feature("anton-beta", { dependencies: [blocks("anton-beta", "anton-gamma")] }),
        feature("anton-gamma", { dependencies: [blocks("anton-gamma", "anton-alpha")] }),
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

  // bd keeps ONE edge per directed pair and answers `bd link --type blocks` over provenance with
  // "already exists with type discovered-from … remove it first", so an ask naming this pair could
  // only ever be approved into that error and would sit open until a human declined it (anton-wsap).
  it("stays silent when a discovered-from edge already occupies the pair bd would have to write", () => {
    expect(
      detect([
        feature("anton-child", {
          description: "## Context\nBlocked on anton-source landing first.",
          dependencies: [discoveredFrom("anton-child", "anton-source")],
        }),
        feature("anton-source"),
      ]),
    ).toEqual([]);
  });

  // The other direction is bd's to write: provenance points source-ward, so the pair this ordering
  // needs (`child → source`) is still free.
  it("still proposes when the provenance edge runs the other way", () => {
    const detection = only(
      detect([
        feature("anton-child", { description: "## Context\nBlocked on anton-source landing first." }),
        feature("anton-source", {
          dependencies: [discoveredFrom("anton-source", "anton-child")],
        }),
      ]),
    );

    expect(detection.subjects).toEqual(["anton-child"]);
    expect(detection.target).toBe("anton-source");
  });

  // The same bar every other detector proposes under: apply refuses to record a live bead as
  // blocked, and once its run lands the bead is settled — so the proposal could never be applied.
  it("stays silent while either end is mid-run", () => {
    const body = "## Context\nBlocked on anton-beta landing first.";
    expect(
      detect([
        feature("anton-alpha", { description: body, labels: ["stage:in-review"] }),
        feature("anton-beta"),
      ]),
    ).toEqual([]);
    expect(
      detect([
        feature("anton-alpha", { description: body }),
        feature("anton-beta", { labels: ["stage:in-review"] }),
      ]),
    ).toEqual([]);
  });

  // The window no liveness signal covers: `bd update --claim` writes the assignee and `in_progress`
  // before the execute job publishes a lease. Recording a new blocker over a pickup parks that run —
  // it refreshes the board and finds a dependency that was absent when it was selected.
  it("stays silent while the blocked end is claimed but not yet leased", () => {
    expect(
      detect([
        feature("anton-alpha", {
          description: "## Context\nBlocked on anton-beta landing first.",
          status: "in_progress",
          assignee: "box-2",
        }),
        feature("anton-beta"),
      ]),
    ).toEqual([]);
  });

  // The edge leaves the BLOCKER's readiness untouched, so a claim on that end is not this detector's
  // business — the bar stays on the bead the edge would take out of the ready set.
  it("still proposes when only the blocker is claimed", () => {
    const detection = only(
      detect([
        feature("anton-alpha", { description: "## Context\nBlocked on anton-beta landing first." }),
        feature("anton-beta", { status: "in_progress", assignee: "box-2" }),
      ]),
    );

    expect(detection.subjects).toEqual(["anton-alpha"]);
    expect(detection.target).toBe("anton-beta");
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

  // The survivor is "the twin that carries the work's history", which is a question about MOMENTS,
  // not about strings: bd stamps that differ in UTC offset order the wrong way lexicographically, and
  // the loser would be recorded as where the work landed.
  it("picks the chronologically newest twin when the stamps carry different offsets", () => {
    const detection = only(
      detect(
        [
          feature("anton-live", { title: "Ship the thing" }),
          feature("anton-earlier", {
            title: "Ship the thing",
            status: "closed",
            updated_at: "2026-07-02T00:30:00+05:30", // 2026-07-01T19:00Z
          }),
          feature("anton-newest", {
            title: "Ship the thing",
            status: "closed",
            updated_at: "2026-07-01T20:00:00Z",
          }),
        ],
        [duplicate(["anton-earlier", "anton-newest", "anton-live"])],
      ),
    );

    expect(detection.target).toBe("anton-newest");
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

  // Settling a run target with tickets still under it would leave them beneath a card no run can
  // reach — the container-orphan state, reached by approving a proposal. bd's report line still
  // names the bead, so nothing is hidden; only the ask nobody could approve is.
  it("does not propose SETTLING a bead that still has open work under it", () => {
    expect(
      detect(
        [feature("anton-shipped"), bead("anton-t1", { parent: "anton-shipped" })],
        [orphan("anton-shipped")],
      ),
    ).toEqual([]);
    expect(
      detect(
        [
          feature("anton-live", { title: "Same" }),
          feature("anton-landed", { title: "Same", status: "closed" }),
          bead("anton-t1", { parent: "anton-live" }),
        ],
        [duplicate(["anton-landed", "anton-live"])],
      ),
    ).toEqual([]);
  });

  it("still proposes DEFERRING a stale bead with open children — parking is reversible", () => {
    const detection = only(
      detect(
        [
          feature("anton-cold", { updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS + 10) }),
          bead("anton-t1", { parent: "anton-cold" }),
        ],
        [stale("anton-cold", "open")],
      ),
    );

    expect(detection.retireAs).toBe("defer");
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

  // A grouped run publishes ONE lease, on the card its tickets hang under, so a ticket it has
  // selected but not yet reached carries no liveness signal of its own. Retiring one would take a
  // bead out of a live run's ticket set, and the run aborts when its claim reaches it.
  it("never retires a ticket of a card whose run is already under way", () => {
    const cold = daysAgo(RETIRE_STALE_OPEN_DAYS + 5);
    expect(
      detect(
        [
          feature("anton-running", { labels: [`run-lease:${NOW + 60_000}`] }),
          bead("anton-t1", { parent: "anton-running", updated_at: cold }),
          bead("anton-t2", { parent: "anton-t1", updated_at: cold }),
        ],
        [stale("anton-t1", "open"), orphan("anton-t2")],
      ),
    ).toEqual([]);
  });

  // A claim is written before its run publishes a lease, so a bead picked up seconds ago reads as
  // free to every liveness signal — and apply refuses only a claim it can date to after the filing.
  // A settling ask filed here would close work a queued runner already owns.
  it("never settles a bead a run has claimed but not yet leased", () => {
    expect(
      detect([feature("anton-shipped", { status: "in_progress", assignee: "box-2" })], [
        orphan("anton-shipped"),
      ]),
    ).toEqual([]);
    expect(
      detect(
        [
          feature("anton-live", { title: "Same", status: "in_progress", assignee: "box-2" }),
          feature("anton-landed", { title: "Same", status: "closed" }),
        ],
        [duplicate(["anton-landed", "anton-live"])],
      ),
    ).toEqual([]);
  });

  // The same blind spot one level down: a grouped run cascades an assignee onto the card it picked
  // up, and its unreached tickets carry no signal of their own.
  it("never settles a ticket whose card a run has claimed but not yet leased", () => {
    expect(
      detect(
        [
          feature("anton-card", { status: "in_progress", assignee: "box-2" }),
          bead("anton-t1", { parent: "anton-card" }),
        ],
        [orphan("anton-t1")],
      ),
    ).toEqual([]);
  });

  // …and the exception that bar is carved around: a bead in_progress and untouched for three weeks
  // IS a dead claim, which is the whole stale finding — deferring it is the one retirement verb a
  // claim must not silence.
  it("still defers a stale bead whose claim outlived its run", () => {
    const detection = only(
      detect(
        [
          feature("anton-dead", {
            status: "in_progress",
            assignee: "box-2",
            updated_at: daysAgo(RETIRE_STALE_IN_PROGRESS_DAYS + 2),
          }),
        ],
        [stale("anton-dead", "in_progress")],
      ),
    );

    expect(detection.kind).toBe("stale");
    expect(detection.retireAs).toBe("defer");
  });

  // The same subtree with nothing running it is ordinary retirement work, so the bar stays on the
  // RUN rather than on being somebody's child.
  it("still retires a ticket whose card no run holds", () => {
    const detection = only(
      detect(
        [
          feature("anton-idle"),
          bead("anton-t1", {
            parent: "anton-idle",
            updated_at: daysAgo(RETIRE_STALE_OPEN_DAYS + 5),
          }),
        ],
        [stale("anton-t1", "open")],
      ),
    );

    expect(detection.kind).toBe("stale");
    expect(detection.subjects).toEqual(["anton-t1"]);
  });

  // bd's report verbs are untyped, so a poured workflow parked on a human shows up as stale like
  // anything else. Every work surface holds plumbing out (isPipelineArtifact); retiring one would
  // mutate a hidden workflow-control bead an approver never meant to see on the board.
  it("never proposes retiring pipeline plumbing the untyped report sweeps in", () => {
    const cold = daysAgo(RETIRE_STALE_OPEN_DAYS + 30);
    expect(
      detect(
        [
          bead("anton-mol", { issue_type: "molecule", title: "Poured workflow", updated_at: cold }),
          bead("anton-gate", {
            issue_type: "gate",
            title: "Poured workflow",
            parent: "anton-mol",
            updated_at: cold,
          }),
          bead("anton-gate-landed", {
            issue_type: "gate",
            title: "Poured workflow",
            status: "closed",
          }),
        ],
        [
          stale("anton-mol", "open"),
          orphan("anton-gate"),
          duplicate(["anton-gate-landed", "anton-gate"]),
        ],
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
        new RegExp(`^${namespaceOf("container-orphan")}:container-orphan:[0-9a-f]{12}$`),
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
