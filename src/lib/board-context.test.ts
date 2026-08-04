/**
 * Unit cover for the board context /scan-triage routes and dedupes against (anton-ol1l). The rules
 * asserted here are the mechanical half of placement — which feature may take a child, which epic
 * may take a feature, which fingerprints count as "already raised" — so a drift in any of them
 * shows up as a failing case rather than as a duplicate bead on someone's board.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "./beads/bd";
import {
  BOARD_CONTEXT_HEADING,
  MAX_FEATURES,
  MAX_PRODUCER_BEADS,
  MAX_TOUCHES,
  buildBoardContext,
  fingerprintsOf,
  formatBoardContext,
  formatBoardContextUnavailable,
  parseFingerprint,
  parseTouches,
} from "./board-context";

function bead(over: Partial<Bead> & { id: string }): Bead {
  return { title: `bead ${over.id}`, status: "open", ...over };
}

/** `<child> is a child of <parent>` as bd carries it inline on the child's `dependencies`. */
function childOf(child: Bead, parentId: string): Bead {
  return {
    ...child,
    dependencies: [
      ...(child.dependencies ?? []),
      { issue_id: child.id, depends_on_id: parentId, type: "parent-child" },
    ],
  };
}

describe("parseFingerprint", () => {
  it("reads every producer namespace, not just stringer", () => {
    expect(parseFingerprint("stringer:duplication:8000d8e1")).toMatchObject({
      producer: "stringer",
      class: "duplication",
      hash: "8000d8e1",
    });
    expect(parseFingerprint("gardener:duplicate:8000d8e1")?.producer).toBe("gardener");
    expect(parseFingerprint("pm:proposal:8000d8e1")?.producer).toBe("pm");
  });

  it("ignores ordinary labels and malformed fingerprints", () => {
    for (const label of ["risk:high", "source:stringer", "stringer:todos", "other:x:y"]) {
      expect(parseFingerprint(label)).toBeUndefined();
    }
  });

  it("collects every fingerprint on a bead", () => {
    const b = bead({
      id: "a-1",
      labels: ["risk:low", "stringer:patterns:a766eaf4", "stringer:patterns:d2b18f20"],
    });
    expect(fingerprintsOf(b).map((f) => f.hash)).toEqual(["a766eaf4", "d2b18f20"]);
  });
});

