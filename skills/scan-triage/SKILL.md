---
name: scan-triage
description: >-
  Turn a stringer scan into a small set of well-formed beads, protecting queue quality. Reads
  stringer signal output, dedupes across every automated producer (stringer/gardener/pm
  fingerprints), routes each signal into the feature that already owns its files, clusters what
  nothing owns into features attached to their product epic, sets risk from severity, discards
  noise, and creates contract-shaped beads for the executor to pick up. Run by anton's
  nightly-stringer job (`stringer scan --delta` → `/scan-triage`); invocable directly on a scan file.
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
- **Read the board.** anton's nightly-stringer job appends a **`## Board context`** section to this
  prompt, after the scan-file line and the severity table — the open features with their touch
  surfaces, the open epics with their tier verdict, and every producer fingerprint already on the
  board, resolved from `bd` moments before this prompt. **When that section is present it IS this read**; use it in §2 (dedupe), §4
  (placement), and `bd show <id>` anything you intend to write to before you write. When it is
  absent or marked UNAVAILABLE, do the read yourself: `bd list --json --limit 0` and `bd list
  --type epic --all --json --limit 0` — `--limit 0` is required, `bd list` defaults to 50 and a
  truncated board silently re-creates beads it can't see.

## 2. Dedupe — across every producer, not just stringer

Skip any signal already tracked. stringer `--delta` already drops signals seen last scan; this
catches ones already turned into beads — **by anyone**.

anton has more than one automated producer, and they see overlapping problems: the same duplicated
helper is a stringer `duplication` signal, a gardener duplicate-bead finding, and a PM proposal.
Each producer tags its beads `<producer>:<class>:<hash>` — `stringer:`, `gardener:`, `pm:` — and
the `<hash>` identifies the underlying issue, not the producer. So:

1. **Match on `<hash>` across ALL three namespaces**, never on `stringer:` alone. A signal whose
   hash appears under `gardener:` or `pm:` is already raised.
2. **Then match on the touched file + the claim**, for the same issue fingerprinted differently by
   two producers. The board-context lines carry each producer bead's `touches:` for exactly this.
3. **A match is a cross-link, never a second bead.** Do not create. Instead:
   - stamp this scan's fingerprint onto the bead that already holds the issue —
     `bd update <id> --add-label stringer:<collector>:<hash>` — so the next scan under either
     namespace lands on that one bead;
   - when the collision is between **two beads already on the board** (one producer's and
     another's, same issue), link them: `bd link <a> <b> --type related`. Leave both open —
     merging duplicates is a human's call — and name the pair in §6 so the gardener can.
   - Count it under `deduped:` (with the `cross-linked:` subset) in §6 — never under `created:`.
4. Only a signal that matches nothing under any namespace is yours to file.

## 3. Triage by class (queue quality)

### 3.1 Severity → `risk:` and priority

stringer's JSON carries no severity field, so anton derives one per signal — from the signal's
`Priority` when a collector sets one, else its kind, else its collector's default (`vuln` →
critical, `dephealth`/`githygiene` → medium, `todos`/`deadcode`/`duplication` → low, an unknown
collector → medium). A secret or a CVE is then FLOORED at `critical` whatever emitted it and
whatever `Priority` it carried: a collector's priority is a queueing hint, not a security
judgment, and it never demotes one of these. That derivation is
`src/lib/scan-severity.ts` — the same one the per-scan health record counts by, so the trend on the
board and the labels on these beads mean the same thing.

The severity you get is then labelled by this mapping:

| severity | label | priority |
| --- | --- | --- |
| critical | risk:high | P0 |
| high | risk:high | P1 |
| medium | risk:low | P2 |
| low | risk:low | P3 |

