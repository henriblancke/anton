/**
 * Manual PR linking: attach a GitHub PR to a run target from the UI (epic detail / ticket dialog) —
 * the human counterpart to the ref execute-epic stamps at PR-open. Linking a PR also moves a
 * still-open run target to stage:in-review, so the review-fix sweep picks it up: that is the whole
 * point of linking a hand-opened PR (or a PR execute-epic failed to record). Pure `normalizePrRef`
 * + `planPrLink` are unit-testable; `linkPr` reads the bead and executes via the beads wrapper
 * (mirrors board-move.ts).
 */
import { beads, type Bead } from "./beads/bd";
import { planMove, type MoveOp } from "./board-move";
import type { Project } from "./types";

/**
 * Normalize a user-entered PR reference to a beads external-ref. Accepts a bare number (`44`),
 * `#44`, an already-normalized `gh-44`, or a full GitHub PR URL
 * (`https://github.com/owner/repo/pull/44`, trailing `/files` etc. tolerated). Returns null when no
 * PR number can be extracted, so the caller answers 400 rather than storing junk.
 *
 * A full URL is stored VERBATIM, not collapsed to `gh-<n>`: collapsing loses the repo, so the chip
 * goes inert when `origin` can't be resolved to a web base, and a pasted fork/other-repo URL would
 * be silently re-expanded against the CURRENT repo and point at the wrong PR. Keeping the URL is
 * strictly safer and fully supported downstream — `prNumberFromRef` (git/pr.ts) reads the number
 * out of `/pull/<n>` for the review-fix sweep, and `prUrlFromRef` returns an http(s) ref as-is.
 * Only a bare number / #44 / gh-44 collapses to the canonical `gh-<n>`.
 */
export function normalizePrRef(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\/\S+\/pull\/\d+/i.test(s)) return s; // full PR url — preserve verbatim
  const m =
    s.match(/^gh-(\d+)$/i) ?? // already normalized
    s.match(/^#?(\d+)$/); // 44 or #44
  return m ? `gh-${m[1]}` : null;
}

export interface PrLinkPlan {
  ref: string;
  /** Stage ops applied alongside the ref — empty for a child ticket or a closed/merged target. */
  stageOps: MoveOp[];
}

/**
 * The writes for linking `ref` to `target`: always set the external-ref, and additionally move a
 * still-open RUN TARGET to in-review (tag in-review / untag implementing, via the canonical
 * planMove) so review-fix sweeps it. A child ticket (not a run target) or a closed target gets only
 * the ref — a child runs via its epic's PR, and a closed/merged target must not be dragged back
 * into review just because someone pasted a PR number. Pure so the transition is unit-testable.
 */
export function planPrLink(target: Bead, ref: string): PrLinkPlan {
  const flipToReview = beads.isRunTarget(target) && target.status !== "closed";
  return { ref, stageOps: flipToReview ? planMove(target, "in-review") : [] };
}

/**
 * Execute a PR link: set the external-ref, apply any stage ops from planPrLink, then best-effort
 * sync so teammates + the review-fix sweep see it within a heartbeat (mirrors board-move/claim —
 * a sync hiccup never fails the write that already landed locally). The in-review plan only ever
 * yields tag/untag ops; a defensive default ignores anything else.
 */
export async function linkPr(project: Project, target: Bead, ref: string): Promise<void> {
  const { stageOps } = planPrLink(target, ref);
  await beads.setExternalRef(project.repoPath, target.id, ref);
  for (const op of stageOps) {
    if (op.kind === "tag") await beads.tag(project.repoPath, target.id, op.labels);
    else if (op.kind === "untag") await beads.untag(project.repoPath, target.id, op.labels);
  }
  await beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[pr-link] beads dolt sync failed after linking PR on ${target.id}`, e));
}
