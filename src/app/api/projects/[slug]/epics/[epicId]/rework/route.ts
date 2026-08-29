import { NextResponse } from "next/server";
import {
  reworkTicket,
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
  ReworkUnavailableError,
  type ReworkInput,
} from "@/lib/rework";
import type { ReviewFinding } from "@/lib/jobs/review-context";
import { parseJsonBody, withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Send one ticket of a run target back with instructions (anton-4ocm) — as a reopen, or as a
 * discovered-from follow-up.
 *
 * The report this decision is made from is served by the sibling `review` route, which the epic
 * page already loads for its score series — so opening this dialog costs no second read.
 */
export const POST = withProject<{ slug: string; epicId: string }>(async (request, { project, params }) => {
  const { body, response: badBody } = await parseJsonBody(request);
  if (badBody) return badBody;

  try {
    const result = await reworkTicket(project, params.epicId, readInput(body));
    return NextResponse.json({ result });
  } catch (err) {
    // Mirrors approve/claim: 409 for a race with a live run, 422 for a target this action can't
    // apply to, 400 for a malformed request, 404 for a bead that isn't there.
    if (err instanceof ReworkConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ReworkNotAllowedError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof ReworkInvalidError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ReworkNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    // 503, not 500: the request is fine and nothing here is broken — `gh` couldn't answer what the
    // target's PR did, and a retry once it can will succeed unchanged (anton-leit).
    if (err instanceof ReworkUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Failed to send the ticket back";
    console.error(`[rework] ${params.epicId} failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

/** Read the POST body into the domain input. Shape only — the domain module owns the validation. */
function readInput(body: unknown): ReworkInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    ticketId: typeof raw.ticketId === "string" ? raw.ticketId : "",
    mode: raw.mode as ReworkInput["mode"],
    summary: typeof raw.summary === "string" ? raw.summary : "",
    instructions: typeof raw.instructions === "string" ? raw.instructions : "",
    findings: readFindings(raw.findings),
  };
}

/**
 * The findings the founder ticked, taken at face value but shape-checked: they are inlined into a
 * bead note (and so into an agent's prompt), so a malformed entry must be dropped rather than
 * rendered as `undefined — undefined`.
 */
function readFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ReviewFinding[] => {
    const f = entry as Partial<ReviewFinding>;
    if (typeof f?.note !== "string" || !f.note.trim()) return [];
    return [
      {
        severity: f.severity === "blocking" ? "blocking" : "advisory",
        location: typeof f.location === "string" && f.location ? f.location : "(general)",
        note: f.note,
      },
    ];
  });
}
