/**
 * The `already-shipped` repair (anton-9a4m, anton-5bpd) — the agent says the ticket's work already
 * landed, and this is anton asking the board and the repository whether that is true, then retiring
 * the ticket against the answer.
 *
 * TWO HALVES, and the order between them is the whole safety property. {@link verifyShippedClaim} is
 * a pure CHECK that writes nothing; {@link repairAlreadyShipped} is the only thing that acts on it,
 * and it acts on nothing else. A retirement that could be reached without the check having returned
 * `verified` would settle a ticket on the strength of a sentence, which is exactly what the zero-diff
 * gate exists to refuse.
 *
 * The claim is the one place a run's own report asserts that NOTHING needs to change. Every other
 * block class describes something that stopped the work; this one describes work that is finished,
 * and acting on it settles a ticket on the strength of a sentence. So the sentence is never the
 * evidence: it is only how anton learns WHAT to look for. What it looks at is what git and bd
 * already hold — a commit the run's base contains, a bead the board has closed, a PR GitHub reports
 * merged — and a claim that names none of those is a claim about nothing checkable.
 *
 * FAIL CLOSED, which here means three separate things:
 *
 *   • Anything anton cannot check is a FAILED check, not a skipped one. A commit this repository has
 *     never seen, a PR `gh` could not read, a bead the board does not hold — each returns a stated
 *     failure. Nothing is fetched to make an unseen commit appear: going to the network mid-check
 *     would make the answer depend on when it was asked.
 *   • The claim is verified WHOLE or not at all. A reason naming a bead, a commit and a PR is three
 *     assertions, and half of them holding is not proof — a commit that is not in the base
 *     CONTRADICTS a closed bead beside it rather than being outvoted by it.
 *   • Existence and reachability ONLY. This says the named work is real and has landed. It does not
 *     — and cannot — say the landed work satisfies THIS ticket's acceptance criteria; that judgement
 *     is a human's, and the caller must never report it as one anton made.
 *
 * THE CHECK IS READ-ONLY BY CONSTRUCTION: no bd mutation, no note, no label, no fetch, no ref
 * update. Everything below {@link ShippedVerdict} is that check; everything below
 * {@link AlreadyShippedOutcome} is the repair, and it re-enters the check rather than reimplementing
 * any part of it.
 */
import { beads, type Bead } from "../beads/bd";
import { withBeadWriteLocks } from "../beads/claim-lock";
import { loadAllIssues } from "../beads/issues";
import { pullRequestState, readCommitReach, type PullRequestState } from "../git/ops";
import { beadIdsNamedIn, indexBoard, isOpenWork, type BoardIndex } from "./board-index";
import type { ProposalAutonomy } from "./autonomy";
import {
  decideRepair,
  recordRepair,
  refusalNote as refusal,
  unstampedNote,
  type RepairAttempt,
  type RepairedBead,
} from "./repair";

/** The class this module repairs. Named once so the guard, the stamp and the prose cannot drift. */
const KLASS = "already-shipped" as const;

/**
 * A commit sha as it appears in prose — 7 to 40 hex characters, standing alone.
 *
 * The boundaries reject a hex run that is part of a longer token: a bead id's suffix (`anton-fade1`),
 * a hyphenated identifier, a word carrying one. What they deliberately do NOT reject is an ordinary
 * English word made only of hex letters ("defaced"), because the alternative — demanding a digit —
 * would silently DROP the rare real sha that has none, and a dropped citation is a check that never
 * ran. A word read as a commit costs a refusal a human sees; a sha read as a word costs a claim
 * verified on less than it named.
 */
const SHA_PATTERN = /(?<![\w-])[0-9a-fA-F]{7,40}(?![\w-])/g;

