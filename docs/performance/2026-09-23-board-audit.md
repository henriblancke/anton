# Board and page performance audit

Measured locally on Node 26.8.2, using 1,104 captured issues (909 closed), 269 board cards, and a disposable SQLite backup. The application database was not mutated. These are server-side measurements, not browser navigation timings; remote `bd` latency is excluded from the board assembly benchmark.

## Changes, ordered by impact

| Priority | Change | Reason and evidence |
| --- | --- | --- |
| 1 | Bounded caches for CommonMark scans, headings, and contract reads | The original CPU profile spent 75% of its sampled stacks in Markdown processing. Text/input keys invalidate edits immediately; returned mutable values are copied. |
| 2 | Project one approval target; give Health a dedicated read | Both previously assembled the entire board and its picker decision. Approval retains the forced-fresh snapshot and existing claim locks; Health reads the same reports and score population without recording a plan. |
| 3 | Reuse dependency indexes and the picker's existing digest | Board construction and approval revalidation previously rebuilt maps and scanned all edges for each target. The shared index preserves child-to-unit rollup, unresolved blockers, and merge-gate handling. |
| 4 | Omit detail-only acceptance text from board responses; render completed cards 20 at a time | Most board data was completed history. All card IDs and totals remain available, and detail views still load full contracts. Three pages load the ticket dialog only when opened. |
| 5 | Combine stage-label deltas into one `bd update` | An ordinary stage move now uses one label write instead of two, avoiding an intermediate state. Reopen still precedes labels, and the whole operation retains its bead lock. |
| 6 | Parallel settings reads and server-seed epic detail | Removes sequential independent reads, a duplicate settings board read, and the epic page's initial client fetch. Writes still trigger a fresh detail read. |
| 7 | Coalesce visibility polling, abort HTTP reads, and narrow compatibility retries | Returning to a tab no longer overlaps a pending poll. Timeout/connection failures no longer fan out into open/closed listings; explicit old-CLI status rejection still falls back. |
| 8 | Cache compact pass-log summaries | Jobs history previously rescanned unchanged transcripts. A bounded cache checks inode, size, mtime and ctime on every read, and refuses to cache a file that changed during the scan. |

## Measurements

Ten samples for warm operations; one cold sample. The after measurements came from the same captured board. Other local test processes may add noise, so these establish the bottleneck reduction rather than a latency guarantee.

| Operation | Before | After |
| --- | ---: | ---: |
| Warm board assembly, median | 6,254 ms | 218 ms |
| Warm board assembly, range | 5,416–6,678 ms | 180–274 ms |
| Board-shaped approval lookup | Full board assembly | 3.71 ms |
| Health board projection | Full board assembly | 0.68 ms |
| Ticket rows, median | 1,069 ms | 9.56 ms |
| Shared blocker index plus lookups for all issues | Per-card helpers: ~184 ms total | 0.36 ms |
| Board payload, gzip | ~241 KB | 109 KB |
| Board payload, uncompressed | ~980 KB | 582 KB |

The new cold process assembled its first board in 1,688 ms, including its initial parsing. The original audit's first board assembly was 5,659 ms, after other parsing benchmarks had already run; this cold comparison is therefore less controlled than the warm comparison. The existing version-only polling path was already sub-millisecond in the original audit and remains independent of full board assembly.

Contract goal, acceptance, and validation outputs and both blocker projections were compared against the original implementation for every captured issue: **5,520 comparisons, zero differences**. Regression tests also cover cache eviction, caller mutation, edits without timestamp changes, log invalidation, poll overlap/abort, completed-history batches, and server-seeded detail refresh.

Reproduce without accessing the live application store:

```sh
node --import tsx scripts/bench-board.mts /tmp/beads.json /tmp/anton-snapshot.db anton
```

The benchmark opens the supplied SQLite snapshot read-only, backs it up into another temporary directory, redirects all application reads/writes there, and replaces `beads.list` with the exported JSON. Exported issue data and database copies are not committed.

## Host contention

Read-only process inspection during validation also found **14 orphaned CPU stress loops**, each running for more than four days. One sample showed **563% combined CPU** and a **74 one-minute load average**. These processes belonged to another session, outside Anton's request code. After the user authorized cleanup, their identities were rechecked, all 14 received SIGTERM, and process-table verification confirmed they had exited. The before/after figures above were collected before that cleanup.

## Remaining costs and constraints

1. **Cold remote board reads:** `bd list` took 1.11–1.81 seconds for 3.46 MB. These changes accelerate local derivation; they do not remove that remote round trip. Snapshot freshness and write fencing must remain intact in any further reduction.
2. **Synchronous build identity:** a cache miss costs 223–275 ms and blocks the request event loop. Tracked as **anton-fzarz**, including relocated-bundle tests and preservation of fresh job-start checks. The existing 15-second display cache remains.
3. **History transfer:** completed cards are mounted incrementally, but their compact metadata is still transferred. Server pagination needs to preserve search, filtering, grouping, counts and drag reconciliation. Remaining run/dependency pages can also benefit from server-seeded data.
4. **Schedule summaries:** the latest-job window query scanned 43,613 jobs in about 21 ms. A trial `(project, status, updated_at)` index was not selected and did not improve it. No speculative schema migration is included.
5. **Picker persistence:** full board reads still record their derived picker generation. This is required so an operator's release/decline names the displayed decision. Removing the write would break approval semantics; the cheap conditional-poll path does not perform it.

Tracking: anton-myba8. Production build, typecheck, lint and control-byte checks run with temporary application state. Detailed final test results are recorded in the PR.
