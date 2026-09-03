/**
 * The `ref-stale` repair (anton-fzas / R5.4) — the bead cites a file that moved, so anton follows
 * the rename and rewrites the pointer.
 *
 * This is the safest repair class by a wide margin, and the reason is that NOTHING here is inferred.
 * Every step is a fact the worktree or git's own history answers:
 *
 *   • the path is in the tree, or it is not;
 *   • git recorded exactly one destination for it, or it did not;
 *   • that destination is in the tree, or it is not;
 *   • what is in the tree at either end is the file the bead meant, or it was recreated since.
 *
 * Refusing to guess is what keeps that true, so the module escalates on every reading that is not
 * one of those yeses — a delete (including one a later rename sits beside), a name that has stood
 * for two different files, a chain that runs past its bound, a destination that is itself missing, a
 * destination some unrelated file took over after the rename, a still-present citation whose own
 * file moved away and left the name to a stranger (PR #223 review). A partial answer is not a
 * repair: if ANY cited path fails to resolve, nothing is rewritten at all, because a bead
 * half-corrected still points somewhere wrong and the retry it would earn is a run spent proving
 * that.
 *
 * What it rewrites is the `## Context` sections and nothing else. Out of scope by construction: prose
 * that merely MENTIONS a file (a citation is a repo-relative path with a directory and an extension,
 * not a sentence about a module), fenced code samples (an import in an example is not a pointer at
 * this repo — see {@link citedPaths}), and symbols — only paths.
 *
 * The loop guard and the trust dial are both repair.ts's, unchanged: {@link decideRepair} decides
 * whether this bead may be repaired for this class at all — a second `ref-stale` block on a bead
 * anton already repaired escalates rather than repairing again (R5.6), and a project that has not
 * armed the class gets the rewrite WORKED OUT and recorded rather than written (R5.3).
 */
import { beads } from "../beads/bd";
import { isContractHeading } from "../beads/contract";
import { scanMarkdown, type ScannedLine } from "../beads/markdown";
import { readPathHistory, type PathHistory } from "../git/ops";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  decideRepair,
  recordRepair,
  refusalNote as refusal,
  unstampedNote,
  type RepairAttempt,
  type RepairedBead,
} from "./repair";
import type { ProposalAutonomy } from "./autonomy";

/** The class this module repairs. Named once so the guard, the stamp and the prose cannot drift. */
const KLASS = "ref-stale" as const;

/**
 * A path CITED by a bead: a repo-relative path with at least one directory segment and a file
 * extension. That shape is the whole line between a citation and prose about a file — "the block
 * handling in execute-epic" names a module and points at nothing checkable, while
 * `src/lib/jobs/execute-epic.ts` is a pointer that either resolves or does not.
 *
 * A leading `./` is allowed and normalised away, so `./src/a.ts` and `src/a.ts` are one citation.
 */