describe("parseTouches", () => {
  it("reads the touch surface out of a bead's ## Context section", () => {
    const b = bead({
      id: "a-1",
      description: "## Goal\nx\n\n## Context\ntouches: src/lib/auth/session.ts:14, src/app/api/auth/route.ts; remediation: extract\n\n## Verify\ny",
    });
    expect(parseTouches(b)).toEqual(["src/lib/auth/session.ts", "src/app/api/auth/route.ts"]);
  });

  it("prefers bd's own context field when it carries one", () => {
    const b = bead({
      id: "a-1",
      context: "touches: src/lib/csv.ts",
      description: "## Context\ntouches: src/wrong.ts",
    });
    expect(parseTouches(b)).toEqual(["src/lib/csv.ts"]);
  });

  it("strips the annotations and line ranges real triage beads carry", () => {
    const b = bead({
      id: "a-1",
      context:
        "touches: src/lib/beads/claim-lock.ts (54 lines, one export), src/components/runs/run-detail-view.tsx:28-42, `src/lib/runs.ts`",
    });
    expect(parseTouches(b)).toEqual([
      "src/lib/beads/claim-lock.ts",
      "src/components/runs/run-detail-view.tsx",
      "src/lib/runs.ts",
    ]);
  });

  it("contributes nothing rather than garbage when the Context is prose", () => {
    expect(parseTouches(bead({ id: "a-1", context: "Found while implementing anton-286r." }))).toEqual([]);
    expect(parseTouches(bead({ id: "a-1" }))).toEqual([]);
  });

  it("keeps extensionless root files, which have neither a slash nor a dot to prove them", () => {
    // Dropping one leaves the file unowned, so a signal against it routes into a rival feature.
    const b = bead({ id: "a-1", context: "touches: Dockerfile, Makefile, src/lib/runs.ts" });
    expect(parseTouches(b)).toEqual(["Dockerfile", "Makefile", "src/lib/runs.ts"]);
  });

  it("keeps the glob and directory surfaces the contract's own documented form uses", () => {
    // `touches: app/reports/*` is skills/bd/SKILL.md's example. Stripping the `*` erased `app/*`
    // and `src/**` entirely, so files a run already owns read as unowned to the next triage.
    const b = bead({
      id: "a-1",
      context: "touches: app/reports/*, app/*, src/**/*.ts, src/lib/*.ts, src/components/",
    });
    expect(parseTouches(b)).toEqual([
      "app/reports/*",
      "app/*",
      "src/**/*.ts",
      "src/lib/*.ts",
      "src/components/",
    ]);
  });

  it("keeps the App Router segments this repo's own paths are full of", () => {
    // Dropping `[slug]` or collapsing `(board)` to `src/app/` is the misroute this module prevents:
    // the first leaves the route unowned, the second hands the feature every file under `src/app`.
    const b = bead({
      id: "a-1",
      context:
        "touches: src/app/projects/[slug]/settings/route.ts, src/app/(board)/page.tsx (54 lines, one export), src/app/(board)/, src/app/api/[[...path]]/route.ts",
    });
    expect(parseTouches(b)).toEqual([
      "src/app/projects/[slug]/settings/route.ts",
      "src/app/(board)/page.tsx",
      "src/app/(board)/",
      "src/app/api/[[...path]]/route.ts",
    ]);
  });

  it("keeps SvelteKit's plus-prefixed route files", () => {
    // Every SvelteKit route file starts with `+`; dropping them left the whole routes tree unowned.
    const b = bead({
      id: "a-1",
      context: "touches: src/routes/+page.svelte, src/routes/(app)/+layout.server.ts, src/routes/+*",
    });
    expect(parseTouches(b)).toEqual([
      "src/routes/+page.svelte",
      "src/routes/(app)/+layout.server.ts",
      "src/routes/+*",
    ]);
  });

  it("unwraps markdown emphasis without mistaking a trailing glob for it", () => {
    const b = bead({ id: "a-1", context: "touches: **src/lib/runs.ts**, *src/x.ts:14*, src/api/*" });
    expect(parseTouches(b)).toEqual(["src/lib/runs.ts", "src/x.ts", "src/api/*"]);
  });

  it("still refuses the prose words that allowlist could have opened the door to", () => {
    expect(parseTouches(bead({ id: "a-1", context: "touches: auth, routing, the build" }))).toEqual([]);
  });

  it("reads a heading at ANY depth, exactly as the contract gate does", () => {
    // A `# Context` bead passes validation, so a routing parser that only took `##` reported no
    // touch surface for a conformant bead — and triage minted work beside it.
    for (const heading of ["# Context", "### Context"]) {
      const b = bead({ id: "a-1", description: `${heading}\ntouches: src/lib/runs.ts` });
      expect(parseTouches(b)).toEqual(["src/lib/runs.ts"]);
    }
  });
});

