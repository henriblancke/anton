/**
 * Minimal standard-cron parser + `nextRun` computation (anton-3t2.1). Supports the classic
 * 5-field crontab syntax — `minute hour day-of-month month day-of-week` — with `*`, lists (`,`),
 * ranges (`a-b`), and steps (`*​/n`, `a-b/n`). No seconds field, no `@daily` macros, no `L`/`#`
 * extensions: schedules here are operator-configured and only need the common cases.
 *
 * Semantics follow POSIX cron: when BOTH day-of-month and day-of-week are restricted (neither is
 * `*`), a day matches if EITHER matches (the OR rule). Sunday is 0 (7 is also accepted).
 *
 * Times are computed in the local timezone (the app is a single-user local server — DESIGN §1).
 * `nextRun` returns the next minute strictly after `after` whose fields all match.
 */

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when the field was `*` — needed for the DOM/DOW OR rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 = Sunday)
];

/** Parse one cron field (e.g. `*​/15`, `1-5`, `0,30`) into the set of values it matches. */
function parseField(field: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step "${stepPart}" in "${field}"`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`invalid cron field "${field}"`);
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron field "${field}" out of range [${spec.min},${spec.max}]`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws on malformed input (fail loud). */
export function parseCron(expr: string): CronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }
  const [minute, hour, dom, month, dowRaw] = fields.map((f, i) => parseField(f, FIELDS[i]));
  // Normalize day-of-week 7 → 0 so Sunday matches either spelling.
  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/** Does `date` (local time) match this cron expression, to the minute? */
export function matches(cron: CronExpr, date: Date): boolean {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;

  const domOk = cron.dom.has(date.getDate());
  const dowOk = cron.dow.has(date.getDay());
  // POSIX OR rule: if both are restricted, either matching is enough; otherwise both must hold.
  if (cron.domRestricted && cron.dowRestricted) {
    if (!domOk && !dowOk) return false;
  } else {
    if (!domOk || !dowOk) return false;
  }
  return true;
}

/**
 * The next minute strictly after `after` (ms epoch) whose fields all match `cron`, as ms epoch.
 * Scans minute-by-minute up to `maxDays` ahead (default 366) and throws if nothing matches — a
 * bound guards against an impossible expression (e.g. Feb 30) spinning forever.
 */
export function nextRun(expr: string | CronExpr, afterMs: number, maxDays = 366): number {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  // Start at the top of the next minute (cron has minute granularity).
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = afterMs + maxDays * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (matches(cron, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron "${typeof expr === "string" ? expr : "<expr>"}" has no run within ${maxDays} days`);
}

/** Validate a cron string; returns true when parseable. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}
