/**
 * The `ref-stale` repair (anton-fzas / R5.4) — the bead cites a file that moved, so anton follows
 * the rename and rewrites the pointer.
 *
 * This is the safest repair class by a wide margin, and the reason is that NOTHING here is inferred.
 * Every step is a fact the worktree or git's own history answers:
 *
 *   • the path is in the tree, or it is not;
 *   • git recorded exactly one destination for it, or it did not;
 *   • that destination is in the tree, or it is not.
 *
 * Refusing to guess is what keeps that true, so the module escalates on every reading that is not
 * one of those three yeses — a delete, a name that has stood for two different files, a chain that
 * runs past its bound, a destination that is itself missing. A partial answer is not a repair: if
 * ANY stale path fails to resolve, nothing is rewritten at all, because a bead half-corrected still
 * points somewhere wrong and the retry it would earn is a run spent proving that.
 *
 * What it rewrites is the `## Context` section and nothing else. Out of scope by construction: prose
 * that merely MENTIONS a file (a citation is a repo-relative path with a directory and an extension,
 * not a sentence about a module), and symbols — only paths.
 *
 * The loop guard and the trust dial are both repair.ts's, unchanged: {@link decideRepair} decides
 * whether this bead may be repaired for this class at all — a second `ref-stale` block on a bead
 * anton already repaired escalates rather than repairing again (R5.6), and a project that has not
 * armed the class gets the rewrite WORKED OUT and recorded rather than written (R5.3).
 */
import { beads } from "../beads/bd";
import { scanMarkdown } from "../beads/markdown";
import { readPathHistory, type PathHistory } from "../git/ops";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  decideRepair,
  recordRepair,
  refusalNote as refusal,
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
 * Every place the given text cites a path, in order — one entry per OCCURRENCE, so a Context that
 * names the same moved file twice can be rewritten in both places rather than half-corrected.
 *
 * Occurrences rather than paths is also what keeps the rewrite honest: each carries the offset the
 * boundary checks below actually validated, so nothing is re-found by a bare substring search that
 * would happily match `src/a.ts` inside `vendor/src/a.tsx`.
 *
 * A path that climbs out of the repository (`..`) or starts at the filesystem root is not a citation
 * this repair will touch: it names something outside the tree anton is allowed to reason about, and
 * "resolve it against the worktree" has no meaning there.
 */
export function citedPaths(text: string): PathCitation[] {
  const out: PathCitation[] = [];
  for (const match of text.matchAll(CITED_PATH)) {
    const index = match.index ?? 0;
    const before = index > 0 ? text[index - 1]! : "";
    const after = text[index + match[0].length] ?? "";
    if (NOT_A_CITATION_BOUNDARY.test(before) || CITATION_TAIL.test(after)) continue;
    const path = match[0].replace(/^\.\//, "");
    if (path.startsWith("/") || path.split("/").includes("..")) continue;
    out.push({ path, text: match[0], index });
  }
  return out;
}

/** The `## Context` section's slice of a description — where it starts, where it ends, what it says. */
export interface ContextSpan {
  start: number;
  end: number;
  body: string;
}

/**
 * Locate the bead's `## Context` body inside its description, as offsets rather than text.
 *
 * Offsets, because this repair REWRITES in place: the surrounding contract (Goal, Acceptance,
 * Verify) has to come back byte-identical, and re-rendering a parsed description would quietly
 * reformat sections nobody asked anton to touch. The section runs to the next heading at its own
 * depth or shallower — a `### Files` grouping beneath it is still Context.
 *
 * Fences and HTML comments are honoured through {@link scanMarkdown}, so a `## Context` quoted
 * inside a code block opens no section here, exactly as it opens none for the contract gate.
 */
export function contextSpan(description: string): ContextSpan | undefined {
  const lines = scanMarkdown(description);
  let start: number | undefined;
  let depth = 0;
  let offset = 0;
  let end = description.length;
  for (const line of lines) {
    const lineEnd = offset + line.text.length;
    if (start === undefined) {
      if (line.heading?.key === "context") {
        start = Math.min(lineEnd + 1, description.length);
        depth = line.heading.depth;
      }
    } else if (line.heading && line.heading.depth <= depth) {
      end = Math.max(start, offset);
      break;
    }
    offset = lineEnd + 1;
  }
  if (start === undefined) return undefined;
  return { start, end, body: description.slice(start, end) };
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
    if (await inWorktree(worktreePath, cur)) return { path, state: "moved", to: cur, trail };
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
  | { action: "repaired"; label: string; description: string; rewrites: PathRewrite[]; attempted: string }
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
 * allowed.
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
  const span = contextSpan(description);
  if (!span) return { action: "none", why: `${bead.id} states no \`## Context\` to check` };

  const citations = citedPaths(span.body);
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

  const unresolved = stale.filter((v) => v.state === "unresolved");
  if (unresolved.length > 0) {
    return {
      action: "escalate",
      why:
        `${bead.id} cites ${unresolved.length} path(s) that are not in the worktree and that git ` +
        `history does not resolve — anton will not guess a replacement, so this needs a human.`,
      evidence: unresolved.map((v) => `\`${v.path}\`: ${v.why}`),
    };
  }

  const moved = stale.flatMap((v) => (v.state === "moved" ? [v] : []));
  const rewrites: PathRewrite[] = moved.map((v) => ({ from: v.path, to: v.to }));
  const rewritten = rewriteContext(description, span, citations, rewrites);
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
  const label = await recordRepair(repoPath, bead, KLASS, attempted, now);
  return { action: "repaired", label, description: rewritten, rewrites, attempted };
}

/**
 * Swap the moved pointers inside the Context span, leaving every other byte of the description alone.
 *
 * Applied back-to-front so each replacement's offsets stay valid, and only at the offsets
 * {@link citedPaths} actually validated — a bead whose prose happens to contain the same characters
 * outside a citation keeps them.
 */
function rewriteContext(
  description: string,
  span: ContextSpan,
  citations: PathCitation[],
  rewrites: PathRewrite[],
): string {
  const to = new Map(rewrites.map((r) => [r.from, r.to]));
  let body = span.body;
  for (const citation of [...citations].sort((a, b) => b.index - a.index)) {
    const next = to.get(citation.path);
    if (!next) continue;
    body =
      body.slice(0, citation.index) + next + body.slice(citation.index + citation.text.length);
  }
  return description.slice(0, span.start) + body + description.slice(span.end);
}

/**
 * The note anton leaves when it REFUSED a `ref-stale` repair — the class bound to the shared
 * formatter ({@link refusal}), so every repair's refusal reads the same way on a bead.
 */
export function refusalNote(outcome: Extract<RefStaleOutcome, { action: "escalate" }>): string {
  return refusal(KLASS, outcome);
}
