/**
 * The board-only delivery-evidence check (anton-fc5x): what a run target marked `delivery:board`
 * ({@link import("../beads/bd").LABELS.boardOnly}) settles a zero-diff commit on, instead of the git
 * branch `assertDelivered` reads for every other ticket.
 *
 * A board-only ticket carries no git diff by design — its product is the Dolt DB, which
 * `.beads/.gitignore` deliberately keeps out of the tree (`refs/dolt/data` is the sync channel, not
 * the tree — see CLAUDE.md). Reading that clean tree as "nothing delivered" is the exact false
 * success issue #46 exists to catch, so a board-only bead needs a DIFFERENT, equally objective
 * source of evidence: the board itself, read fresh before the agent starts and again after it
 * finishes, diffed on the fields anton's own bookkeeping never touches.
 *
 * Confirmed evidence here still leaves the BRANCH untouched, and the run's `step:pr` needs at least
 * one commit ahead of base or `gh pr create` fails on an empty diff (anton-fc5x review round 3). That
 * gap is closed one layer up, in `assertDelivered` (execute-epic-ticket.ts): once this module
 * confirms `found && synced`, it records an empty attribution commit via
 * {@link import("./steps/git").recordBoardOnlyAttribution} before settling the ticket delivered — so
 * this module only ever answers "did the board change", never touches git itself.
 *

 * The agent runs `bd` directly in its own worktree process, never through this app's `bd.ts`
 * wrapper — so the in-process issue snapshot (snapshot.ts) never sees the agent's writes land and
 * cannot be trusted for either read here. Both reads below go through {@link mustReadBoard} (never a
 * bare `bd list --status all` — see its own docstring), which bypasses that cache and retries a
 * contended Dolt read instead of failing the evidence check on one round trip.
 *
 * KNOWN GAP (anton-fc5x review round 1, finding 2): the diff below is of the WHOLE board, not of
 * writes this ticket's agent can be shown to have made. A concurrent write from anything else with
 * access to the same board — a sibling run on another machine (or the same one, since the run-lease
 * actor is machine-scoped, not run-scoped — see operator.ts), a gardener apply pass, a product-master
 * proposal filing — lands inside the same window and reads as this ticket's evidence, ESPECIALLY on
 * a shared Dolt server (`dolt_mode: server`), where every writer shares one live view with no pull to
 * even delay it. This was not left unexamined: `bd` was checked directly (bd 1.1.2) for a way to
 * attribute an EDIT to the actor that made it, since that would let this module filter the diff down
 * to this ticket's own writes. It does not currently offer one — `bd history <id> --json`'s
 * `Committer` field is the underlying Dolt/OS committer identity, constant across writes regardless
 * of `--actor`/`BEADS_ACTOR`, and `created_by` is stamped only at creation, never updated on an edit.
 * So an edited (as opposed to newly created) bead carries no per-write actor this module can read
 * back. Closing this for real needs either an upstream `bd` capability (an `updated_by`-style field)
 * or a different anton-side design (e.g. a per-run marker the ticket's own writes are made to carry),
 * neither of which fits inside this finding's fix. Until then this check is accepted as best-effort
 * corroboration, not proof: it can be fooled by board activity outside this ticket, but it can still
 * never be fooled by the agent's OWN unsubstantiated self-report, which is the false-success shape
 * anton-j5i8 exists to catch and the reason this check exists at all.
 */
import {
  BOARD_EVIDENCE_PENDING_PREFIX,
  beads,
  LABELS,
  REVIEW_SCORE_PREFIX,
  RUN_LEASE_PREFIX,
  STAGE_PREFIX,
  type Bead,
} from "../beads/bd";
import { mustPersist, mustReadBoard } from "./execute-epic-persist";

