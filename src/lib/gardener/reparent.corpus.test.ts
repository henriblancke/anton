/**
 * THE REGRESSION CORPUS for `detectParentlessClusters` (anton-9hpp): the board as it stood on the
 * 2026-08-15 sweep, where the detector filed eleven proposals and the founder declined nine.
 *
 * These are the real beads, with their real titles, kinds and homes — the titles ARE the evidence,
 * because every declined match was a word ("epic", "ticket", "instead", "three", "copy", "route",
 * "test") that two titles happened to share. A rule change that reads well but re-files any of the
 * nine has not fixed anything, and a rule change that goes silent has not either: anton-f7up, the
 * one proposal worth applying, is in here as the case that must still fire.
 *
 * Only the beads the sweep's proposals concerned are reconstructed, plus the children each home
 * carried — nothing else in a 700-bead board changes what these detections do.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "../beads/bd";
import { detectBoard } from "./detect";

const NOW = Date.parse("2026-08-15T00:00:00Z");

const at = (id: string, type: Bead["issue_type"], title: string, parent?: string): Bead => ({
  id,
  title,
  status: "open",
  issue_type: type,
  updated_at: new Date(NOW - 86_400_000).toISOString(),
  ...(parent ? { parent } : {}),
});

const task = (id: string, title: string, parent?: string) => at(id, "task", title, parent);
const bug = (id: string, title: string, parent?: string) => at(id, "bug", title, parent);
const feature = (id: string, title: string) => at(id, "feature", title);

/** anton-puoi — matched on "copy" and "three". */
const PUOI = [
  feature("anton-xhm4", "One FilterSelect: the three filter bars stop carrying their own copy"),
  task("anton-iquy", "Extract the copy-pasted error+retry panel into one <ErrorState> component (5 views)"),
  task("anton-uumc", "Unify the three copies of the job handlers' safe() best-effort helper"),
];

/** anton-4ax6 — matched on "claim", onto a leaf feature carrying no tickets of its own. */
const AX6 = [
  feature("anton-kmkm", "The claim write-lock and the markdown scanner are tested directly"),
  task("anton-ccky", "A ticket claim refused for a non-claimable status reports the status, not 'DB is locked'"),
  bug("anton-vsg3", "Claim refusals that will never succeed are retried as transient (status blocked, in_progress)"),
];

/**
 * anton-7xqw, anton-n2h2, anton-ez02 and anton-dbqr — four proposals open at once, all naming
 * anton-5ahy, all on the token "epic". The most generic word on this board, and it cleared the old
 * bar because exactly one open card happened to carry it.
 */
const AHY = [
  feature("anton-5ahy", "Epic-tier blocks edges shape the roadmap and the ready frontier"),
  task("anton-hfh3", "Decompose computeEpicGraph and computeChildReadiness before the top-tier rollup lands", "anton-5ahy"),
  task("anton-px7o", "Pre-approve structure check on the target's subtree", "anton-5ahy"),
  task("anton-x5yl", "Rollup, approve, board, and roadmap honor top-tier blocks edges", "anton-5ahy"),
  task("anton-04pu", "orphan-grooming's bucket epic writes '## Acceptance' where bd wants '## Success Criteria'"),
  task("anton-d5et", "Dedupe queue.ts's twice-built execute-epic job row and thrice-repeated job-lookup preamble"),
  task("anton-do0q", "Working-layer beads under a container epic ride no board card"),
  task("anton-f3qj", "Dedupe the run view's hand-mirrored RunStatus and run-detail shape"),
  task("anton-ol8f", "Decompose the EpicCard component (217 lines, 27 branches) and dedupe its clone blocks"),
  task("anton-1gj0", "Replace the literal NUL byte in epic-graph.ts's edge key (it makes the file undiffable)"),
  bug("anton-zfz4", "Feature cards hardcode the type chip to Epic — and it now doubles the iris badge"),
  bug("anton-5tof", "execute-epic.formula-walk integration suite is flaky"),
  task("anton-h1ds", "Add-work UI still produces a one-PR epic, not a feature"),
  task("anton-74f8", "epic-graph.ts contains a literal NUL byte, so git treats it as binary"),
];

/** anton-a7hp — matched on "ticket" alone, onto a card that did carry three tickets of its own. */
const A7HP = [
  feature("anton-w9yb", "The product master proposes the right home: misfiled features and tickets"),
  task("anton-02po", "The misfiled kind: claim, refusals, evidence fence, and skill", "anton-w9yb"),
  task("anton-6us7", "The pass sees parentage: epics, cards, and what hangs off what", "anton-w9yb"),
  task("anton-dokt", "Re-parenting home validity becomes tier-aware", "anton-w9yb"),
  task("anton-ri2b", "A run should skip a snoozed child ticket"),
  bug("anton-vbtu", "Flaky: ticket-timeout integration test races its own 0m budget against the rollback-failure setup"),
];