describe("buildBoardContext — feature attach verdicts", () => {
  const surface = { context: "touches: src/lib/auth/session.ts" };

  it("offers a plain open feature that already has children", () => {
    const feature = bead({ id: "f-1", issue_type: "feature", ...surface });
    const ctx = buildBoardContext([feature, childOf(bead({ id: "t-1", issue_type: "task" }), "f-1")]);
    expect(ctx.features).toHaveLength(1);
    expect(ctx.features[0]).toMatchObject({
      id: "f-1",
      attachable: true,
      touches: ["src/lib/auth/session.ts"],
    });
  });

  it("owns the files its child tickets declare, not just the ones it repeats itself", () => {
    // The feature's RUN implements its children, so a file only a child names is still owned — read
    // as unowned, it is the signal that mints a run target beside the run already changing it.
    const feature = bead({ id: "f-1", issue_type: "feature", ...surface });
    const child = childOf(
      bead({ id: "t-1", issue_type: "task", context: "touches: src/lib/auth/token.ts" }),
      "f-1",
    );
    const grandchild = childOf(
      bead({ id: "t-2", issue_type: "task", context: "touches: src/lib/auth/cookie.ts" }),
      "t-1",
    );
    const ctx = buildBoardContext([feature, child, grandchild]);

    expect(ctx.features[0].touches).toEqual([
      "src/lib/auth/session.ts",
      "src/lib/auth/token.ts",
      "src/lib/auth/cookie.ts",
    ]);
  });

  it("survives a cyclic parent-child edge rather than hanging on the board read", () => {
    const feature = childOf(bead({ id: "f-1", issue_type: "feature", ...surface }), "t-1");
    const child = childOf(
      bead({ id: "t-1", issue_type: "task", context: "touches: src/lib/auth/token.ts" }),
      "f-1",
    );
    const ctx = buildBoardContext([feature, child]);
    expect(ctx.features[0].touches).toEqual(["src/lib/auth/session.ts", "src/lib/auth/token.ts"]);
  });

  it("refuses a childless feature — its first child would replace its own spec", () => {
    const ctx = buildBoardContext([bead({ id: "f-1", issue_type: "feature", ...surface })]);
    expect(ctx.features[0].attachable).toBe(false);
    expect(ctx.features[0].attachReason).toContain("childless");
  });

  it.each([
    ["approved", { labels: ["approved"] }],
    ["stage:implementing", { labels: ["stage:implementing"] }],
    ["run-lease", { labels: ["run-lease:1799999999999:run-a"] }],
    ["PR ref", { metadata: { pr: "gh-42" } }],
    ["in_progress", { status: "in_progress" }],
  ])("refuses a feature whose run has been captured (%s)", (_name, over) => {
    const feature = bead({ id: "f-1", issue_type: "feature", ...surface, ...over });
    const ctx = buildBoardContext([feature, childOf(bead({ id: "t-1", issue_type: "task" }), "f-1")]);
    expect(ctx.features[0].attachable).toBe(false);
  });

  it("carries the epic a feature hangs off, so a sibling can be filed under the same outcome", () => {
    const epic = bead({ id: "e-1", issue_type: "epic", labels: ["area:auth"] });
    const feature = childOf(bead({ id: "f-1", issue_type: "feature", ...surface }), "e-1");
    const ctx = buildBoardContext([epic, feature, childOf(bead({ id: "t-1", issue_type: "task" }), "f-1")]);
    expect(ctx.features[0].epicId).toBe("e-1");
  });

  it("omits closed features — they own nothing a new signal can join", () => {
    const ctx = buildBoardContext([bead({ id: "f-1", issue_type: "feature", status: "closed", ...surface })]);
    expect(ctx.features).toHaveLength(0);
  });
});

describe("buildBoardContext — epic attach verdicts", () => {
  it("refuses a pre-tier epic, whose ticket children a first feature would strand", () => {
    const epic = bead({ id: "e-1", issue_type: "epic", labels: ["area:auth"] });
    const ctx = buildBoardContext([epic, childOf(bead({ id: "t-1", issue_type: "task" }), "e-1")]);
    expect(ctx.epics[0]).toMatchObject({ attachable: false, area: "area:auth" });
    expect(ctx.epics[0].attachReason).toContain("PRE-TIER");
  });

  it("offers an epic whose only ticket children are CLOSED — nothing is left to strand", () => {
    const epic = bead({ id: "e-1", issue_type: "epic" });
    const ctx = buildBoardContext([
      epic,
      childOf(bead({ id: "t-1", issue_type: "task", status: "closed" }), "e-1"),
      childOf(bead({ id: "t-2", issue_type: "task", status: "done" }), "e-1"),
    ]);
    expect(ctx.epics[0].attachable).toBe(true);
  });

  it("still refuses when ONE open ticket remains among closed ones", () => {
    const ctx = buildBoardContext([
      bead({ id: "e-1", issue_type: "epic" }),
      childOf(bead({ id: "t-1", issue_type: "task", status: "closed" }), "e-1"),
      childOf(bead({ id: "t-2", issue_type: "task" }), "e-1"),
    ]);
    expect(ctx.epics[0].attachReason).toContain("PRE-TIER");
  });

  it("counts a CLOSED feature child as proof the epic is a container", () => {
    const ctx = buildBoardContext([
      bead({ id: "e-1", issue_type: "epic" }),
      childOf(bead({ id: "f-1", issue_type: "feature", status: "closed" }), "e-1"),
      childOf(bead({ id: "t-1", issue_type: "task" }), "e-1"),
    ]);
    expect(ctx.epics[0].attachable).toBe(true);
  });

  it("offers an epic that already groups features, and an empty one", () => {
    const withFeature = bead({ id: "e-1", issue_type: "epic" });
    const empty = bead({ id: "e-2", issue_type: "epic" });
    const ctx = buildBoardContext([
      withFeature,
      empty,
      childOf(bead({ id: "f-1", issue_type: "feature" }), "e-1"),
    ]);
    expect(ctx.epics.map((e) => e.attachable)).toEqual([true, true]);
  });

  // §4.1's correct outcome for a signal is often an epic that already shipped: hiding it lets an
  // unattended triage conclude no home exists and mint a duplicate outcome.
  it("offers CLOSED epics too, ranked after the open ones", () => {
    const ctx = buildBoardContext([
      bead({ id: "e-closed", issue_type: "epic", status: "closed", title: "Deps are current" }),
      bead({ id: "e-open", issue_type: "epic" }),
    ]);
    expect(ctx.epics.map((e) => e.id)).toEqual(["e-open", "e-closed"]);
    expect(ctx.epics[1]).toMatchObject({ status: "closed", attachable: true });
  });

  // A delivered outcome is reusable; an abandoned one is a human won't-do. Offering it has triage
  // reopen it off a signal that merely matched its area, reversing the decision unattended.
  it("drops ABANDONED epics from the candidates entirely", () => {
    const ctx = buildBoardContext([
      bead({
        id: "e-dropped",
        issue_type: "epic",
        status: "closed",
        labels: ["abandoned", "area:auth"],
      }),
      bead({ id: "e-shipped", issue_type: "epic", status: "closed" }),
    ]);
    expect(ctx.epics.map((e) => e.id)).toEqual(["e-shipped"]);
    expect(formatBoardContext(ctx)).not.toContain("e-dropped");
  });

  it("still refuses a closed epic that is pre-tier — reopening it would strand its open tickets", () => {
    const ctx = buildBoardContext([
      bead({ id: "e-1", issue_type: "epic", status: "closed" }),
      childOf(bead({ id: "t-1", issue_type: "task" }), "e-1"),
    ]);
    expect(ctx.epics[0].attachable).toBe(false);
    expect(ctx.epics[0].attachReason).toContain("PRE-TIER");
  });
});

