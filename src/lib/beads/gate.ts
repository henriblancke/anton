/**
 * The gate seam (anton-uk95): the types, argv builders, parsers and the ONE invoker every gate call
 * goes through. Lifted out of ./bd (anton-lsad) so the cwd invariant below is reviewable on its
 * own; ./bd composes these into `beads.gate*` and re-exports the public surface.
 */
import { githubRepoSlug } from "../git/remote";
import { parseJsonTail } from "./bd-json";
import { bd } from "./dolt-exec";
import { invalidateIssueSnapshot } from "./snapshot";
import type { Bead } from "./types";

// ── gate seam (anton-uk95) ──
//
// A gate is a real bead (`issue_type: gate`) that blocks its step with an ordinary `blocks` edge, so
// an async wait is board-visible state and costs nothing while it waits. `bd gate check` evaluates
// open timer/GitHub gates and closes the satisfied ones.
//
// THE INVARIANT EVERY CALL HERE EXISTS TO HOLD: bd is spawned with `cwd` = the project repo, and
// NEVER with `-C`. `bd -C <dir>` changes only which DATABASE bd reads — it does not change the
// process cwd — while the `gh` subprocess bd spawns to evaluate a `gh:run` / `gh:pr` gate resolves
// its repository from that cwd. So `-C` yields a verdict from whatever repo the caller happened to
// start in, in BOTH directions: a green CI run in project A resolves project B's gate (a false
// green), and a failed run in A escalates B's (a false escalation). Proven on bd 1.1.0 and 1.1.2 in
// .product/decisions/2026-07-28-bd-workflow-primitives.md §5; locked in by gate-cwd.integration.test.ts.
// `bd gate discover` draws its candidate runs from the same cwd, so the rule covers it too.

/** Gate flavours `bd gate create --type` accepts. `bead` is deliberately absent — unresolvable here. */
export type GateType = "human" | "timer" | "gh:run" | "gh:pr";

/** What `bd gate check --type` may be scoped to: one gate type, `gh` (both GitHub types), or all. */
export type GateCheckScope = GateType | "gh" | "bead" | "all";

/** A gate bead, as `bd gate list --json` returns it. */
export interface Gate extends Bead {
  /** The gate's flavour (bd's `await_type`). */
  await_type?: GateType;
  /** The condition identifier — a workflow run id for `gh:run`, a PR number for `gh:pr`. */
  await_id?: string;
  /**
   * Timeout in NANOSECONDS — bd serialises a Go `time.Duration` as an integer, so `--timeout=2h`
   * reads back as 7.2e12. Absent when the gate has no deadline (bd's default: wait forever).
   * {@link gateDeadline} is the only place that converts it.
   */
  timeout?: number;
}

/**
 * The `--reason` a gate was created with, read back off the gate bead. bd keeps no reason field: it
 * folds the reason into the description it composes — `Ad-hoc gate blocking <bead>\n\nReason:
 * <reason>` (measured on bd 1.1.2), verbatim and untruncated — so this is the only way to ask what a
 * gate is waiting FOR. Undefined when the gate carries no reason.
 */
export function gateReason(gate: Bead): string | undefined {
  const marker = "\nReason: ";
  const at = (gate.description ?? "").indexOf(marker);
  return at === -1 ? undefined : gate.description!.slice(at + marker.length);
}

export interface GateCreateOpts {
  /** Bead the gate blocks (required by bd). */
  blocks: string;
  /** Defaults to bd's own default, `human`. */
  type?: GateType;
  /** Workflow run id (`gh:run`) or PR number (`gh:pr`). Omit for a gate `gate discover` will fill. */
  awaitId?: string;
  /** Timer gates only, e.g. `2h`. */
  timeout?: string;
  reason?: string;
}

export interface GateCheckOpts {
  scope?: GateCheckScope;
  /** Report the verdicts without closing anything. */
  dryRun?: boolean;
  /** Also run bd's escalation for failed/expired gates. Escalation does NOT close the gate. */
  escalate?: boolean;
}

export interface GateDiscoverOpts {
  dryRun?: boolean;
  /** Branch whose runs are candidates; bd defaults to the cwd repo's current branch. */
  branch?: string;
  /** Max runs to query from GitHub. */
  limit?: number;
  /** Max age for gate/run matching, e.g. `30m`. */
  maxAge?: string;
}

