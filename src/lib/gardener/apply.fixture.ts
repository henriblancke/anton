/**
 * The bd seam and the fixture boards that apply-on-approve is asserted against, shared by the three
 * suites the module itself is split into (anton-m4b5.1): `apply-plan.test.ts` (the decision),
 * `apply-steps.test.ts` (the writes under their locks) and `apply.test.ts` (the composition).
 *
 * The seam stubs bd's WRITES and records them, because what matters is exactly which verb ran
 * against which bead — a `close` where a `defer` was proposed is the one mistake a retirement must
 * never make. Reads answer from {@link setSnapshot}'s board, overlaid with whatever {@link liveBeads}
 * a case has primed, which is how a race under the write lock is staged.
 *
 * Test-only. Each suite keeps its own `vi.mock("../beads/bd", …)` mapping bd's signatures onto
 * {@link record}, {@link showBead} and {@link listBoard} — vitest hoists that factory above the
 * file's imports, so it may only reach this module from INSIDE the wrappers it returns, never while
 * building them.
 */
import { LABELS, type Bead } from "../beads/bd";
// Type-only: erased at build, so it does not load apply.ts ahead of a suite's `vi.mock`.
import type { ApplyActor } from "./apply";
import {
  detectionSubjectKey,
  proposalFingerprint,
  type GardenerPlan,
} from "./detections";

export const REPO = "/tmp/gardener-apply";

/** Every bd write the module made, in order: `<verb> <args…>`. */
export const calls: string[] = [];
/**
 * What `bd show` answers with under the write lock — the board AS OF THE WRITE, which is a different
 * question from the snapshot `applyProposal` decided on. Defaults to the snapshot; a test primes an
 * entry here to stage the exact race the lock exists for (a run claiming mid-approval).
 */
export const liveBeads = new Map<string, Bead | undefined>();
/**
 * Writes primed to reject, keyed by `<verb>:<id>` → which occurrence fails (1-based). The occurrence
 * matters: rolling a re-parent back re-issues the SAME verb on the SAME bead, so "fail the second
 * one" is the only way to test a rollback that itself fails.
 */
export const failOn = new Map<string, number>();
const seen = new Map<string, number>();

let snapshot: Bead[] = [];
let afterWrite: ((call: string) => void) | undefined;
let byFlags: ((extra: string[]) => Promise<Bead[]>) | undefined;

/**
 * Run `hook` after every write that landed — the seam a test uses to make the board ANSWER
 * differently once something has been written to it, which is how a second concurrent approve or a
 * run starting mid-rollback is staged.
 */
export function onWrite(hook: (call: string) => void): void {
  afterWrite = hook;
}

/**
 * The board `applyProposal` was handed — what the under-lock re-read falls back to for any bead
 * {@link liveBeads} does not override. {@link apply} sets it; a test only calls this directly when it
 * drives `applyProposal` itself.
 */
export function setSnapshot(board: Bead[]): void {
  snapshot = board;
}

/**
 * Answer every `bd list` by the FLAGS it was given — the way to stage a bd that rejects
 * `--status all`. Unset, a listing answers with the whole {@link liveBoard}.
 */
export function listByFlags(answer: (extra: string[]) => Promise<Bead[]>): void {
  byFlags = answer;
}

/** Every stubbed bd WRITE lands here: recorded, primed to fail, then reflected into the live board. */
export function record(verb: string, ...args: string[]): Promise<string> {
  const key = `${verb}:${args[0]}`;
  const call = [verb, ...args].join(" ");
  calls.push(call);
  const nth = (seen.get(key) ?? 0) + 1;
  seen.set(key, nth);
  if (failOn.get(key) === nth) return Promise.reject(new Error(`bd ${verb} exploded`));
  // bd reflects a write immediately, and this module re-reads what it wrote — the rollback before it
  // undoes a move, the next approval before it re-applies one. A board that answered with pre-write
  // state would make those guards untestable.
  if (verb === "reparent") setLive(args[0] as string, { parent: args[1] || undefined });
  if (verb === "close") setLive(args[0] as string, { status: "closed" });
  afterWrite?.(call);
  return Promise.resolve("");
}

/** What the next `bd show` of this bead answers with — the board as the writes have left it. */
export function setLive(id: string, patch: Partial<Bead>): void {
  const current = liveBeads.get(id) ?? snapshot.find((b) => b.id === id);
  if (current) liveBeads.set(id, { ...current, ...patch });
}

/**
 * The board a `bd list` taken under the write lock answers with: the snapshot with every
 * {@link liveBeads} override applied, INCLUDING ids the snapshot never carried — which is how a test
 * stages work another approval attached mid-apply.
 */
export function liveBoard(): Bead[] {
  const merged = new Map(snapshot.map((b) => [b.id, b]));
  for (const [id, live] of liveBeads) {
    if (live) merged.set(id, live);
    else merged.delete(id);
  }
  return [...merged.values()];
}

