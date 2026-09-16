/**
 * The board-picker's brake sequence (anton-7p5x): every check the pass asks before it may act on
 * what it decided, as a REGISTERED LIST rather than a chain inlined in the handler — adding a brake
 * is adding an entry to {@link BOARD_PICKER_BRAKES}, not a new branch in the caller. The order below
 * IS the order every unattended pass asks it, pinned by name in board-picker.test.ts.
 *
 * Two of the brakes LATCH a standing disarm (`failure-streak`, `score-slide`); `disarm` then reads
 * whichever of them fired, or one an operator set by hand — read only after both, so a fresh latch
 * from this same pass is already visible to it. `wip-hold` is the one brake that clears itself, so it
 * is derived fresh every pass rather than read off a latch. The last three resolve how far an armed
 * project may go: `track-record` reads the operator's own accept/veto history (fetched alongside
 * settings in one round trip, since neither depends on the other), `armed-policy` reads the policy
 * setting, and `earned-autonomy` floors the setting by what that history has earned (anton-vkp9),
 * logging the reason out loud so the setting's own silence never has to speak for it.
 *
 * This module also owns the small ranking glue either side of the sequence leans on —
 * {@link rankBoardPickerPlan} (the pure decision, bound to one board snapshot) and
 * {@link resolveArmedPolicy} (the same policy read the restamp needs on its own, after the brakes
 * have already run once) — so board-picker.ts is left with the I/O ends the module's own header
 * describes: the board read, the write of the plan, and the call into ./picker-apply.
 */
import type { Bead } from "../beads/types";
import { activeDisarm } from "../autopilot-disarm";
import type { AutopilotDisarm } from "../autopilot-breaker";
import { describeFailureStreak } from "../autopilot-failure-streak";
import { describeScoreSlide } from "../autopilot-score-slide";
import { describeWipHold, type WipHold } from "../autopilot-wip";
import { activeDeferrals, pickerTrackRecord, type PickerTrackRecord } from "../picker-veto";
import { pickerApplyVerdict, type PickerApplyVerdict } from "../gardener/autonomy";
import {
  getProjectSettings,
  resolvePickerApplyOverride,
  resolvePickerAutonomy,
  resolvePickerPolicy,
  type ProjectSettings,
} from "../projects";
import type { Policy, PickerAutonomy } from "../policy/types";
import { checkFailureStreak } from "./picker-failure-breaker";
import { checkScoreSlide } from "./picker-score-breaker";
import { checkWipLimit, type ReadPrActivity } from "./picker-wip-hold";
import {
  ADMIT_ALL_POLICY,
  decideBoardPickerPlan,
  type BoardPickerDecision,
} from "./picker-decision";
import { armedPickerPolicy } from "./picker-policy";
import type { AntonDb, Clock } from "./queue";

/** Everything a brake needs to decide, gathered once per pass. */
export interface BoardPickerBrakeContext {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  board: Bead[];
  signal: AbortSignal;
  readPrActivity?: ReadPrActivity;
}

/** What the sequence has learned so far — each brake reads what it needs and adds its own answer. */
export interface BoardPickerBrakeState {
  disarm?: AutopilotDisarm;
  hold?: WipHold;
  settings?: ProjectSettings;
  record?: PickerTrackRecord;
  armed?: Policy;
  autonomy?: PickerAutonomy;
  verdict?: PickerApplyVerdict;
}

/** One named brake: reads whatever it needs off the context and the state so far, answers its own. */
export interface BoardPickerBrake {
  name: string;
  run(
    ctx: BoardPickerBrakeContext,
    state: BoardPickerBrakeState,
  ): Promise<BoardPickerBrakeState>;
}

/**
 * The registered sequence, in the order every pass asks it. {@link runBoardPickerBrakes} folds over
 * this array — a new brake is a new entry here, never a new branch in the fold itself.
 */
