"use client";

/**
 * The advisory half of the contract, where the operator actually is when it matters (anton-j9zs).
 *
 * The approve route refuses a BLOCKING gap and reports the advisory ones in its 200 body: the run is
 * starting despite them, so they cost quality, not runnability. Nothing else surfaces them at that
 * moment — the board chip is behind on the card the operator just left — so every surface that
 * starts a run reads the body here and says it once.
 *
 * The run's human gates ride the same body and the same call (anton-qfso.2). They cost the operator
 * their own time rather than the run's quality, so they get their own toast — but one entry point
 * owns the read, because a Response body can only be consumed once and "says it once" must hold for
 * a surface that was written before either advisory existed.
 *
 * That entry point owns the SUCCESS toast too (PR #214 review). A surface that phrases its own
 * "…& running" before this read announces a run for a target anton hands straight back, and the
 * notice below would then contradict a message the operator has already read. Every surface passes
 * the line it would show for a run that starts and lets the response decide whether it is true.
 */
import { toast } from "sonner";

/** One `id → missing X, Y` line per thin bead, as the approve route formats them. */
function gapsOf(body: unknown): string[] {
  return linesOf((body as { advisory?: unknown } | null)?.advisory);
}

/** One `id → title` line per bead in the run only a person can do. */
function humanGatesOf(body: unknown): string[] {
  return linesOf((body as { humanGates?: unknown } | null)?.humanGates);
}

/**
 * Whether the approved TARGET is itself a person's work, which is a different outcome from a run
 * that merely contains some (PR #214 review): anton refuses a `agent:human` target outright, before
 * dispatching any of its children, so no agent-run starts at all.
 */
function humanTargetOf(body: unknown): boolean {
  return (body as { humanTarget?: unknown } | null)?.humanTarget === true;
}

/** A string list, or nothing — a malformed field is never worth a half-rendered toast. */
function linesOf(field: unknown): string[] {
  return Array.isArray(field) ? field.filter((l): l is string => typeof l === "string") : [];
}

/** What an accepted approve is announced as, before the response gets a say in it. */
export interface ApprovalOutcome {
  /** This surface's own wording for the run it just started — used unless no run starts. */
  started: string;
  /** The target's title, for the line that stands in for {@link ApprovalOutcome.started}. */
  title: string;
}

/**
 * Announce an accepted approve: what it did, then what it costs. Consumes the response body, so
 * callers pass a response they've already accepted as ok. Beyond the success line it is silent on a
 * conformant target with no human work (the common case) and on a body that carries neither — a run
 * must never be held up by its own reporting, so a malformed payload is simply nothing to add.
 *
 * NEVER throws, which is what lets every caller await it inside the `try` that wraps its approve.
 * The approval has already landed by the time this runs; a failure here rethrown into that `try`
 * would roll the optimistic state back and toast an error for work that actually succeeded.
 */
export async function toastApprovalOutcome(res: Response, outcome: ApprovalOutcome): Promise<void> {
  try {
    reportApprovalOutcome(await res.json().catch(() => null), outcome);
  } catch (err) {
    console.error("[contract-advisory] failed to read the approve response", err);
  }
}

/**
 * The same report, for a caller that has ALREADY read the body — a response body can only be
 * consumed once, and a surface that inspects the 200 payload before deciding the run really started
 * (`release-action.tsx`, which reads `jobId`) has nothing left to hand {@link toastApprovalOutcome}.
 *
 * NEVER throws, for the same reason as above.
 */
export function reportApprovalOutcome(body: unknown, outcome: ApprovalOutcome): void {
  try {
    const humanTarget = humanTargetOf(body);
    // The success line first: it is the answer to the click, and the notices below qualify it.
    toast.success(humanTarget ? `Approved "${outcome.title}" — no run starts` : outcome.started);
    warnSpecGaps(gapsOf(body));
    if (humanTarget) noteHumanTarget();
    else warnHumanGates(humanGatesOf(body));
  } catch (err) {
    console.error("[contract-advisory] failed to surface the approve outcome", err);
  }
}

function warnSpecGaps(gaps: string[]): void {
  if (gaps.length === 0) return;
  toast.warning(gaps.length === 1 ? "1 spec gap" : `${gaps.length} spec gaps`, {
    // Long enough to read several bead ids and act on them; the run is already under way.
    duration: 10_000,
    description: (
      <div className="flex flex-col gap-1">
        <span>Runs as shaped, but thinner than it could be.</span>
        <ul className="flex flex-col gap-0.5">
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </div>
    ),
  });
}

/**
 * How many times this run will stop for the operator, named. `info`, not `warning`: human work is
 * shaped, approved work that anton is right to hand back — the operator is being told what they
 * signed up for, not that something is wrong.
 */
function warnHumanGates(gates: string[]): void {
  if (gates.length === 0) return;
  toast.info(gates.length === 1 ? "1 ticket needs you" : `${gates.length} tickets need you`, {
    duration: 10_000,
    description: (
      <div className="flex flex-col gap-1">
        <span>
          {gates.length === 1
            ? "anton runs the rest and holds this one until you do it."
            : "anton runs the rest and holds these until you do them."}
        </span>
        <ul className="flex flex-col gap-0.5">
          {gates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      </div>
    ),
  });
}

/**
 * The target itself is the human work, so there is no "rest" for anton to run (PR #214 review): the
 * executor refuses a `agent:human` target before it dispatches anything under it, and promising a
 * partial run here would leave the operator waiting on a run that never starts.
 *
 * The gate lines are deliberately NOT listed, and not required either: the route reports the target's
 * own label, so a re-run of a target whose dispatch set is empty — every child closed, or already in
 * review — still says this (PR #214 review). Any human children under it are moot besides, since no
 * dispatch reaches them, and naming them would read as work anton is about to hold, which is the
 * exact claim this toast exists to withdraw.
 */
function noteHumanTarget(): void {
  toast.info("This one is yours", {
    duration: 10_000,
    description: (
      <span>
        It&apos;s labelled <span className="font-mono">agent:human</span>, so no agent-run starts —
        anton hands the whole target back rather than dispatching any of it.
      </span>
    ),
  });
}