/** `bd show` under the lock. Reads stay out of {@link calls}: what matters is which WRITE hit which bead. */
export function showBead(id: string): Promise<Bead> {
  const live = liveBeads.has(id) ? liveBeads.get(id) : snapshot.find((b) => b.id === id);
  return live ? Promise.resolve(live) : Promise.reject(new Error(`bd show: no such issue ${id}`));
}

/** `bd list` under the lock — the whole live board unless a case primed {@link listByFlags}. */
export function listBoard(extra: string[]): Promise<Bead[]> {
  return byFlags ? byFlags(extra) : Promise.resolve(liveBoard());
}

/** Every suite's `beforeEach`: no recorded write, no primed board, no hook survives a case. */
export function resetSeam(): void {
  calls.length = 0;
  failOn.clear();
  seen.clear();
  liveBeads.clear();
  afterWrite = undefined;
  snapshot = [];
  byFlags = undefined;
}

/**
 * Apply against `board`, with that same board answering the under-lock re-read of every subject —
 * i.e. nothing changed between the decision and the writes. A test that wants something to change
 * primes {@link liveBeads} for the bead it wants to move under the apply.
 *
 * The module is pulled in lazily so the suite's `vi.mock` is in place before apply.ts binds `beads`.
 *
 * `actor` defaults to `approval` because that is the caller nearly every case here stands in for —
 * the approve route — and the note it writes is asserted verbatim in `apply.test.ts` ("applied —
 * …"). The default is deliberate, NOT a stand-in for the production requirement: `applyProposal`
 * itself takes no default, so no caller outside these suites can leave the attribution unsaid. A
 * case that means "a policy did this" passes `"policy"` explicitly, and the note it produces is
 * pinned there too, so a wrong label is a failing test rather than a quiet one.
 */
export async function apply(
  proposal: Bead,
  board: Bead[],
  actor: ApplyActor = "approval",
  signal?: AbortSignal,
) {
  setSnapshot(board);
  const { applyProposal } = await import("./apply");
  return applyProposal(REPO, proposal, board, actor, signal);
}

/** {@link apply} with the proposal itself on the board — every apply re-reads it under its lock. */
export function applyWith(proposal: Bead, board: Bead[], actor: ApplyActor = "approval") {
  return apply(proposal, [...board, proposal], actor);
}

// ── fixture builders ──

export function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...extra };
}

/** A bead with a parent, expressed the way `bd list --json` carries it (field + inline edge). */
export function child(id: string, parent: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, extra),
    parent,
    dependencies: [{ issue_id: id, depends_on_id: parent, type: "parent-child" }],
  };
}

/** A bead waiting on `blocker`, carried the way `bd list --json` carries a blocks edge. */
export function blockedBy(id: string, blocker: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, extra),
    dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }],
  };
}

/** A closed bead the board records as superseded by `survivor` — the edge `bd supersede` writes. */
export function supersededBy(id: string, survivor: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, { status: "closed", ...extra }),
    dependencies: [{ issue_id: id, depends_on_id: survivor, type: "supersedes" }],
  };
}

/**
 * The {@link LINK} pair with ONE blocks edge between them: `from` waits on `to`. Its ids are two
 * characters wide because the body scanner only reads bd ids as bd writes them (`anton-02oc`) — a
 * one-character suffix never matches, so an `anton-a` pair could not state an ordering in prose.
 */
export const edged = (from: string, to: string): Bead[] =>
  ["anton-aa", "anton-bb"].map((id) => (id === from ? blockedBy(id, to) : bead(id)));

/**
 * A plan fingerprinted the way the emitter would fingerprint it — through the SAME key builder, not
 * a copy of it, because apply now recomputes that hash from the plan's own fields and a fixture with
 * a hand-rolled fingerprint would prove the opposite of what these tests claim.
 */
export function planFor(input: Omit<GardenerPlan, "fingerprint">): GardenerPlan {
  return {
    ...input,
    fingerprint: proposalFingerprint(
      input.kind,
      detectionSubjectKey(input.kind, input.subjects, input.target, input.detail),
    ),
  };
}

/**
 * The proposal bead as the board hands it back: fingerprint label + the plan as metadata, filed at
 * {@link FILED}. The filing stamp is not decoration — it is what dates a claim or an edit as "since
 * we asked", so a proposal without one fails those checks closed.
 */
export function proposalFor(plan: GardenerPlan, extra: Partial<Bead> = {}): Bead {
  return bead("anton-p1", {
    title: "Gardener: do the thing",
    labels: [plan.fingerprint, "domain:eng", "source:gardener"],
    metadata: { gardener: plan },
    created_at: FILED,
    ...extra,
  });
}

/** The moment every decision below is judged at — only the run-lease checks read it. */
export const NOW = Date.parse("2026-08-03T00:00:00Z");

/** When the proposals below were FILED: the board their evidence describes is a month old. */
export const FILED = "2026-07-01T00:00:00Z";

