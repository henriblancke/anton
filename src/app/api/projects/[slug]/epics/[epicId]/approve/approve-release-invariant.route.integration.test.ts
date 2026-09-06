/**
 * NO START WITHOUT EVIDENCE, as a checked property (anton-0lom).
 *
 * The release path has many branches, and every one of them was so far guarded by a case that
 * asserts its OWN expected rows (`approve-release.route.integration.test.ts`). That is a convention:
 * a future change that reintroduces a silent skip on a started pick would rewrite the one case that
 * noticed, and nothing would say the rule itself had been broken. anton-k4qr was exactly that bug —
 * a superseded generation dropped the accept while the approve and the enqueue landed anyway, so
 * earned autonomy read a start with no operator choice behind it.
 *
 * So this file holds the RULE rather than the rows, over one table driven across the branches:
 *
 *   • a start ⇒ evidence — if anton would pick this target now and the request left a run covering
 *     it, a verdict row for it must exist;
 *   • no start ⇒ no accept — a release that ends with nothing running must not leave one behind.
 *
 * The antecedent is DERIVED, never declared: "anton would pick this now" is `board.upNext`, the same
 * live ranking the lane draws and the route re-derives, read from a real board build at the instant
 * the click lands. And both derived facts — the button the card offers, and the pick the ranking
 * holds — are asserted per branch, so a branch can never drift into passing vacuously: a change that
 * stops offering `[Release]` on the superseded case fails here before the invariant is even asked.
 *
 * Out of scope: the PM's proposal ledger, a different record until the unification feature lands.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  actAs,
  executeEpicJobs,
  setupApproveSuite,
  type ApproveBody,
  type ApproveSuiteCtx,
} from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";
import { isPickerPick } from "@/components/board/board-utils";
import { getBoard } from "@/lib/board";
import { getProjectBySlug } from "@/lib/projects";
import { listPickerVerdicts, recordPickerVeto } from "@/lib/picker-veto";
import { STAGES, type ApprovalRunOutcome, type Board } from "@/lib/types";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];
let getDb: ApproveSuiteCtx["getDb"];
let schema: ApproveSuiteCtx["schema"];

/**
 * What one branch of the release path looks like, and the two DERIVED facts it claims about itself.
 *
 * `offers` and `picked` are asserted, not assumed — they are what makes the invariant below
 * non-vacuous, so a branch that quietly stops being a pick fails on its own claim rather than
 * passing on an antecedent that never fires.
 */
interface ReleaseBranch {
  name: string;
  /** Stage the world and answer with the target the operator is about to release. */
  arrange: () => Promise<string>;
  /** Whatever happens between the card being drawn and the click landing. */
  interleave?: (target: string) => Promise<unknown>;
  /** The board draws `[Release]` on the card the operator clicks (`isPickerPick`). */
  offers: boolean;
  /** anton would pick this target at the moment the click lands (`board.upNext`). */
  picked: boolean;
  /** The request leaves a run covering the target. */
  starts: boolean;
  /** Extra body beyond the release button's own `{ release, immediate }` — a take-over. */
  body?: ApproveBody;
  /** Who the click lands as, when it is not the operator who staged the board. */
  as?: string;
  /** Undo suite-wide state (a settings edit, a schedule row) for whatever runs next. */
  cleanup?: () => Promise<unknown>;
}

/** The `approvy` project row the fixture seeded — what every board read and picker record is keyed on. */
async function project() {
  return (await getProjectBySlug("approvy"))!;
}

/** A real board build — the screen the operator clicks from, which is also what RECORDS the plan
 *  generation the button posts (anton-f12y). Nothing here is a stand-in: the provenance, the lane and
 *  the generation are the ones the surface renders. */
async function drawBoard(): Promise<Board> {
  return getBoard(await project());
}

/** The card's badges, wherever the target renders — a run target is an epic card or a standalone chip. */
function provenanceOf(board: Board, id: string) {
  for (const stage of STAGES) {
    const epic = board.columns[stage].find((e) => e.id === id);
    if (epic) return epic.provenance;
    const chip = board.standalone[stage].find((s) => s.id === id);
    if (chip) return chip.provenance;
  }
  return undefined;
}

/** Every accept/decline recorded against `beadId` on the seeded project. */
async function verdictsFor(beadId: string) {
  const rows = await listPickerVerdicts(getDb(), (await project()).id);
  return rows.filter((r) => r.beadId === beadId);
}