const CITED_PATH = /(?:\.\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.\w+/g;

/** What may NOT sit immediately before a citation — the characters that make it part of something
 * else. A `/` or `:` in front is a URL's path or authority (`https://vercel.com/docs/a.html`), and a
 * word character means the match started mid-token. */
const NOT_A_CITATION_BOUNDARY = /[\w@/:+-]/;

/** What may NOT sit immediately after — a truncated match of a longer path or identifier. */
const CITATION_TAIL = /[\w/-]/;

/** One place a bead points at a file — one OCCURRENCE, not one path. */
export interface PathCitation {
  /** The path as it will be checked and followed — repo-relative, `./` stripped. */
  path: string;
  /** The exact substring in the source text, so a rewrite replaces what was written. */
  text: string;
  /** Offset of {@link text} within the text it was read from. */
  index: number;
}

/**
 * Every scanned line of `source` with the offset it starts at.
 *
 * The separator is MEASURED at each line rather than assumed to be one character (PR #223 review):
 * {@link scanMarkdown} splits on `\r?\n` and hands back lines with the `\r` already gone, so a bead
 * written with CRLF endings would drift every offset one byte earlier per line — truncating the tail
 * of a Context span, and mis-aiming the rewrite of a citation inside it.
 */
function* scannedLines(source: string): Generator<{ line: ScannedLine; start: number; next: number }> {
  let offset = 0;
  for (const line of scanMarkdown(source)) {
    const lineEnd = offset + line.text.length;
    const next = lineEnd + (source.startsWith("\r\n", lineEnd) ? 2 : 1);
    yield { line, start: offset, next };
    offset = next;
  }
}

/**
 * Every place the given text cites a path, in order — one entry per OCCURRENCE, so a Context that
 * names the same moved file twice can be rewritten in both places rather than half-corrected.
 *
 * Occurrences rather than paths is also what keeps the rewrite honest: each carries the offset the
 * boundary checks below actually validated, so nothing is re-found by a bare substring search that
 * would happily match `src/a.ts` inside `vendor/src/a.tsx`.
 *
 * FENCED code is not prose about the repository and holds no citations (PR #223 review): an
 * `import { Foo } from "@types/node/globals.d.ts"` in a Context code sample wears the shape of a
 * repo-relative path while pointing at nothing in the tree, and reading it as a citation escalated
 * the whole repair — refusing to follow a pointer that WAS mechanically followable, on the strength
 * of a line the bead never claimed was a file here. Skipping the fence is also what keeps a rewrite
 * out of a code sample the founder wrote to say something specific. Fences are read through
 * {@link scanMarkdown}, the same scanner {@link contextSpans} sections by, so the two cannot drift.
 *
 * A path that climbs out of the repository (`..`) or starts at the filesystem root is not a citation
 * this repair will touch: it names something outside the tree anton is allowed to reason about, and
 * "resolve it against the worktree" has no meaning there.
 */
export function citedPaths(text: string): PathCitation[] {
  const out: PathCitation[] = [];
  for (const { line, start } of scannedLines(text)) {
    if (line.fenced) continue;
    for (const match of line.text.matchAll(CITED_PATH)) {
      const at = match.index ?? 0;
      const before = at > 0 ? line.text[at - 1]! : "";
      const after = line.text[at + match[0].length] ?? "";
      if (NOT_A_CITATION_BOUNDARY.test(before) || CITATION_TAIL.test(after)) continue;
      const path = match[0].replace(/^\.\//, "");
      if (path.startsWith("/") || path.split("/").includes("..")) continue;
      out.push({ path, text: match[0], index: start + at });
    }
  }
  return out;
}

/** A `## Context` section's slice of a description — where it starts, where it ends, what it says. */
export interface ContextSpan {
  start: number;
  end: number;
  body: string;
}

/**
 * Locate EVERY `## Context` body inside a description, in order, as offsets rather than text.
 *
 * Offsets, because this repair REWRITES in place: the surrounding contract (Goal, Acceptance,
 * Verify) has to come back byte-identical, and re-rendering a parsed description would quietly
 * reformat sections nobody asked anton to touch. Each section runs to the next heading at its own
 * depth or shallower — a `### Files` grouping beneath it is still Context — or to a heading naming
 * another contract section at ANY depth (PR #223 review): the gate reads a `### Verify` written under
 * `## Context` as Verify's own content ({@link isContractHeading}), so a span that swallowed it would
 * rewrite citations belonging to a section this repair promises never to touch.
 *
 * Every occurrence rather than the first (PR #223 review), because a repeated heading is not a
 * malformed bead to this repair: the contract gate CONCATENATES repeated sections, so a citation
 * under the second `## Context` is spec exactly as much as one under the first. Reading only the
 * first would answer `none` on a bead whose later section is stale, or rewrite half of one that is
 * stale in both and report the whole thing repaired.
 *
 * Fences and HTML comments are honoured through {@link scanMarkdown}, so a `## Context` quoted
 * inside a code block opens no section here, exactly as it opens none for the contract gate.
 *
 * Offsets come from {@link scannedLines}, which measures each line separator rather than assuming
 * one byte (PR #223 review) — a CRLF bead would otherwise truncate the tail of Context, and with it
 * a stale citation the repair could have followed.
 */
export function contextSpans(description: string): ContextSpan[] {
  const spans: ContextSpan[] = [];
  let start: number | undefined;
  let depth = 0;
  const close = (end: number) => {
    const at = Math.max(start!, end);
    spans.push({ start: start!, end: at, body: description.slice(start!, at) });
    start = undefined;
  };
  for (const { line, start: offset, next } of scannedLines(description)) {
    // A heading at the open section's depth or shallower closes it, as does any heading naming
    // another contract section however deeply nested — and either may open the next one, so two
    // adjacent `## Context` sections are two spans rather than one swallowing the other.
    const closes = line.heading && (line.heading.depth <= depth || isContractHeading(line.heading));
    if (start !== undefined && closes) close(offset);
    if (start === undefined && line.heading?.key === "context") {
      start = Math.min(next, description.length);
      depth = line.heading.depth;
    }
  }
  if (start !== undefined) close(description.length);
  return spans;
}

/** What the worktree and git history answer for one cited path. */
export type PathVerdict =
  | { path: string; state: "present" }
  | { path: string; state: "moved"; to: string; trail: string[] }
  | { path: string; state: "unresolved"; why: string };

/** How many renames deep the follow goes. A pointer that moved more times than this is not the
 * mechanical rename this repair exists for, and following it further is guessing by another name. */
const MAX_RENAME_HOPS = 8;

async function inWorktree(worktreePath: string, path: string): Promise<boolean> {
  return access(join(worktreePath, path)).then(
    () => true,
    () => false,
  );
}

/**
 * What git records happening to the file that USED to wear `path` — read from the incarnation living
 * there now.
 *
 * `--follow` walks BACKWARDS from a path's current life, so where the walk starts decides what it
 * can see: a removal BEFORE the current file took the name is reported (the walk keeps the name
 * across a plain re-add), and one before a RENAME brought the file in is not (the walk switches to
 * the pre-rename name at that commit). Both readings are what the callers below need — the second is
 * why a rename that legitimately replaced an already-deleted name stays followable.
 *
 * `undefined` means the name has stood for one file since. An unreadable history is neither answer:
 * it is anton failing to check, and is carried back as `unreadable` rather than as "nothing
 * happened".
 */
async function removalSince(
  worktreePath: string,
  path: string,
): Promise<{ how: string } | { unreadable: string } | undefined> {
  let history: PathHistory;
  try {
    history = await readPathHistory(worktreePath, path);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { unreadable: `git history for \`${path}\` could not be read (${detail})` };
  }
  if (!history.deleted && history.renamedTo.length === 0) return undefined;
  return { how: history.deleted ? "deleted" : `renamed away to \`${history.renamedTo[0]}\`` };
}

/**
 * Whether the file sitting at a rename's DESTINATION is the incarnation that rename produced — or an
 * unrelated file that later took the name over (PR #223 review).
 *
 * The source's history cannot answer this. `src/a.ts` renamed to `src/b.ts`, `src/b.ts` deleted, and
 * something else committed at `src/b.ts` still reads from `src/a.ts` as ONE clean rename: a removal
 * after the rename is invisible from the name that moved. Read from the destination it is the only
 * thing visible — see {@link removalSince}.
 *
 * Returns the refusal's reason, or `undefined` when the destination has stood for one file since.
 */
async function recreatedSinceRename(
  worktreePath: string,
  path: string,
): Promise<string | undefined> {
  const removal = await removalSince(worktreePath, path);
  if (removal === undefined) return undefined;
  if ("unreadable" in removal) return removal.unreadable;
  return (
    `\`${path}\` was ${removal.how} after the rename that put the bead's file there — whatever wears ` +
    `that name now was committed afterwards, so it is not the file the bead pointed at`
  );
}

/**
 * The same reincarnation read on the SOURCE side: whether a cited path that IS in the worktree holds
 * the file the bead pointed at, or one that took the name over after the original moved away (PR
 * #223 review).
 *
 * Being in the tree is not on its own an answer. A bead written before `src/a.ts` was renamed to
 * `src/b.ts` cites a name an unrelated file was later committed at, and reading only the worktree
 * calls that pointer good — so a Context that ALSO cites something followable would be rewritten,
 * stamped repaired and retried with `src/a.ts` still aimed at the wrong file. `--follow` reports the
 * rename away, because a plain re-add does not switch the name the walk is following.
 *
 * Returns the refusal's reason, or `undefined` when the citation still names its own file.
 */
async function recreatedAtCitedPath(
  worktreePath: string,
  path: string,
): Promise<string | undefined> {
  const removal = await removalSince(worktreePath, path);
  if (removal === undefined) return undefined;
  if ("unreadable" in removal) return removal.unreadable;
  return (
    `\`${path}\` is in the worktree, but git records the file that wore that name ${removal.how} — ` +
    `what sits there now was committed afterwards, so it is not the file the bead pointed at`
  );
}

/**
 * Check one cited path against the worktree and, when it is gone, follow it through git history.
 *
 * Both reads are the WORKTREE's, not the project checkout's: a worktree is a full git checkout on
 * the run's own branch, and that branch is where the rename the agent tripped over actually is. The
 * main checkout may be several merges behind it.
 *
 * The follow is a chain, not a single lookup: a file renamed twice is still one pointer with one
 * current home, and stopping at the first hop would rewrite the bead to a path that is also missing.
 * Every way the chain fails to end at a file that is actually THERE is `unresolved` — there is no
 * branch here that returns a best guess.
 */
export async function verifyCitedPath(worktreePath: string, path: string): Promise<PathVerdict> {
  // `present` is a claim about the TREE and nothing more. Whether what sits there is the file the
  // bead meant is {@link recreatedAtCitedPath}'s question, and {@link repairRefStale} asks it only
  // once a repair is actually in play — see the vetting there (PR #223 review).
  if (await inWorktree(worktreePath, path)) return { path, state: "present" };
  const trail = [path];
  let cur = path;
  for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
    let history: PathHistory;
    try {
      history = await readPathHistory(worktreePath, cur);
    } catch (e) {
      // An unreadable history is not an absent rename: it is anton failing to check, and the one
      // answer it must never infer from that is "there is nowhere for this to have gone".
      const detail = e instanceof Error ? e.message : String(e);
      return { path, state: "unresolved", why: `git history for \`${cur}\` could not be read (${detail})` };
    }
    if (history.renamedTo.length > 1) {
      return {
        path,
        state: "unresolved",
        why:
          `\`${cur}\` has stood for more than one file — git records it renamed to ` +
          `${history.renamedTo.map((p) => `\`${p}\``).join(" and ")}, so which one the bead meant ` +
          `is not something history answers`,
      };
    }
    if (history.renames > 1) {
      // The same destination twice is not one rename (PR #223 review): the path had to be recreated
      // between those commits, so it has stood for two files just as surely as two destinations
      // would mean — and the latest `to` is an incarnation the bead may never have pointed at.
      return {
        path,
        state: "unresolved",
        why:
          `\`${cur}\` was renamed to \`${history.renamedTo[0]}\` ${history.renames} times — the ` +
          `path was recreated between those commits, so the name has stood for more than one file ` +
          `and which one the bead meant is not something history answers`,
      };
    }
    if (history.deleted && history.renamedTo.length === 1) {
      // Deleted AND renamed is the same ambiguity as two renames wearing one name: the path was
      // removed outright, later recreated by something else, and it is that unrelated file the
      // rename carries. Following it would rewrite the pointer to a file the bead never meant.
      return {
        path,
        state: "unresolved",
        why:
          `\`${cur}\` was both deleted and renamed — git records it removed outright and, in another ` +
          `commit, renamed to \`${history.renamedTo[0]}\`, so the name has stood for more than one ` +
          `file and which one the bead meant is not something history answers`,
      };
    }
    if (history.renamedTo.length === 0) {
      return {
        path,
        state: "unresolved",
        why: history.deleted
          ? `\`${cur}\` was deleted, not renamed — there is nothing to point at`
          : `git records no rename for \`${cur}\``,
      };
    }
    const next = history.renamedTo[0]!;
    if (trail.includes(next)) {
      return { path, state: "unresolved", why: `the rename history of \`${path}\` loops` };
    }
    trail.push(next);
    cur = next;
    if (await inWorktree(worktreePath, cur)) {
      const recreated = await recreatedSinceRename(worktreePath, cur);
      return recreated === undefined
        ? { path, state: "moved", to: cur, trail }
        : { path, state: "unresolved", why: recreated };
    }
  }
  return {
    path,
    state: "unresolved",
    why: `\`${path}\` was renamed more than ${MAX_RENAME_HOPS} times without landing on a file that ` +
      `is in the worktree`,
  };
}