/**
 * A bead nobody has written to in over a year — what a `stale` proposal's subject still has to look
 * like at approve time, and old enough that any claim on it long predates {@link FILED}.
 */
export const cold = (id: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { updated_at: "2025-01-01T00:00:00Z", ...extra });

/** Its opposite: a bead written SINCE {@link FILED} — a change the approver was never shown. */
export const warm = (id: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { updated_at: "2026-07-15T00:00:00Z", ...extra });

/**
 * A {@link LINK} subject whose own body still spells the ordering out. An `implied-order` ask rests
 * on nothing but that phrase, so apply re-derives it from the board — a bead the board no longer
 * places after its blocker is a proposal whose only evidence somebody removed.
 */
export const ordered = (base: Bead = bead("anton-aa")): Bead => ({
  ...base,
  description: "## Context\nBlocked on anton-bb landing first.",
});

/**
 * The same pair with a `discovered-from` edge between them. bd keeps one edge per directed pair and
 * refuses to write `blocks` over provenance, so this is the pair no link ask may name (anton-wsap).
 */
export const provenanced = (base: Bead = ordered()): Bead => ({
  ...base,
  dependencies: [
    ...(base.dependencies ?? []),
    { issue_id: base.id, depends_on_id: "anton-bb", type: "discovered-from" },
  ],
});

/**
 * The landed twin a {@link SUPERSEDE} points at, untouched since the filing like its subject: the
 * contents match is symmetric, so the survivor's own edits falsify it too.
 */
export const landed = (extra: Partial<Bead> = {}): Bead =>
  cold("anton-b", { status: "closed", ...extra });

/** A bead a run owns right now: an unexpired lease, dated relative to `at`. */
export const leased = (id: string, at: number): Bead =>
  bead(id, { assignee: "runner-1", labels: [LABELS.runLease(at + 60_000, "run-9")] });

/** The other half of the same bar (board-index `isInFlight`): a run whose PR is up. */
export const inReview = (id: string): Bead => bead(id, { labels: ["stage:in-review"] });

/** A feature card with an open ticket under it — a legal re-parent home. */
export const CARD = bead("anton-card", { issue_type: "feature" });

/** The tier ABOVE a card: an epic, which may only carry cards once it already groups one. */
export const EPIC = bead("anton-epic", { issue_type: "epic" });

/** What makes {@link EPIC} a container — an epic groups cards the moment a feature lands under it. */
export const GROUPED = child("anton-f1", EPIC.id, { issue_type: "feature" });

/** A card as the SUBJECT of a move rather than its home: the tier whose home is an epic. */
export const FEATURE = bead("anton-feat", { issue_type: "feature" });

/**
 * The run target a retirement subject can ride as a TICKET. A grouped run publishes ONE lease, on
 * this bead — its tickets carry no liveness signal of their own — so this is where "a run is already
 * under way over that work" is readable at all.
 */
export const runCard = (extra: Partial<Bead> = {}): Bead =>
  bead("anton-run", { issue_type: "feature", ...extra });

/** The subject as a ticket of {@link runCard}, untouched since the filing like every retirement's. */
export const ticket = (extra: Partial<Bead> = {}): Bead =>
  child("anton-a", "anton-run", { updated_at: "2025-01-01T00:00:00Z", ...extra });

/** The three retirement plans against one subject, with the board each needs. */
export const retirements = (board: Bead[]): [GardenerPlan, Bead[]][] => [
  [DEFER, board],
  [CLOSE, board],
  [SUPERSEDE, [...board, landed()]],
];

export const REPARENT = planFor({
  kind: "container-orphan",
  move: "reparent",
  subjects: ["anton-a"],
  target: CARD.id,
});

export const CLUSTER = planFor({
  kind: "parentless-cluster",
  move: "reparent",
  subjects: ["anton-a", "anton-b"],
  target: CARD.id,
});

/**
 * The product master's re-parent (anton-02po): a bead whose home is WRONG rather than missing. Its
 * subject already rides a card, which is exactly what the gardener's two kinds refuse — so it is the
 * one re-parent whose premise no board read restates, and the evidence fence is what stands in.
 */
export const MISFILED = planFor({
  kind: "misfiled",
  move: "reparent",
  subjects: ["anton-a"],
  target: CARD.id,
});

export const LINK = planFor({
  kind: "implied-order",
  move: "link",
  subjects: ["anton-aa"],
  target: "anton-bb",
});

export const DEFER = planFor({
  kind: "stale",
  move: "retire",
  retireAs: "defer",
  subjects: ["anton-a"],
});

export const CLOSE = planFor({
  kind: "shipped-orphan",
  move: "retire",
  retireAs: "close",
  subjects: ["anton-a"],
});

export const SUPERSEDE = planFor({
  kind: "superseded",
  move: "retire",
  retireAs: "supersede",
  subjects: ["anton-a"],
  target: "anton-b",
});
