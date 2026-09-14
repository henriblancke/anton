import type { EscalationView } from "@/lib/types";

/** Coarse, human duration: "42m" / "4h" / "3d". Whole units — minutes of precision read as noise. */
export function stuckFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How long this has been stuck, as of NOW where the sweep recorded a start time, falling back to
 * the age the sweep froze into the finding. The live value is the honest one: an escalation raised
 * at 02:00 and still open at 09:00 has been stuck seven hours, not the twenty minutes the sweep saw.
 *
 * A plain function, not a prop default, so the clock read stays out of the component's render — and
 * `nowMs` is REQUIRED to get the live value rather than defaulting to `Date.now()`. The caller is a
 * Client Component, which renders once on the server and again when the browser hydrates; a default
 * clock read here would give those two renders two different answers whenever a stall crossed a
 * minute boundary between them, which React reports as a hydration mismatch. Callers with no clock
 * to offer (the server pass, the pre-hydration pass) get the sweep's frozen age, which is server
 * data and therefore identical on both sides. See StuckFor in escalation-strip.tsx.
 */
export function escalationAge(escalation: EscalationView, nowMs?: number): string {
  if (nowMs === undefined || !escalation.since) return stuckFor(escalation.ageMs);
  return stuckFor(nowMs - escalation.since * 1000);
}