/** A pull request as it appears in prose — `#85`, `PR #85`, or any github `…/pull/85` url. */
const PR_PATTERN = /(?:#|\/pull\/)(\d+)/g;

/** Every commit the reason cites, lower-cased and de-duplicated in the order written. */
export function claimedCommits(reason: string | undefined): string[] {
  if (!reason) return [];
  return [...new Set([...reason.matchAll(SHA_PATTERN)].map((m) => m[0].toLowerCase()))];
}

/**
 * Every PR the reason cites, as the `gh-<n>` ref beads uses — the same form
 * {@link pullRequestState} takes, so a PR named in prose and one read off a bead are checked by one
 * code path.
 */
export function claimedPullRequests(reason: string | undefined): string[] {
  if (!reason) return [];
  return [...new Set([...reason.matchAll(PR_PATTERN)].map((m) => `gh-${m[1]}`))];
}

/**
 * What the check answers.
 *
 * `proof` carries one line per check that PASSED, in the order the checks ran — the evidence a
 * retirement is allowed to point at, and, on a failure, the part of the claim that did hold. It is
 * never a reason to retire on its own: only `verified` is.
 */
export type ShippedVerdict =
  | { state: "verified"; proof: string[] }
  | { state: "unverified"; why: string; proof: string[] };

/**
 * The whole-board read the claim is checked against — through `loadAllIssues` rather than a bare
 * `bd list --status all`, for the reason repair-dep-missing.ts gives: that flag is unsupported on
 * some bd versions, and a read that throws is swallowed by the caller's outer catch, silently
 * turning every check on such a bd into an escalation.
 *
 * GATE-COMPLETE for the same reason it is there: this read is what tells a bead that genuinely
 * closed from one bd omits from the ordinary listing.
 */
function readBoard(repoPath: string): Promise<Bead[]> {
  return loadAllIssues(repoPath, { strictGates: true });
}

/**
 * Check the agent's `already-shipped` claim against the repository and the board.
 *
 * Reads only (see the module header). Returns `unverified` with the failed check stated for every
 * reading that is not proof — including the one the caller most needs named: a claim that cites
 * nothing anton can check at all.
 */
export async function verifyShippedClaim(args: {
  /** The project repository — bd's workspace, and the git repo whose refs and objects are read. */
  repoPath: string;
  /**
   * The ref the run forked from, as the run resolved it (`baseRef`). Work "has shipped" when this
   * ref's history CONTAINS it — see {@link readCommitReach} for why the other direction proves
   * nothing.
   */
  base: string;
  /** The ticket whose block is being checked — it cannot be the evidence for its own retirement. */
  targetId: string;
  /** The agent's stated reason: the claim, and the only place the evidence is named. */
  reason?: string;
  /** The board to check against. Read fresh when absent — the run's snapshot predates the session. */
  board?: Bead[];
}): Promise<ShippedVerdict> {
  const { repoPath, base, targetId, reason } = args;
  const index = indexBoard(args.board ?? (await readBoard(repoPath)));
  const commits = claimedCommits(reason);
  const namedBeads = beadIdsNamedIn(index, reason).filter((id) => id !== targetId);
  const prs = claimedPullRequests(reason);

  if (commits.length === 0 && namedBeads.length === 0 && prs.length === 0) {
    return {
      state: "unverified",
      proof: [],
      why: reason
        ? `the claim names no commit, bead or PR anton can check ("${reason.trim()}") — anton ` +
          `verifies work that landed, it does not take the report's word for it`
        : `the agent claimed the work already shipped and named nothing that shipped it`,
    };
  }

  const proof: string[] = [];
  // One state per PR however many times it is named — a bead's own ref and the number written in the
  // prose are routinely the same PR, and `gh` is a network call.
  const prStates = new Map<string, PullRequestState>();
  const readPr = async (ref: string): Promise<PullRequestState> => {
    const cached = prStates.get(ref);
    if (cached) return cached;
    const state = await pullRequestState(repoPath, ref);
    prStates.set(ref, state);
    return state;
  };

  for (const commit of commits) {
    const reach = await readCommitReach(repoPath, commit, base);
    switch (reach.state) {
      case "reaches":
        proof.push(`commit \`${reach.sha.slice(0, 10)}\` is in the history of the run's base (${base})`);
        break;
      case "outside":
        return {
          state: "unverified",
          proof,
          why:
            `commit \`${commit}\` exists but ${base} does not contain it — whatever it carries has ` +
            `not landed in what this run builds on`,
        };
      case "absent":
        return {
          state: "unverified",
          proof,
          why:
            `\`${commit}\` is named as the commit that shipped this, but no such commit is in this ` +
            `repository — anton does not fetch to make a claimed commit appear`,
        };
      case "unreadable":
        return {
          state: "unverified",
          proof,
          why: `whether \`${commit}\` reaches ${base} could not be read (${reach.detail})`,
        };
    }
  }

  for (const id of namedBeads) {
    const bead = index.byId.get(id);
    if (!bead) {
      return {
        state: "unverified",
        proof,
        why: `\`${id}\` is named as having shipped this work, but the board holds no such bead`,
      };
    }
    // ABANDONED is closed without having landed anything — the one status where bd's own "closed"
    // and "the work exists" come apart. A merged PR still redeems it below: what shipped is what
    // shipped, whatever the bead was later labelled.
    const abandoned = beads.isAbandoned(bead);
    if (bead.status === "closed" && !abandoned) {
      proof.push(`\`${id}\` is closed on the board`);
      continue;
    }
    const pr = beads.getPrRef(bead);
    const standing = abandoned ? "abandoned" : bead.status;
    if (!pr) {
      return {
        state: "unverified",
        proof,
        why:
          `\`${id}\` is named as having shipped this work, but the board still holds it as ` +
          `${standing} and it points at no PR — nothing there says its work landed`,
      };
    }
    const state = await readPr(pr);
    if (state === "merged") {
      proof.push(`\`${id}\` is ${standing}, but its PR (${pr}) is merged`);
      continue;
    }
    return {
      state: "unverified",
      proof,
      why:
        state === "unknown"
          ? `\`${id}\` is ${standing} and anton could not read the state of its PR (${pr}) — ` +
            `whether that work landed is exactly what the claim rests on`
          : `\`${id}\` is ${standing} and its PR (${pr}) is ${state}, not merged`,
    };
  }

  for (const pr of prs) {
    const state = await readPr(pr);
    if (state === "merged") {
      proof.push(`PR ${pr} is merged`);
      continue;
    }
    return {
      state: "unverified",
      proof,
      why:
        state === "unknown"
          ? `the claim names PR ${pr} and anton could not read its state — an unreadable PR is an ` +
            `unchecked claim, not a merged one`
          : `the claim names PR ${pr}, which is ${state}, not merged`,
    };
  }

  return { state: "verified", proof };
}

/**
 * The one sentence a caller may say on a verified claim, and the line it may not cross.
 *
 * Written here rather than at the call site so the SCOPE of what was checked travels with the
 * evidence: anton proved the named work exists and has landed, and nothing about whether it is this
 * ticket's work.
 *
 * ONE LINE, because a bead's notes blob is line-delimited (beads/notes.ts): a multi-line note parses
 * back as several, the later ones attributed to anton with no context at all. So the checks are
 * joined with `;` rather than bulleted — this is the note a retirement's whole justification lives
 * in, and half of it losing its attribution is exactly the record that must not rot.
 */
export function shippedEvidenceNote(verdict: { proof: string[] }): string {
  return (
    `anton: verified the already-shipped claim against the repository and the board — ` +
    `${verdict.proof.join("; ")}. Existence and reachability only — anton did not judge whether ` +
    `that work meets this ticket's acceptance criteria.`
  ).replace(/\s+/g, " ");
}

/**
 * Which bead the ticket retires AGAINST, or why no bead on the board can be that.
 *
 * `supersede` names a survivor, and that is the whole difference between this retirement and a plain
 * close: a reader following the graph finds where the work actually landed without parsing prose. So
 * a verified claim is not enough on its own — the claim also has to point at exactly one bead this
 * board holds.
 */
export type ShipperVerdict = { state: "resolved"; id: string } | { state: "unresolved"; why: string };

/**
 * Resolve the bead the claim says shipped this work, and refuse every reading that is not exactly
 * one.
 *
 * CARDINALITY BEFORE MEMBERSHIP, for the reason `resolvePrereq` states (repair-dep-missing.ts): a
 * reason naming two ids is ambiguous whether or not both are real, and the one that missed may be
 * the mistyped form of the bead actually meant. `bd supersede` takes ONE survivor, and picking it by
 * position would point the retirement at whichever id the agent happened to write first.
 *
 * A claim that names a commit or a PR but NO bead is refused here too, and deliberately: the work may
 * well have landed, but nothing on the board carries it, so there is no survivor to point at. That is
 * a human's call — closing the ticket on a bare commit is a different verb with a different meaning.
 */
export function resolveShipper(
  index: BoardIndex,
  targetId: string,
  reason: string | undefined,
): ShipperVerdict {
  const candidates = beadIdsNamedIn(index, reason).filter((id) => id !== targetId);
  if (candidates.length === 0) {
    return {
      state: "unresolved",
      why: reason
        ? `the claim names no bead id anton can resolve ("${reason.trim()}") — a supersede has to ` +
          `name the bead the work landed under, and anton will not close a ticket against prose`
        : `the agent claimed the work already shipped and named no bead that shipped it`,
    };
  }
  if (candidates.length > 1) {
    return {
      state: "unresolved",
      why:
        `the claim names ${candidates.length} bead ids ` +
        `(${candidates.map((id) => `\`${id}\``).join(", ")}) — which one this ticket is superseded ` +
        `by is not something it answers, and anton will not pick one`,
    };
  }
  const id = candidates[0]!;
  if (!index.byId.has(id)) {
    return {
      state: "unresolved",
      why: `\`${id}\` is named as having shipped this work, but the board holds no such bead`,
    };
  }
  return { state: "resolved", id };
}