describe("buildBoardContext — cross-producer fingerprints", () => {
  it("lists every open producer-filed bead with its fingerprints and surface", () => {
    const stringerBead = bead({
      id: "s-1",
      issue_type: "task",
      labels: ["source:stringer", "stringer:duplication:8000d8e1"],
      context: "touches: src/lib/runs.ts",
    });
    const gardenerBead = bead({
      id: "g-1",
      issue_type: "task",
      labels: ["gardener:duplicate:8000d8e1"],
      context: "touches: src/lib/runs.ts",
    });
    const ctx = buildBoardContext([stringerBead, gardenerBead, bead({ id: "x-1", labels: ["risk:low"] })]);

    expect(ctx.producers.map((p) => p.id)).toEqual(["s-1", "g-1"]);
    // The collision the triage must arbitrate: one hash, two namespaces.
    const hashes = ctx.producers.flatMap((p) => p.fingerprints.map((f) => f.hash));
    expect(new Set(hashes).size).toBe(1);
  });

  it("drops closed producer beads — a fixed issue that came back is a real signal again", () => {
    const ctx = buildBoardContext([
      bead({ id: "s-1", status: "closed", labels: ["stringer:todos:aaa"] }),
    ]);
    expect(ctx.producers).toHaveLength(0);
  });
});