export const BOARD_PICKER_BRAKES: BoardPickerBrake[] = [
  {
    // R4.4: a streak of runs that stopped without delivering latches the standing disarm.
    name: "failure-streak",
    async run({ db, clock, projectId, board }, state) {
      const breaker = await checkFailureStreak(db, clock, { projectId, board });
      if (breaker?.latched) {
        console.warn(`[board-picker] ${projectId}: disarmed — ${describeFailureStreak(breaker.streak)}`);
      }
      return state;
    },
  },
  {
    // R4.3: runs that DELIVER but keep scoring below the floor latch the same disarm — run after the
    // failure breaker rather than beside it, so whichever fires first owns the freeze and the other
    // reads it as already-disarmed and abstains, rather than stacking a second thing to clear.
    name: "score-slide",
    async run({ db, clock, projectId }, state) {
      const slide = await checkScoreSlide(db, clock, { projectId });
      if (slide?.latched) {
        console.warn(`[board-picker] ${projectId}: disarmed — ${describeScoreSlide(slide.slide)}`);
      }
      return state;
    },
  },
  {
    // R4.2: the only brake that clears itself — re-derived fresh every pass, never latched.
    name: "wip-hold",
    async run({ db, projectId, repoPath, board, signal, readPrActivity }, state) {
      const hold = await checkWipLimit(db, {
        projectId,
        repoPath,
        board,
        signal,
        ...(readPrActivity ? { readPrActivity } : {}),
      });
      if (hold) console.info(`[board-picker] ${projectId}: holding — ${describeWipHold(hold)}`);
      return { ...state, hold };
    },
  },
  {
    // Whether the project is FROZEN, asked of the disarm table rather than of the two checks above:
    // both answer `undefined` on an already-disarmed project (a latch does not re-latch), so reading
    // their verdicts alone would treat every pass after the first as armed again. Read after both, so
    // a fresh latch from this same pass is already visible here.
    name: "disarm",
    async run({ db, projectId }, state) {
      return { ...state, disarm: await activeDisarm(db, projectId) };
    },
  },
  {
    // The operator's own accept/veto record — re-read every pass, since the window rolls and a record
    // that degrades after arming must return the picker to `shadow` on the very next tick. Fetched
    // alongside settings in one round trip: two independent reads, so one trip rather than two.
    name: "track-record",
    async run({ db, projectId }, state) {
      const [settings, record] = await Promise.all([
        getProjectSettings(db, projectId),
        pickerTrackRecord(db, projectId),
      ]);
      return { ...state, settings, record };
    },
  },
  {
    // The policy the operator accepted in settings, applied to the plan this pass records. An unarmed
    // project keeps the structural default — the pass starts nothing, so an unnarrowed plan is a
    // ranking, not an autopilot.
    name: "armed-policy",
    async run(_ctx, state) {
      return { ...state, armed: state.settings ? resolvePickerPolicy(state.settings) : undefined };
    },
  },
  {
    // How far this pass may go with what it decides (anton-vkp9): floored by what this project's own
    // releases and vetoes have EARNED, not by the setting alone. Said out loud, because a setting the
    // pass silently ignores is the unexplained state this floor exists to avoid.
    name: "earned-autonomy",
    async run({ projectId }, state) {
      const { settings, record } = state;
      if (!settings || !record) return state;
      const autonomy = resolvePickerAutonomy(settings, record);
      const verdict = pickerApplyVerdict(record, resolvePickerApplyOverride(settings));
      if (settings.pickerAutonomy === "apply" && settings.pickerPolicy) {
        if (autonomy !== "apply") {
          console.info(`[board-picker] ${projectId}: apply not earned — ${verdict.reason}`);
        } else if (verdict.arming === "deliberate" && verdict.deliberate) {
          console.info(
            `[board-picker] ${projectId}: apply armed deliberately by ${verdict.deliberate.by} ` +
              `on ${verdict.deliberate.at} — ${verdict.earned.reason}`,
          );
        }
      }
      return { ...state, autonomy, verdict };
    },
  },
];

/** Run the registered brake sequence in order, folding each answer into the next. */
export async function runBoardPickerBrakes(
  ctx: BoardPickerBrakeContext,
): Promise<BoardPickerBrakeState> {
  let state: BoardPickerBrakeState = {};
  for (const brake of BOARD_PICKER_BRAKES) {
    state = await brake.run(ctx, state);
  }
  return state;
}

/**
 * One decision over one board snapshot — the same function whether it is the pass's first read or
 * the re-read that follows its own start. Shared rather than repeated, because a restamp decided by
 * a second copy of these inputs could rank differently from the plan it replaces for no reason an
 * operator could see.
 *
 * The deferrals are resolved here against the OBSERVATION instant, like the age criterion beside
 * them, so one decision answers "is this still deferred?" the same way for every target it ranks.
 */
export async function rankBoardPickerPlan(
  db: AntonDb,
  input: { projectId: string; board: Bead[]; observedAtMs: number; armed?: Policy },
): Promise<BoardPickerDecision> {
  const { projectId, board, observedAtMs, armed } = input;
  const at = new Date(observedAtMs);
  return decideBoardPickerPlan({
    board,
    policy: armed ? armedPickerPolicy(armed, board, at) : ADMIT_ALL_POLICY,
    // Stamped into the plan's freshness fence, so a settings edit that admits or excludes a target
    // invalidates this plan the moment it lands rather than a cadence later.
    ...(armed ? { armedPolicy: armed } : {}),
    runtime: { observedAtMs, deferrals: await activeDeferrals(db, projectId, at) },
  });
}

/** The armed policy as settings read NOW — the restamp's own fresh read, outside the brake sequence. */
export async function resolveArmedPolicy(db: AntonDb, projectId: string): Promise<Policy | undefined> {
  return resolvePickerPolicy(await getProjectSettings(db, projectId));
}