/** A pointer this repair rewrote, as the bead's note reports it. */
export interface PathRewrite {
  from: string;
  to: string;
}

/**
 * What the repair decided. `none` is not a failure — it means the block was not `ref-stale` after
 * all (every path the bead cites is right there), so the caller's existing block handling stands
 * untouched.
 */
export type RefStaleOutcome =
  | { action: "none"; why: string }
  /**
   * The rewrite landed. `label` is absent only when the stamp that follows it failed — the fix
   * stands unstamped rather than being taken back; see {@link stampRewrite}.
   */
  | { action: "repaired"; label?: string; description: string; rewrites: PathRewrite[]; attempted: string }
  /**
   * Armed at `shadow`: the rewrite anton worked out and did NOT write. Carries the same fields the
   * armed outcome does, minus the stamp — there is no label because nothing was stamped, and the
   * caller must go on settling the block exactly as it would have without a repair.
   */
  | { action: "shadow"; description: string; rewrites: PathRewrite[]; attempted: string }
  | { action: "escalate"; why: string; evidence: string[]; prior?: RepairAttempt };

/** The bead as this repair reads it — its labels and notes for the guard, its description to fix. */
export interface RefStaleBead extends RepairedBead {
  description?: string;
}

/**
 * Verify the bead's pointers, follow what moved, rewrite the Context — or refuse.
 *
 * ORDER is load-bearing. Staleness is established BEFORE the loop guard is consulted, because
 * {@link decideRepair} answers "may anton repair this bead for this class", and asking it about a
 * bead whose paths are all fine would escalate an unrelated block on the strength of a repair that
 * has nothing to do with it. Facts first, then permission.
 *
 * The WRITE order is repair.ts's: the description, then the stamp. A crash between them leaves a
 * bead that is correct and unstamped — it can be repaired again, which is the survivable direction.
 * The reverse would leave a bead stamped for a repair that never landed and no second attempt
 * allowed. A stamp that FAILS rather than crashing is settled the same way, deliberately — see
 * {@link stampRewrite}.
 */
