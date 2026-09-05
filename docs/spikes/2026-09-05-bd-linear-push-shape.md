# Spike: what `bd linear sync --push` actually sends (anton-ey0w.1)

**Date:** 2026-09-05 · **Feature:** anton-s8ob (Linear sync spike) · **bd:** 1.1.2 (installed);
answers re-checked against 1.2.2 (latest stable) and unchanged.

## Questions and answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does push map `parent-child` onto Linear sub-issues? | **No.** Push never sends a parent. Hierarchy is import-only. |
| 2 | Does push carry bead labels? | **No.** Push never sends `labelIds`, so the run-lease cannot reach Linear as a label — but a lease-only change is still **one read per linked bead**, plus a write for the ~5-in-8 of the default population that carry a structured `acceptance_criteria`/`design`/`notes` field, whose unchanged-issue skip never fires (§2). |
| 3 | What does `--update-refs` write into `external_ref`? | The **Linear issue URL verbatim, always** — the flag is declared but never read, so it cannot be turned off. |

Consequences for the downstream tickets are at the bottom.

## Method (read this before trusting the numbers)

The ticket asked for `--dry-run` against a throwaway Linear team. That method cannot answer any of
the three questions, and its throwaway-team half needs a credential this worktree does not have:

- **`--dry-run` is not offline and not descriptive.** It hits the live API before printing anything
  (workflow-state cache — `engine.go:815`, before the dry-run branch at `:850`), so it needs real
  credentials. The Linear tracker does not implement `BatchPushDryRunner` (only Notion does —
  `internal/notion/tracker.go:247`), so a Linear dry-run falls through to the per-issue loop, which
  prints exactly one line per bead: `[dry-run] Would create in Linear: <title>` (`engine.go:928-937`).
  No fields, no parent, no labels. It would have told us nothing about the payload.
- **A live push needs a Linear API key**, which is a human-minted credential (see *Still open* below).

So the evidence here is the **push payload itself**, read from bd's source at the exact version
installed (`v1.1.2`, fetched from the Go module proxy), corroborated against the shipped binary's
embedded GraphQL strings and against live CLI behaviour on a scratch board. Since the only channel
from bd to Linear is the GraphQL mutation body, a field bd never puts in that body cannot appear in
Linear — which is what makes the source-level answer definitive rather than indicative.

```bash
bd version                          # bd version 1.1.2 (20e493e56)
curl -s -o v1.1.2.zip https://proxy.golang.org/github.com/steveyegge/beads/@v/v1.1.2.zip
unzip -q v1.1.2.zip                 # -> github.com/steveyegge/beads@v1.1.2/
strings -n 8 "$(which bd)" | grep -E 'mutation (CreateIssue|BatchCreateIssues|UpdateIssue)'
# mutation CreateIssue($input: IssueCreateInput!) {
# mutation BatchCreateIssues($input: IssueBatchCreateInput!) {
# mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
```

All file:line references below are `github.com/steveyegge/beads@v1.1.2`.

## 1. Parent-child → Linear sub-issues: **no**

The push path takes the batch branch (`engine.go:850`, Linear implements `BatchPushTracker`), and
every payload it can produce is enumerable:

```go
// internal/linear/types.go:391 — the create input struct. No ParentID field exists.
type IssueCreateInput struct {
	TeamID      string   `json:"teamId"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Priority    int      `json:"priority,omitempty"`
	StateID     string   `json:"stateId,omitempty"`
	LabelIDs    []string `json:"labelIds,omitempty"`
	ProjectID   string   `json:"projectId,omitempty"`
}
```

- Batch create builds exactly `{teamId, title, description, priority, stateId(, projectId)}`
  (`internal/linear/tracker.go:379-390`).
- Single create (duplicate titles) goes through `buildIssueCreateInput`, same key set
  (`internal/linear/client.go:691-710`).
- Update sends `{title, description, priority}` plus `stateId`
  (`internal/linear/fieldmapper.go:78-85`, `tracker.go:461-474`).

No parent id, no `parentId`, no second pass that links issues after creation. `grep -rn parentId
internal/linear` returns nothing; the only `parentId` in the whole tree belongs to the **GitLab**
tracker, which does support it (`internal/gitlab/client.go:589`,
`hierarchyWidget: { parentId: %q }`). Linear simply has not been given that treatment.

The mapping is **one-way**: pull *does* read Linear's `parent` and record it as a bd `parent-child`
dependency (`internal/linear/mapping.go:590-598`). So a hierarchy authored in Linear survives the
trip into beads; a hierarchy authored in beads does not survive the trip out. Everything anton
pushes lands as a **flat list of top-level issues** in the configured team.

**What survives push:** title, description (with `## Acceptance Criteria` / `## Design` / `## Notes`
appended — `mapping.go:23-35`), priority, workflow state, and project id. Nothing else. bd also does
not push `blocks` edges: dependency mapping is pull-only, and only with `--relations`.