/**
 * Label prefixes anton itself rewrites on a claim, a heartbeat lease refresh or a review round,
 * regardless of what the agent did — comparing these would read anton's own bookkeeping, on this
 * ticket or any other running concurrently, as the ticket's delivery. Every OTHER label (`size:`,
 * `domain:`, `agent:`, `source:`, a gardener/pm fingerprint, …) is real content a board-only ticket
 * may exist to write — e.g. a batch relabel or reparent — and must be fingerprinted like any other
 * field (anton-fc5x review round 1). `board-evidence-pending:*` (anton-fc5x follow-up) belongs here
 * too — it is this very check's own cross-retry marker (see {@link readBoardEvidence}), so diffing
 * it would have the marker fingerprint as the ticket's own evidence the moment it is written.
 */
const BOOKKEEPING_LABEL_PREFIXES = [
  RUN_LEASE_PREFIX,
  STAGE_PREFIX,
  REVIEW_SCORE_PREFIX,
  BOARD_EVIDENCE_PENDING_PREFIX,
];

/** `b`'s labels, minus anton's own bookkeeping prefixes, in a stable order so re-fetching the same
 * content twice (labels can come back in a different order) never reads as a change. */
function contentLabels(b: Bead): string[] {
  return (b.labels ?? [])
    .filter((l) => !BOOKKEEPING_LABEL_PREFIXES.some((prefix) => l.startsWith(prefix)))
    .toSorted();
}

/** A point-in-time fingerprint of the whole board's CONTENT — status, title, description,
 * acceptance criteria, priority, every non-bookkeeping label, parentage and dependency edges.
 * Deliberately not assignee, notes or metadata, which anton itself rewrites on a claim, a heartbeat
 * lease refresh or a note, regardless of what the agent did. Parent and dependencies are included
 * (anton-fc5x review round 2) because a reparent or a `bd dep add`/`bd supersede` — both canonical
 * board-only deliverables per this module's own docstring — touch only those edges, never
 * status/title/description/labels, and would otherwise fingerprint as no change at all.
 * `acceptance_criteria` is included (anton-fc5x review round 3) for the same reason: `bd update
 * --acceptance` is a supported board-only write (bd-args.ts) that the list projection exposes under
 * this field (formula.integration.test.ts), and it touches neither status nor description.
 * `external_ref` is included (anton-fc5x review round 4) for the same reason again: it is a real,
 * persisted content field (`bd linear sync --push` / `beads.setExternalRef`), not anton's own
 * bookkeeping, so a board-only ticket whose sole deliverable is attaching or changing a tracker
 * reference must not fingerprint as unchanged. */
export interface BoardFingerprint {
  readonly beads: ReadonlyMap<string, string>;
}

/** `b`'s dependency edges as a stable, order-independent view — `bd list --json` does not
 * guarantee edge order, so re-fetching identical content twice must not read as a change. */
function normalizedDependencies(b: Bead): string[] {
  return (b.dependencies ?? []).map((d) => `${d.type}:${d.depends_on_id}`).toSorted();
}

function fingerprintOf(b: Bead): string {
  return JSON.stringify([
    b.status,
    b.title,
    b.description ?? "",
    b.acceptance_criteria ?? "",
    b.priority ?? null,
    contentLabels(b),
    beads.parentOf(b) ?? null,
    normalizedDependencies(b),
    b.external_ref ?? "",
  ]);
}

/** Fingerprint every bead in a board read, keyed by id. */
export function fingerprintBoard(board: readonly Bead[]): BoardFingerprint {
  return { beads: new Map(board.map((b) => [b.id, fingerprintOf(b)])) };
}

/**
 * Every bead id whose CONTENT differs between two fingerprints — created, edited or deleted.
 * Pure, so the diff rule is unit-testable without a board read on either side.
 */
export function boardEvidence(before: BoardFingerprint, after: BoardFingerprint): string[] {
  const changed: string[] = [];
  for (const [id, hash] of before.beads) {
    if (after.beads.get(id) !== hash) changed.push(id);
  }
  for (const id of after.beads.keys()) {
    if (!before.beads.has(id)) changed.push(id);
  }
  return changed;
}