export async function repairRefStale(args: {
  /** Where bd writes go — the project's beads workspace. */
  repoPath: string;
  /** The checkout the pointers are verified against and whose history is followed — the RUN's. */
  worktreePath: string;
  bead: RefStaleBead;
  /** The block being repaired — its reason rides into the escalation. */
  block: { reason?: string };
  /** Unix milliseconds, stamped on the repair label so the breaker can order failures against it. */
  now: number;
  /** How far this project lets anton go with `ref-stale` (R5.3) — see repair-autonomy.ts. */
  autonomy: ProposalAutonomy;
}): Promise<RefStaleOutcome> {
  const { repoPath, worktreePath, bead, block, now, autonomy } = args;
  const description = bead.description ?? "";
  const spans = contextSpans(description);
  if (spans.length === 0) return { action: "none", why: `${bead.id} states no \`## Context\` to check` };

  const sections = spans.map((span) => ({ span, citations: citedPaths(span.body) }));
  const citations = sections.flatMap((s) => s.citations);
  if (citations.length === 0) {
    return { action: "none", why: `${bead.id}'s \`## Context\` cites no file paths` };
  }

  const cited = [...new Set(citations.map((c) => c.path))];
  const verdicts = await Promise.all(cited.map((path) => verifyCitedPath(worktreePath, path)));
  const stale = verdicts.filter((v) => v.state !== "present");
  if (stale.length === 0) {
    return {
      action: "none",
      why: `every path ${bead.id} cites is in the worktree, so its block is not \`${KLASS}\``,
    };
  }

  const decision = decideRepair(bead, KLASS, block, autonomy);
  if (decision.action === "escalate") return { ...decision };

  // A path that is in the tree is only a good pointer if the file THERE is the one the bead meant,
  // and that is a history read — vetted here rather than in `verifyCitedPath` so it costs nothing,
  // and escalates nothing, on a bead whose block turned out not to be `ref-stale` at all. Once
  // something IS stale the vetting is load-bearing: a repair that rewrote the followable pointer and
  // left a reincarnated one alone would stamp the bead repaired and earn it a retry still aimed at
  // the wrong file (PR #223 review).
  const present = verdicts.flatMap((v) => (v.state === "present" ? [v.path] : []));
  const reincarnated = await Promise.all(
    present.map(async (path) => {
      const why = await recreatedAtCitedPath(worktreePath, path);
      return why === undefined ? [] : [{ path, why }];
    }),
  );

  const unresolved = [
    ...stale.flatMap((v) => (v.state === "unresolved" ? [v] : [])),
    ...reincarnated.flat(),
  ];
  if (unresolved.length > 0) {
    return {
      action: "escalate",
      why:
        `${bead.id} cites ${unresolved.length} path(s) that git history does not resolve to the file ` +
        `the bead meant — anton will not guess a replacement, so this needs a human.`,
      evidence: unresolved.map((v) => `\`${v.path}\`: ${v.why}`),
    };
  }

  const moved = stale.flatMap((v) => (v.state === "moved" ? [v] : []));
  const rewrites: PathRewrite[] = moved.map((v) => ({ from: v.path, to: v.to }));
  const rewritten = rewriteContexts(description, sections, rewrites);
  const attempted = `rewrote ${bead.id}'s \`## Context\` pointer(s): ${rewrites
    .map((r) => `\`${r.from}\` → \`${r.to}\``)
    .join(", ")}`;

  // Everything above is a READ — the tree, git's history, the bead's own prose — so the shadow is
  // the armed answer with the two writes removed, not a second implementation that agrees with it
  // until the day it doesn't.
  if (decision.action === "shadow") {
    return { action: "shadow", description: rewritten, rewrites, attempted };
  }

  await beads.update(repoPath, bead.id, { description: rewritten }, bead.labels);
  const label = await stampRewrite(repoPath, bead, attempted, now);
  return { action: "repaired", ...(label ? { label } : {}), description: rewritten, rewrites, attempted };
}

/**
 * Stamp a rewrite that has ALREADY landed — and keep the repair when the stamp is what failed.
 *
 * The opposite of `dep-missing`'s answer to the same window ({@link revertPrereqEdge}), because the
 * two writes are not the same kind of thing. An unrecorded `blocks` edge holds other work back with
 * nothing on the board explaining it, so that repair takes its edge back; a rewritten pointer is
 * simply CORRECT — taking it back would restore a path that points nowhere and block the ticket on
 * a fact anton had already resolved. So the rewrite stands and the ticket is re-queued (PR #223
 * review). Rejecting here instead would settle the block with the bead already fixed, and the fix
 * would never be found again: the next pass sees every path present and answers `none`.
 *
 * What the missing stamp costs is the breaker's double weight on a later failure (R5.8), not the
 * loop guard (R5.6) — for that same reason a second `ref-stale` pass over this bead answers `none`
 * whether or not a label suppresses it. The note is best-effort, and says the fix landed unstamped
 * so a human reading the bead is not left with a silently rewritten description.
 */
async function stampRewrite(
  repoPath: string,
  bead: RefStaleBead,
  attempted: string,
  now: number,
): Promise<string | undefined> {
  try {
    return await recordRepair(repoPath, bead, KLASS, attempted, now);
  } catch (e) {
    console.error(`[repair] ${bead.id} was rewritten but its repair could not be stamped`, e);
    await beads.note(repoPath, bead.id, unstampedNote(KLASS, attempted)).catch(() => {});
    return undefined;
  }
}

/**
 * Swap the moved pointers inside every Context span, leaving all other bytes of the description
 * alone.
 *
 * Applied back-to-front — the spans and, within each, the citations — so each replacement's offsets
 * stay valid, and only at the offsets {@link citedPaths} actually validated: a bead whose prose
 * happens to contain the same characters outside a citation keeps them.
 *
 * A leading `./` the author wrote is carried onto the replacement (PR #223 review). `citedPaths`
 * normalises it away and git reports the destination without one, so the naive swap turns
 * `./src/a.ts` into `src/b.ts` — resolving identically, but changing the bead's formatting under a
 * founder who has to read the result. The repair moves the pointer and nothing else.
 */
function rewriteContexts(
  description: string,
  sections: { span: ContextSpan; citations: PathCitation[] }[],
  rewrites: PathRewrite[],
): string {
  const to = new Map(rewrites.map((r) => [r.from, r.to]));
  let out = description;
  for (const { span, citations } of [...sections].sort((a, b) => b.span.start - a.span.start)) {
    let body = span.body;
    for (const citation of [...citations].sort((a, b) => b.index - a.index)) {
      const next = to.get(citation.path);
      if (!next) continue;
      const written = citation.text.startsWith("./") ? `./${next}` : next;
      body =
        body.slice(0, citation.index) + written + body.slice(citation.index + citation.text.length);
    }
    out = out.slice(0, span.start) + body + out.slice(span.end);
  }
  return out;
}

/**
 * The note anton leaves when it REFUSED a `ref-stale` repair — the class bound to the shared
 * formatter ({@link refusal}), so every repair's refusal reads the same way on a bead.
 */
export function refusalNote(outcome: Extract<RefStaleOutcome, { action: "escalate" }>): string {
  return refusal(KLASS, outcome);
}