## 2. Labels on push: **no**

`labelIds` is a legal field on the create input, but nothing in the push path ever fills it:

```go
// internal/linear/tracker.go:347 — batch push, single-create branch
var labelIDs []string   // declared nil, never populated
created, _, createErr := client.CreateIssueIdempotent(ctx, issue.Title, issue.Description, priority, stateID, labelIDs, marker)

// internal/linear/tracker.go:210 and :221 — non-batch create path
client.CreateIssueIdempotent(ctx, issue.Title, description, priority, stateID, nil, marker)
client.CreateIssue(ctx, issue.Title, description, priority, stateID, nil)
```

and `buildIssueCreateInput` only emits the key `if len(labelIDs) > 0` (`client.go:706`). The update
map has no label key at all. Bead labels never reach Linear, in either direction of the push —
`approved`, `stage:*`, `run-lease:*`, `agent:*`, `area:*` are all invisible there. (Labels matter to
bd only on **pull**, where Linear's labels infer a bead *type* via `linear.label_type_map` —
`mapping.go:456-480`.)

**So no bead label can reach Linear, the run-lease included.** That is the whole of the label
question, and it holds on the payload alone.

### It does not follow that a lease-only change writes nothing

The skip that would deliver that is defeated — **once for every bead, and permanently for some**.
Worth deriving in full, because the design leaned on it.

`BatchPush` fetches the remote issue and skips when `PushFieldsEqual` finds title / description /
priority / status all equal (`tracker.go:451-458`, `mapping.go:422-436`). Labels are correctly
absent from that set. The description is in it, and two independent defects make it mismatch:

1. **Every issue bd created carries a marker the comparison does not know about.** Batch create
   sends `AppendIdempotencyMarker(issue.Description, marker)` (`tracker.go:376-377`; the
   single-create path does the same inside `CreateIssueIdempotent`, `client.go:829`), so the remote
   description initially ends in `\n<!-- bd-idempotency: <12 hex> -->`. `FetchIssueByIdentifier`
   returns `description` verbatim (`client.go:1097-1105`), and the marker's only reader anywhere in
   the tree is `extractIdempotencyMarker`, used to recover from an ambiguous batch (`client.go:986`,
   `:1003`) — nothing strips it before the compare, while `BuildLinearDescription(local)` never
   contains one. **Applies to every bead, and self-clears:** the update it forces writes a
   marker-free description (`fieldmapper.go:78-85`), so from the second push on the marker is gone.
   Cost: exactly one extra write per bead, once, after its create.
2. **The description is built twice — but this only bites a bead with structured fields.** The
   engine hands `BatchPush` *formatted copies*: `formatPushIssue` sets
   `copy.Description = BuildLinearDescription(issue)` but leaves `AcceptanceCriteria` / `Design` /
   `Notes` populated on the copy (`engine.go:1060-1067`, built at `:1055`, passed to `BatchPush` at
   `:851`). `PushFieldsEqual` then calls `BuildLinearDescription` on that copy, appending
   `## Acceptance Criteria` / `## Design` / `## Notes` a **second** time (`mapping.go:23-35`). bd
   knows the hazard elsewhere — the create path carries a comment refusing to re-format for exactly
   this reason (`tracker.go:196-200`), and `NormalizeIssueForLinearHash` clears the three fields
   after merging them (`mapping.go:37-51`) — the guard was just never applied to the push
   comparison. **This defeat does not clear:** the update writes the *singly* appended description
   (`IssueToTracker` sends `issue.Description`, which is already the merged copy —
   `fieldmapper.go:77-84`), so the local build stays one append longer than anything the remote can
   hold and the next push mismatches again. **But `BuildLinearDescription` reads only bd's three
   *structured* fields — it never parses the description body** (`mapping.go:23-35`). A bead whose
   rubric lives in the description body appends nothing on either pass, so the two builds agree and
   this defeat cannot touch it.

#### How many anton beads carry structured fields — the load-bearing number

