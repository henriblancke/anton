---
name: scan-triage
description: >-
  Turn a stringer scan into a small set of well-formed beads, protecting queue quality. Reads
  stringer signal output, dedupes against existing beads, clusters related signals into features
  attached to their product epic, sets risk from severity, discards noise, and creates
  contract-shaped beads for the executor to pick up. Run by anton's nightly-stringer job
  (`stringer scan --delta` → `/scan-triage`); invocable directly on a scan file.
---

# /scan-triage — stringer signals → good beads

stringer will happily emit hundreds of signals. Dumping them as raw beads floods the board and
the executor ships noise faster. **The board is the product** — your job is to convert signals
into the *few* beads worth doing, shaped to the contract, and drop the rest.

Read `.product/principles.md` and `.product/PRODUCT.md` first. **If `.product/` is missing, STOP
and WARN the user explicitly:** without principles and product context you'd triage signals into
beads against a vacuum — no scope, no risk conventions, no non-goals. Direct them to run the
bundled **`/setup`** (the `setup` skill installed alongside this one) in their repo first, then
re-run `/scan-triage`. All bead writes go through the **`bd` skill** (installed alongside this
one) — it carries anton's label / edge / lifecycle conventions and the bead contract. Input: a
stringer scan file (JSON) passed as the argument.

## 1. Read signals + existing board

- Parse the scan file (stringer JSON). Each signal has a collector, severity, file/line, rule,
  and often a suggested remediation.
- `bd list --json --limit 0` the existing open beads — `--limit 0` is required, `bd list` defaults
  to 50 and a truncated board silently re-creates beads it can't see. You dedupe against these in
  §2, and reuse them in §4 to find the epic each feature belongs under.

## 2. Dedupe

Skip any signal already tracked. Match by a stable fingerprint — `source:stringer` +
collector + file + rule — carried on prior beads as a label/metadata. stringer `--delta`
already drops signals seen last scan; this catches ones already turned into beads.

## 3. Triage by class (queue quality)

anton runs **features**, not epics: a cluster is a **`feature` scoped to one reviewable PR** (one
worktree, one PR) with its child tickets under it. The `epic` is the tier *above* — the product
outcome several features add up to — and you attach the feature to one in §4. The `bd` skill holds
the three tiers, the nesting rule, and the run-target rule.

- **Security — always a bead, `risk:high`.** Committed secrets, known CVEs (OSV), unsafe
  config. One run target each — a `feature` when an epic owns that surface, otherwise a
  parentless `bug` (the §4.3 fallback, surfaced in §6); never cluster away a vuln.
- **Debt — cluster, `risk:low`.** TODOs/FIXMEs, dead code, duplication, complexity hotspots →
  group into **one `feature` per theme** ("Pay down auth-module debt") with child tickets. A theme
  that is one small change is still a `feature` — childless, its Acceptance carried on the feature
  itself. Don't create 40 TODO beads — and don't grow one feature past a reviewable PR to keep the
  count down: two themes are two features.
- **Dependencies — cluster.** Stale/deprecated/archived packages → one `feature` "Upgrade stale
  deps" with a child ticket per package; a single bump is that same feature with no children.
- **Risk/hygiene/docs — mostly drop or cluster.** Lottery risk, high-churn, doc drift → a
  bead only if actionable and worth a human's PR review. Merge-conflict markers / large
  binaries → one cleanup bead: a child ticket only on a feature *this triage just created*,
  otherwise its own run target — a `feature` under the epic that owns the surface, or a parentless
  `task` (the §4.3 fallback). Never file a standalone one as a `chore` — a parentless `chore` isn't
  a run target, so it would sit on the board unexecuted.

**A bare ticket is never how you file small work.** Parented to an epic it's a dead bead; parentless
it runs but drops off the roadmap. Whenever an epic owns the surface, small work is a **childless
`feature`** — a parentless `task`/`bug` is reserved for §4.3, where no epic honestly holds it.

**Never grow a run that has started.** A run captures its ticket list when it begins, so a ticket
attached to a feature that is already approved, implementing, in review, or carrying a PR ref is
never implemented — and merge finalization closes it as delivered anyway. Only extend a feature
this triage created, or one still open with no `approved` / `stage:*` label and no PR ref
(`bd show <feature-id>` before you link). An assignee alone is not a disqualifier — a human claim
reserves a feature without approving it, so no run has captured its tickets yet. Anything else gets
its own run target.

