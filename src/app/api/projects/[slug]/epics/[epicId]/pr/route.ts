import { NextResponse } from "next/server";
import { beads, type Bead } from "@/lib/beads/bd";
import { githubBaseUrl } from "@/lib/git/remote";
import { linkPr, normalizePrRef } from "@/lib/pr-link";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Manually link a GitHub PR to a run target (epic or standalone task/bug) — the human counterpart
 * to the ref execute-epic stamps at PR-open, for when it failed to record one or the ticket was
 * implemented by hand. POST { ref } sets the bead's external-ref and, for a still-open run target,
 * moves it to stage:in-review so the review-fix sweep picks it up (see lib/pr-link.ts).
 *
 * Gated on isRunTarget (422 otherwise), mirroring the approve/claim routes: only an epic or a
 * parentless task/bug carries its own PR — a child ticket runs via its epic's PR, so linking a PR
 * to it is meaningless. `ref` accepts 44 / #44 / gh-44 / a full PR url; an unparseable ref, or a
 * full url for a different repo than this project's origin, 400s.
 */

/** Build the 422 reason for a non-run-target, mirroring the approve/claim routes' wording. */
function notRunnableReason(id: string, target: Bead): string {
  const parent = (target.parent ?? target.parent_id) as string | undefined;
  const type = target.issue_type ?? "unknown";
  return (type === "task" || type === "bug") && parent
    ? `${id} is a child ticket of ${parent} — link the PR to its epic ${parent} instead; a child runs via its epic's PR, not its own`
    : `${id} is not a run target: type "${type}" — only an epic or a parentless task/bug carries a PR`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawRef = (body as { ref?: unknown })?.ref;
  if (typeof rawRef !== "string") {
    return NextResponse.json({ error: "ref must be a string" }, { status: 400 });
  }
  // Resolve the project's origin `owner/repo` so a pasted full PR url is validated against it — an
  // off-repo url is rejected (else review-fix's getPrReview would run `gh pr view <n>` in THIS repo
  // and hit the wrong same-numbered PR). Undefined when there's no resolvable web base.
  const base = await githubBaseUrl(project.repoPath);
  const originSlug = base?.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "") || undefined;
  const parsed = normalizePrRef(rawRef, originSlug);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const ref = parsed.ref;

  // Fresh read: the run-target gate and the in-review flip must decide from the true current state.
  let target: Bead;
  try {
    target = await beads.show(project.repoPath, epicId);
  } catch {
    return NextResponse.json({ error: `Ticket ${epicId} not found on the board` }, { status: 404 });
  }
  if (!beads.isRunTarget(target)) {
    return NextResponse.json({ error: notRunnableReason(epicId, target) }, { status: 422 });
  }

  await linkPr(project, target, ref);
  return NextResponse.json({ item: await beads.show(project.repoPath, epicId) });
}
