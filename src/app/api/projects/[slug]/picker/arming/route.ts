import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { earnedPickerAutonomy } from "@/lib/gardener/autonomy";
import { systemClock } from "@/lib/jobs/queue";
import { resolveOperator } from "@/lib/operator";
import { pickerTrackRecord } from "@/lib/picker-veto";
import type { PickerAutonomy } from "@/lib/policy/types";
import {
  deliberateArmingSchema,
  resolvePickerApplyOverride,
  resolvePickerAutonomy,
  updateProjectSettingsIf,
  type ProjectSettings,
} from "@/lib/projects";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Arm `apply` DELIBERATELY (anton-d1lk): the operator's signed bypass of the earned floor.
 *
 * The floor exists because trust is evidence — a project's own releases and vetoes say whether its
 * picks were worth starting. An operator who accepts the risk before that evidence exists is
 * substituting their judgement for it, so the bypass is stored as a signature (who, when) rather
 * than as a flag, and every surface that shows the level shows which of the two is holding it up.
 *
 * The actor is resolved SERVER-side, exactly as the autopilot re-arm route resolves it and for the
 * same reason: a caller-supplied author on the one write that starts unattended work with no record
 * behind it would make the audit trail worth nothing. This is also why the arming is not a settings
 * PATCH field — that table takes the client at its word.
 *
 * Two writes in one patch, because "arm apply" is one act: the signature, and the level it is for.
 * They are separable afterwards — moving the level back to `shadow` in settings leaves the signature
 * standing, and it applies again the moment the level returns to `apply`.
 *
 * REFUSALS, all 409 and all about state the client cannot see:
 *   • no work policy — the structural floor. Without an armed policy the picker's plan admits every
 *     claimable target, so `apply` there is autopilot with no approval in it; there is no boundary
 *     to accept the risk OF, and a stored arming would be a signature on nothing.
 *   • already armed — a second click, or a tab rendered before someone else armed it. Overwriting
 *     would silently rewrite who signed and when, which is the one thing this record is for.
 *   • already earned — a tab rendered before enough releases cleared the bar, or a direct call. The
 *     signature is kept for good as evidence that this project once ran on somebody's word rather
 *     than on its record (PR #245 review), so one written when the record already supported `apply`
 *     would be a false audit trail: a bypass of a floor that was not holding. The operator who wants
 *     `apply` here chooses it in settings, and the earned floor answers.
 *
 * The first two are decided INSIDE the settings write transaction rather than against a snapshot
 * read first, which is what makes the second one true: two clicks landing together would otherwise
 * both find an unarmed project, and the loser would replace the winner's signature while both were
 * told they had armed it. The record is read just before it — the decision under the lock is
 * synchronous — and that is enough: verdicts only arrive as the operator answers picks, so the
 * worst the gap admits is a signature one release late, not one on an already-earned project.
 *
 * The signature is checked against the SAME schema that reads it back before anything is written.
 * The reader drops what it cannot parse, so an operator name it would refuse (over its length cap)
 * must not be stored as a success: the response would claim `apply` while the floor resolved
 * `shadow`, and every retry would overwrite the same unreadable value. Same 500 as an unresolvable
 * identity — it is anton's environment that cannot sign, not the project's state.
 */
export const POST = withProject<{ slug: string }>(async (_request, { project }) => {
  const by = await resolveOperator();
  if (!by) {
    return NextResponse.json(
      { error: "anton could not tell who you are — set ANTON_OPERATOR or a global git user.name" },
      { status: 500 },
    );
  }

  const signature = deliberateArmingSchema.safeParse({
    by,
    at: new Date(systemClock.now()).toISOString(),
  });
  if (!signature.success) {
    return NextResponse.json(
      {
        error:
          "anton's operator name cannot be stored as a signature (1–200 characters) — set " +
          "ANTON_OPERATOR to a shorter name",
      },
      { status: 500 },
    );
  }
  const arming = signature.data;
  const earned = earnedPickerAutonomy(await pickerTrackRecord(getDb(), project.id));
  const result = await updateProjectSettingsIf<string>(project.slug, (current) => {
    if (!current.pickerPolicy) {
      return {
        refuse:
          "This project has no work policy, so apply cannot be armed — accept a policy first, " +
          "then arm it",
      };
    }
    const standing = resolvePickerApplyOverride(current);
    if (standing) {
      return {
        refuse: `apply is already armed deliberately, by ${standing.by} — nothing was changed`,
      };
    }
    if (earned.eligible) {
      return {
        refuse:
          "This project's record already clears the bar for apply, so there is no floor to sign " +
          "past — choose apply in settings instead; nothing was changed",
      };
    }
    return { write: { pickerApplyOverride: arming, pickerAutonomy: "apply" } };
  });
  if (!result.applied) return NextResponse.json({ error: result.refused }, { status: 409 });

  return NextResponse.json({
    armedBy: arming.by,
    armedAt: arming.at,
    autonomy: await resolvedAutonomy(project.id, result.settings),
  });
});

/**
 * Revoke it (anton-d1lk). The signature is deleted and nothing else is touched — the stored level
 * stays `apply`, and the earned floor decides again on the very next pass, which is what returns an
 * unearned project to `shadow` and leaves an earned one exactly where it was.
 *
 * 409 when nothing is armed, like the re-arm route: the state is the server's answer, not the one
 * the operator was looking at.
 *
 * Revoking is NOT signed, and the asymmetry with POST is deliberate. The arming is standing state
 * that has to name who is holding `apply` up; a revoke leaves nothing standing to attribute. Making
 * it an authored write would also let an unresolvable operator (a 500 here) block taking a risky
 * arming back — the one act that must never be gated on anton's environment. Revocation HISTORY, if
 * it is ever wanted, is an append-only record like `autopilot_disarms`, not a settings field.
 */
export const DELETE = withProject<{ slug: string }>(async (_request, { project }) => {
  const result = await updateProjectSettingsIf<string>(project.slug, (current) =>
    resolvePickerApplyOverride(current)
      ? { write: { pickerApplyOverride: undefined } }
      : { refuse: "apply is not deliberately armed on this project — nothing was changed" },
  );
  if (!result.applied) return NextResponse.json({ error: result.refused }, { status: 409 });

  return NextResponse.json({ autonomy: await resolvedAutonomy(project.id, result.settings) });
});

/**
 * The level the picker will actually run at, returned by both handlers so the panel settles on the
 * server's answer rather than on the one it predicted — the revoke case especially, where whether
 * the project lands on `shadow` or stays at `apply` is a fact about its record, not about the click.
 */
async function resolvedAutonomy(
  projectId: string,
  settings: ProjectSettings,
): Promise<PickerAutonomy> {
  return resolvePickerAutonomy(settings, await pickerTrackRecord(getDb(), projectId));
}