anton's contract puts the whole rubric in `description` and **forbids `--acceptance`**
(`skills/bd/SKILL.md:187-215`); graph-created beads have no acceptance field at all, deliberately
(`src/lib/beads/bd.ts:1877-1891`). A bead written under that rule alone is description-only, so
defeat 2 cannot reach it. Two things break that assumption: the board still carries beads created
before the rule, and **anton itself fills a structured field at runtime** — `bd note` is how job
notes and human steering land on a run target (`beads.note`, `src/lib/beads/bd.ts:2315-2321`), and
`notes` is one of the three fields `BuildLinearDescription` appends.

Measure the population the sync actually processes, not a convenient slice of it. The design's
default for **Also include** is *Open and closed* and the mock's previewed command is `--state all`,
so the population is **every epic and feature on the board, open or closed** — a closed bead is
fetched, compared and updated on every cycle exactly like an open one:

```bash
bd list --status all --json --limit 0 | jq -c '
  def structured: ((.acceptance_criteria//"")!="") or ((.design//"")!="") or ((.notes//"")!="");
  [.[] | select(.issue_type=="epic" or .issue_type=="feature")] as $t |
  {default_state_all: {total: ($t|length), structured: ([$t[]|select(structured)]|length)},
   if_open_only:      {total:      ([$t[]|select(.status=="open")]|length),
                       structured: ([$t[]|select(.status=="open" and structured)]|length)},
   by_field: {acceptance_criteria: ([$t[]|select((.acceptance_criteria//"")!="")]|length),
              design:              ([$t[]|select((.design//"")!="")]|length),
              notes:               ([$t[]|select((.notes//"")!="")]|length)},
   since_the_contract: {total:      ([$t[]|select(.created_at>"2026-08-15")]|length),
                        structured: ([$t[]|select(.created_at>"2026-08-15" and structured)]|length),
                        notes_only: ([$t[]|select(.created_at>"2026-08-15" and (.notes//"")!=""
                                                 and (.acceptance_criteria//"")=="")]|length)}}'
# measured 2026-09-05:
# {"default_state_all":{"total":196,"structured":123},
#  "if_open_only":{"total":39,"structured":12},
#  "by_field":{"acceptance_criteria":103,"design":0,"notes":36},
#  "since_the_contract":{"total":75,"structured":17,"notes_only":16}}
```

**Under the documented default, roughly five of every eight pushed beads write on every cycle** —
123 of 196. The open-only slice (12 of 39) is the flattering one and does not describe the default:
157 of the 196 are closed, 111 of those carry a structured field, and nothing removes a closed bead
from a `--state all` population.

**The write tail also does not trend to zero**, for two independent reasons:

- Closed beads never leave the default population, so their writes are permanent rather than
  decaying. Closing a legacy bead does not retire its cost; it freezes it.
- `notes` keeps minting new members of the writing set. Of the 75 epics+features created since
  2026-08-15, well under the current contract, 17 carry a structured field — **16 of them
  `notes`-only**, with exactly one `acceptance_criteria`. The contract killed the acceptance field;
  it cannot keep `bd note` off a run target, and anton notes its own run targets.

So the skip fires only for a bead that is description-only **and** has never been noted **and** has
been pushed at least once — and the writing set converges to a floor, not to zero. The lever that
actually shrinks it is the **Also include** control: *Open only* takes the population from 196 to 39
and the per-cycle writes from 123 to 12. That is a design choice for the sync ticket, not a bd
behaviour, and it is flagged rather than decided here.

bd's regression test does not cover either defeat: `TestBatchPush_SkipsUnchangedIssue`
(`internal/linear/tracker_test.go:80-137`) uses an empty local description, no structured fields and
a remote with no marker — the one shape where both defeats are absent — and builds the `Tracker`
directly, bypassing `formatPushIssue`.

### What hazard 2's residue actually is: a read per bead, plus a write tail that does not decay

Per push, per Linear-linked bead:

1. **One read, always.** `IssueByIdentifier` before any skip decision (`tracker.go:451`), plus one
   workflow-state fetch per team. No skip avoids this — the fetch is what feeds the comparison, so
   the read cost is a floor that does not shrink.
2. **A write, conditionally.** An `issueUpdate` mutation whenever the skip misses — reported back as
   `Updated: N`, and carrying an `external_ref` re-write with it (`tracker.go:496`). It misses once
   per bead after its create (defeat 1), then permanently for the ~5-in-8 of the default population
   carrying a structured field (defeat 2), and for any bead whose title / description / priority /
   status genuinely moved.
