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
  ANTON_METADATA_KEYS,
  BOARD_EVIDENCE_PENDING_PREFIX,
  beads,
  LABELS,
  REVIEW_SCORE_PREFIX,
  RUN_LEASE_PREFIX,
  STAGE_PREFIX,
  type Bead,
} from "../beads/bd";
import { PoisonEpic } from "./errors";
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

/** `b`'s custom metadata, minus anton's own bookkeeping keys ({@link ANTON_METADATA_KEYS}), as
 * stably-ordered `[key, value]` pairs — object key order is not guaranteed to survive a re-fetch,
 * and an unsorted array would read that as a change. `bd update --set-metadata k=v` (anton-fc5x
 * review round 6) is a supported board-only write with no other field it necessarily touches, so
 * a ticket whose sole deliverable is custom metadata must not fingerprint as unchanged. */
function contentMetadata(b: Bead): [string, unknown][] {
  return Object.entries(b.metadata ?? {})
    .filter(([k]) => !ANTON_METADATA_KEYS.includes(k))
    .toSorted(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0));
}

/** A point-in-time fingerprint of the whole board's CONTENT — status, title, description,
 * acceptance criteria, priority, every non-bookkeeping label, every non-bookkeeping metadata key,
 * parentage and dependency edges. Deliberately not assignee or notes, which anton itself rewrites
 * on a claim, a heartbeat lease refresh or a note, regardless of what the agent did. Parent and
 * dependencies are included (anton-fc5x review round 2) because a reparent or a `bd dep
 * add`/`bd supersede` — both canonical board-only deliverables per this module's own docstring —
 * touch only those edges, never status/title/description/labels, and would otherwise fingerprint
 * as no change at all. `acceptance_criteria` is included (anton-fc5x review round 3) for the same
 * reason: `bd update --acceptance` is a supported board-only write (bd-args.ts) that the list
 * projection exposes under this field (formula.integration.test.ts), and it touches neither status
 * nor description. `external_ref` is included (anton-fc5x review round 4) for the same reason
 * again: it is a real, persisted content field (`bd linear sync --push` / `beads.setExternalRef`),
 * not anton's own bookkeeping, so a board-only ticket whose sole deliverable is attaching or
 * changing a tracker reference must not fingerprint as unchanged. `issue_type` is included
 * (anton-fc5x review round 5) for the same reason once more: `bd update <id> --type task` is a
 * supported board-only repair (tiers.mjs) that retypes a bead without touching status, title,
 * description or labels, so leaving it out would fingerprint that repair as no change at all.
 * `metadata` (minus `ANTON_METADATA_KEYS`) is included (anton-fc5x review round 6) for the same
 * reason again: it is the field `bd update --set-metadata` writes to, and anton's own metadata
 * writes (the PR pointer, its retired counterpart, the board-evidence baseline) are excluded the
 * same way its own labels already are. */
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
    b.issue_type ?? "",
    contentLabels(b),
    beads.parentOf(b) ?? null,
    normalizedDependencies(b),
    b.external_ref ?? "",
    contentMetadata(b),
  ]);
}

/** Fingerprint every bead in a board read, keyed by id. */
export function fingerprintBoard(board: readonly Bead[]): BoardFingerprint {
  return { beads: new Map(board.map((b) => [b.id, fingerprintOf(b)])) };
}

/**
 * `board`, with every bead's description populated before it is fingerprinted (PR #284 review).
 * `mustReadBoard` goes through the same list read the rest of the app does, and on bd variants that
 * omit `description` from `bd list --json` that comes back `undefined` on every bead — which
 * `fingerprintOf` folds to `""` on BOTH the baseline and the post-run read alike. A board-only
 * ticket whose sole deliverable edits another bead's description would then fingerprint as
 * unchanged: `""` before, `""` after, no diff, on a board that genuinely changed.
 *
 * Deliberately NOT `ensureDescription` (issues.ts), which closes the same gap for a single detail
 * view by memoizing the `bd show` per bead — right there, wrong here. That memo is invalidated only
 * by a write THIS app makes through `bd.ts`, and the docstring atop this module explains why that
 * never happens for the writes this check exists to catch: the agent runs `bd` directly in its own
 * worktree process. Sharing that cache across the baseline and post-run reads would serve the
 * baseline's stale description right back on the post-run read, hiding exactly the description-only
 * edit this hydration exists to surface. A fresh, uncached `bd show` per read is the correct (if
 * costlier) fix; a failed show leaves that bead's description empty rather than failing the whole
 * board read, matching `ensureDescription`'s own missing-field fallback.
 */