**Per project adjustable**, via `scanSeverity` in project settings (`PATCH
/api/projects/<slug>/settings`, e.g. `{"scanSeverity":{"medium":{"risk":"high","priority":1}}}`) —
one entry per severity, both knobs required. anton's nightly-stringer job resolves the project's
policy and appends it to this prompt: **when a mapping table follows the scan-file line below, that
table wins over the defaults above.** The per-class rules below still decide what becomes a bead at
all; this only decides how it is labelled.

### 3.2 What becomes a bead

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
  binaries → one cleanup bead: a child ticket only on a feature *this triage just created* that
  already carries child tickets, otherwise its own run target — a `feature` under the epic that owns
  the surface, or a parentless `task` (the §4.3 fallback). Never file a standalone one as a `chore` —
  a parentless `chore` isn't a run target, so it would sit on the board unexecuted.

**A bare ticket is never how you file small work.** Parented to an epic it's a dead bead; parentless
it runs but drops off the roadmap. Whenever an epic owns the surface, small work is a **childless
`feature`** — a parentless `task`/`bug` is reserved for §4.3, where no epic honestly holds it.

**Never give a childless feature its first child.** A childless feature runs *itself* as its one
ticket, off its own Acceptance. The moment a ticket hangs under it the run works the children
instead — the feature's spec is never sent to the agent, and merge closes it as delivered on a PR
containing only that child. So a cleanup ticket only ever joins a feature that **already** has
working-layer children; anything else gets its own run target.

**Never grow a run that has started.** A run captures its ticket list when it begins, so a ticket
attached to a feature that is already approved, implementing, in review, or carrying a PR ref is
never implemented — and merge finalization closes it as delivered anyway. So a feature is extendable
only if this triage created it, or it is still open with
no `approved` / `stage:*` label and no PR ref (`bd show <feature-id>` before you link).
An assignee alone is not a disqualifier — a human claim reserves a feature without approving it,
so no run has captured its tickets yet. Anything else gets its own run target.

This guard only rules candidates *out*; it never widens a per-class rule above. Which features a
bead may join at all is decided first, and there are exactly two ways in: a feature **this triage
just created**, or the open feature whose **touch surface owns the signal's files** (§4.0). Surface
ownership is the qualifier — an open feature that merely sounds related, under another epic, is not
a home. A cleanup bead in particular joins nothing else.

Respect `.product/config.yaml` `stringer.max_beads_per_scan` — if triage exceeds it, keep the
highest-severity and defer the rest (they resurface next scan). Security is exempt from the cap.

## 4. Place the work — route INTO existing structure before you build new

Work the order below and stop at the first rule that holds. A new cluster beside work that already
owns the same files is the failure mode this section exists to prevent: it splits one PR into two,
puts two agents in the same file, and hides the debt from the person already rewriting it.

### 4.0 A live feature already owns these files → route there

The board-context lines (§1) carry each open feature's touch surface, parsed from its `## Context`
`touches:`. A signal whose file falls inside one belongs to **that feature**. Match on the surface,
not the theme — same file, or the same module that feature is named for. Two files in the same repo
is not ownership; when the signal's file is outside the surface, this rule does not fire.

Which of the two forms depends on the `attach:` verdict anton resolved for that feature:

- **`attach:child`** → file the bead as a **child ticket** of that feature: `bd link <ticket>
  <feature> --type parent-child`. It ships in that feature's PR, reviewed by whoever is already in
  the file. Confirm with `bd show <feature-id>` before you link.
- **`attach:no (<reason>)`** → its run has already captured its ticket list, or it is childless and a
  first child would silently replace its own spec (§3.2). **Do not attach.** File the work as its own
  run target — a `feature` under the **same epic** that feature hangs off — and record the
  relationship: `bd link <new> <feature> --type discovered-from`. Provenance kept, running PR
  untouched.

A signal is routed to at most one owner. When two features' surfaces both cover the file, pick the
one whose Goal names the problem, and say so in the routing note (§5).

### 4.1–4.3 Nothing owns it → attach the new feature to an epic

