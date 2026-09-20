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
import { createHash } from "node:crypto";
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
import { mustPersist, mustRead, mustReadBoard } from "./execute-epic-persist";

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

/**
 * Exact-match labels anton rewrites the same way the prefixes above do, on ANY bead on the board —
 * not just the one currently dispatched — but that aren't prefix-shaped so the filter above never
 * catches them (PR #284 review). `LABELS.notDelivered` ("not-delivered") is cleared on every claim
 * ({@link import("./execute-epic-ticket-bookends")}) and set on nearly every timeout/no-delivery/
 * retirement path (execute-epic-ticket-settle.ts, execute-epic-dispatch.ts) — routine dispatch
 * traffic on an UNRELATED ticket flips it while this ticket's own evidence window is open, which
 * would otherwise fingerprint as this ticket's delivery.
 */
const BOOKKEEPING_LABELS: readonly string[] = [LABELS.notDelivered];

/** `b`'s labels, minus anton's own bookkeeping prefixes and exact labels, in a stable order so
 * re-fetching the same content twice (labels can come back in a different order) never reads as a
 * change. */
function contentLabels(b: Bead): string[] {
  return (b.labels ?? [])
    .filter((l) => !BOOKKEEPING_LABEL_PREFIXES.some((prefix) => l.startsWith(prefix)))
    .filter((l) => !BOOKKEEPING_LABELS.includes(l))
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
 * acceptance criteria, design, priority, every non-bookkeeping label, every non-bookkeeping
 * metadata key, parentage, dependency edges, and (on every bead except the one this run is
 * dispatching) assignee.
 * Notes stay excluded on every bead — anton's heartbeat appends to them regardless of what the agent
 * did, and no supported board-only write uses notes as its sole deliverable. Parent and
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
 * `design` is included (chatgpt-codex-connector, PR #284 review, "Include the design field in
 * board fingerprints") for the same reason once more: `bd update <id> --design` is a supported
 * board-only write (`.beads/PRIME.md:125-126`) that this module's own contract-field list
 * (`CONTRACT_FIELDS` in gardener/repair-already-shipped.ts) already treats as real ticket content
 * alongside description/acceptance/context — unlike notes, it is not anton's own bookkeeping, so a
 * board-only ticket whose sole deliverable is `bd update <id> --design ...` must not fingerprint
 * as unchanged. `metadata` (minus `ANTON_METADATA_KEYS`) is included (anton-fc5x review round 6)
 * for the same reason again: it is the field `bd update --set-metadata` writes to, and anton's own
 * metadata writes (the PR pointer, its retired counterpart, the board-evidence baseline) are excluded the
 * same way its own labels already are. Assignee is included on every OTHER bead too (anton-fc5x
 * follow-up review) for the same reason once more: reserving or reassigning another bead via `bd
 * assign`/`beads.assign` is a supported board-only deliverable (skills/bd/SKILL.md) that touches no
 * other field — `bd assign` deliberately leaves status untouched — so excluding assignee everywhere
 * would fingerprint that delivery as no change at all. Only the CURRENTLY DISPATCHED ticket's own
 * assignee stays excluded, because anton itself rewrites it on a claim or a heartbeat lease refresh
 * regardless of what the agent did — that exclusion is what `dispatchedTicketId` below narrows to. */
export interface BoardFingerprint {
  readonly beads: ReadonlyMap<string, string>;
}

/** `b`'s dependency edges as a stable, order-independent view — `bd list --json` does not
 * guarantee edge order, so re-fetching identical content twice must not read as a change. */
function normalizedDependencies(b: Bead): string[] {
  return (b.dependencies ?? []).map((d) => `${d.type}:${d.depends_on_id}`).toSorted();
}

/** `dispatchedTicketId`, so this ticket's own claim/heartbeat-rewritten assignee never fingerprints
 * as its own evidence, while every OTHER bead's assignee — where a board-only reassignment would
 * actually land — does. */
function fingerprintOf(b: Bead, dispatchedTicketId: string): string {
  const content = JSON.stringify([
    b.status,
    b.title,
    b.description ?? "",
    b.acceptance_criteria ?? "",
    b.design ?? "",
    b.priority ?? null,
    b.issue_type ?? "",
    contentLabels(b),
    beads.parentOf(b) ?? null,
    normalizedDependencies(b),
    b.external_ref ?? "",
    contentMetadata(b),
    b.id === dispatchedTicketId ? "" : (b.assignee ?? ""),
  ]);
  // Hashed, not stored raw (PR #284 review round 16): the baseline this fingerprints into
  // (setBoardEvidenceBaseline) holds one entry per bead on the WHOLE board, so its serialized size
  // is proportional to board size regardless of how it is persisted. A fixed-size digest bounds
  // each bead's contribution regardless of description length while still changing whenever the
  // content does — `setBoardEvidenceBaseline` itself writes through a bounded file, not an argv
  // argument (chatgpt-codex-connector, PR #284 review, "Bound the complete baseline metadata
  // argument"), so this hashing is what keeps that file's own size from scaling with description
  // length rather than with bead count.
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Fingerprint every bead in a board read, keyed by id. `dispatchedTicketId` (default none, i.e. no
 * exclusion) names the ticket this run is currently dispatching, so its own assignee — rewritten by
 * anton's claim/heartbeat regardless of what the agent did — never fingerprints as this ticket's own
 * evidence, while every other bead's assignee does. */
export function fingerprintBoard(board: readonly Bead[], dispatchedTicketId = ""): BoardFingerprint {
  return { beads: new Map(board.map((b) => [b.id, fingerprintOf(b, dispatchedTicketId)])) };
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
 * costlier) fix.
 *
 * Returns `undefined` if ANY bead's description could not be hydrated after {@link mustRead}'s own
 * retries (PR #284 review round 11) — a single transient `bd show` failure used to fold to `""`
 * unconditionally, and a real (non-empty) description on the other side of the baseline/post-run
 * comparison would then diff against that synthetic empty value as if the bead had changed, crediting
 * a board-only agent with evidence it never produced. The caller folds this the same way it already
 * folds a failed {@link mustReadBoard}: an unreadable comparison, never a fabricated one.
 *
 * Reads are bounded at {@link DESCRIPTION_HYDRATION_CONCURRENCY} in flight, not fired as one
 * unbounded `Promise.all` (PR #284 review round 12): each needing hydration is a `bd show`
 * SUBPROCESS with its own {@link mustRead} retries, and a board that omits descriptions from `bd
 * list --json` needs one per bead. A board of hundreds or thousands would launch that many processes
 * simultaneously, and a failed spawn/read then retries in the same synchronized herd — exhausting
 * file descriptors/process slots or contending the Dolt database and making both this read and the
 * one on the other side of the comparison consistently unavailable, blocking every board-only ticket
 * even though the board itself is healthy. Beads that already carry a description (the common case)
 * cost nothing — only the ones needing a `bd show` occupy a slot.
 */
const DESCRIPTION_HYDRATION_CONCURRENCY = 4;

export async function hydrateDescriptions(repo: string, board: readonly Bead[]): Promise<Bead[] | undefined> {
  const hydrated: (Bead | undefined)[] = [];
  for (let i = 0; i < board.length; i += DESCRIPTION_HYDRATION_CONCURRENCY) {
    const batch = await Promise.all(
      board.slice(i, i + DESCRIPTION_HYDRATION_CONCURRENCY).map(async (b) => {
        if (b.description !== undefined) return b;
        const full = await mustRead(repo, b.id);
        return full && { ...b, description: full.description ?? "" };
      }),
    );
    hydrated.push(...batch);
  }
  return hydrated.every((b): b is Bead => Boolean(b)) ? hydrated : undefined;
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
 * fails outright, or whose description hydration cannot be trusted (see {@link readBoardEvidence}'s
 * `!hydrated` branch): this ticket's own writes can
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
  const hydrated = board && (await hydrateDescriptions(repo, board));
  return hydrated ? fingerprintBoard(hydrated, ticket?.id) : null;
}

/**
 * Durably persist `baseline` onto `ticket` BEFORE the agent is ever dispatched (PR #284 review,
 * "Persist the board baseline before dispatch") — closes the crash window `readBoardBaseline` alone
 * leaves open. On a shared-server board the agent's `bd -C <repo>` writes are globally visible the
 * instant they land, but between `runTicket` computing `boardBaseline` and `readBoardEvidence` first
 * persisting a pending marker, that baseline lived only in this process's memory. A process/host death
 * inside that window — after the agent wrote, before this ticket ever reached the evidence check —
 * left a resumed attempt with nothing preserved to reuse: `readBoardBaseline` would take a FRESH read
 * that already absorbed the delivered state, and an idempotent retry then diffs as no evidence at all,
 * permanently.
 *
 * The WRITE is a no-op when `baseline` was already reused from a preserved value — a resumed attempt
 * whose baseline `readBoardBaseline` pulled off the ticket's own metadata is already durable locally;
 * re-persisting it would cost a write for nothing. The confirming PUSH below still runs every attempt
 * (chatgpt-codex-connector, PR #284 review, "Reconfirm a preserved baseline before dispatching a
 * retry") — mirrors the same fix already made in {@link readBoardEvidence}'s `!hydrated` branch, for
 * the same reason: a same-machine retry that finds the write already done used to return `true`
 * without ever confirming THAT sync succeeded.
 *
 * `beads.push` is a pull → commit → push pass (`runDoltSync`), so EVERY confirming push here — the
 * fresh-persist path above and the reconfirm-only path alike — can pull in remote changes made by
 * something else with access to the same board (a sibling run, a gardener pass) between
 * `readBoardBaseline` and this call, changes `baseline` does not reflect (chatgpt-codex-connector, PR
 * #284 review, "Refresh the baseline after the confirming pull"). Left uncorrected, `readBoardEvidence`'s
 * post-run diff — still measured against that stale `baseline` — would credit those pre-dispatch pulled
 * beads as this ticket's own evidence and accept a no-op agent as `delivered`. So once the confirming
 * push lands, this re-reads the board and, if the pull actually changed anything, persists and confirms
 * a REFRESHED baseline taken after it — the caller uses THAT for the rest of this attempt (dispatch
 * hasn't happened yet, so a refreshed read here still describes pre-dispatch state) instead of the one
 * read before the pull.
 *
 * That refreshed persist's OWN confirming push is itself a pull → commit → push pass (chatgpt-codex-
 * connector, PR #284 review, "Re-read after the refreshed-baseline push"): if yet another machine
 * publishes a change between the refresh read above and this second push, that push's pull absorbs it
 * locally, but the fingerprint already taken describes the board BEFORE that pull. Returning it as-is
 * would repeat exactly the bug this whole refresh exists to close — a pre-dispatch change the baseline
 * omits reads as the agent's own evidence — just one pull later. So this doesn't stop at one refresh:
 * after each confirming push lands, it re-reads the board again and loops back through the same
 * persist-and-push cycle as long as that read still differs from the last baseline it confirmed,
 * bounded at {@link BASELINE_REFRESH_ROUNDS} rounds so a board under continuous, unrelated churn fails
 * closed (returns `null`) rather than spinning forever chasing a moving target. A round that finds no
 * further difference returns the last confirmed baseline immediately — a healthy pass with nothing left
 * to pull costs exactly the pushes it needed and no more.
 *
 * The refresh is skipped entirely — `baseline` is returned as-is once the confirming push above lands —
 * when `ticket` already carries a RECOVERY baseline (chatgpt-codex-connector, PR #284 review round 17,
 * "Preserve recovery baselines when resuming dispatched tickets"): one {@link readBoardEvidence}
 * preserved AFTER a dispatch attempt already ran, as opposed to the never-dispatched baseline this
 * function itself persists and freely refreshes above. On a RESUMED (redispatching) attempt, the
 * confirming pull just above can legitimately pull in that SAME prior attempt's own not-yet-confirmed
 * delivery — folding it into a "refreshed" baseline would erase the only pre-delivery snapshot an
 * idempotent resumed agent's evidence check needs to diff against, permanently rejecting its next
 * confirmation as unchanged. A never-dispatched baseline carries no such risk: nothing has been
 * dispatched against it yet, so anything its confirming pull picks up is genuinely pre-existing state
 * from something else with board access, safe to fold in. See {@link beads.boardEvidenceBaselineLocked}.
 *
 * Never throws: any failure — the initial persist, the confirming push, a refresh read, or a refresh
 * round's persist/push — returns `null` so `runTicket` can refuse to dispatch on the same closed-fail
 * path it already takes for an unreadable baseline, rather than dispatch an agent whose writes this
 * attempt could not durably anchor. Retrying every push here is safe specifically because a caller only
 * ever reaches dispatch once this function returns non-null (`runTicket` refuses to dispatch on `null`)
 * — so a prior attempt that returned unconfirmed never let an agent run, and there is nothing a retry
 * could lose by confirming again.
 */
/**
 * How many extra read/persist/push rounds {@link ensureBoardBaselinePersisted} chases a moving
 * baseline before giving up. Each round is one more machine's concurrent write the function can
 * still absorb correctly; past that it fails closed (`null`) rather than loop indefinitely against a
 * board under continuous unrelated churn — the same trade every bounded retry in this codebase makes
 * (see {@link mustPersist}'s `attempts`).
 */
const BASELINE_REFRESH_ROUNDS = 3;

export async function ensureBoardBaselinePersisted(
  repo: string,
  ticket: Bead,
  baseline: BoardFingerprint,
): Promise<BoardFingerprint | null> {
  const hadBaseline = Boolean(beads.boardEvidenceBaseline(ticket));
  const locked = hadBaseline && beads.boardEvidenceBaselineLocked(ticket);
  const recoveryBaseline = locked && beads.boardEvidenceBaselineVerified(ticket);
  if (!hadBaseline) {
    const persisted = await mustPersist(() =>
      beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(baseline)),
    );
    if (!persisted) return null;
  }
  const synced = await beads
    .push(repo)
    .then((outcome) => outcome === "synced" || outcome === "shared-server")
    .catch(() => false);
  if (!synced) return null;
  if (recoveryBaseline) return baseline;
  // A lock left mid-verification (chatgpt-codex-connector, PR #284 review, "Distinguish tentative
  // locks before trusting them on resume") is NOT the never-dispatched baseline the free-refresh
  // loop below assumes: that loop's own persist omits the locked/verified keys entirely, and `bd`
  // MERGES metadata rather than replacing it, so writing through it here would leave a stale
  // `locked` flag pointing at a candidate this call is about to replace with `refreshed`. Re-enter
  // `lockDispatchBaseline` directly instead — it already knows how to re-verify (or move past) a
  // candidate it may have locked tentatively itself, on a PRIOR attempt that crashed before ever
  // confirming it stable.
  if (locked) return lockDispatchBaseline(repo, ticket, baseline);

  let confirmed = baseline;
  for (let round = 0; round < BASELINE_REFRESH_ROUNDS; round += 1) {
    const board = await mustReadBoard(repo);
    const hydrated = board && (await hydrateDescriptions(repo, board));
    if (!hydrated) return null;
    const refreshed = fingerprintBoard(hydrated, ticket.id);
    if (boardEvidence(confirmed, refreshed).length === 0) return lockDispatchBaseline(repo, ticket, confirmed);
    const refreshedPersisted = await mustPersist(() =>
      beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(refreshed)),
    );
    if (!refreshedPersisted) return null;
    const refreshedSynced = await beads
      .push(repo)
      .then((outcome) => outcome === "synced" || outcome === "shared-server")
      .catch(() => false);
    if (!refreshedSynced) return null;
    confirmed = refreshed;
  }
  // Every round found the board still drifting under its own confirming push — fail closed rather
  // than dispatch against a baseline that may still omit a change landing right now.
  return null;
}

/**
 * How many extra lock/push/re-read rounds {@link lockDispatchBaseline} chases a moving baseline
 * before giving up — the same bounded trade as {@link BASELINE_REFRESH_ROUNDS}, just for the drift
 * that loop itself cannot see: its OWN confirming push (chatgpt-codex-connector, PR #284 review,
 * "Re-read the board after syncing the baseline lock"). `beads.push` is a pull → commit → push
 * pass, so that push can pull in a write that landed after the refresh loop's last stable read —
 * on an embedded board, `readBoardEvidence`'s later `beads.push` would then pull that SAME write
 * into the local Dolt DB while this function still hands back the older baseline, and the post-run
 * diff would credit it to the dispatched agent as evidence it never produced. Each round below is
 * one more such write this function can still absorb correctly; past that it fails closed (`null`)
 * rather than loop indefinitely against a board under continuous unrelated churn.
 */
const LOCK_STABILITY_ROUNDS = 3;

/**
 * Best-effort: drop the (possibly stray) locked baseline {@link lockDispatchBaseline} itself just
 * wrote, so a round that fails AFTER claiming the lock never leaves it behind for a LATER attempt to
 * trust blindly (chatgpt-codex-connector, PR #284 review, "Refresh locks left by failed pre-dispatch
 * attempts"). Every persist in that function's loop writes `locked: true` BEFORE that round's own
 * push and re-read have confirmed the value is actually stable — that ordering is what survives a
 * crash mid-round, but it also means a round that then fails (an unconfirmed push, an unreadable
 * re-read, or a comparison that found drift on the very last round) can leave a candidate locked that
 * the caller's own next statement was about to disprove. Left in place, `ensureBoardBaselinePersisted`'s
 * `recoveryBaseline` fast path on the NEXT attempt would skip its own refresh loop entirely and hand
 * that stale value back for dispatch untouched — even though THIS attempt's own confirming push
 * already pulled in the change that invalidated it, crediting a no-op agent with someone else's write
 * the same way this whole locking scheme exists to prevent, just relocated to the round that gives up
 * rather than the one that never tried. Clearing restores the ticket to "no baseline persisted", so
 * the next attempt recomputes and re-verifies a fresh one from scratch instead of trusting a value
 * this call could not itself confirm.
 *
 * Local-only and never throws: this runs on a path that is already refusing to dispatch (`null`), so
 * there is no delivery to protect by insisting the clear also reaches the remote — a same-machine
 * resume (the common case; the run-lease actor that will retry this ticket) sees it immediately
 * either way. An unconfirmed or refused clear still leaves the caller returning `null`, the same
 * closed-fail path a healthy round would have taken anyway.
 */
async function abandonDispatchBaseline(repo: string, ticket: Bead): Promise<null> {
  await beads.clearBoardEvidenceBaseline(repo, ticket.id).catch(() => {});
  return null;
}

/**
 * Lock the settled pre-dispatch baseline onto `ticket` before this function ever hands it back for
 * dispatch (chatgpt-codex-connector, PR #284 review, "Lock the baseline before starting dispatch").
 * Without this, the lock was only ever set by {@link readBoardEvidence} AFTER the agent session ran —
 * so a host death during that session (agent writes land, evidence check never runs) left the
 * baseline unlocked. A resumed attempt's `ensureBoardBaselinePersisted` then found `recoveryBaseline`
 * false, treated the baseline as still freely refreshable, and its confirming pull folded the
 * previous attempt's already-landed writes into a "refreshed" baseline — erasing the only snapshot an
 * idempotent retry's evidence check needs to diff against, and permanently rejecting it as no
 * delivery. Locking here, the instant the pre-dispatch baseline stops moving, closes that window:
 * every later resume finds `recoveryBaseline` true and returns this exact baseline untouched, exactly
 * as `readBoardEvidence`'s own recovery locks already do for the post-dispatch case.
 *
 * Re-reads the board after every confirming push and loops back (bounded by
 * {@link LOCK_STABILITY_ROUNDS}) whenever that read no longer matches what was just locked
 * (chatgpt-codex-connector, PR #284 review): the push itself can pull in a concurrent write, so the
 * baseline handed back must describe the board AFTER its own confirming push, not before it. The
 * first round upgrades the still-unlocked baseline via {@link preserveRecoveryBaseline}; a later
 * round re-persists the newer content directly — `preserveRecoveryBaseline` no-ops once a lock is
 * already set, and a round that found drift needs the LOCKED value overwritten with the drifted one,
 * not skipped.
 *
 * Fails closed like every other write in this function: an unconfirmed lock, an unreadable re-read,
 * or a baseline that never stops drifting all refuse dispatch (`null`) rather than risk repeating the
 * exact loss this locking exists to prevent — and, in every one of those failure shapes, clears the
 * stray locked baseline this call itself just wrote (see {@link abandonDispatchBaseline}) rather than
 * leave it for a later attempt's `ensureBoardBaselinePersisted` to trust without ever re-reading the
 * board (chatgpt-codex-connector, PR #284 review, "Refresh locks left by failed pre-dispatch
 * attempts").
 */
async function lockDispatchBaseline(
  repo: string,
  ticket: Bead,
  baseline: BoardFingerprint,
): Promise<BoardFingerprint | null> {
  let candidate = baseline;
  let locked = false;
  for (let round = 0; round < LOCK_STABILITY_ROUNDS; round += 1) {
    const persisted = locked
      ? await mustPersist(() =>
          beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(candidate), true),
        )
      : await preserveRecoveryBaseline(repo, ticket, candidate, false);
    if (!persisted) return locked ? abandonDispatchBaseline(repo, ticket) : null;
    locked = true;
    const synced = await beads
      .push(repo)
      .then((outcome) => outcome === "synced" || outcome === "shared-server")
      .catch(() => false);
    if (!synced) return abandonDispatchBaseline(repo, ticket);
    const board = await mustReadBoard(repo);
    const hydrated = board && (await hydrateDescriptions(repo, board));
    if (!hydrated) return abandonDispatchBaseline(repo, ticket);
    const refreshed = fingerprintBoard(hydrated, ticket.id);
    if (boardEvidence(candidate, refreshed).length === 0) {
      // Every write above locked `candidate` as a TENTATIVE value, before this very comparison had
      // a chance to prove it stable (chatgpt-codex-connector, PR #284 review, "Distinguish tentative
      // locks before trusting them on resume") — a process death between that write and here left a
      // resume's `recoveryBaseline` fast path with nothing to tell it apart from a value this loop
      // actually finished proving. Only now, once the comparison itself has passed, is `candidate`
      // safe to mark verified — see {@link BOARD_EVIDENCE_BASELINE_VERIFIED_KEY}.
      const verified = await preserveRecoveryBaseline(repo, ticket, candidate, true);
      return verified ? candidate : abandonDispatchBaseline(repo, ticket);
    }
    candidate = refreshed;
  }
  // The lock-confirming push kept pulling in further drift every round — fail closed rather than
  // hand back a locked baseline that may still omit a change landing right now, and clear the stray
  // locked value this loop itself left behind rather than leave it for the next attempt to trust.
  return abandonDispatchBaseline(repo, ticket);
}

/**
 * Preserve `baseline` as `ticket`'s recovery baseline, UPGRADING an existing unlocked baseline to
 * locked rather than skipping the write (chatgpt-codex-connector, PR #284 review, "Set the recovery
 * lock when a baseline already exists"). `ensureBoardBaselinePersisted` now always leaves an
 * unlocked, freely-refreshed baseline on a board-only ticket before dispatch, so every one of
 * `readBoardEvidence`'s own recovery-preserve attempts below finds `alreadyPreserved` true on
 * basically every dispatched attempt — treating that alone as "nothing to do" (the old behavior)
 * means the lock this function exists to set never gets written at all. Left unlocked, a LATER
 * attempt's `ensureBoardBaselinePersisted` still treats it as the never-dispatched baseline it is
 * free to refresh across its own confirming pull — which can fold in THIS attempt's own
 * not-yet-confirmed delivery — and a subsequent idempotent retry then diffs against a baseline that
 * already contains its own writes, permanently rejecting it as unchanged. Already-locked is still a
 * true no-op (once already verified to the level THIS call needs): nothing to upgrade, and
 * re-writing identical content would cost a write for nothing.
 *
 * `verified` (chatgpt-codex-connector, PR #284 review, "Distinguish tentative locks before trusting
 * them on resume") says whether the caller can vouch for `baseline` as final the instant this write
 * lands, or is asking for a TENTATIVE lock still pending its own confirmation — see
 * {@link BOARD_EVIDENCE_BASELINE_VERIFIED_KEY}. Every post-dispatch call from {@link
 * readBoardEvidence} passes `true`: those preserve a snapshot that is already as final as it will
 * ever get, with no further round to confirm it. `lockDispatchBaseline`'s own PRE-dispatch round
 * passes `false` for its first, optimistic write — made before that SAME round's own confirming
 * push and re-read have proven the candidate stable — and only calls back in with `true` once they
 * have. The no-op check honors this: a lock already present but not yet verified is not treated as
 * "nothing to do" when THIS call is the one trying to verify it.
 */
async function preserveRecoveryBaseline(
  repo: string,
  ticket: Bead,
  baseline: BoardFingerprint,
  verified: boolean,
): Promise<boolean> {
  if (
    beads.boardEvidenceBaselineLocked(ticket) &&
    (!verified || beads.boardEvidenceBaselineVerified(ticket))
  ) {
    return true;
  }
  return mustPersist(() =>
    beads.setBoardEvidenceBaseline(repo, ticket.id, serializeFingerprint(baseline), true, verified),
  );
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
   * A recovery baseline this attempt tried to preserve — because nothing else on the ticket already
   * anchors a resume to the pre-dispatch board (see {@link readBoardEvidence}'s `!hydrated` branch,
   * its marker-write-exhausted-every-retry branch, or its own confirming-push-failed branch at the
   * very end) — PERSISTED LOCALLY but could not be confirmed synced before this attempt gave up (PR
   * #284 review round 9, extended round 13). Usually paired with `evidenceUnavailable: true`, except
   * from the last of those three branches, where `found`/`ids`/`synced` describe real (if unconfirmed)
   * evidence instead. Named separately because it is a sharper warning than a merely unreadable
   * post-run board: if this ticket resumes on ANOTHER machine (the run-lease actor is machine-scoped,
   * not run-scoped), that machine never sees this preserved baseline either, so `readBoardBaseline`
   * takes a FRESH read there too — one that may already have absorbed this ticket's own writes
   * through an independent sync pass — and an idempotent retry that correctly makes no further writes
   * then reads as no evidence at all, permanently. Resuming on the SAME machine is still safe (the
   * baseline sits in this process's local Dolt state regardless of whether it pushed), so the
   * operator note has to say which. Only ever set when the local persist itself succeeded — see
   * {@link baselineUnpersisted} for the case where it did not.
   */
  baselineUnconfirmed?: boolean;
  /**
   * The same recovery baseline as {@link baselineUnconfirmed} could not be written even LOCALLY,
   * after every retry (anton-fc5x review round 7) — the sibling case, which requires the local write
   * to have actually landed. With nothing persisted anywhere, resuming on THIS machine is NOT
   * specially safe: a same-machine resume finds no preserved baseline either and falls back to the
   * same fresh read a different machine would, one that may already have absorbed this ticket's own
   * writes through an independent sync pass. Named separately so `boardOnlyNoDeliveryMessage` never
   * repeats `baselineUnconfirmed`'s same-machine safety claim for a write that never landed at all.
   */
  baselineUnpersisted?: boolean;
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
 * A TOTAL read failure, OR a read whose description hydration could not be trusted (`!hydrated`), with NO prior pending ids (PR #284 review round 8) is the one
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
  const hydrated = board && (await hydrateDescriptions(repo, board));
  if (!hydrated) {
    const pending = beads.pendingBoardEvidence(ticket);
    // No post-run read at all — or a read whose description hydration could not be trusted (PR #284
    // review round 11) — means `freshIds` can never be computed THIS attempt — the one case
    // `pending` alone (a PRIOR attempt's confirmed-but-unsynced ids) cannot cover, because a first
    // attempt has no prior marker to fall back on (PR #284 review). The baseline this attempt
    // already read is preserved instead, so a resumed attempt's `readBoardBaseline` reuses it
    // rather than taking a fresh one that may already have absorbed this ticket's writes through a
    // sync pass this check never confirmed (see that function's docstring). The WRITE is skipped
    // once a baseline is already preserved AND LOCKED (see {@link preserveRecoveryBaseline}), so a
    // repeated read failure doesn't churn it every attempt — but the confirming PUSH below still
    // runs every attempt (chatgpt-codex-connector, PR #284 review, "track whether preserved
    // baselines were synced"): a same-machine retry that found a baseline already here used to skip
    // this whole block, silently dropping `baselineUnconfirmed` from its result even though THIS
    // baseline was never actually confirmed synced — the operator note then fell back to a plain
    // "board read failed" with no warning to stay on this machine, exactly the false-success shape
    // the flag exists to prevent.
    const persisted = await preserveRecoveryBaseline(repo, ticket, baseline, true);
    if (!persisted) {
      // A write that failed outright leaves NO baseline anywhere, not even on this machine, so a
      // same-machine-safe claim would be false — reported as `baselineUnpersisted` instead
      // (anton-fc5x review round 7), which carries no such claim.
      return { found: pending.length > 0, ids: pending, synced: false, evidenceUnavailable: true, baselineUnpersisted: true };
    }
    // Persisted (this attempt or a prior one) AND confirmed synced before this recovery baseline is
    // trusted (PR #284 review round 9) — a write that only landed locally does not help a resume on
    // ANOTHER machine (the run-lease actor is machine-scoped, not run-scoped): that machine's
    // `readBoardBaseline` finds no preserved baseline either and falls back to a fresh read that may
    // already have absorbed this ticket's own — by-then synced through some other channel — writes,
    // permanently rejecting an idempotent retry as unchanged. `baselineUnconfirmed` is reported
    // (never silently folded into a plain `evidenceUnavailable`) so the operator note can say
    // precisely that resuming on THIS machine is safe but resuming elsewhere is not.
    const synced = await beads
      .push(repo)
      .then((outcome) => outcome === "synced" || outcome === "shared-server")
      .catch(() => false);
    return {
      found: pending.length > 0,
      ids: pending,
      synced: false,
      evidenceUnavailable: true,
      ...(synced ? {} : { baselineUnconfirmed: true }),
    };
  }
  const freshIds = boardEvidence(baseline, fingerprintBoard(hydrated, ticket.id));
  const pending = beads.pendingBoardEvidence(ticket);
  const ids = [...new Set([...pending, ...freshIds])].toSorted();
  if (ids.length === 0) return { found: false, ids: [], synced: false };
  const stale = beads.boardEvidencePendingLabels(ticket);
  // Compared as SETS, not `stale[0] !== ...` (PR #284 review, "Bound pending evidence before adding
  // it as one label") — a batch large enough to need `chunkBoardEvidenceIds` now spans several
  // `board-evidence-pending:*` labels, so the single-label equality check below would treat every
  // such ticket as changed on every attempt, churning the write (and its confirming push) forever.
  const desired = beads.boardEvidencePendingLabelsFor(ids);
  const unchanged =
    stale.length === desired.length && stale.toSorted().every((label, i) => label === desired.toSorted()[i]);
  if (!unchanged) {
    const persisted = await mustPersist(() =>
      beads.setBoardEvidencePending(repo, ticket.id, ids, stale),
    );
    if (!persisted) {
      // The marker never made it onto the board at all, so there is nothing new for the push below
      // to cover — but the content edits still might be, and the caller's message distinguishes
      // `markerUnpersisted` from `!synced` regardless of this value, so it is still worth reporting.
      //
      // The baseline is preserved too, reusing the same recovery mechanism as the `!hydrated` branch
      // above (PR #284 review): `freshIds` is real here — the board content already changed — but
      // with no marker AND no preserved baseline, a resumed attempt's `readBoardBaseline` takes a
      // FRESH read that already reflects this change, diffs it against itself, and finds nothing —
      // permanently losing this attempt's confirmed evidence even once the write channel recovers.
      // Guarded on already LOCKED, not merely already preserved (see {@link
      // preserveRecoveryBaseline}), so a repeated retry doesn't churn the write every attempt once
      // the lock itself has landed.
      const baselinePersisted = await preserveRecoveryBaseline(repo, ticket, baseline, true);
      const outcome = await beads.push(repo).catch(() => "not-wired" as const);
      const synced = outcome === "synced" || outcome === "shared-server";
      // Confirmed (persisted AND synced) exactly like the `!hydrated` branch's recovery baseline (PR
      // #284 review round 10) — both marker and baseline are unrecoverable state once this attempt's
      // baseline is superseded, so a baseline write that landed only locally, or never landed at all,
      // is reported the same way that branch reports it: `baselineUnconfirmed`/`baselineUnpersisted`,
      // not silently folded into `markerUnpersisted`/`synced`, which describe the marker and content
      // edits only. The two are kept distinct (anton-fc5x review round 7) for the same reason as the
      // `!hydrated` branch above: only a baseline that actually landed locally makes a same-machine
      // resume specially safe.
      return {
        found: true,
        ids,
        synced,
        markerUnpersisted: true,
        ...(!baselinePersisted
          ? { baselineUnpersisted: true }
          : !synced
            ? { baselineUnconfirmed: true }
            : {}),
      };
    }
  }
  // One push, after the marker (if any) is on the board, so it is the confirming sync for both the
  // content edits and the recovery marker together.
  const outcome = await beads.push(repo).catch(() => "not-wired" as const);
  const synced = outcome === "synced" || outcome === "shared-server";
  if (synced) return { found: true, ids, synced };
  // The confirming push failed — including the fast path where the marker already matched `ids`
  // going in (e.g. left by an earlier attempt, or by the heartbeat backstop that syncs independently
  // of this check), so nothing above wrote anything this call and there is otherwise NO recovery
  // state for a resume to fall back on (PR #284 review). If that independent channel already
  // published the content to the remote, another machine's resume never sees this local-only
  // marker: its own `readBoardBaseline` falls back to a fresh read that already reflects the
  // published content, diffs it against itself, and finds nothing — permanently rejecting an
  // idempotent retry as unchanged, exactly the stranding the two branches above already guard
  // against on their own push failures. Preserve the same recovery baseline here, guarded on
  // already LOCKED (see {@link preserveRecoveryBaseline}) so a repeated retry doesn't churn the
  // write every attempt once the lock itself has landed. No second push is worth attempting to
  // confirm it: the one just above already answered whether the sync channel is healthy this
  // attempt, so a locally-persisted baseline here is `baselineUnconfirmed` by definition —
  // same-machine resume safe, never cross-machine, exactly like the two branches above.
  const baselinePersisted = await preserveRecoveryBaseline(repo, ticket, baseline, true);
  return {
    found: true,
    ids,
    synced,
    ...(baselinePersisted ? { baselineUnconfirmed: true } : { baselineUnpersisted: true }),
  };
}

/**
 * Release the pending marker once the handoff its evidence unblocked has actually completed —
 * the attribution commit (if any) landed and the bead settled (anton-fc5x review round 4). Deliberately
 * separate from {@link readBoardEvidence}, which only ever ADDS to the marker: only the ticket's own
 * success path, after `finishTicket` returns without throwing, knows the handoff truly finished.
 *
 * Also sets {@link beads.setBoardEvidenceConfirmed} — the one write here that is NEVER released
 * (PR #284 review, "no record that this bead's board-only delivery ever happened"). Once this
 * function returns, the marker and preserved baseline it clears are gone by design, and without a
 * permanent trace a resume that finds this ticket closed with no commit on its OWN branch (a crash
 * before the epic's branch was ever pushed, or a fresh worktree on another machine) cannot tell
 * "confirmed and cleaned up" from "closed with no evidence at all" — `doneOnBoard`'s dispatch-loop
 * caller (execute-epic-dispatch.ts) reads this durable flag to take the safe branch instead of
 * regenerating a ticket whose fresh board baseline already absorbed its own landed change, which
 * can never produce a further diff to prove and would otherwise fail it as undelivered forever.
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
 *
 * `hasCleanupObligation` (PR #284 review, "retain a retry obligation after cleanup push failure")
 * covers the THIRD and FOURTH cases those two survivors both miss: either both cleanup writes land
 * locally and only the confirming push fails, or the marker and baseline clear locally but
 * `setBoardEvidenceConfirmed` itself exhausts its retries (PR #284 review, "preserve an obligation
 * when confirmation persistence fails") — both leave `markerCleared`/`baselineCleared` true, so
 * `pending`/`boardEvidenceBaseline` come back empty on a same-machine resume. A plain
 * `stalePending.length > 0 || hasPreservedBaseline` check reads either as "nothing left to do" and
 * never calls this again, leaving the remote holding a stale pending marker and baseline on an
 * already-closed bead indefinitely (only `concludeRunAttempt`'s best-effort final sync might catch
 * it, and that failure is logged, not retried) — or, in the fourth case, leaving
 * `boardEvidenceConfirmed` permanently unset with nothing left to signal a resume should retry it.
 * The `!cleared || !synced` branch below persists {@link beads.setBoardEvidenceCleanupUnsynced} as
 * exactly that obligation before throwing whenever ANY of the three writes may have landed, not
 * only when all three (`cleared`) did, so a caller can pass it back on resume even with `ids` empty
 * and `hasBaseline` false; once a later attempt clears and confirms and syncs successfully, it is
 * released the same way the other two survivors are.
 *
 * A resumed `hasCleanupObligation` retry should still pass the REAL ids (PR #284 review, "Recover
 * cleanup-only resumes before regeneration"/"Preserve confirmed evidence IDs during cleanup
 * retries"), not a bare `[]`, whenever any are known — recovered from
 * {@link beads.cleanupUnsyncedBoardEvidenceIds} (what THIS obligation itself carried) and
 * {@link beads.confirmedBoardEvidenceIds} (already durably confirmed by an earlier call), unioned
 * with whatever is still in `ids`. `setBoardEvidenceConfirmed` below is not idempotent on `ids` — a
 * retry that passes fewer ids than a prior successful call overwrites real confirmed evidence with
 * less, and a retry whose only prior trace is this obligation (the marker/baseline confirmation
 * itself never landed) has NO OTHER source for those ids once they are gone. `ids` stays a plain
 * parameter (rather than being derived from `ticket` in here) for that confirmed-evidence write
 * specifically, since the recovery union above is the caller's job — every call site already holds
 * the ticket. The `--remove-label` value is a different matter: it is read straight off `ticket`'s
 * own current label (see `stale` below), never off `ids`, since the recovery call sites deliberately
 * pass a WIDER union into `ids` than the bead's live pending label actually holds.
 */
export async function clearBoardEvidencePending(
  repo: string,
  ticket: Bead,
  ids: readonly string[],
  hasBaseline = false,
  hasCleanupObligation = false,
): Promise<void> {
  const ticketId = ticket.id;
  // The label removed below is read off the bead's OWN current `board-evidence-pending:*` label
  // (PR #284 review round 16), never synthesized from `ids` via `LABELS.boardEvidencePending(ids)`
  // as it used to be — every other place that removes a prefixed label reads the bead's real value
  // first (e.g. this same function's `setBoardEvidenceConfirmed` neighbor, or `readBoardEvidence`'s
  // own `stale` above) for exactly this reason. The three cleanup-retry call sites in
  // execute-epic-dispatch.ts deliberately pass `ids` as a UNION of pending + cleanup-unsynced +
  // confirmed ids — wider than the bead's live pending label, and correct for `ids`' OTHER use below
  // (`setBoardEvidenceConfirmed`, which needs that full set). Building `--remove-label` from that
  // union instead constructs a value the bead's actual label may not match, so the write either
  // errors or silently no-ops, stranding the real stale marker.
  const stale = beads.boardEvidencePendingLabels(ticket);
  if (ids.length === 0 && !hasBaseline && !hasCleanupObligation && stale.length === 0) return;
  // Written FIRST, before either recovery signal below is cleared (chatgpt-codex-connector, PR
  // #284 review, "Persist confirmation before clearing recovery evidence") — `mustPersist`'s
  // retries only cover a WRITE that bd refuses; they cannot cover the process (or host) dying
  // between two already-`await`ed statements, which never reaches the later statement at all. On
  // the old order (marker clear, then baseline clear, then this write) a death right after both
  // clears landed — globally visible immediately on a shared Dolt server, no push required — left
  // the ticket with no pending marker, no preserved baseline, no confirmation and no cleanup
  // obligation: every recovery signal this module and `execute-epic-dispatch.ts`'s resume checks
  // rely on gone at once. A resume then finds `doneOnBoard` true, `boardEvidenceConfirmed` false,
  // and nothing pending or preserved, so it falls through to regeneration — against a fresh
  // baseline that already contains this ticket's own confirmed writes, which an idempotent agent
  // can only ever diff as unchanged and fail with `NoDeliveryError`, undoing a delivery that
  // already landed. Writing this first closes the gap: a death immediately after leaves
  // `boardEvidenceConfirmed` true with the marker/baseline still present, which is exactly the
  // shape `execute-epic-dispatch.ts` already finishes as a "confirmed, finish survivor cleanup"
  // resume rather than a delivery to regenerate. `--metadata @file` merges into existing custom
  // metadata rather than replacing it (see {@link beads.setBoardEvidenceConfirmed}), so writing
  // this key before the marker/baseline clear does not disturb them — the three writes are
  // independent regardless of order. NOT idempotent on `ids` (PR #284 review, "Preserve confirmed
  // evidence IDs during cleanup retries") — the field carries the confirmed ids themselves, not a
  // boolean, so retrying this write with a narrower `ids` than a prior successful call overwrites
  // real confirmed evidence with less. Every caller is therefore responsible for passing the full
  // known id set on a retry (pending ids UNIONED with whatever
  // `beads.confirmedBoardEvidenceIds`/`beads.cleanupUnsyncedBoardEvidenceIds` already know), never
  // just the ids freshly found this attempt.
  const confirmedSet = await mustPersist(() => beads.setBoardEvidenceConfirmed(repo, ticketId, ids));
  const markerCleared =
    stale.length === 0 ? true : await mustPersist(() => beads.setBoardEvidencePending(repo, ticketId, [], stale));
  const baselineCleared = await mustPersist(() => beads.clearBoardEvidenceBaseline(repo, ticketId));
  const cleared = markerCleared && baselineCleared && confirmedSet;
  const synced = cleared
    ? await beads
        .push(repo)
        .then((outcome) => outcome === "synced" || outcome === "shared-server")
        .catch(() => false)
    : false;
  if (!cleared || !synced) {
    // All writes landed locally — only the confirming push is missing. This obligation marker is
    // what a resume's `hasCleanupUnsynced` check relies on (PR #284 review, "require the cleanup
    // obligation write to succeed"): unlike the earlier `.catch(() => {})` here, its result is not
    // discarded — `mustPersist` never throws, so a swallowed result meant a resume whose local db
    // ALSO refused this write would see no pending marker, no baseline, and no obligation, and
    // silently skip the retry forever while the remote still carries stale evidence. The `detail`
    // below says so explicitly when it happens, since a plain resume can no longer be trusted to
    // fix it.
    //
    // Persisted whenever BOTH the marker and the baseline cleared, not only when `cleared` (all
    // three, including confirmation) did (PR #284 review, "preserve an obligation when confirmation
    // persistence fails"): a prior call can clear the marker and the baseline but exhaust its
    // retries on `setBoardEvidenceConfirmed` alone — `cleared` is then false, yet the two survivors
    // a resume would otherwise check (`pendingBoardEvidence`, `boardEvidenceBaseline`) are already
    // gone from the board. Without persisting an obligation here too, a same-machine resume sees
    // neither survivor, never calls this function again, and `boardEvidenceConfirmed` is left
    // permanently unset with no record anything is still owed — the same false-success shape
    // `hasCleanupObligation` exists to prevent, just reached through a different partial-write
    // combination. Gated on whether `ids` survive somewhere ELSE a resume already reads, not on whether the
    // BASELINE survives (chatgpt-codex-connector, PR #284 review, "Preserve IDs when confirmation
    // and baseline cleanup both fail") — a still-present pending marker carries `ids` directly (its
    // labels ARE the ids), and a landed `confirmedSet` carries them via
    // `beads.confirmedBoardEvidenceIds`, but a still-present preserved BASELINE carries none of
    // this: it is a whole-board content fingerprint, never diffed for ids by any resume path in
    // `execute-epic-dispatch.ts`. The old `markerCleared && baselineCleared` gate treated a
    // surviving baseline as if it were an equally good ids carrier — so whenever confirmation AND
    // the baseline clear both failed while the marker clear alone succeeded, no obligation was
    // written at all, and a resume's `recoveredIds` union (pending ∪ cleanup-unsynced ∪ confirmed)
    // came back empty despite the baseline's presence: `clearBoardEvidencePending`'s own retry then
    // overwrote the durable confirmation with `[]`, permanently losing which beads this ticket's
    // delivery touched.
    const idsRecoverableElsewhere = !markerCleared || confirmedSet;
    // Carries `ids` along with the obligation (PR #284 review, "Recover cleanup-only resumes
    // before regeneration") — the pending marker and preserved baseline that would otherwise
    // carry them are exactly what `markerCleared`/`baselineCleared` just cleared, so this
    // obligation is the only place left for a resume, on this machine or a fresh cross-machine
    // worktree with no attribution commit of its own, to recover which ids still need confirming.
    const obligationWritten = cleared || !idsRecoverableElsewhere;
    const obligationPersisted = obligationWritten
      ? await mustPersist(() => beads.setBoardEvidenceCleanupUnsynced(repo, ticketId, ids))
      : true;
    // Confirmed synced too, not just persisted (PR #284 review, "confirm the cleanup-retry
    // obligation reaches the remote before throwing"): this obligation is the ONLY remaining trace
    // that confirmation is still owed once the marker clears with the ids not otherwise recoverable,
    // so a local-only obligation is exactly the false-success shape this whole function otherwise
    // guards against. It gets its OWN push rather than reusing `synced` above — that push ran
    // BEFORE this write ever landed on the board (or, in the ids-not-recoverable-but-`!cleared`
    // case, never ran at all, since `cleared` gates it), so it cannot have confirmed this marker
    // either way. A same-machine resume can still see a local-only obligation and retry correctly, but a
    // resume on a FRESH cross-machine worktree — the exact case this obligation exists to carry
    // the retry across — reads `hasBoardEvidenceCleanupUnsynced` as false there and never retries
    // at all, so the detail below says so explicitly when the push cannot confirm it.
    const obligationSynced =
      obligationWritten && obligationPersisted
        ? await beads
            .push(repo)
            .then((outcome) => outcome === "synced" || outcome === "shared-server")
            .catch(() => false)
        : obligationPersisted;
    const detail = cleared
      ? !obligationPersisted
        ? "every cleanup write landed locally, but the confirming push could not verify they reached " +
          "the remote, and bd also refused the local retry-obligation marker (after retries) — a " +
          "resume will NOT automatically retry this cleanup; clear the pending marker and preserved " +
          "baseline for this ticket directly, or retry until the obligation marker persists"
        : obligationSynced
          ? "every cleanup write landed locally, but the confirming push could not verify they reached " +
            "the remote"
          : "every cleanup write landed locally, but the confirming push could not verify they reached " +
            "the remote, and the retry-obligation marker persisted only locally, not confirmed synced " +
            "— a resume on THIS machine will retry the cleanup, but a resume on a different machine " +
            "will not see the obligation and will not retry it; check the sync channel before resuming " +
            "elsewhere"
      : `bd would not clear ${[
          !markerCleared && "the pending-evidence marker",
          !baselineCleared && "the preserved baseline",
          !confirmedSet && "the delivery-confirmed marker",
        ]
          .filter((s): s is string => s !== false)
          .join(" and ")} it left on the board (after retries)${
          !idsRecoverableElsewhere
            ? !obligationPersisted
              ? ", and bd also refused the local retry-obligation marker (after retries) — a resume " +
                "will NOT automatically retry the rest of this cleanup; clear or complete it for " +
                "this ticket directly, or retry until the obligation marker persists"
              : obligationSynced
                ? " — a resume will retry the rest of this cleanup via the retry-obligation marker " +
                  "this run persisted"
                : " — a resume on THIS machine will retry the rest of this cleanup via the " +
                  "retry-obligation marker this run persisted locally, but that marker was not " +
                  "confirmed reaching the remote — a resume on a different machine will not see it " +
                  "and will not retry; check the sync channel before resuming elsewhere"
            : ""
        }`;
    throw new PoisonEpic(
      `${ticketId} delivered and closed, but ${detail} — the run stopped rather than leave a stale ` +
        `board-evidence record on an already-closed ticket, which a later reopen could read as ` +
        `current evidence for no new work. Check the beads DB${cleared ? " and the sync channel" : ""}, ` +
        `then resume the run.`,
    );
  }
  if (hasCleanupObligation) {
    // Mirrors the marker/baseline clear above (thread on PR #284 line 618, "persist and sync the
    // cleared cleanup obligation"): a local-only clear that's never confirmed reaching the remote is
    // exactly the failure this obligation marker exists to prevent — silently trusting it here would
    // let a refused write, or a push that lands after the process dies, leave the remote holding the
    // obligation forever, for every later machine to rediscover and retry a cleanup this ticket
    // already settled.
    const obligationCleared = await mustPersist(() =>
      beads.clearBoardEvidenceCleanupUnsynced(repo, ticketId),
    );
    const obligationSynced = obligationCleared
      ? await beads
          .push(repo)
          .then((outcome) => outcome === "synced" || outcome === "shared-server")
          .catch(() => false)
      : false;
    if (!obligationCleared || !obligationSynced) {
      throw new PoisonEpic(
        `${ticketId} delivered and closed, but the cleanup-sync retry obligation could not be ` +
          `${obligationCleared ? "confirmed as synced to the remote" : "cleared locally"} (after ` +
          `retries) — the run stopped rather than leave a later machine to rediscover and retry an ` +
          `already-settled cleanup. Check the beads DB${obligationCleared ? " and the sync channel" : ""}, ` +
          `then resume the run.`,
      );
    }
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