/**
 * What the repair decided.
 *
 * `retired` rather than `repaired`, because the caller must not treat it like `ref-stale`'s rewrite:
 * that one corrects a bead and earns a retry, this one settles the bead for good. There is nothing
 * left to run, so the run carries on with the REST of its tickets instead (anton-5bpd).
 */
export type AlreadyShippedOutcome =
  /**
   * Armed at `shadow`: the survivor anton resolved, the evidence it checked, and the retirement it
   * did NOT write. No stamp, because nothing happened to the bead — so the caller settles the block
   * exactly as it would have without a repair.
   */
  | { action: "shadow"; replacementId: string; proof: string[]; attempted: string }
  | {
      action: "retired";
      /** The repair stamp written on the ticket; absent when the stamp itself failed. */
      label?: string;
      /** The survivor the `supersedes` edge now points at. */
      replacementId: string;
      /** One line per check that passed — the evidence the note on the bead carries. */
      proof: string[];
      attempted: string;
    }
  | { action: "escalate"; why: string; evidence: string[]; prior?: RepairAttempt };

/**
 * Retire a ticket whose work already landed — or refuse, which is the answer for everything that is
 * not a claim anton could check WHOLE.
 *
 * THE ORDER OF THE GATES is the design:
 *
 *   1. A ticket that COMMITTED in this run contradicts its own claim, and that is decided before
 *      anything else because it costs no read and no autonomy level makes it acceptable. The agent
 *      says nothing needed to change and the branch says something did; retiring would close a
 *      ticket whose diff is in the run's own pull request, attributed to work that shipped
 *      elsewhere.
 *   2. The loop guard and the trust dial ({@link decideRepair}), asked next for `dep-missing`'s
 *      reason: the CLASS here is the agent's own report and nothing about the bead asserts it, so a
 *      second `already-shipped` block on a ticket anton already retired is a diagnosis that has been
 *      disproved — and that answer costs no board read to give (R5.6).
 *   3. The SURVIVOR, then the CLAIM. Resolving the survivor is a board read; verifying reaches git
 *      and possibly `gh`, so the cheap refusal runs first.
 *
 * The WRITE order is the evidence note, then the supersede, then the stamp — and it is deliberately
 * not `dep-missing`'s. A note is a statement, not a fix: written first, a failure that follows leaves
 * a bead saying truthfully what anton verified and still blocked for a human, while the reverse order
 * could settle a ticket with nothing on it explaining why. Nothing is ever taken back: un-superseding
 * a bead is not an undo, it is a second decision about work that has already landed.
 */
