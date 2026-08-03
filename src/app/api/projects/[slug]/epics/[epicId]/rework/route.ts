import { NextResponse } from "next/server";
import { isMissingBeadError } from "@/lib/beads/bd";
import { getReviewReport } from "@/lib/review-report";
import {
  reworkTicket,
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
  type ReworkInput,
} from "@/lib/rework";
import type { ReviewFinding } from "@/lib/jobs/review-context";
import { withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * The rework surface for a run target (anton-4ocm):
 *
 *   GET  → the self-review report the founder decides from — every round this target recorded, and
 *          the findings still on the table.
 *   POST → send one ticket back with instructions, as a reopen or a discovered-from follow-up.
 *
 * The report is a separate GET rather than a field on the epic detail because it costs a hydrated
 * `bd show --include-comments`: every epic page would pay for a thread only the rework dialog reads.
 */
export const GET = withProject<{ slug: string; epicId: string }>(async (_request, { project, params }) => {
  try {
    return NextResponse.json({ report: await getReviewReport(project.repoPath, params.epicId) });
  } catch (err) {
    // Only bd ANSWERING "no such bead" is a 404. A bd that couldn't answer at all (absent, dolt
    // wedged) is a 500 — reporting it as not-found would tell the founder their target is gone.
    if (isMissingBeadError(err)) {
      return NextResponse.json(
        { error: `Ticket ${params.epicId} not found on the board` },
        { status: 404 },
      );
    }
    console.error(`[rework] could not read ${params.epicId}'s review report`, err);
    return NextResponse.json({ error: "Could not read the review report" }, { status: 500 });
  }
});

export const POST = withProject<{ slug: string; epicId: string }>(async (request, { project, params }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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