function hydrateDescriptions(repo: string, board: readonly Bead[]): Promise<Bead[]> {
  return Promise.all(
    board.map(async (b) => {
      if (b.description !== undefined) return b;
      const full = await beads.show(repo, b.id).catch(() => undefined);
      return { ...b, description: full?.description ?? "" };
    }),
  );
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

/** `fingerprint`, as a JSON-safe value bd's metadata can carry — see {@link
 * beads.setBoardEvidenceBaseline}. This is the WHOLE board's content, not just this ticket's own
 * beads — see that constant's docstring for the size tradeoff this accepts and why. */
function serializeFingerprint(fingerprint: BoardFingerprint): Record<string, string> {
  return Object.fromEntries(fingerprint.beads);
}

/** The inverse of {@link serializeFingerprint}. */
function deserializeFingerprint(serialized: Record<string, string>): BoardFingerprint {
  return { beads: new Map(Object.entries(serialized)) };
}

/**
 * The pre-dispatch board read a board-only ticket's evidence check diffs against — taken once, as
 * early as `runTicket` can manage, so writes the agent makes anywhere on the board are inside the
 * window this compares. Best-effort like the git baseline it sits beside (`readTicketBaseline`): an
 * unreadable board (after {@link mustReadBoard}'s own retries) costs the evidence check, never the
 * run, and `assertDelivered` treats a missing baseline as "nothing to compare", which fails the same
 * closed way a genuine zero diff does.
 *
 * `ticket` (PR #284 review) lets a RESUMED attempt reuse a PRIOR attempt's preserved baseline
 * instead of taking a fresh one. A fresh read on every attempt is wrong the moment a post-run read
 * fails outright (see {@link readBoardEvidence}'s `!board` branch): this ticket's own writes can
 * still reach the remote through a sync pass that runs independently of this check (the heartbeat
 * backstop, a write-nudged push), so a resumed attempt's fresh baseline would already include them
 * — and an idempotent agent that correctly makes no further writes would then diff as no evidence
 * at all, forever. Reusing the preserved baseline instead keeps the comparison anchored to the
 * board as it stood before this ticket's FIRST attempt ever ran. Omitted (or carrying nothing
 * preserved), this takes a fresh read exactly as before.
 */
export async function readBoardBaseline(repo: string, ticket?: Bead): Promise<BoardFingerprint | null> {
  const preserved = ticket && beads.boardEvidenceBaseline(ticket);
  if (preserved) return deserializeFingerprint(preserved);
  const board = await mustReadBoard(repo);
  return board ? fingerprintBoard(await hydrateDescriptions(repo, board)) : null;
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
  /**
   * The pending-evidence marker write failed after every retry (PR #284 review round 5) — evidence
   * was found (and `synced` reports whether the push itself confirmed), but the durable record of it
   * could not be persisted to the board. Named separately so the caller stops here rather than
   * reading `found && synced` as a settled verdict: that marker is the ONLY record of `ids` once the
   * next attempt's baseline is taken fresh, so proceeding as if this attempt succeeded risks a crash
   * between here and this ticket's attribution/close permanently stranding a delivery that already
   * landed, with nothing left on the ticket to recover it from.
   */
  markerUnpersisted?: boolean;
  /**
   * The FIRST attempt's recovery baseline (see {@link readBoardEvidence}'s `!board` branch) could
   * not be made durable — persisted AND confirmed synced — before this attempt gave up (PR #284
   * review round 9). Always paired with `evidenceUnavailable: true`. Named separately because it is
   * a sharper warning than a merely unreadable post-run board: if this ticket resumes on ANOTHER
   * machine (the run-lease actor is machine-scoped, not run-scoped), that machine never sees this
   * preserved baseline either, so `readBoardBaseline` takes a FRESH read there too — one that may
   * already have absorbed this ticket's own writes through an independent sync pass — and an
   * idempotent retry that correctly makes no further writes then reads as no evidence at all,
   * permanently. Resuming on the SAME machine is still safe (the baseline sits in this process's
   * local Dolt state regardless of whether it pushed), so the operator note has to say which.
   */
  baselineUnconfirmed?: boolean;
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
 * A TOTAL read failure (`!board`) with NO prior pending ids (PR #284 review round 8) is the one
 * case `pending` cannot cover — a first attempt has nothing to fall back on. This ticket's own
 * writes can still reach the remote through a sync pass that runs independently of this check (the
 * heartbeat backstop, a write-nudged push), so leaving no trace here would let a resumed attempt's
 * `readBoardBaseline` take a FRESH baseline that already absorbed them — the same stranding the
 * pending marker exists to prevent, just one step earlier, and with no marker possible because no
 * diff was ever computed. So THIS attempt's baseline is preserved on the ticket
 * ({@link beads.setBoardEvidenceBaseline}) instead: a resumed attempt reuses it rather than reading
 * fresh, anchoring the eventual diff to the board as it stood before this ticket's first attempt
 * ever ran, however many read failures and external syncs land in between. Released by {@link
 * clearBoardEvidencePending} alongside the pending-ids marker, once the handoff those ids unblocked
 * actually completes.
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
 * The result then reports `markerUnpersisted: true` (PR #284 review round 5) rather than the found
 * evidence it still carries: an unset marker is exactly the state this attempt cannot safely build
 * on top of, so the caller stops here instead of treating found-and-synced as a settled verdict.
 *
 * The marker is written BEFORE the confirming push, not after (PR #284 review round 7). On a
 * non-server Dolt board, `beads.push` is what makes any LOCAL write visible to another machine — so
 * a push taken before the marker exists confirms only the content edits, never the marker itself. A
 * process or machine death in the gap between that push and the marker write would leave another
 * machine's next pull seeing the content edits (already synced) folded into its fresh baseline as
 * pre-existing state — nothing to diff — with no pending marker to say those ids belong to this
 * ticket's delivery: the exact stranding {@link clearBoardEvidencePending}'s docs warn about, just
 * one push earlier. Writing the marker first and pushing once after means the same push confirms
 * both together.
 */
export async function readBoardEvidence(
  repo: string,
  baseline: BoardFingerprint,
  ticket: Bead,
): Promise<BoardEvidenceResult> {
  const board = await mustReadBoard(repo);
  if (!board) {
    const pending = beads.pendingBoardEvidence(ticket);
    // No post-run read at all means `freshIds` can never be computed THIS attempt — the one case
    // `pending` alone (a PRIOR attempt's confirmed-but-unsynced ids) cannot cover, because a first
    // attempt has no prior marker to fall back on (PR #284 review). The baseline this attempt
    // already read is preserved instead, so a resumed attempt's `readBoardBaseline` reuses it
    // rather than taking a fresh one that may already have absorbed this ticket's writes through a
    // sync pass this check never confirmed (see that function's docstring). Skipped once a baseline
    // is already preserved, so a repeated read failure doesn't churn the write every attempt.
    if (!beads.boardEvidenceBaseline(ticket)) {
      // Persisted AND confirmed synced before this recovery baseline is trusted (PR #284 review
      // round 9) — a write that only landed locally, or landed but never confirmed reaching the
      // remote, does not help a resume on ANOTHER machine (the run-lease actor is machine-scoped,
      // not run-scoped): that machine's `readBoardBaseline` finds no preserved baseline either and
      // falls back to a fresh read that may already have absorbed this ticket's own — by-then synced
      // through some other channel — writes, permanently rejecting an idempotent retry as unchanged.
      // `baselineUnconfirmed` is reported (never silently folded into a plain `evidenceUnavailable`)
      // so the operator note can say precisely that resuming on THIS machine is safe but resuming
      // elsewhere is not.
      const persisted = await mustPersist(() =>
        beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(baseline)),
      );
      const synced = persisted
        ? await beads
            .push(repo)
            .then((outcome) => outcome === "synced" || outcome === "shared-server")
            .catch(() => false)
        : false;
      if (!persisted || !synced) {
        return {
          found: pending.length > 0,
          ids: pending,
          synced: false,
          evidenceUnavailable: true,
          baselineUnconfirmed: true,
        };
      }
    }
    return { found: pending.length > 0, ids: pending, synced: false, evidenceUnavailable: true };
  }
  const freshIds = boardEvidence(baseline, fingerprintBoard(await hydrateDescriptions(repo, board)));
  const pending = beads.pendingBoardEvidence(ticket);
  const ids = [...new Set([...pending, ...freshIds])].toSorted();
  if (ids.length === 0) return { found: false, ids: [], synced: false };
  const stale = beads.boardEvidencePendingLabels(ticket);
  if (stale.length !== 1 || stale[0] !== LABELS.boardEvidencePending(ids)) {
    const persisted = await mustPersist(() =>
      beads.setBoardEvidencePending(repo, ticket.id, ids, stale),
    );
    if (!persisted) {
      // The marker never made it onto the board at all, so there is nothing new for the push below
      // to cover — but the content edits still might be, and the caller's message distinguishes
      // `markerUnpersisted` from `!synced` regardless of this value, so it is still worth reporting.
      //
      // The baseline is preserved too, reusing the same recovery mechanism as the `!board` branch
      // above (PR #284 review): `freshIds` is real here — the board content already changed — but
      // with no marker AND no preserved baseline, a resumed attempt's `readBoardBaseline` takes a
      // FRESH read that already reflects this change, diffs it against itself, and finds nothing —
      // permanently losing this attempt's confirmed evidence even once the write channel recovers.
      // Guarded on nothing already preserved so a repeated retry doesn't churn the write every
      // attempt.
      const baselineAlreadyPreserved = Boolean(beads.boardEvidenceBaseline(ticket));
      const baselinePersisted =
        baselineAlreadyPreserved ||
        (await mustPersist(() =>
          beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(baseline)),
        ));
      const outcome = await beads.push(repo).catch(() => "not-wired" as const);
      const synced = outcome === "synced" || outcome === "shared-server";
      // Confirmed (persisted AND synced) exactly like the `!board` branch's recovery baseline (PR
      // #284 review round 10) — both marker and baseline are unrecoverable state once this attempt's
      // baseline is superseded, so a baseline write that landed only locally, or never landed at all,
      // is reported the same way that branch reports it: `baselineUnconfirmed`, not silently folded
      // into `markerUnpersisted`/`synced`, which describe the marker and content edits only.
      return {
        found: true,
        ids,
        synced,
        markerUnpersisted: true,
        ...(!baselinePersisted || !synced ? { baselineUnconfirmed: true } : {}),
      };
    }
  }
  // One push, after the marker (if any) is on the board, so it is the confirming sync for both the
  // content edits and the recovery marker together.
  const outcome = await beads.push(repo).catch(() => "not-wired" as const);
  const synced = outcome === "synced" || outcome === "shared-server";
  return { found: true, ids, synced };
}

/**
 * Release the pending marker once the handoff its evidence unblocked has actually completed —
 * the attribution commit (if any) landed and the bead settled (anton-fc5x review round 4). Deliberately
 * separate from {@link readBoardEvidence}, which only ever ADDS to the marker: only the ticket's own
 * success path, after `finishTicket` returns without throwing, knows the handoff truly finished.
 *
 * Retried through {@link mustPersist} rather than a bare `.catch(() => {})` (PR #284 review round 8):
 * a swallowed failure here is NOT harmless — it leaves the stale marker on an already-closed bead,
 * so a later reopen (a review send-back on this same board-only ticket) reads `pendingBoardEvidence`
 * as CURRENT evidence and can accept the reopened ticket as delivered on an agent that made no new
 * write at all. Retrying narrows that window; an exhausted retry still leaves the marker in place
 * exactly as before, logged like every other refused write here.
 *
 * The preserved baseline ({@link beads.setBoardEvidenceBaseline}), if any, is released in the same
 * call — its recovery job is done the moment the marker it backs is cleared, and leaving it behind
 * would anchor a future, unrelated reopening of this ticket to a board snapshot from long before it.
 *
 * Both writes must land or this throws {@link PoisonEpic} (PR #284 review round 9) — resolving
 * quietly on a partial or total failure is NOT harmless (see the retry note above): a surviving
 * pending marker lets a later reopen read stale evidence as current and accept it with no new work,
 * and a surviving baseline anchors a future, unrelated reopening of this ticket to a stale snapshot.
 * Both are false-success risks this run must not carry forward silently, so it halts for a human
 * instead. The caller (`runTicket`) invokes this only AFTER the ticket has already closed/transitioned
 * successfully, outside the try/catch that reclassifies a ticket as failed — this poison is about the
 * cleanup write, not this ticket's own (already-settled) delivery, and must not reopen or reblock it.
 *
 * Confirmed synced too, not just persisted (PR #284 review): on a non-server Dolt board these writes
 * only clear LOCAL state, and unlike marker creation in {@link readBoardEvidence} nothing previously
 * confirmed the cleanup itself reached the remote. A process death (or a failed best-effort final
 * `beads.sync`) between a local-only clear and the next push would leave another machine's pull still
 * seeing the stale marker and preserved baseline after this ticket has already closed — and a later
 * reopen there could read them as current evidence and accept a no-op run as delivered. So the push
 * is part of the same all-or-nothing gate as the two writes: unconfirmed sync throws {@link
 * PoisonEpic} exactly like an unpersisted write, rather than returning as if the cleanup were done.
 *
 * `hasBaseline` (PR #284 review) covers the PARTIAL-failure resume case a plain `ids.length === 0`
 * guard would otherwise skip entirely: a prior call can clear the marker but exhaust its retries on
 * the baseline, throwing `PoisonEpic` with the marker already gone. A resumed retry that only checks
 * `pendingBoardEvidence` then sees nothing pending and never calls this again — this ticket's own
 * cleanup path is done — leaving the preserved baseline stranded on an already-closed bead for a
 * later, unrelated reopen to misread as a stale-but-current snapshot. Callers pass whichever of the
 * two survivors still needs clearing; either alone is enough to avoid the no-op early return.
 */
export async function clearBoardEvidencePending(
  repo: string,
  ticketId: string,
  ids: readonly string[],
  hasBaseline = false,
): Promise<void> {
  if (ids.length === 0 && !hasBaseline) return;
  const markerCleared =
    ids.length === 0
      ? true
      : await mustPersist(() =>
          beads.setBoardEvidencePending(repo, ticketId, [], [LABELS.boardEvidencePending(ids)]),
        );
  const baselineCleared = await mustPersist(() => beads.clearBoardEvidenceBaseline(repo, ticketId));
  const cleared = markerCleared && baselineCleared;
  const synced = cleared
    ? await beads
        .push(repo)
        .then((outcome) => outcome === "synced" || outcome === "shared-server")
        .catch(() => false)
    : false;
  if (!cleared || !synced) {
    const detail = cleared
      ? "both cleanup writes landed locally, but the confirming push could not verify they reached " +
        "the remote"
      : `bd would not clear ${[
          !markerCleared && "the pending-evidence marker",
          !baselineCleared && "the preserved baseline",
        ]
          .filter((s): s is string => s !== false)
          .join(" and ")} it left on the board (after retries)`;
    throw new PoisonEpic(
      `${ticketId} delivered and closed, but ${detail} — the run stopped rather than leave a stale ` +
        `board-evidence record on an already-closed ticket, which a later reopen could read as ` +
        `current evidence for no new work. Check the beads DB${cleared ? " and the sync channel" : ""}, ` +
        `then resume the run.`,
    );
  }
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
