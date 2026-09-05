# Spike: what `bd linear sync --push` actually sends (anton-ey0w.1)

**Date:** 2026-09-05 · **Feature:** anton-s8ob (Linear sync spike) · **bd:** 1.1.2 (installed);
answers re-checked against 1.2.2 (latest stable) and unchanged.

## Questions and answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does push map `parent-child` onto Linear sub-issues? | **No.** Push never sends a parent. Hierarchy is import-only. |
| 2 | Does push carry bead labels? | **No.** Push never sends `labelIds`. Run-lease churn cannot reach Linear as a label. |
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

**So run-lease churn does not write to Linear.** The skip check confirms it: an unchanged-but-relabelled
bead compares equal on title / description / priority / status (`PushFieldsEqual`,
`mapping.go:422-436`, called at `tracker.go:454`) and is skipped without an update mutation.

Two caveats that keep hazard 2 from being fully closed:

1. **The skip is not free.** Every Linear-linked bead costs one `IssueByIdentifier` read per push run
   (`tracker.go:451`) plus one workflow-state fetch per team, *before* any skip decision. A push
   triggered by each run-lease refresh (every 5 min, `RUN_LEASE_REFRESH_MS`) is therefore N+1 API
   reads every 5 minutes even though it writes nothing. The design's 5-minute debounce is what caps
   this — the label itself is harmless.
2. **Status churn does cross.** `status` is in the compared set and is pushed as `stateId`. A run
   flipping its target `open → in_progress → closed` is three real Linear updates. That is the
   activity feed to reason about, not the lease label.

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
  (`internal/linear/idempotency.go:20-36`), so an interrupted push does not duplicate issues.

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

## What this changes downstream

- **anton-60oi (reshape the contracts):** the epic → sub-issue shape is not available. Either accept
  a flat push (tier lives in `--type` and in the Linear project, not in the issue tree), carry the
  parent as a line in the pushed description, or route epics to Linear **projects** and features to
  issues within them — the routing machinery the design already plans for `area:` is the only
  hierarchy bd can express today.
- **anton-ey0w.5 (keep run-lease churn out of Linear):** no longer a code change to move the lease off
  labels — bd cannot leak a label. What remains is rate: debounce push-triggered syncs (each one is
  N+1 reads) and decide whether per-run `status` transitions should reach Linear at all.
- **anton-ey0w.2 (wrapper + `external_ref` guard):** the guard cannot delegate to `--update-refs`; it
  must be a pre-push refusal while any bead still holds a `gh-<n>` ref. The wrapper's ref reader must
  accept both the slugged and canonical URL forms, and the per-area routing pass must pass
  `--issues`/`--parent` or `linear.project_id` will silently suppress every create.