export async function repairAlreadyShipped(args: {
  /** Where bd writes go — the project's beads workspace, and the git repo the claim is checked in. */
  repoPath: string;
  /** The ref the run forked from — what "has landed" is measured against (`baseRef`). */
  base: string;
  bead: RepairedBead;
  /** The block being repaired — its reason carries the claim, and rides into the record. */
  block: { reason?: string };
  /** Whether this ticket's work reached a commit on the run's branch — see gate 1 above. */
  committed: boolean;
  /** Unix milliseconds, stamped on the repair label so the breaker can order failures against it. */
  now: number;
  /** How far this project lets anton go with `already-shipped` (R5.3) — see repair-autonomy.ts. */
  autonomy: ProposalAutonomy;
  /** The board to check against. Read fresh when absent — the run's snapshot predates the session. */
  board?: Bead[];
}): Promise<AlreadyShippedOutcome> {
  const { repoPath, base, bead, block, committed, now, autonomy } = args;
  const claim = block.reason?.trim() || "(no reason given)";

  if (committed) {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but this run committed changes for it — the claim that ` +
        `nothing needed to change is contradicted by the branch, so anton retired nothing.`,
      evidence: [
        `the agent reported: ${claim}`,
        `its work is in this run's diff, so closing the ticket as superseded would file that diff ` +
          `under work that shipped somewhere else`,
      ],
    };
  }

  const decision = decideRepair(bead, KLASS, block, autonomy);
  if (decision.action === "escalate") return { ...decision };

  const board = args.board ?? (await readBoard(repoPath));
  const index = indexBoard(board);
  const shipper = resolveShipper(index, bead.id, block.reason);
  if (shipper.state === "unresolved") {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but anton could not resolve the bead it says shipped ` +
        `the work — a supersede points at a survivor, so this needs a human.`,
      evidence: [shipper.why],
    };
  }
  const replacementId = shipper.id;

  // Settling a bead with open work beneath it leaves those children hanging off a card no run can
  // reach — the same bar `retire.ts` holds its own supersede proposals to, and apply re-checks under
  // the lock. A subtree is retired from the bottom up or not at all.
  const stranded = index.openDescendants(bead.id);
  if (stranded.length > 0) {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but open work still sits beneath it — closing it as ` +
        `superseded would strand that work under a card no run can reach.`,
      evidence: [
        `still open below ${bead.id}: ${stranded.map((b) => b.id).join(", ")}`,
        `the agent reported: ${claim}`,
      ],
    };
  }

  const verdict = await verifyShippedClaim({
    repoPath,
    base,
    targetId: bead.id,
    reason: block.reason,
    board,
  });
  if (verdict.state === "unverified") {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, and anton could NOT verify that the work landed — the ` +
        `ticket stays blocked for a human, exactly as an unclassified block would.`,
      evidence: [
        `the failed check: ${verdict.why}`,
        ...(verdict.proof.length > 0 ? [`what did hold: ${verdict.proof.join("; ")}`] : []),
        `the agent reported: ${claim}`,
      ],
    };
  }

  const attempted =
    `retired ${bead.id} as superseded by ${replacementId} (bd supersede ${bead.id} --with ` +
    `${replacementId}) on verified evidence that the work already landed — the agent reported: ${claim}`;
  // Everything above is a READ — the board, git's history, GitHub's answer for a PR — so the shadow
  // is the armed answer with the three writes removed, not a second implementation of the decision.
  if (decision.action === "shadow") {
    return { action: "shadow", replacementId, proof: verdict.proof, attempted };
  }

  // Both beads' locks, and the ticket re-read inside them: the board this was decided against is a
  // snapshot, and the one thing a retirement cannot survive is somebody else having settled either
  // end of it in the window — an operator abandoning the ticket, another run closing it, the
  // survivor being reopened because its work turned out not to have landed after all.
  return withBeadWriteLocks(repoPath, [bead.id, replacementId], async () => {
    const moved = await retirementMoved(repoPath, bead.id, replacementId);
    if (moved) {
      return {
        action: "escalate",
        why:
          `${bead.id} blocked as \`${KLASS}\`, but the board moved between the check and the write — ` +
          `anton retired nothing rather than settle a ticket against evidence that had changed.`,
        evidence: [moved, `the retirement anton did not write: ${attempted}`],
      };
    }
    // The evidence FIRST (see the header): a note states what anton checked, and a bead carrying it
    // is honest whether or not the retirement below lands.
    await beads.note(repoPath, bead.id, shippedEvidenceNote(verdict));
    await beads.supersede(repoPath, bead.id, replacementId);
    let label: string | undefined;
    try {
      label = await recordRepair(repoPath, bead, KLASS, attempted, now);
    } catch (e) {
      // The retirement stands, for `ref-stale`'s reason ({@link unstampedNote}): the ticket is closed
      // and pointed at its survivor, and reopening it over a missing label would undo a correct
      // settlement to protect a guard the closed bead no longer needs.
      console.error(`[repair] ${bead.id} was retired as superseded but could not be stamped`, e);
      await beads.note(repoPath, bead.id, unstampedNote(KLASS, attempted)).catch(() => {});
    }
    return { action: "retired", ...(label ? { label } : {}), replacementId, proof: verdict.proof, attempted };
  });
}

