/**
 * Cadence presets and human-readable cron descriptions (anton-1sa6).
 *
 * One source of truth for "what does this cron mean" so the settings picker, the schedule row
 * summary and the stored expression can never disagree: {@link presetForCron} decides which menu
 * item a stored cron opens on, {@link cronForPreset} turns that choice back into the exact same
 * string, and {@link describeCron} renders the phrase both surfaces show.
 *
 * Deliberately narrow: only the shapes the presets can produce get a phrase. Anything else — a
 * hand-written expression with lists, ranges or a restricted month — resolves to the `custom`
 * preset and describes as its own raw text, rather than growing a cronstrue-grade describer.
 *
 * Pure TypeScript with no node builtins (it reuses cron.ts, which is equally pure), so the client
 * settings component can import it directly.
 */
import { isValidCron, parseCron } from "./cron";

export type CadencePresetId =
  | "every-5-minutes"
  | "every-10-minutes"
  | "every-15-minutes"
  | "every-30-minutes"
  | "hourly"
  | "hourly-at"
  | "daily"
  | "weekly"
  | "custom";

/** The parts a preset names — which values carry over when the operator switches between presets. */
export type CadenceField = "minute" | "hour" | "weekday";

/** The knobs a preset can read. Unused fields keep their default so switching presets is lossless. */
export interface CadenceParts {
  /** Minute of the hour, 0-59. */
  minute: number;
  /** Hour of the day, 0-23 (local time — schedules run on the machine's clock). */
  hour: number;
  /** Day of week, 0-6 with Sunday = 0. */
  weekday: number;
}

export interface CadencePreset {
  id: CadencePresetId;
  /** Menu label. Presets that take inputs read as a lead-in ("Daily at…"). */
  label: string;
  fields: readonly CadenceField[];
  /** Starting values when an operator switches TO this preset. */
  defaults: CadenceParts;
}

export interface CadenceSelection {
  presetId: CadencePresetId;
  /** The preset's inputs, filled from the expression where it names them and defaulted otherwise. */
  parts: CadenceParts;
}

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Fallback inputs for fields a preset does not name, so every selection carries a full set. */
const BASE_PARTS: CadenceParts = { minute: 0, hour: 3, weekday: 1 };

/** Step minutes offered as fixed menu items; other steps still describe, but open as `custom`. */
const PRESET_STEPS = [5, 10, 15, 30] as const;

export const CADENCE_PRESETS: readonly CadencePreset[] = [
  {
    id: "every-5-minutes",
    label: "Every 5 minutes",
    fields: [],
    defaults: BASE_PARTS,
  },
  {
    id: "every-10-minutes",
    label: "Every 10 minutes",
    fields: [],
    defaults: BASE_PARTS,
  },
  {
    id: "every-15-minutes",
    label: "Every 15 minutes",
    fields: [],
    defaults: BASE_PARTS,
  },
  {
    id: "every-30-minutes",
    label: "Every 30 minutes",
    fields: [],
    defaults: BASE_PARTS,
  },
  {
    id: "hourly",
    label: "Hourly",
    fields: [],
    defaults: BASE_PARTS,
  },
  {
    id: "hourly-at",
    // Minute 0 belongs to `hourly`, so this preset starts mid-hour — see presetForCron.
    label: "Hourly at…",
    fields: ["minute"],
    defaults: { ...BASE_PARTS, minute: 30 },
  },
  {
    id: "daily",
    label: "Daily at…",
    fields: ["hour", "minute"],
    defaults: { ...BASE_PARTS, hour: 3, minute: 0 },
  },
  {
    id: "weekly",
    label: "Weekly on…",
    fields: ["weekday", "hour", "minute"],
    defaults: { ...BASE_PARTS, weekday: 1, hour: 4, minute: 0 },
  },
  {
    id: "custom",
    label: "Custom cron",
    fields: [],
    defaults: BASE_PARTS,
  },
];

export function presetById(id: CadencePresetId): CadencePreset | undefined {
  return CADENCE_PRESETS.find((p) => p.id === id);
}

