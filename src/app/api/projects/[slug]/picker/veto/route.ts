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
  /**
   * The plan GENERATION the operator was looking at when they answered — what names the pick this
   * verdict is about. Optional: a caller that names none records a veto against no pick.
   */
  planId: z.string().trim().min(1).max(120).optional(),
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
 * The plan is read for provenance, not for permission: a veto records the rank and the generation id
 * of the decision it answers, so the record names a PICK rather than only a bead. Which decision
 * that is comes from the CLIENT — the generation it had on screen — and is honoured only while the
 * recorded plan is still that generation (PR #212 review). Inferring it from membership instead
 * would misattribute every veto posted from a tab a later pass has overtaken: a bead can sit in both
 * the plan the operator answered and the newer one, and the verdict would then carry a rank and a
 * rule from a pick they were never shown — and, keyed on that generation, refuse the release of it
 * (`recordPickerVeto`).
 *
 * A veto that cannot name its decision — an unnamed generation, a superseded one, or a plan that no
 * longer carries the target — is still recorded and still defers: the pass may have re-ranked since
 * the operator looked, and their answer is not theirs to lose. It simply records no pick, rank, rule
 * and plan id dropped together, rather than one it cannot stand behind.
 *
 * A `never` on a project with no armed policy, or one whose policy narrows nothing this bead
 * satisfies, returns `criterion: null`. That is an answer, not a failure: the editor opens at the
 * panel and the operator authors the first rule.
 *
 * A pick gets ONE answer, and this route does not own that gate — the store does, under the write
 * lock (`recordPickerVeto`), because the opposite verdict is written by the approve route and no
 * client-side lock spans two tabs. A veto that loses the race to a release answers 409: the run is
 * under way, so there is nothing left to defer.
 */
export const POST = withProject<{ slug: string }>(async (request, { project }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { beadId, action: 'not-now' | 'never' }" },
      { status: 400 },
    );
  }
  const { beadId, action, planId } = parsed.data;
  const db = getDb();

  const plan = await getBoardPickerPlan(db, project.id).catch(() => undefined);
  const displayed = planId !== undefined && plan?.planId === planId ? plan : undefined;
  const entry = displayed?.entries.find((e) => e.beadId === beadId);
  const pick =
    displayed && entry
      ? { rank: entry.rank, planId: displayed.planId, ...(entry.rule ? { rule: entry.rule } : {}) }
      : undefined;

  // Only `never` pays for a board read: `not-now` needs nothing but the veto, and making the cheap
  // veto wait on `bd` would be the one thing that stops an operator from using it.
  const criterion =
    action === "never" ? await resolveCriterion(project, beadId).catch(() => undefined) : undefined;

  const outcome = await recordPickerVeto(db, systemClock, {
    projectId: project.id,
    beadId,
    action,
    ...pick,
    ...(criterion ? { criterion } : {}),
  });

  // The release answered this pick first, and the store settles that race rather than the client:
  // recording the decline too would claim the operator both started and set aside one decision.
  if (!outcome.recorded) {
    return NextResponse.json(
      {
        error: `${beadId} was already released — that pick is running, so there is nothing to set aside`,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    beadId,
    action,
    deferredUntil: outcome.deferral.untilMs,
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