/**
 * What one `bd gate check` pass did. `errors` is the field that must never be ignored: a gate bd
 * could not evaluate (no `gh`, an API failure) is UNKNOWN — not resolved and not unresolved — so a
 * caller must treat `errors > 0` the way execute-epic treats an unreadable PR state: retry with a
 * counting error rather than reading `resolved: 0` as "still waiting".
 */
export interface GateCheckResult {
  checked: number;
  resolved: number;
  escalated: number;
  errors: number;
  dryRun: boolean;
}

/** One entry of `bd ready --gated` — a molecule whose gate closed, with the step now runnable. */
export interface GatedMolecule {
  molecule_id: string;
  molecule_title?: string;
  closed_gate?: Gate;
  ready_step?: Bead;
}

/** Pure argv builder for `bd gate create`, exposed for testing (like buildUpdateArgs). */
export function buildGateCreateArgs(opts: GateCreateOpts): string[] {
  if (!opts.blocks) throw new Error("bd gate create requires the id of the bead the gate blocks");
  const args = ["gate", "create", "--blocks", opts.blocks];
  if (opts.type) args.push("--type", opts.type);
  if (opts.awaitId) args.push("--await-id", opts.awaitId);
  if (opts.timeout) args.push("--timeout", opts.timeout);
  if (opts.reason) args.push("--reason", opts.reason);
  args.push("--json"); // plain output appends dispatch hints (for `bd sling`, which doesn't exist)
  return args;
}

/** Pure argv builder for `bd gate check`, exposed for testing. */
export function buildGateCheckArgs(opts: GateCheckOpts = {}): string[] {
  const args = ["gate", "check"];
  if (opts.scope) args.push("--type", opts.scope);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.escalate) args.push("--escalate");
  args.push("--json");
  return args;
}

/** Pure argv builder for `bd gate discover`, exposed for testing. */
export function buildGateDiscoverArgs(opts: GateDiscoverOpts = {}): string[] {
  const args = ["gate", "discover"];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.branch) args.push("--branch", opts.branch);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.maxAge) args.push("--max-age", opts.maxAge);
  return args;
}

/**
 * Read a `bd gate check` summary, or THROW. The throw is the point: a check whose result can't be
 * read is the unknown state, and returning zeros would render it as "nothing satisfied yet" — a
 * wait that never ends on a bd whose output format moved. Fail loud instead.
 */
export function parseGateCheck(raw: string): GateCheckResult {
  const s = parseJsonTail(raw) as Record<string, unknown> | undefined;
  if (!s || typeof s.checked !== "number") {
    throw new Error(
      `bd gate check: could not read its --json summary (bd output format changed?) — refusing to ` +
        `report an unreadable check as "no gates resolved". Output: ${raw.slice(0, 200)}`,
    );
  }
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    checked: s.checked,
    resolved: n(s.resolved),
    escalated: n(s.escalated),
    errors: n(s.errors),
    dryRun: s.dry_run === true,
  };
}

/**
 * The ONE invoker every gate call goes through. It exists so the cwd invariant cannot be forgotten
 * at a call site: `repo` is bd's spawn cwd (empty is a loud failure, never the server's own cwd),
 * and `GH_REPO` is set alongside it — belt and braces for the case a future call site can't control
 * cwd, since GH_REPO overrides gh's repo resolution outright. A non-github.com origin (or no remote)
 * yields no slug, and then GH_REPO is explicitly UNSET rather than left inherited: a server launched
 * with GH_REPO in its own environment would otherwise have every gate here evaluated against that
 * other repository. No slug means cwd alone governs. Never pass `-C` in `args`.
 */
export async function bdGate(repo: string, args: string[]): Promise<string> {
  if (!repo) throw new Error(`bd ${args.join(" ")}: a gate call requires the project repo as cwd`);
  const slug = await githubRepoSlug(repo).catch(() => undefined);
  return bd(repo, args, { env: { GH_REPO: slug } });
}

/** {@link bdGate} for the calls that mutate gates — invalidates the board snapshot like bdWrite. */
export async function bdGateWrite(repo: string, args: string[]): Promise<string> {
  const stdout = await bdGate(repo, args);
  invalidateIssueSnapshot(repo, true);
  return stdout;
}