/** The cadence shapes this module can name. Anything else is `custom`/raw. */
type Cadence =
  | { kind: "every-minutes"; step: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

const ALL = "*";

/** A field written as a bare in-range integer (not a list, range or step). */
function plainInt(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/**
 * Recognise the cadence a cron spells out, or null when it is outside the named set. Matches on the
 * raw field text rather than the parsed value sets: the point is to recover the operator's *choice*,
 * and `0,15,30,45` is a hand-written expression even though it fires like `*​/15`.
 */
function classify(expr: string): Cadence | null {
  if (!isValidCron(expr)) return null;
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/);
  if (dom !== ALL || month !== ALL) return null;

  if (hour === ALL && dow === ALL) {
    if (minute === ALL) return { kind: "every-minutes", step: 1 };
    const stepped = /^\*\/(\d{1,2})$/.exec(minute);
    if (stepped) {
      const step = Number(stepped[1]);
      return step >= 1 && step <= 59 ? { kind: "every-minutes", step } : null;
    }
  }

  const m = plainInt(minute, 0, 59);
  if (m == null) return null;
  if (hour === ALL) return dow === ALL ? { kind: "hourly", minute: m } : null;

  const h = plainInt(hour, 0, 23);
  if (h == null) return null;
  if (dow === ALL) return { kind: "daily", hour: h, minute: m };

  const wd = plainInt(dow, 0, 7);
  if (wd == null) return null;
  // Cron accepts 7 for Sunday; the picker only ever offers 0-6.
  return { kind: "weekly", weekday: wd === 7 ? 0 : wd, hour: h, minute: m };
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * A phrase an operator reads ("Every 10 minutes", "Daily at 03:00"), falling back to the expression
 * itself for anything outside the named shapes.
 */
export function describeCron(expr: string): string {
  const cadence = classify(expr);
  if (!cadence) return expr.trim();
  switch (cadence.kind) {
    case "every-minutes":
      return cadence.step === 1 ? "Every minute" : `Every ${cadence.step} minutes`;
    case "hourly":
      return cadence.minute === 0
        ? "Hourly, on the hour"
        : `Hourly at :${String(cadence.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${hhmm(cadence.hour, cadence.minute)}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_LABELS[cadence.weekday]} at ${hhmm(cadence.hour, cadence.minute)}`;
  }
}

/** Build the cron a preset stands for. Throws for `custom`, which has no cron of its own. */
export function cronForPreset(id: CadencePresetId, parts?: Partial<CadenceParts>): string {
  const preset = presetById(id);
  if (!preset) throw new Error(`unknown cadence preset: "${id}"`);
  if (id === "custom") {
    throw new Error("the custom preset has no cron of its own — keep the operator's expression");
  }
  const { minute, hour, weekday } = { ...preset.defaults, ...parts };
  assertRange("minute", minute, 0, 59);
  assertRange("hour", hour, 0, 23);
  assertRange("weekday", weekday, 0, 6);

  switch (id) {
    case "every-5-minutes":
      return "*/5 * * * *";
    case "every-10-minutes":
      return "*/10 * * * *";
    case "every-15-minutes":
      return "*/15 * * * *";
    case "every-30-minutes":
      return "*/30 * * * *";
    case "hourly":
      return "0 * * * *";
    case "hourly-at":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`cadence ${name} must be an integer in [${min},${max}], got ${value}`);
  }
}

/**
 * Which menu item a stored cron opens on, plus the inputs to prefill. Every cron this module can
 * build round-trips back to the preset that built it; anything else resolves to `custom`, and the
 * picker shows the raw expression instead.
 */
export function presetForCron(expr: string): CadenceSelection {
  const cadence = classify(expr);
  if (!cadence) return { presetId: "custom", parts: { ...BASE_PARTS } };

  switch (cadence.kind) {
    case "every-minutes": {
      const step = PRESET_STEPS.find((s) => s === cadence.step);
      return step
        ? { presetId: `every-${step}-minutes`, parts: { ...BASE_PARTS } }
        : { presetId: "custom", parts: { ...BASE_PARTS } };
    }
    case "hourly":
      // `0 * * * *` is the plain hourly item; any other minute is the parameterised one.
      return cadence.minute === 0
        ? { presetId: "hourly", parts: { ...BASE_PARTS, minute: 0 } }
        : { presetId: "hourly-at", parts: { ...BASE_PARTS, minute: cadence.minute } };
    case "daily":
      return {
        presetId: "daily",
        parts: { ...BASE_PARTS, hour: cadence.hour, minute: cadence.minute },
      };
    case "weekly":
      return {
        presetId: "weekly",
        parts: { weekday: cadence.weekday, hour: cadence.hour, minute: cadence.minute },
      };
  }
}

/**
 * The daily cadence a weekly one becomes when it is promoted, keeping the operator's time of day —
 * `Weekly on Monday at 06:00` → `Daily at 06:00`.
 *
 * Null for anything that is not weekly, which is what makes this safe to offer: a cadence that is
 * already daily or faster has nothing to raise, and a hand-written expression is a choice no offer
 * gets to rewrite.
 */
export function dailyEquivalentOf(expr: string): string | null {
  const cadence = classify(expr);
  if (cadence?.kind !== "weekly") return null;
  return cronForPreset("daily", { hour: cadence.hour, minute: cadence.minute });
}

/** Below this gap between fires, the UI warns that a cadence is expensive — it never refuses. */
export const FAST_CADENCE_MINUTES = 5;

/**
 * Does this cadence fire more often than every {@link FAST_CADENCE_MINUTES} minutes? Measured as the
 * smallest gap between consecutive fires, so a hand-written `0,1,2 * * * *` is caught as well as
 * `*​/1`. An unparseable expression is not flagged — validation owns that error.
 */
export function isFastCadence(expr: string, thresholdMinutes = FAST_CADENCE_MINUTES): boolean {
  let cron;
  try {
    cron = parseCron(expr);
  } catch {
    return false;
  }
  const minutes = [...cron.minute].sort((a, b) => a - b);
  if (minutes.length === 0) return false;

  let smallestGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < minutes.length; i++) {
    smallestGap = Math.min(smallestGap, minutes[i] - minutes[i - 1]);
  }
  // The wrap from :55 to the next hour's :00 only counts when every hour fires.
  if (cron.hour.size === 24) {
    smallestGap = Math.min(smallestGap, 60 - minutes[minutes.length - 1] + minutes[0]);
  }
  return smallestGap < thresholdMinutes;
}