/**
 * Why either end of the retirement is no longer what it was checked as, read fresh from bd at the
 * write — or undefined when both still are.
 *
 * A read that FAILED is a refusal rather than an assumption either way: anton closes a ticket against
 * a board it could check, and a `bd show` that broke is not a check.
 */
async function retirementMoved(
  repoPath: string,
  targetId: string,
  replacementId: string,
): Promise<string | undefined> {
  const read = async (id: string): Promise<Bead | string> => {
    try {
      const bead = await beads.show(repoPath, id);
      return bead?.id ? bead : `\`${id}\` is no longer on the board`;
    } catch (e) {
      return `\`${id}\` could not be re-read before the retirement (${e instanceof Error ? e.message : String(e)})`;
    }
  };
  const target = await read(targetId);
  if (typeof target === "string") return target;
  if (!isOpenWork(target)) {
    return (
      `${targetId} is already settled (${target.status}) — somebody else decided this ticket's ` +
      `outcome, and anton does not rewrite that`
    );
  }
  const replacement = await read(replacementId);
  if (typeof replacement === "string") return replacement;
  // Reopened and pointing at no PR is the one reading that TAKES BACK the verification: the survivor
  // is work in progress again, so it has not landed and nothing is superseded by it. A closed one —
  // or one reopened for rework with its merged PR still attached — is still where the work landed.
  if (isOpenWork(replacement) && !beads.getPrRef(replacement)) {
    return (
      `\`${replacementId}\` is open again (${replacement.status}) and points at no PR — it has not ` +
      `landed, so ${targetId} is not superseded by it`
    );
  }
  return undefined;
}

/**
 * The note anton leaves when it REFUSED an `already-shipped` repair — the class bound to the shared
 * formatter, so every repair's refusal reads the same way on a bead.
 */
export function refusalNote(outcome: Extract<AlreadyShippedOutcome, { action: "escalate" }>): string {
  return refusal(KLASS, outcome);
}
