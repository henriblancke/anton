import { NextResponse } from "next/server";

import { actOnEscalation, isEscalationAction } from "@/lib/escalation-actions";
import { NotAbandonableError } from "@/lib/abandon";
import { openEscalations } from "@/lib/escalations";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Settle one escalation (anton-wvcy): `{ action: "resume" | "abandon" }`.
 *
 * A POST on the escalation itself rather than two sub-resources — both verbs are the SAME decision
 * ("how does this stall end?"), and modelling them as one action field keeps the panel's two buttons
 * on one code path. Returns the remaining open escalations so the board panel re-renders from the
 * response instead of racing a refetch against the write.
 *
 * 409 covers both "already settled" (someone else clicked first) and "nothing to act on" (a finding
 * that names no bead) — in each case the request was valid but the state refuses it.
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
        { error: 'action must be "resume" or "abandon"' },
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
  "no-target": "This escalation names no ticket to act on",
} as const;
