---
name: scan-triage
description: >-
  Turn a stringer scan into a small set of well-formed beads, protecting queue quality. Reads
  stringer signal output, dedupes against existing beads, clusters related signals into epics,
  sets risk from severity, discards noise, and creates contract-shaped beads for the executor
  (foolery) to pick up. Called by bin/loom-scan.sh nightly; invocable directly on a scan file.
---

# /scan-triage — stringer signals → good beads

stringer will happily emit hundreds of signals. Dumping them as raw beads floods the board and
the executor ships noise faster. **The board is the product** — your job is to convert signals
into the *few* beads worth doing, shaped to the contract, and drop the rest.

Read `.product/principles.md` and `.product/PRODUCT.md` first. All bead writes go through the
`bd` skill. Input: a stringer scan file (JSON) passed as the argument.

## 1. Read signals + existing board

- Parse the scan file (stringer JSON). Each signal has a collector, severity, file/line, rule,
  and often a suggested remediation.
- `bd list --json` the existing open beads. You will dedupe against these.

## 2. Dedupe

Skip any signal already tracked. Match by a stable fingerprint — `source:stringer` +
collector + file + rule — carried on prior beads as a label/metadata. stringer `--delta`
already drops signals seen last scan; this catches ones already turned into beads.

## 3. Triage by class (queue quality)

- **Security — always a bead, `risk:high`.** Committed secrets, known CVEs (OSV), unsafe
  config. One bead each; never cluster away a vuln.
- **Debt — cluster, `risk:low`.** TODOs/FIXMEs, dead code, duplication, complexity hotspots →
  group into **one epic per theme** ("Pay down auth-module debt") with child tickets, or a
  single `task` if small. Don't create 40 TODO beads.
- **Dependencies — cluster.** Stale/deprecated/archived packages → one epic "Upgrade stale
  deps" with a child per package (or one task if trivial).
- **Risk/hygiene/docs — mostly drop or cluster.** Lottery risk, high-churn, doc drift → a
  bead only if actionable and worth a human's PR review. Merge-conflict markers / large
  binaries → one hygiene task.

Respect `.product/config.yaml` `stringer.max_beads_per_scan` — if triage exceeds it, keep the
highest-severity and defer the rest (they resurface next scan). Security is exempt from the cap.

## 4. Shape each into a contract bead

Every bead created must satisfy the bead contract (see the `bd` skill):

```
## Goal        one line: the risk/debt and why it matters (cite the signal)
## Acceptance  - [ ] concrete, verifiable fix (e.g. "no OSV-2026-xxxx in lockfile")
## Context     touches: <file:line from the signal>; remediation: <stringer suggestion>
## Out of scope- unrelated cleanup
## Verify      the check that proves it (test, re-scan clean, lockfile diff)
```

Labels: `domain:eng`, `source:stringer`, `risk:<class>`, `agent:<stack match>`, `size:`, and a
fingerprint (`stringer:<collector>:<hash>`) for future dedup. Link child tickets to their epic
(`parent-child`).

## 5. Report

`created: N (E epics, T tickets) · deduped: D · dropped-as-noise: K · deferred (over cap): X`,
with the security beads listed explicitly. Fail loud if the scan file is missing/unparseable.
Never invent signals not in the file.