3. **Genuine content change only sometimes.** When an update does fire on an otherwise unchanged
   bead it re-sends title, description, priority and `stateId` at their existing values, so whether
   a stakeholder sees a feed entry is Linear's change detection, not bd's. What *is* a real change:
   the first push after a create (marker removal), and `status` — it is in the compared set and
   pushed as `stateId`, so a run flipping its target `open → in_progress → closed` visits three
   statuses across **two** genuine transitions.

A push triggered by every run-lease refresh (5 min, `RUN_LEASE_REFRESH_MS`) therefore costs **N
reads plus roughly 0.6N writes per cycle** on the default *Open and closed* population (123 writes
against N=196 today) — for a change Linear cannot even represent. That tail does not decay: closed
beads stay in the population forever and `bd note` keeps adding to it. Switching **Also include** to
*Open only* is what moves the number (N=39, 12 writes), and the read floor alone still makes the
debounce the only cap, not a nicety. And anton must not build the guarantee on bd's skip: a test
asserting "an unchanged bead syncs nothing" has to assert it at anton's own seam (no push fired at
all), because asserting it of bd holds only for a never-noted description-only bead, and only from
its second push on.

## 3. `--update-refs`: declared, never read, always on

```bash
grep -rn "update-refs" --include="*.go" .
# cmd/bd/linear.go:184:  linearSyncCmd.Flags().Bool("update-refs", true, "Update external_ref after creating Linear issues")
```

That is the **only** occurrence in the tree. The flag is never read — `cmd/bd/linear.go:212-227`
pulls every other bool out of the flag set and never asks for this one. **`--update-refs=false` is
silently ignored**; the write-back is unconditional.

What gets written, exactly:

- **Batch path (the one Linear takes):** `external_ref` = the `url` field Linear returned, trimmed,
  **verbatim including the slug** — e.g. `https://linear.app/<workspace>/issue/TEAM-123/spike-child-feature`
  (`tracker.go:358`, `:408`, `:496` → `engine.go:1069-1084`). Written for **updated** issues too, not
  just created ones.
- **Non-batch path** (other trackers, or Linear if the batch interface is ever dropped): `external_ref`
  = `BuildExternalRef`, which **canonicalises the slug away** →
  `https://linear.app/<workspace>/issue/TEAM-123`, falling back to `https://linear.app/issue/TEAM-123`
  when the URL is empty (`tracker.go:520-530`, `client.go:1245-1267`, `engine.go:964-966`).
- Both forms are read back through `ExtractLinearIdentifier` (first path segment after `issue/`,
  `client.go:1233-1243`), so the slug difference is cosmetic for bd — but anton's own reader must
  accept **both** shapes.
- `--dry-run` writes nothing: the per-issue loop `continue`s before the create (`engine.go:928-937`).

### Hazard 1 (`external_ref` collision) is confirmed, and worse than assumed

A bead is classified as "needs creating" purely by `extRef == "" || !IsLinearExternalRef(extRef)`
(`engine.go:925-926`, `tracker.go:303-313`), and `IsLinearExternalRef` is a substring test for
`linear.app/` + `/issue/` (`client.go:1270-1272`). A bead carrying a legacy `gh-<n>` PR pointer in
`external_ref` therefore does not read as "already linked" — bd **creates a brand-new Linear issue
for it and overwrites the PR pointer with the Linear URL**. The pointer is not merely shadowed, it is
gone, and `--update-refs=false` cannot prevent it. The design's rule stands and hardens: the sync job
must refuse to push while `planPrRefMigration(list)` is non-empty. This is a pre-push guard in
anton's own code — there is no bd flag that buys safety here.

## Other findings worth carrying into the build

- **Push gates, in order** (observed on a scratch board): auth configured → `linear.state_map`
  explicitly configured (`bd linear link`) → live fetch of team workflow states. Each fails closed
  with a distinct message; the third one is a network call, so nothing about push is testable offline.
- **bd refuses to store the API key in a git-tracked config**: `bd config set linear.api_key …` is
  rejected with a `--force-git-tracked` escape hatch. The environment-only credential posture in the
  design is enforced by bd, not just by us.
