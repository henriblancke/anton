/**
 * The `already-shipped` CHECK (anton-9a4m) — the agent says the ticket's work already landed, and
 * this is anton asking the board and the repository whether that is true.
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
 * READ-ONLY BY CONSTRUCTION. Nothing here writes: no bd mutation, no note, no label, no fetch, no
 * ref update. What to DO with a verified claim — retire the ticket as superseded, with this evidence
 * attached — is anton-leay's, and it must not be reachable from a check that could fail half-way.
 */
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { pullRequestState, readCommitReach, type PullRequestState } from "../git/ops";
import { beadIdsNamedIn, indexBoard } from "./board-index";

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
 */
export function shippedEvidenceNote(verdict: { proof: string[] }): string {
  return [
    `anton verified the already-shipped claim against the repository and the board:`,
    ...verdict.proof.map((line) => `  • ${line}`),
    `Existence and reachability only — anton did not judge whether that work meets this ticket's ` +
      `acceptance criteria.`,
  ].join("\n");
}