/** anton-r09l — three beads matching on three different words: "source", "test", "split". */
const R09L = [
  feature("anton-m4b5.1", "Split apply.test.ts to follow the source split — 1919 lines and two modules now testless"),
  task("anton-flih", "Decide repo-wide source diffability: .gitattributes vs a control-byte CI lint"),
  task("anton-t24d", "Test + simplify the prune route handler (no test file; complex POST)"),
  task("anton-tart", "Split runner.test.ts (1793 lines, 20 edits in 90 days) into focused suites"),
];

/** anton-z5jn — "route" for two of them, "review" for the third. */
const Z5JN = [
  feature("anton-witd", "The review-score surface is covered: the score chip, the report route, and the rework route"),
  bug("anton-e7yy", "next build fails prerendering the built-in /_global-error route"),
  task("anton-to2a", "Make trailing-content the one retryable review protocol violation"),
];

/**
 * anton-f7up — the one the founder applied. Both subjects are complexity hotspots and anton-3xs is
 * the complexity-debt bucket that already carried eight of exactly that kind.
 */
const F7UP = [
  feature("anton-3xs", "Pay down code-complexity debt (stringer 2026-07-16)"),
  task("anton-l6u", "Reduce complexity + coupling in review-fix job", "anton-3xs"),
  task("anton-0nz", "Simplify parseTicketPatch + add tests", "anton-3xs"),
  task("anton-tun", "Decompose the SettingsView component (387 lines, 18 branches)", "anton-3xs"),
  task("anton-goc", "Decompose the EpicBoard component (157 lines, 33 branches)", "anton-3xs"),
  task("anton-72ox", "Decompose the EpicDetailView component (316 lines, 25 branches)", "anton-3xs"),
  task("anton-17i", "Simplify the PATCH handler in the [slug]/settings API route", "anton-3xs"),
  task("anton-lq58", "Decompose the StandaloneChip component (177 lines, 29 branches)", "anton-3xs"),
  task("anton-ladt", "Extract the Dolt sync coalescer out of bd.ts (5 cwd-keyed maps, 2 prior review blocks)", "anton-3xs"),
  task("anton-2cpj", "Simplify agent-frontmatter parsing in agents-discovery.ts (2 complexity hotspots)"),
  task("anton-qeir", "Decompose review-fix.ts job handler (3 complexity hotspots in the repo's 13-edit churn file)"),
];

const BOARD: Bead[] = [...PUOI, ...AX6, ...AHY, ...A7HP, ...R09L, ...Z5JN, ...F7UP];

const clusters = (board: Bead[] = BOARD) =>
  detectBoard({ board, now: NOW }).filter((d) => d.kind === "parentless-cluster");

describe("the 2026-08-15 parentless-cluster sweep", () => {
  /**
   * The nine, by the target each named. A re-filed proposal for any of these targets is the same
   * proposal — the fingerprint no longer distinguishes subject sets — so the target is the assertion.
   */
  it.each([
    ["anton-puoi", "anton-xhm4", 'matched on "copy" and "three"'],
    ["anton-4ax6", "anton-kmkm", 'matched on "claim", onto a card carrying no tickets'],
    ["anton-7xqw", "anton-5ahy", 'matched on "epic"'],
    ["anton-n2h2", "anton-5ahy", 'matched on "epic"'],
    ["anton-ez02", "anton-5ahy", 'matched on "epic"'],
    ["anton-dbqr", "anton-5ahy", 'matched on "epic"'],
    ["anton-a7hp", "anton-w9yb", 'matched on "ticket"'],
    ["anton-r09l", "anton-m4b5.1", 'matched on "source", "test" and "split"'],
    ["anton-z5jn", "anton-witd", 'matched on "route" and "review"'],
  ])("does not re-file %s -> %s (%s)", (_declined, target) => {
    expect(clusters().map((d) => d.target)).not.toContain(target);
  });

  it("still proposes anton-f7up's cluster — the fix is not silence", () => {
    const [detection, ...rest] = clusters();

    expect(rest).toEqual([]);
    expect(detection.target).toBe("anton-3xs");
    expect(detection.subjects).toEqual(["anton-2cpj", "anton-qeir"]);
    // The claim an approver checks: one subject the pair states between them, which the card states
    // too — not a word each happens to share with it.
    expect(detection.evidence.join("\n")).toContain('"complexity", "hotspot"');
    expect(detection.evidence.join("\n")).toContain("already carries 8 ticket(s)");
  });

  // Four proposals for anton-5ahy stood open at once because each patrol hashed a different
  // membership. Whatever the membership, the claim is now one claim.
  it("fingerprints a target's cluster the same however the membership moved", () => {
    const trimmed = BOARD.filter((b) => b.id !== "anton-2cpj");
    const withOneMore = [...BOARD, task("anton-new", "Simplify the complexity hotspots in relink.ts")];

    expect(clusters(trimmed)).toEqual([]); // one bead left is not a cluster
    const [before] = clusters();
    const [after] = clusters(withOneMore);
    expect(after.subjects).toEqual(["anton-2cpj", "anton-new", "anton-qeir"]);
    expect(after.fingerprint).toBe(before.fingerprint);
  });
});