/**
 * Did this request leave a run covering the target?
 *
 * The route's own `run` word, CHECKED against the queue rather than taken on trust — the invariant's
 * antecedent is "a run was enqueued", so a route that misreports one would otherwise silence the very
 * rule this file exists to hold. `elsewhere` counts: the work is running, on another machine, which
 * is what the accept records (anton-jz1).
 */
async function coveredByRun(res: Response, target: string): Promise<boolean> {
  if (res.status !== 200) {
    expect(await executeEpicJobs(target)).toHaveLength(0);
    return false;
  }
  const { run } = (await res.json()) as { run?: ApprovalRunOutcome };
  const jobs = await executeEpicJobs(target);
  if (run === "started") {
    expect(jobs.length).toBeGreaterThan(0);
    return true;
  }
  if (run === "elsewhere") return true;
  expect(jobs).toHaveLength(0);
  return false;
}

/** A runnable card-with-child pair, the shape every branch starts from. `labels` is how a branch
 *  makes a target runnable-but-never-PICKED: `agent:human` is approvable work anton refuses to rank. */
async function runTarget(title: string, labels?: string[]): Promise<string> {
  const epic = await beads.create(repo, {
    title,
    type: "epic",
    acceptance: "- [ ] it works",
    ...(labels ? { labels } : {}),
  });
  const child = await beads.create(repo, {
    title: `${title} child`,
    type: "task",
    acceptance: "- [ ] it works",
  });
  await beads.link(repo, child, epic, "parent-child");
  return epic;
}

/** Point the project's picker at `settings`, answering the undo the branch registers as `cleanup`. */
async function setPickerSettings(settings: Record<string, unknown>): Promise<void> {
  await getDb()
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify(settings) })
    .where(eq(schema.projects.id, (await project()).id));
}

/** The level the fixture seeds: the one that OFFERS picks, so an unwound branch leaves the next able
 *  to release at all. */
const OFFERING = { pickerAutonomy: "shadow" };

