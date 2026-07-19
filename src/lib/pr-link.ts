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

/** Success (a ready-to-store external-ref) or a human-readable rejection reason. */
export type PrRefResult = { ok: true; ref: string } | { ok: false; error: string };

/** Parse `owner/repo` + number from a GitHub PR url (trailing `/files` etc. tolerated), else null. */
export function parseGitHubPrUrl(input: string): { slug: string; number: string } | null {
  const m = input.trim().match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  return m ? { slug: m[1], number: m[2] } : null;
}

/**
 * Normalize a user-entered PR reference to a beads external-ref. Accepts a bare number (`44`),
 * `#44`, an already-normalized `gh-44`, or a full GitHub PR URL
 * (`https://github.com/owner/repo/pull/44`, trailing `/files` etc. tolerated).
 *
 * A full URL is validated against the project's `originSlug` (`owner/repo`, resolved by the caller
 * from `origin`): an OFF-REPO url is REJECTED, because storing it would let review-fix's
 * `getPrReview(repo, number)` run `gh pr view <n>` against the CURRENT repo — inspecting/finalizing
 * the wrong same-numbered PR, or failing to sweep the linked one. A same-repo url collapses to the
 * canonical `gh-<n>` (origin matched, so `prUrlFromRef` re-expands it correctly). When origin can't
 * be resolved (no web base) the url is kept verbatim — we can't validate it, but there's also no gh
 * remote for the sweep to mis-target, and the chip stays clickable. Bare number / #44 / gh-44 →
 * `gh-<n>` regardless of origin.
 */
export function normalizePrRef(input: string, originSlug?: string): PrRefResult {
  const s = input.trim();
  if (!s) return { ok: false, error: "empty PR reference" };
  const url = parseGitHubPrUrl(s);
  if (url) {
    if (originSlug && url.slug.toLowerCase() !== originSlug.toLowerCase()) {
      return {
        ok: false,
        error: `that PR url is for ${url.slug}, not this repo (${originSlug}) — link a PR from this repository`,
      };
    }
    return { ok: true, ref: originSlug ? `gh-${url.number}` : s };
  }
  const m = s.match(/^gh-(\d+)$/i) ?? s.match(/^#?(\d+)$/);
  return m
    ? { ok: true, ref: `gh-${m[1]}` }
    : { ok: false, error: `could not read a PR number from "${s}" — pass 44, #44, gh-44, or a PR url in this repo` };
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
