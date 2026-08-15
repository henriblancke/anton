import { NextResponse } from "next/server";

import { actOnEscalation, isEscalationAction } from "@/lib/escalation-actions";
import { NotAbandonableError } from "@/lib/abandon";
import { openEscalations } from "@/lib/escalations";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Settle one escalation (anton-wvcy): `{ action: "resume" | "abandon" | "dismiss" }`.
 *
 * A POST on the escalation itself rather than sub-resources — every verb is the SAME decision
 * ("how does this stall end?"), and modelling them as one action field keeps the panel's buttons
 * on one code path. Returns the remaining open escalations so the board panel re-renders from the
 * response instead of racing a refetch against the write.
 *
 * The verb set does not grow with the stall class: `resume` on a wait for a PERSON is
 * resolve-and-resume — it closes the gate and then re-enqueues the run target — because that is one
 * decision ("I did it, carry on") and splitting it into two requests would leave the founder able to
 * settle half of it. See escalation-actions.ts for the ordering that makes it safe.
 *
 * 409 covers "already settled" (someone else clicked first), "nothing to act on" (a finding that
 * names neither a bead nor a job), "contested" (another machine is running the work now),
 * "unverified" (bd couldn't confirm whether one is), and a `dismiss` on a wait for a person (which
 * would settle the row over a still-open gate) — in each case the request was valid but the state
 * refuses it.
 */
export const POST = withProject<{ slug: string; escalationId: string }>(
  async (request, { project, params }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const action = (body as { action?: unknown })?.action;
    if (!isEscalationAction(action)) {
      return NextResponse.json(
        { error: 'action must be "resume", "abandon", or "dismiss"' },
        { status: 400 },
      );
    }

    try {
      const result = await actOnEscalation(project, params.escalationId, action);
      if (!result.ok) {
        const status = result.reason === "not-found" ? 404 : 409;
        return NextResponse.json({ error: FAILURE_MESSAGES[result.reason] }, { status });
      }
      return NextResponse.json({
        action: result.action,
        detail: result.detail,
        escalations: await openEscalations(project.id),
      });
    } catch (err) {
      if (err instanceof NotAbandonableError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : "Failed to settle the escalation";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);

const FAILURE_MESSAGES = {
  "not-found": "Escalation not found",
  "not-open": "This escalation has already been settled",
  "no-target": "This escalation names no ticket or job to act on",
  "not-dismissable":
    "A wait on a person can't be dismissed — the gate would stay open and the next sweep would raise it again. Resolve it (you did the thing) or abandon the work",
  contested: "Another machine has picked this work back up — it is running again, so nothing was changed",
  unverified:
    "anton could not read the shared board, so it can't rule out another machine running this work — nothing was changed. Try again once bd can reach the remote",
} as const;