describe("formatBoardContext", () => {
  it("renders one citable line per feature, epic and producer bead", () => {
    const epic = bead({ id: "e-1", issue_type: "epic", title: "Auth is trustworthy", labels: ["area:auth"] });
    const feature = childOf(
      bead({
        id: "f-1",
        issue_type: "feature",
        title: "Harden the session helpers",
        context: "touches: src/lib/auth/session.ts",
      }),
      "e-1",
    );
    const ticket = childOf(bead({ id: "t-1", issue_type: "task" }), "f-1");
    const gardenerBead = bead({ id: "g-1", title: "dupes", labels: ["gardener:duplicate:8000d8e1"] });

    const out = formatBoardContext(buildBoardContext([epic, feature, ticket, gardenerBead]));

    expect(out).toContain(BOARD_CONTEXT_HEADING);
    expect(out).toContain("f-1 · attach:child · epic:e-1 · Harden the session helpers · touches: src/lib/auth/session.ts");
    expect(out).toContain("e-1 · attach:feature");
    expect(out).toContain("g-1 · open · gardener:duplicate:8000d8e1");
  });

  // A bare `attach:feature` on a closed epic would have triage link under it and leave a delivered
  // outcome on the roadmap with backlog work beneath it — linking never reopens the parent.
  it("marks a closed epic reopen-first, naming the command that makes it linkable", () => {
    const out = formatBoardContext(
      buildBoardContext([
        bead({ id: "e-9", issue_type: "epic", status: "closed", title: "Deps are current" }),
      ]),
    );
    expect(out).toContain("e-9 · attach:reopen-first (closed — `bd reopen e-9` before linking");
    expect(out).toContain("open and closed");
  });

  it("says what it dropped instead of truncating silently", () => {
    const board = Array.from({ length: MAX_FEATURES + 3 }, (_, i) =>
      bead({ id: `f-${i}`, issue_type: "feature", context: "touches: src/x.ts" }),
    );
    const ctx = buildBoardContext(board);
    expect(ctx.omitted.features).toBe(3);
    expect(formatBoardContext(ctx)).toContain("and 3 more open feature(s) (omitted");
  });

  // Bare `bd list` is capped at 50, so a hint naming it hands back another truncated slice — triage
  // still misses the owning feature or existing fingerprint and mints the duplicate anyway.
  it("points every capped section at an UNLIMITED board read, never a bare `bd list`", () => {
    const board = [
      ...Array.from({ length: MAX_FEATURES + 1 }, (_, i) =>
        bead({ id: `f-${i}`, issue_type: "feature", context: "touches: src/x.ts" }),
      ),
      ...Array.from({ length: MAX_PRODUCER_BEADS + 1 }, (_, i) =>
        bead({ id: `p-${i}`, labels: [`stringer:duplication:${i.toString(16).padStart(8, "0")}`] }),
      ),
    ];
    const out = formatBoardContext(buildBoardContext(board));
    expect(out).toContain("and 1 more open feature(s) (omitted — ask `bd list --json --limit 0`");
    expect(out).toContain(
      "and 1 more producer-filed bead(s) (omitted — ask `bd list --json --limit 0`",
    );
    expect(out).not.toMatch(/ask `bd list` for the rest/);
  });

  it("says a touch surface was CAPPED rather than presenting part of it as the whole", () => {
    // A signal on file 13 must not read as unowned — that is how a duplicate cluster gets minted
    // beside the run already changing that file.
    const declared = Array.from({ length: MAX_TOUCHES + 5 }, (_, i) => `src/lib/f${i}.ts`);
    const feature = bead({
      id: "f-1",
      issue_type: "feature",
      context: `touches: ${declared.join(", ")}`,
    });
    const ctx = buildBoardContext([feature, childOf(bead({ id: "t-1", issue_type: "task" }), "f-1")]);

    expect(ctx.features[0].touches).toHaveLength(MAX_TOUCHES);
    expect(ctx.features[0].touchesOmitted).toBe(5);
    // A feature's surface aggregates its children's paths, so the dropped one may be a child's — and
    // `bd show` on the feature cannot show a child's Context. Point at the read that can.
    expect(formatBoardContext(ctx)).toContain(
      "+5 more not shown — `bd show f-1` and `bd children f-1`",
    );
  });

  it("sends a capped producer bead to its OWN show — its surface inherits nothing", () => {
    const declared = Array.from({ length: MAX_TOUCHES + 2 }, (_, i) => `src/lib/f${i}.ts`);
    const ctx = buildBoardContext([
      bead({
        id: "s-1",
        issue_type: "task",
        labels: ["stringer:duplication:8000d8e1"],
        context: `touches: ${declared.join(", ")}`,
      }),
    ]);

    expect(formatBoardContext(ctx)).toContain("+2 more not shown — `bd show s-1` before deciding");
  });

  it("leaves a surface inside the cap unqualified", () => {
    const feature = bead({ id: "f-1", issue_type: "feature", context: "touches: src/lib/runs.ts" });
    const ctx = buildBoardContext([feature, childOf(bead({ id: "t-1", issue_type: "task" }), "f-1")]);
    expect(ctx.features[0].touchesOmitted).toBe(0);
    expect(formatBoardContext(ctx)).not.toContain("more not shown");
  });

  it("names the empty sections rather than rendering a blank the agent reads as noise", () => {
    const out = formatBoardContext(buildBoardContext([]));
    expect(out).toContain("(no open features)");
    expect(out).toContain("(no epics on the board)");
    expect(out).toContain("(no producer-filed beads open)");
  });

  it("an unavailable board says so loudly — silence would read as an empty board", () => {
    const out = formatBoardContextUnavailable("bd exited 1");
    expect(out).toContain("UNAVAILABLE");
    expect(out).toContain("bd exited 1");
    expect(out).toContain("Do NOT treat this as an empty board");
  });
});