const BRANCHES: ReleaseBranch[] = [
  {
    name: "a live pick released from the generation on screen",
    arrange: () => runTarget("Live pick"),
    offers: true,
    picked: true,
    starts: true,
  },
  {
    name: "a live pick whose generation was replaced under the operator",
    // anton-k4qr's own case, and the one this file exists for: the tab still shows the generation it
    // was drawn from, a later decision has replaced it, and the target survives the re-derivation. A
    // silent skip here starts the run and records nothing — the invariant below is what refuses it.
    arrange: () => runTarget("Superseded but still ranked"),
    interleave: async () => {
      await runTarget("A newer arrival");
    },
    offers: true,
    picked: true,
    starts: true,
  },
  {
    name: "a live pick a run on another machine already covers",
    arrange: async () => {
      const epic = await runTarget("Running elsewhere");
      // A LABEL on the target, so it is part of the board the plan's fence covers — published before
      // the card is drawn, not between the draw and the click.
      await beads.publishRunLease(repo, epic, Date.now() + 15 * 60_000);
      return epic;
    },
    offers: true,
    picked: true,
    starts: true,
  },
  {
    name: "a pick the re-derivation no longer carries",
    // The other half of anton-k4qr: the card was drawn as a pick, and by the time the click lands the
    // board has moved it out of the ranking entirely. A release is a request to START the pick, so
    // anton refusing to pick it refuses the start — nothing approved, nothing enqueued, nothing recorded.
    arrange: () => runTarget("Retired between draw and click"),
    interleave: (target) => beads.tag(repo, target, ["agent:human"]),
    offers: true,
    picked: false,
    starts: false,
  },
  {
    name: "a pick a teammate claimed between the draw and the click",
    arrange: () => runTarget("Contested pick"),
    interleave: (target) => beads.assign(repo, target, "bob"),
    as: "alice",
    offers: true,
    picked: false,
    starts: false,
  },
  {
    name: "a target the ranking never carried",
    // The `release` flag is a CLAIM, not a fact: a stale lane or a direct caller can set it on any
    // runnable target. The run is the operator's to have; the evidence is not.
    arrange: () => runTarget("Never picked", ["agent:human"]),
    offers: false,
    picked: false,
    starts: true,
  },
  {
    name: "a pick the operator has vetoed",
    arrange: async () => {
      const epic = await runTarget("Vetoed pick");
      await recordPickerVeto(getDb(), { now: () => Date.now() }, {
        projectId: (await project()).id,
        beadId: epic,
        action: "not-now",
      });
      return epic;
    },
    offers: false,
    picked: false,
    starts: true,
  },
  {
    name: "a pick the policy's age bounds have moved past",
    // The decision input a plan's digest structurally cannot hold: a soak the target has not served.
    // The lane drops it, so the release answers a pick nobody is being offered.
    arrange: async () => {
      const epic = await runTarget("Soaking pick");
      await setPickerSettings({ ...OFFERING, pickerPolicy: { minAgeDays: 1 } });
      return epic;
    },
    offers: false,
    picked: false,
    starts: true,
    cleanup: () => setPickerSettings(OFFERING),
  },
  {
    name: "the picker is at propose",
    // The level that ranks and offers nothing (R3.5) — no lane, no badge, no start to answer for.
    arrange: async () => {
      const epic = await runTarget("Proposing picker");
      await setPickerSettings({ pickerAutonomy: "propose" });
      return epic;
    },
    offers: false,
    picked: false,
    starts: true,
    cleanup: () => setPickerSettings(OFFERING),
  },
  {
    name: "the picker is disarmed",
    arrange: async () => {
      const epic = await runTarget("Disarmed picker");
      await getDb().insert(schema.schedules).values({
        id: randomUUID(),
        projectId: (await project()).id,
        type: "board-picker",
        cron: "*/10 * * * *",
        enabled: false,
      });
      return epic;
    },
    offers: false,
    picked: false,
    starts: true,
    cleanup: async () =>
      getDb().delete(schema.schedules).where(eq(schema.schedules.projectId, (await project()).id)),
  },
  {
    name: "a take-over of blocked work that enqueues nothing",
    // The release answers its pick BEFORE it enqueues, so the price of reserving early is a run that
    // never follows. This is the branch where that happens, and where the reservation must come back
    // out: an accept for a run that never started is evidence of nothing.
    arrange: async () => {
      const blocker = await beads.create(repo, {
        title: "Reservation blocker",
        type: "task",
        acceptance: "- [ ] it works",
      });
      const target = await beads.create(repo, {
        title: "Reserved but never run",
        type: "task",
        acceptance: "- [ ] it works",
      });
      await beads.link(repo, target, blocker, "blocks");
      await beads.assign(repo, target, "someone-else");
      await beads.approve(repo, target);
      return target;
    },
    body: { steal: true },
    offers: false,
    picked: false,
    starts: false,
  },
];

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — release keeps its evidence rule", () => {
  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, approve, beads, resetOperatorCache, getDb, schema } = s);
  });

  afterAll(() => {
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  for (const branch of BRANCHES) {
    it(`no start without evidence — ${branch.name}`, async () => {
      actAs("anton-test");
      const target = await branch.arrange();
      try {
        // The card as drawn: what the operator saw, and the generation its button carries.
        const screen = await drawBoard();
        expect(isPickerPick(provenanceOf(screen, target)), "the board drew [Release]").toBe(
          branch.offers,
        );

        await branch.interleave?.(target);
        if (branch.as) actAs(branch.as);

        // The ranking as the CLICK finds it — the live decision the route re-derives, so a board that
        // moved between the draw and the click is judged where the route judges it.
        const atClick = branch.interleave ? await drawBoard() : screen;
        const picked = atClick.upNext?.some((e) => e.beadId === target) ?? false;
        expect(picked, "anton would pick this target now").toBe(branch.picked);

        const res = await approve(target, {
          release: true,
          immediate: true,
          ...(screen.upNextPlanId ? { planId: screen.upNextPlanId } : {}),
          ...branch.body,
        });
        const started = await coveredByRun(res, target);
        expect(started, "the request left a run covering the target").toBe(branch.starts);

        const rows = await verdictsFor(target);
        if (picked && started) {
          // THE INVARIANT. anton's own pick started a run, so the operator's answer to that pick has
          // to be on the record — earned autonomy counts these rows, and a start it cannot account
          // for is a start nobody chose.
          expect(rows, "a started pick left no verdict row").not.toEqual([]);
        }
        if (!started) {
          // Its dual: nothing ran, so there is nothing an accept could be evidence OF.
          expect(
            rows.filter((r) => r.verdict === "accepted"),
            "an accept survived a release that started nothing",
          ).toEqual([]);
        }
      } finally {
        await branch.cleanup?.();
      }
    });
  }

  it("drives the invariant, not around it", () => {
    // The table's own guard: a rule only held over branches that never fire is a rule nobody checks.
    // Both halves need cases, and the started-pick half needs more than the happy path — the
    // superseded generation is the one that regressed (anton-k4qr).
    expect(BRANCHES.filter((b) => b.picked && b.starts).length).toBeGreaterThanOrEqual(3);
    expect(BRANCHES.filter((b) => !b.starts).length).toBeGreaterThanOrEqual(2);
  });
});