/**
 * The pre-dispatch board read a board-only ticket's evidence check diffs against — taken once, as
 * early as `runTicket` can manage, so writes the agent makes anywhere on the board are inside the
 * window this compares. Best-effort like the git baseline it sits beside (`readTicketBaseline`): an
 * unreadable board (after {@link mustReadBoard}'s own retries) costs the evidence check, never the
 * run, and `assertDelivered` treats a missing baseline as "nothing to compare", which fails the same
 * closed way a genuine zero diff does.
 */
export async function readBoardBaseline(repo: string): Promise<BoardFingerprint | null> {
  const board = await mustReadBoard(repo);
  return board ? fingerprintBoard(board) : null;
}

/** What the post-run board read found, relative to the baseline. */
export interface BoardEvidenceResult {
  /** At least one bead's content differs from the baseline. */
  found: boolean;
  /** The changed bead ids, for the operator note — empty when `found` is false. */
  ids: string[];
  /** Whether the sync pass confirmed those writes reached the remote (or, on a shared Dolt server,
   * that propagation is inherent) — meaningless when `found` is false. */
  synced: boolean;
  /** The pre-dispatch board baseline could not be read (anton-fc5x review round 4) — a board-only
   * ticket's classification came from the ticket/run-target label alone, so this is not "no board
   * evidence", it is "no comparison could be made at all". Named separately so the operator note
   * says which. */
  baselineUnavailable?: boolean;
  /** The POST-run board read could not be read (after retries) — the symmetric case to {@link
   * baselineUnavailable} for the other end of the comparison (PR #284 review). Named separately so
   * `boardOnlyNoDeliveryMessage` can say "the board read failed, no comparison could be made" rather
   * than fold this into `!found`'s "nothing differs", which is only true when the read actually
   * happened. `ids`/`found` still carry whatever a PRIOR attempt already confirmed and left pending
   * (see {@link readBoardEvidence}) — this attempt simply could not add to or confirm them. */
  evidenceUnavailable?: boolean;
}

/**
 * Read the board fresh, diff it against the baseline, and — only once real evidence is found —
 * confirm it is synced. The push is skipped on a diff with nothing in it: an idle board-only ticket
 * that changed nothing has no writes to confirm, and a bare sync pass proves nothing about THIS
 * ticket's delivery even when it succeeds.
 *
 * The board read goes through {@link mustReadBoard} rather than a bare `beads.list`, and a read that
 * fails all its retries reads as `evidenceUnavailable: true` — never a plain `!found`, which would
 * assert "nothing differs" when in fact no comparison was made at all (anton-fc5x review round 4/PR
 * #284 follow-up) — instead of throwing a plain `Error` out of `assertDelivered`. Thrown here it
 * would skip the board-only `NoDeliveryError`/`keepOpen` path entirely and fall to generic release
 * handling (anton-fc5x review round 1). Whatever a PRIOR attempt already left pending on the ticket
 * is still surfaced (never dropped) so a resumed ticket that already confirmed evidence keeps that
 * fact even when THIS attempt's read fails. A push that throws (a real auth/network/remote-conflict
 * failure, per `runDoltSync`'s contract) is read as unsynced rather than propagated for the same
 * reason: the caller's gate must fail closed on "found, but unconfirmed" exactly as it does on "not
 * found", never crash the ticket walk over the sync probe.
 *
 * An unsynced write is not the end of the story (anton-fc5x follow-up): `ticket` — read fresh at
 * this attempt's claim, so it carries whatever a PRIOR attempt persisted — may already hold
 * `board-evidence-pending:*` ids a previous call left behind when it found writes but could not
 * confirm the push. Those are unioned into THIS attempt's diff rather than replaced by it, because
 * `readBoardBaseline` takes a fresh board read every attempt: a resumed ticket whose agent makes no
 * further writes (correctly — the prior attempt's writes already landed) would otherwise diff an
 * unchanged board against itself and report no evidence at all, even once the sync channel
 * recovers.
 *
 * The marker is written whenever evidence is found, synced or not (anton-fc5x review round 4) — it
 * is NOT cleared here just because the push confirmed synced. A confirmed sync is not the end of
 * this ticket's handoff: the caller still has to record the attribution commit and close the bead,
 * and either can fail after this point. Clearing the marker on "synced" alone would lose the only
 * record of this evidence if the process dies (or one of those later steps fails) before settlement
 * actually completes — a resumed attempt's fresh baseline would then silently absorb the change as
 * "no evidence" and reject a delivery that already landed. The caller clears the marker explicitly,
 * via {@link clearBoardEvidencePending}, only once the whole handoff has gone through. The write here
 * is skipped when the marker already holds exactly this id set, so a retry that finds nothing new
 * doesn't churn the label on every attempt.
 *
 * That write goes through {@link mustPersist}, not a bare `.catch(() => {})` (PR #284 review round
 * 4/follow-up): this marker is the ONLY record of `freshIds` once the next attempt's baseline is
 * taken fresh (it will include whatever this attempt's writes already landed), so a single contended
 * Dolt write that silently failed would strand a genuinely-delivered ticket — the settle-time sync
 * later publishes the edits, a resumed attempt's fresh baseline absorbs them as "no change", finds no
 * pending marker either, and permanently rejects a delivery that already shipped. Retrying (and
 * logging every refusal) narrows that window without pretending a write bd keeps refusing is
 * recoverable — an exhausted retry still leaves the marker unset, exactly as it would have before.
 */
