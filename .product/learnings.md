# LEARNINGS

Raw, append-only, episodic. The signal that compacts into `principles.md`. Append a dated
line whenever you overturn a park, revert a merge, correct the worker/shaper, or hit a
repeated blind spot.

Format: `- YYYY-MM-DD [tag] what happened → what should change`
Tags: `scope`, `bug`, `security`, `test`, `shape`, `perf`, `dx`, `false-park`, `bad-merge`.

<!-- Example:
- 2026-07-09 [false-park] review parked a copy-only change as risk; it was fine → copy/docs
  beads default risk:low and skip the strict scope check.
-->

## New
- 2026-09-05 [bug] Second live NUL-as-dedupe-key found (`gardener/record.ts`), same class as the
  epic-graph.ts one — a literal control byte makes git call the module binary, so no diff-based
  reviewer sees it → composite Map keys use `JSON.stringify([a, b])`, never a raw `\0`; the
  `control-bytes` CI gate now blocks the class outright.

## Compacted
<!-- promoted entries move here once they graduate into principles.md -->