Only a genuinely unowned cluster becomes a new feature. A parentless `feature` still runs, but it
falls off the roadmap — it advances no outcome anyone tracks. Triage usually runs unattended on the
nightly cron, so there is nobody to ask mid-run: either place the feature, or surface it in §6 for
the founder to place.

1. **Look before you create.** `bd list --type epic --all --json --limit 0` — always `--all`, because
   the right home may already be closed and you can't judge that from a list that omits it; always
   `--limit 0`, because the default 50 would hide the matching epic and mint a duplicate.
   Match on `area:` first — the product surface the signal's files sit on — then on theme. Debt in the auth module belongs under whatever outcome already owns auth.
   Then confirm the match is **safe to attach to** — the board-context epic lines already carry that
   verdict for every OPEN epic (`attach:feature` / `attach:no (PRE-TIER …)`); for a closed one, or
   when the section is unavailable, derive it with `bd children <epic-id>`:
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
              routed: <parent-id|none> — <why THIS parent>
## Out of scope- unrelated cleanup
## Verify      the check that proves it (test, re-scan clean, lockfile diff)
```

Pour that shape from the project's bead formula rather than retyping it —
`bd cook anton-bead --mode=runtime --var goal='…' …`, then `bd create --description` from the cooked
step for the tier you're creating (`feature` for the cluster, `ticket` for its children; see the
`bd` skill). Fill every var: an unfilled `TODO —` default is not a triaged bead, and a fabricated
Acceptance box is worse than none.

**Every created bead records its routing decision** on its own `## Context`, as one `routed:` line
directly under `touches:`. Placement is the judgment call in this whole prompt and it runs
unattended, so the reasoning has to survive on the bead — it is what the gardener (and a human)
audit a misroute against. State the parent and the evidence, in one line:

```
routed: anton-abcd — src/lib/auth/session.ts is inside its touch surface (child ticket)
routed: anton-abcd — same surface, but attach:no (stage:implementing); filed as a sibling feature under epic anton-zzzz, discovered-from it
routed: anton-zzzz — no open feature touches src/lib/csv.ts; new feature under the epic that owns area:reports
routed: none — no epic honestly owns this; parentless run target, surfaced under needs-an-epic (§4.3)
```

A `routed:` line that only restates the parent id ("routed: anton-abcd") is not a decision — name
the file/surface or the absence that decided it. Same line on a cross-link (§2), naming the bead the
issue was already on and the fingerprint that matched.

Labels: `domain:eng`, `source:stringer`, `risk:<class>`, `agent:<stack match>`, `size:`, and a
fingerprint (`stringer:<collector>:<hash>`) for future dedup — on the feature and on each ticket, so
the next scan dedupes against either. The `<hash>` identifies the **issue**, not the producer:
derive it from the file + rule so it is stable across scans and reproducible by another producer —
a hash keyed on the line number or the scan date defeats §2 for everyone. One `area:` on the epic,
and nowhere else. Edges: `bd link <ticket> <feature> --type parent-child` and `bd link <feature>
<epic> --type parent-child`.

## 6. Report

```
created: N (F features, T tickets) · epics: A attached, C created · routed-into-existing: R · deduped: D (cross-linked: L) · dropped-as-noise: K · deferred (over cap): X
```

`routed-into-existing:` counts beads placed under a feature that already owned the files (§4.0),
child or `discovered-from`. `deduped:` counts every signal that produced no bead because the board
already held it; `cross-linked:` is the subset that got a `related` edge across producer namespaces
(§2). Keep `created:` and `deduped:` exactly where they are — the health record parses that line.

Then list, explicitly: the security beads, each `routed-into-existing` bead as
`<new-id> → <parent-id> (child | discovered-from)`, each cross-link as `<a> ↔ <b>` with the matching
fingerprint, and any bead filed under `needs-an-epic:` (§4.3) with the epics you considered — that
line is the ask the unattended run can't make in person. Fail loud if the scan file is
missing/unparseable. Never invent signals not in the file.
