import { NextResponse } from "next/server";
import { z } from "zod";

import { getBoardPickerPlan } from "@/lib/board-picker-plan";
import { allIssues } from "@/lib/beads/issues";
import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { recordPickerVeto } from "@/lib/picker-veto";
import { admittingCriterion } from "@/lib/policy/admitting";
import { policyCandidates } from "@/lib/policy/candidates";
import { getProjectSettings, resolvePickerPolicy } from "@/lib/projects";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  beadId: z.string().trim().min(1).max(120),
  /** `not-now` sets the target aside; `never` does that AND sends the operator at the rule. */
  action: z.enum(["not-now", "never"]),
});

/**
 * Veto one of the picker's picks (anton-jqvy / R3.9).
 *
 * Both actions do the same thing to the board — record a decline against the decision, and defer
 * that ONE target for a bounded window — and differ only in where the operator goes next. `never`
 * additionally answers WHICH criterion of the armed policy admitted this bead, so the client can
 * open the editor on the control that would keep work like this out. That resolution is server-side
 * because it needs the board and the stored policy; the client only carries the answer into a URL.
 *
 * The plan is read for provenance, not for permission: a veto records the rank and the board digest
 * of the decision it answers, so the record names a PICK rather than only a bead. A target the
 * current plan does not carry is still vetoable — the pass may have re-ranked since the operator
 * looked — and simply records no rank.
 *
 * A `never` on a project with no armed policy, or one whose policy narrows nothing this bead
 * satisfies, returns `criterion: null`. That is an answer, not a failure: the editor opens at the
 * panel and the operator authors the first rule.
 */
export const POST = withProject<{ slug: string }>(async (request, { project }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { beadId, action: 'not-now' | 'never' }" },
      { status: 400 },
    );
  }
  const { beadId, action } = parsed.data;
  const db = getDb();

  const plan = await getBoardPickerPlan(db, project.id).catch(() => undefined);
  const entry = plan?.entries.find((e) => e.beadId === beadId);

  // Only `never` pays for a board read: `not-now` needs nothing but the veto, and making the cheap
  // veto wait on `bd` would be the one thing that stops an operator from using it.
  const criterion =
    action === "never" ? await resolveCriterion(project, beadId).catch(() => undefined) : undefined;

  const deferral = await recordPickerVeto(db, systemClock, {
    projectId: project.id,
    beadId,
    action,
    ...(entry?.rule ? { rule: entry.rule } : {}),
    ...(entry ? { rank: entry.rank } : {}),
    ...(plan?.stamp.digest ? { planDigest: plan.stamp.digest } : {}),
    ...(criterion ? { criterion } : {}),
  });

  return NextResponse.json({
    beadId,
    action,
    deferredUntil: deferral.untilMs,
    criterion: criterion ?? null,
  });
});

/**
 * Which criterion admitted this bead, or undefined.
 *
 * Fail-soft, and the caller swallows a throw for the same reason: `Never` must still record its
 * decline and still defer the target when the board or the settings read falls over. Losing the deep
 * link's anchor costs the operator one click; losing the veto costs them the decision.
 */
async function resolveCriterion(
  project: { id: string; repoPath: string },
  beadId: string,
): Promise<ReturnType<typeof admittingCriterion>> {
  const policy = resolvePickerPolicy(await getProjectSettings(getDb(), project.id));
  if (!policy) return undefined;
  const board = await allIssues(project.repoPath).catch(() => []);
  const candidate = policyCandidates(board).candidates.find((c) => c.id === beadId);
  return candidate ? admittingCriterion(candidate, policy) : undefined;
}