export async function readBoardEvidence(
  repo: string,
  baseline: BoardFingerprint,
  ticket: Bead,
): Promise<BoardEvidenceResult> {
  const board = await mustReadBoard(repo);
  if (!board) {
    const pending = beads.pendingBoardEvidence(ticket);
    return { found: pending.length > 0, ids: pending, synced: false, evidenceUnavailable: true };
  }
  const freshIds = boardEvidence(baseline, fingerprintBoard(board));
  const pending = beads.pendingBoardEvidence(ticket);
  const ids = [...new Set([...pending, ...freshIds])].toSorted();
  if (ids.length === 0) return { found: false, ids: [], synced: false };
  const outcome = await beads.push(repo).catch(() => "not-wired" as const);
  const synced = outcome === "synced" || outcome === "shared-server";
  const stale = beads.boardEvidencePendingLabels(ticket);
  if (stale.length !== 1 || stale[0] !== LABELS.boardEvidencePending(ids)) {
    await mustPersist(() => beads.setBoardEvidencePending(repo, ticket.id, ids, stale));
  }
  return { found: true, ids, synced };
}

/**
 * Release the pending marker once the handoff its evidence unblocked has actually completed —
 * the attribution commit (if any) landed and the bead settled (anton-fc5x review round 4). Deliberately
 * separate from {@link readBoardEvidence}, which only ever ADDS to the marker: only the ticket's own
 * success path, after `finishTicket` returns without throwing, knows the handoff truly finished.
 * Best-effort like every other write here — a failed clear costs a harmless extra comparison on the
 * next board-only ticket that touches this bead, never a false verdict.
 */
export async function clearBoardEvidencePending(
  repo: string,
  ticketId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await beads
    .setBoardEvidencePending(repo, ticketId, [], [LABELS.boardEvidencePending(ids)])
    .catch(() => {});
}

/**
 * Whether THIS TICKET's delivery is board-only (anton-fc5x review round 2) — checking the ticket
 * alone misses the documented shape: `skills/bd/SKILL.md` has shapers put `delivery:board` "on a run
 * target," and for a legacy `epic` with plain `task` children (or a `feature` with `task`/`subtask`
 * children) the run TARGET is the epic/feature, never the dispatched child `runTicket` calls this
 * for. Checked on both so a label placed on either settles the same way — the target's alone
 * (inherited by every child), or a ticket's own (e.g. a standalone target, which IS its run's
 * target).
 */
export function isBoardOnlyRun(run: { readonly target: Bead }, ticket: Bead): boolean {
  return beads.isBoardOnly(ticket) || beads.isBoardOnly(run.target);
}