Respect `.product/config.yaml` `stringer.max_beads_per_scan` — if triage exceeds it, keep the
highest-severity and defer the rest (they resurface next scan). Security is exempt from the cap.

## 4. Attach every feature to an epic

A parentless `feature` still runs, but it falls off the roadmap — it advances no outcome anyone
tracks. Triage usually runs unattended on the nightly cron, so there is nobody to ask mid-run:
either place the feature, or surface it in §6 for the founder to place.

1. **Look before you create.** `bd list --type epic --json --limit 0` (add `--all` if a closed epic
   might be the right home; `--limit 0` because the default 50 would hide the matching epic and mint
   a duplicate). Match on `area:` first — the product surface the signal's files sit on — then
   on theme. Debt in the auth module belongs under whatever outcome already owns auth.
   Then confirm the match is **safe to attach to** — `bd children <epic-id>`:
   - **Pre-tier epic** (direct `task`/`bug`/`chore` children, no `feature` child): that epic is
     itself a run target, and the first feature you hang under it turns it into a container — its
     own tickets then ride on no run at all, and a run already approved or in flight on it is
     refused at its next gate. Don't attach. File the work per §4.3 and note under `needs-an-epic:`
     that the epic's legacy tickets need moving under a feature first; that migration is a human's
     call, not triage's.
   - **Closed epic**: reopen it (`bd reopen <epic-id> --reason 'new work from stringer triage'`)
     before linking. Attaching a feature does not reopen its parent, and a closed epic with open
     features under it reads as a delivered outcome on the roadmap while its features sit in the
     backlog. If you can't justify reopening it, it isn't the right home.
2. **Nothing fits, but you can name the outcome → create the epic.** State it as an outcome a
   stakeholder would recognise ("Dependencies are current and CVE-free"), not a restatement of the
   feature ("Upgrade stale deps"). Give it exactly one `area:` label and Success Criteria that
   several features add up to.
3. **Can't name an outcome you'd defend → don't fake one.** Never mint a one-feature epic to
   silence the question, and never leave a `feature` parentless. File the work instead as a
   parentless `task`/`bug` — a run of one, still a run target — and list it in §6 under
   `needs-an-epic:` so the founder places or re-shapes it. Surfaced, never orphaned.

**Child tickets hang off the feature, never off the epic.** A ticket parented straight to an epic
is a dead bead: it isn't a run target (it has a parent) and no feature's run covers it. Confirm the
tree with `bd children <epic-id>` before you report.

## 5. Shape each into a contract bead

Every feature and ticket created must satisfy the bead contract (see the `bd` skill); an epic
carries less — a one-line outcome, Success Criteria, and its `area:`:

```
## Goal        one line: the risk/debt and why it matters (cite the signal)
## Acceptance  - [ ] concrete, verifiable fix (e.g. "no OSV-2026-xxxx in lockfile")
## Context     touches: <file:line from the signal>; remediation: <stringer suggestion>
## Out of scope- unrelated cleanup
## Verify      the check that proves it (test, re-scan clean, lockfile diff)
```

Pour that shape from the project's bead formula rather than retyping it —
`bd cook anton-bead --mode=runtime --var goal='…' …`, then `bd create --description` from the cooked
step for the tier you're creating (`feature` for the cluster, `ticket` for its children; see the
`bd` skill). Fill every var: an unfilled `TODO —` default is not a triaged bead, and a fabricated
Acceptance box is worse than none.

Labels: `domain:eng`, `source:stringer`, `risk:<class>`, `agent:<stack match>`, `size:`, and a
fingerprint (`stringer:<collector>:<hash>`) for future dedup — on the feature and on each ticket, so
the next scan dedupes against either. One `area:` on the epic, and nowhere else. Edges: `bd link
<ticket> <feature> --type parent-child` and `bd link <feature> <epic> --type parent-child`.

## 6. Report

```
created: N (F features, T tickets) · epics: A attached, C created · deduped: D · dropped-as-noise: K · deferred (over cap): X
```

Then list, explicitly: the security beads, and any bead filed under `needs-an-epic:` (§4.3) with
the epics you considered — that line is the ask the unattended run can't make in person. Fail loud
if the scan file is missing/unparseable. Never invent signals not in the file.