- **`linear.project_id` silently suppresses creates.** When a project id is configured, `ShouldPush`
  drops every bead that has no `external_ref` yet, unless the invocation was scoped with `--parent`
  or `--issues` (`cmd/bd/linear.go:359`, `:732-742`). The per-area routing plan (set `project_id`,
  push that area's ids, restore) **must** pass `--issues`/`--parent` or it will create nothing and
  report success.
- **Tier filtering works as the design assumes:** `--type epic,feature` filters on bead type,
  `--state open` skips closed, `--parent` limits to a subtree (`engine.go:1373-1403`, `:843-847`).
- **Creates are idempotent** via a hash marker appended to the description
  (`internal/linear/idempotency.go:20-36`), so an interrupted push does not duplicate issues. The
  same marker is what breaks the first unchanged-issue skip after every create (§2).

## Still open (needs a human)

A real push to a throwaway Linear team was **not** run: it needs a `LINEAR_API_KEY` for a scratch
workspace, which only a person can mint. Nothing above depends on it — a field bd never sends cannot
arrive — but a live run would additionally confirm the workspace-slug shape of the returned `url`
and how a flat push *looks* to a stakeholder. If someone wants that leg: create a throwaway Linear
team, export `LINEAR_API_KEY`, and re-run the reproduce block below against it.

## Reproduce

```bash
# 1. Source at the installed version
bd version
curl -s -o /tmp/bd.zip https://proxy.golang.org/github.com/steveyegge/beads/@v/v1.1.2.zip
unzip -q /tmp/bd.zip -d /tmp/bdsrc && cd /tmp/bdsrc/github.com/steveyegge/beads@v1.1.2
grep -n "type IssueCreateInput" -A 9 internal/linear/types.go     # no ParentID
grep -rn "parentId" --include="*.go" internal/linear              # nothing (GitLab has it, Linear doesn't)
grep -n "var labelIDs \[\]string" -A 2 internal/linear/tracker.go # nil labels on create
grep -rn "update-refs" --include="*.go" .                         # declaration only, never read

# 1b. Why the unchanged-issue skip misses (§2), defeat by defeat
grep -n "AppendIdempotencyMarker" internal/linear/tracker.go internal/linear/client.go
#   tracker.go:377 / client.go:829 - every created issue's remote description ends in the marker
grep -rn "extractIdempotencyMarker" --include="*.go" internal/ | grep -v _test.go
#   client.go:986,1003 only - recovery search; nothing ever strips the marker back off
grep -n "BuildLinearDescription(local) != remote.Description" internal/linear/mapping.go
#   :429 - compares a marker-free local build against the raw remote description
sed -n '1060,1067p' internal/tracker/engine.go
#   formatPushIssue: sets copy.Description, does NOT clear AcceptanceCriteria/Design/Notes ...
sed -n '37,51p' internal/linear/mapping.go
#   ... unlike NormalizeIssueForLinearHash, which does - so PushFieldsEqual appends them twice
sed -n '23,35p' internal/linear/mapping.go
#   :23-35 - the builder reads only the STRUCTURED fields; a description-only bead is untouched
sed -n '196,200p' internal/linear/tracker.go
#   bd's own comment naming the double-append hazard on create; never applied to the comparison
sed -n '80,137p' internal/linear/tracker_test.go
#   the skip test: empty description, no structured fields, no marker - neither defeat present

# 2. Live CLI behaviour on a throwaway board (no real Linear team touched)
mkdir /tmp/linear-spike-board && cd /tmp/linear-spike-board && git init -q . && bd init --prefix spike
bd create "Spike epic parent" -t epic -l area:board
bd create "Spike child feature" -t feature -l run-lease:host-1,approved
bd link spike-2dm spike-xz8 --type parent-child   # ids as generated by this run

bd linear sync --push --dry-run
#   Error: Linear authentication not configured
bd config set linear.api_key "lin_api_SCRATCH"
#   (refused: config.yaml is git-tracked; use --force-git-tracked)
LINEAR_API_KEY=bogus LINEAR_TEAM_ID=00000000-0000-0000-0000-000000000000 bd linear sync --push --dry-run
#   Error: linear.state_map is not configured. Run 'bd linear link' to configure status mapping first.
for k in backlog:open unstarted:open started:in_progress completed:closed canceled:closed; do
  bd config set linear.state_map.${k%%:*} ${k##*:}; done
LINEAR_API_KEY=bogus LINEAR_TEAM_ID=00000000-0000-0000-0000-000000000000 bd linear sync --push --dry-run
#   Error: fetching workflow states for team …: API error: … "AUTHENTICATION_ERROR" … (status 401)
#   ^ proves --dry-run calls the live API before it previews anything
```

Where a Go toolchain is available, both defeats — and the boundary between them — are directly
executable. Drop this into `internal/linear/` in the extracted module and run
`go test ./internal/linear -run SkipDefeat -v`:

```go
package linear

import (
	"strings"
	"testing"

	"github.com/steveyegge/beads/internal/types"
)

// Defeat 1 hits every bead once, then clears. This is anton's own bead shape:
// the rubric lives in Description, the structured fields are empty.
func TestSkipDefeat_DescriptionOnly(t *testing.T) {
	bead := &types.Issue{Title: "T", Description: "body"}

	// Mirrors Engine.formatPushIssue (engine.go:1060-1067) — the copy BatchPush receives.
	pushed := *bead
	pushed.Description = BuildLinearDescription(bead)

	// PushFieldsEqual's description leg (mapping.go:429) re-runs the builder.
	local := BuildLinearDescription(&pushed)

	// The remote as bd created it. AppendIdempotencyMarker's second parameter is the
	// WHOLE comment, wrapper included — that is what GenerateIdempotencyMarker returns
	// (idempotency.go:20-36), not a bare hash — so this is the literal remote suffix.
	marked := AppendIdempotencyMarker(pushed.Description, "<!-- bd-idempotency: deadbeef1234 -->")
	if local == marked {
		t.Error("marker-carrying remote description compared equal")
	}
	// ...and that first mismatch forces an update that writes `local` back. From the
	// second push on the descriptions agree, so the skip fires: no further writes.
	if local != pushed.Description {
		t.Errorf("description-only bead should compare equal once the marker is gone: %q vs %q",
			local, pushed.Description)
	}
}

// Defeat 2 needs a STRUCTURED field, and never clears. Legacy anton beads only.
func TestSkipDefeat_StructuredFields(t *testing.T) {
	bead := &types.Issue{Title: "T", Description: "body", AcceptanceCriteria: "- [ ] a"}

	// formatPushIssue merges Description but leaves AcceptanceCriteria populated...
	pushed := *bead
	pushed.Description = BuildLinearDescription(bead)

	// ...so the builder appends the section a second time on the compare.
	local := BuildLinearDescription(&pushed)
	if strings.Count(local, "## Acceptance Criteria") != 2 {
		t.Fatalf("expected the section appended twice, got %q", local)
	}
	// The update writes the singly-appended `pushed.Description` back (fieldmapper.go:77-84),
	// so the local build stays one append longer forever. Every push writes.
	if local == pushed.Description {
		t.Error("byte-identical remote description compared equal")
	}
}
```

## What this changes downstream

- **anton-60oi (reshape the contracts):** the epic → sub-issue shape is not available, and **neither
  is the tier**: `--type` only selects which beads are pushed, so the payload (title, description,
  priority, state, project id) carries nothing that separates an epic from a feature in Linear.
  Either accept a flat, tier-less push and say so, carry the parent or tier as text in the pushed
  title/description, or route epics to Linear **projects** and features to issues within them — the
  routing machinery the design already plans for `area:` is the only hierarchy bd can express today,
  and it groups by area, not by tier.
- **anton-ey0w.5 (keep run-lease churn out of Linear):** no longer a code change to move the lease off
  labels — bd cannot leak a label. What remains is a **read per linked bead per push, unconditional**,
  plus a write tail: bd's unchanged-issue skip misses once per bead after its create, and misses
  forever for any bead carrying a structured `acceptance_criteria`/`design`/`notes` field — **123 of
  the 196 epics+features in the default `--state all` population** on 2026-09-05 (§2). Only a
  never-noted, description-only bead skips from its second push on, and `bd note` keeps moving beads
  out of that set. So the debounce is still the only cap — the read floor alone justifies it — but
  the ticket should size the cost as N reads + ~0.6N writes on the documented default, note that the
  tail does not decay (closed beads never leave a `--state all` population), and treat *Open only*
  as the lever if the cost has to come down. The "a lease-only change syncs nothing" test must still
  assert *no push fired* at anton's seam: asserting that bd skips is true only for a never-noted
  description-only bead, and only after its first push.
  Still to decide: whether per-run `status` transitions should reach Linear at all.
- **anton-ey0w.2 (wrapper + `external_ref` guard):** the guard cannot delegate to `--update-refs`; it
  must be a pre-push refusal while any bead still holds a `gh-<n>` ref. The wrapper's ref reader must
  accept both the slugged and canonical URL forms, and the per-area routing pass must pass
  `--issues`/`--parent` or `linear.project_id` will silently suppress every create.
