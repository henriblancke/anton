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
 * already hold — a commit the run's base contains, a bead the board has closed, a PR whose merge
 * the run's base contains — and a claim that names none of those is a claim about nothing checkable.
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
import { beads, LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLocks } from "../beads/claim-lock";
import { loadAllIssues } from "../beads/issues";
import { humanNotesPromptBlock } from "../beads/notes";
import {
  newestPullRequestCommit,
  pullRequestCommitNaming,
  pullRequestCommitUnder,
  readCommitNaming,
  readCommitReach,
  readPullRequestCommits,
  readPullRequestMerge,
  type PullRequestCommits,
  type PullRequestState,
} from "../git/ops";
import {
  beadIdsNamedIn,
  indexBoard,
  isOpenWork,
  ticketOwnerOf,
  ticketPathOf,
  type BoardIndex,
} from "./board-index";
import { mustPersist } from "../jobs/execute-epic-persist";
import type { ProposalAutonomy } from "./autonomy";
import {
  decideRepair,
  recordRepair,
  refusalNote as refusal,
  unstampedNote,
  type RepairAttempt,
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

/**
 * A url, taken whole, so no segment of it is read as a sha (PR #238 review): the owner or repository
 * in `https://github.com/abcdefg/widgets/pull/85` stands alone between slashes exactly like a commit
 * does, and read as one it fails a claim that is otherwise sound against a commit this repository
 * never had. The one url segment that IS a citation — the sha under `/commit/` — is read by
 * {@link COMMIT_URL_SHA} from the url itself, so citing a commit by its GitHub link is not the
 * dropped citation the sha pattern's boundaries are careful to avoid.
 *
 * The token ends at the punctuation that separates one citation from the next without whitespace
 * (PR #238 review) — a comma or semicolon, a bracket or parenthesis, a quote or backtick, a pipe —
 * because a url that swallows its neighbour hides that neighbour from the check: in
 * `…/commit/aaaaaaa,bbbbbbb` the second sha, and in `[a](…/commit/aaaaaaa)[b](…/commit/bbbbbbb)`
 * the second link, would never be verified, and a claim whose omitted commit is absent from the
 * base would still retire the ticket on the half that held. None of these characters occurs in a
 * GitHub commit or PR url. A trailing full stop is left on the token: it delimits nothing here, and
 * the sha extractor's own boundary reads past it.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s,;()[\]<>"'`|]+/g;

/** Every sha a `…/commit/<sha>` (or `…/pull/<n>/commits/<sha>`) url cites. */
const COMMIT_URL_SHA = /\/commits?\/([0-9a-fA-F]{7,40})(?![\w-])/g;

/** A sha or a url, whichever comes first — one pass, so the citations keep the order written. */
const CITATION_PATTERN = new RegExp(`${URL_PATTERN.source}|${SHA_PATTERN.source}`, "g");

/** Every commit the reason cites, lower-cased and de-duplicated in the order written. */
export function claimedCommits(reason: string | undefined): string[] {
  if (!reason) return [];
  const cited: string[] = [];
  for (const [token] of reason.matchAll(CITATION_PATTERN)) {
    const shas = /^https?:/.test(token)
      ? [...token.matchAll(COMMIT_URL_SHA)].map((m) => m[1])
      : [token];
    for (const sha of shas) cited.push(sha.toLowerCase());
  }
  return [...new Set(cited)];
}

/**
 * A pull request as it appears in prose — `#85`, `PR #85`, or a `https://…/<owner>/<repo>/pull/85`
 * url. The url's repository is captured whole with the number (PR #238 review): `gh pr view` reads
 * a bare number in the CURRENT repository, so a url pointing at another one reduced to its number
 * would be checked against whatever PR this repository happens to hold under it.
 */
const PR_PATTERN = /\bhttps?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)\b|#(\d+)\b/g;

/**
 * Every PR the reason cites, in the form {@link readPullRequestLanding} takes — so a PR named in
 * prose and one read off a bead are checked by one code path. A bare number becomes the `gh-<n>`
 * ref beads uses; a url stays a url, which `gh` resolves in the repository it names. That is what
 * fails a citation of another repository's PR closed: its merge commit is one this repository has
 * never seen, so it never reaches the run's base.
 */
export function claimedPullRequests(reason: string | undefined): string[] {
  if (!reason) return [];
  return [...new Set([...reason.matchAll(PR_PATTERN)].map((m) => (m[2] ? `gh-${m[2]}` : m[0])))];
}

/**
 * What the check answers.
 *
 * `proof` carries one line per check that PASSED, in the order the checks ran — the evidence a
 * retirement is allowed to point at, and, on a failure, the part of the claim that did hold. It is
 * never a reason to retire on its own: only `verified` is.
 */
export type ShippedVerdict =
  | { state: "verified"; proof: string[]; landed: Record<string, BeadLanding>; cited: CitedEvidence[] }
  | { state: "unverified"; why: string; proof: string[] };

/**
 * One piece of git or GitHub evidence the verdict rests on, in its checkable form — every commit
 * and PR the claim cited, beside the ones the named beads' landings read (PR #238 review). The
 * survivor's landing is what a retirement points at, but the claim verified as a WHOLE: a commit or
 * PR cited alongside the survivor that the base no longer contains at the write would fail a rerun
 * of the check, so the same set is re-asked under the lock rather than surviving as prose in `proof`.
 */
export type CitedEvidence = { kind: "commit"; sha: string } | { kind: "pr"; ref: string };

/**
 * What PROVED a named bead's work landed — kept in its checkable form beside the prose, because the
 * retirement re-asks exactly this under the lock (PR #238 review): the survivor's PR pointer being
 * swapped, or its PR un-merging, in the window between the check and the write takes the
 * verification back, and a reread that only looked at status would never see it.
 *
 * The date each carries is what the fences measure against the survivor's history again
 * ({@link stillCurrentCycle}): a survivor reopened in the window — closed once more, or still open
 * and keeping its merged PR pointer — keeps this landing in the base, and it is the cycle that
 * moved, not the evidence. A PR landing is dated by the WORK it carries (`workedAt`, the newest
 * commit GitHub records for it), never by its merge: a merge is dated when the PR merged, and a PR
 * still open when its bead was reopened merges unchanged with a date after a reopen it holds
 * nothing from. A commit landing has only its `landedAt` — when it entered the base — which is why
 * it counts only while the bead has never been reopened ({@link commitOfCurrentCycle}).
 */
export type BeadLanding =
  /** A commit in the run's base names the bead. */
  | { via: "commit"; sha: string; landedAt: string }
  /** The bead's own PR is merged. */
  | { via: "pr"; ref: string; workedAt: string }
  /**
   * The bead is closed, the PR of the run target it rides is merged, and a commit GitHub records
   * in that PR names the bead — the PR carried it, whatever the board says of its parentage now.
   */
  | { via: "owner-pr"; ownerId: string; ref: string; workedAt: string };

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
 * Whether a pull request's work is in the run's base — or, when it is not, what GitHub and git said.
 *
 * `predicate` completes the sentence "<the PR> …" for every reading that is not proof, so each
 * refusal names the same fact in the same words whichever bead's PR it was asked of. `state` is
 * kept beside it because two of the readings are worded differently by their callers: a PR gh
 * could not read is an UNCHECKED claim, not a failed one, and a PR merely open or closed is the
 * everyday case the prose keeps short.
 */
type PullRequestLanding =
  | { landed: true; sha: string }
  | { landed: false; state: PullRequestState; predicate: string };

/**
 * Read a PR and place its merge in the history of `base`.
 *
 * MERGED IS NOT LANDED (PR #238 review). `gh` reports a PR merged whatever branch it merged into,
 * and a repository that ships through `develop` or a release line has merged PRs whose work the
 * run's base does not contain — so the check asks where the merge commit sits, exactly as it asks
 * of a commit named in prose: the commit gh reports for the merge has to be one `base` reaches.
 * A merged PR gh reports no commit for is unplaced, and unplaced fails closed: the alternative is
 * taking the state's word for the very thing the check exists to verify. Nothing is fetched, for
 * {@link readCommitReach}'s reason — a merge this repository has not seen is `absent`, and going
 * to the network to make it appear would make the answer depend on when it was asked.
 */
async function readPullRequestLanding(
  repoPath: string,
  base: string,
  ref: string,
): Promise<PullRequestLanding> {
  const pr = await readPullRequestMerge(repoPath, ref);
  if (pr.state !== "merged") {
    return {
      landed: false,
      state: pr.state,
      predicate: pr.state === "unknown" ? "could not be read" : `is ${pr.state}, not merged`,
    };
  }
  const unlanded = (predicate: string): PullRequestLanding => ({ landed: false, state: "merged", predicate });
  if (!pr.mergeCommit) {
    return unlanded(
      `is merged, and gh named no commit for the merge — anton cannot place it in the history of ` +
        `the run's base (${base}), so it does not count as landed there`,
    );
  }
  const reach = await readCommitReach(repoPath, pr.mergeCommit, base);
  const short = pr.mergeCommit.slice(0, 10);
  switch (reach.state) {
    case "reaches":
      return { landed: true, sha: reach.sha };
    case "outside":
      return unlanded(
        `is merged elsewhere than the run's base (${base})` +
          `${pr.baseRefName ? ` — into \`${pr.baseRefName}\`` : ""}: its merge commit \`${short}\` ` +
          `is not in ${base}'s history, so what it carries has not landed in what this run builds on`,
      );
    case "absent":
      return unlanded(
        `is merged, and its merge commit \`${short}\` is one this repository has never seen — the ` +
          `run's base (${base}) does not contain it, and anton does not fetch to make it appear`,
      );
    case "unreadable":
      return unlanded(
        `is merged, and whether its merge commit \`${short}\` reaches the run's base (${base}) ` +
          `could not be read (${reach.detail})`,
      );
  }
}

/** The clause a proof line ends on for a PR whose merge the base contains — the evidence itself. */
function landedTail(base: string, landing: { sha: string }): string {
  return `, and its merge commit \`${landing.sha.slice(0, 10)}\` is in the history of the run's base (${base})`;
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
  const cited: CitedEvidence[] = [];
  const cite = (evidence: CitedEvidence) => {
    if (!cited.some((c) => citesSame(c, evidence))) cited.push(evidence);
  };
  // One reading per PR however many times it is named — a bead's own ref and the number written in
  // the prose are routinely the same PR, and `gh` is a network call.
  const landings = new Map<string, PullRequestLanding>();
  const readPr = async (ref: string): Promise<PullRequestLanding> => {
    const cached = landings.get(ref);
    if (cached) return cached;
    const landing = await readPullRequestLanding(repoPath, base, ref);
    landings.set(ref, landing);
    return landing;
  };
  // Likewise the PR's commit list — one read however many beads the same PR is asked for.
  const carried = new Map<string, PullRequestCommits>();
  const readCommits = async (ref: string): Promise<PullRequestCommits> => {
    const cached = carried.get(ref);
    if (cached) return cached;
    const commits = await readPullRequestCommits(repoPath, ref);
    carried.set(ref, commits);
    return commits;
  };

  for (const commit of commits) {
    const reach = await readCommitReach(repoPath, commit, base);
    switch (reach.state) {
      case "reaches":
        proof.push(`commit \`${reach.sha.slice(0, 10)}\` is in the history of the run's base (${base})`);
        cite({ kind: "commit", sha: reach.sha });
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

  const landed: Record<string, BeadLanding> = {};
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
      const closed = await closedBeadLanding({ repoPath, base, index, bead, readPr, readCommits });
      if ("why" in closed) return { state: "unverified", proof, why: closed.why };
      proof.push(closed.proof);
      landed[id] = closed.landing;
      cite(citedByLanding(closed.landing));
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
    const landing = await readPr(pr);
    if (landing.landed) {
      // Held to the bead's CURRENT cycle like a closed one is (PR #238 review): a bead shipped once
      // and reopened for rework keeps its merged PR pointer, and that merge speaks for the work it
      // was reopened FROM, not the work it holds now. A never-closed bead awaiting its merge's
      // finalization has no reopen in its history and stands.
      const work = await ownPullRequestWork({ repoPath, index, bead, ref: pr, readCommits });
      if ("why" in work) {
        return {
          state: "unverified",
          proof,
          why: `\`${id}\` is ${standing} and its PR (${pr}) is merged — but ${work.why}`,
        };
      }
      proof.push(`\`${id}\` is ${standing}, but its PR (${pr}) is merged${landedTail(base, landing)}`);
      landed[id] = { via: "pr", ref: pr, workedAt: work.workedAt };
      cite({ kind: "pr", ref: pr });
      continue;
    }
    return {
      state: "unverified",
      proof,
      why:
        landing.state === "unknown"
          ? `\`${id}\` is ${standing} and anton could not read the state of its PR (${pr}) — ` +
            `whether that work landed is exactly what the claim rests on`
          : `\`${id}\` is ${standing} and its PR (${pr}) ${landing.predicate}`,
    };
  }

  for (const pr of prs) {
    const landing = await readPr(pr);
    if (landing.landed) {
      proof.push(`PR ${pr} is merged${landedTail(base, landing)}`);
      cite({ kind: "pr", ref: pr });
      continue;
    }
    return {
      state: "unverified",
      proof,
      why:
        landing.state === "unknown"
          ? `the claim names PR ${pr} and anton could not read its state — an unreadable PR is an ` +
            `unchecked claim, not a merged one`
          : `the claim names PR ${pr}, which ${landing.predicate}`,
    };
  }

  return { state: "verified", proof, landed, cited };
}

/** The git or GitHub fact a bead's landing read — the half of it the base can take back. */
function citedByLanding(landing: BeadLanding): CitedEvidence {
  return landing.via === "commit" ? { kind: "commit", sha: landing.sha } : { kind: "pr", ref: landing.ref };
}

function citesSame(a: CitedEvidence, b: CitedEvidence): boolean {
  return a.kind === "commit" ? b.kind === "commit" && a.sha === b.sha : b.kind === "pr" && a.ref === b.ref;
}

/**
 * What says a CLOSED bead's work has landed — or why nothing does.
 *
 * Closed alone is not it (PR #238 review). In anton's own lifecycle an epic's children close the
 * moment their run commits them (execute-epic-ticket-bookends `closeOnDone`), while the feature's
 * one pull request opens afterwards and merges later still — so "closed on the board" is routinely
 * true of work sitting on an unmerged branch, and retiring a live ticket against it would settle
 * that ticket on work the run's base does not contain. What proves the close is one of three things
 * the base or GitHub can be asked for, tried cheapest first: a commit in the base's history naming
 * the bead (local, and the shape anton's own commits and squash bodies take), the bead's own PR
 * merged, or the merged PR of the run target it rides — which is where a child's work actually
 * lands, since the child carries no PR ref of its own.
 *
 * The last of those is held to more than the parentage the board shows NOW (PR #238 review). A bead
 * re-homed under a feature after that feature's PR merged rides it today and was carried by nothing
 * of it: the PR could not have held work that was filed elsewhere when it merged. So the PR has to
 * say so itself — one of the commits GitHub records for it names the bead — and a merged owner PR
 * whose commit list never mentions the bead proves nothing for it.
 *
 * And every one of the three is held to the bead's CURRENT closure (PR #238 review). A bead that
 * shipped once, was reopened for rework, and was closed again by a run whose pull request has not
 * merged still has its first landing in the base — the old commit naming it, the old merged PR —
 * and any of those would retire another ticket against work the survivor's latest close does not
 * describe. So a PR counts only when the WORK it carries postdates the bead's last reopen
 * ({@link workOfCurrentCycle}) — its commits, not its merge, which a PR left open across a reopen
 * and merged unchanged dates after that reopen — and a naming commit counts only while the bead has
 * never been reopened ({@link commitOfCurrentCycle}): what the base holds must be what this close
 * is about.
 *
 * A naming commit that fails that bar is an evidence route that gave nothing, not a refusal (PR
 * #238 review). It was DISCOVERED — the newest commit in the base naming the bead — not cited by
 * the claim, and it dates its merge rather than its work: a squash of the rework lands with the
 * same shape as a squash of the cycle the reopen undid. The PR routes are still asked; a merged PR
 * whose commits postdate the reopen proves the current cycle landed. What the commit said rides
 * into any refusal that follows, so a human reading it sees every route anton tried.
 */
async function closedBeadLanding(args: {
  repoPath: string;
  base: string;
  index: BoardIndex;
  bead: Bead;
  readPr: (ref: string) => Promise<PullRequestLanding>;
  readCommits: (ref: string) => Promise<PullRequestCommits>;
}): Promise<{ landing: BeadLanding; proof: string } | { why: string }> {
  const { repoPath, base, index, bead, readPr, readCommits } = args;
  const id = bead.id;
  // The naming commit the base holds but the current cycle cannot claim — see the note above.
  let staleCommit: string | undefined;
  const refuse = (why: string): { why: string } => ({ why: staleCommit ? `${why}; ${staleCommit}` : why });
  const naming = await readCommitNaming(repoPath, id, base);
  switch (naming.state) {
    case "found": {
      const cycle = await commitOfCurrentCycle(repoPath, bead, { sha: naming.sha, landedAt: naming.committedAt });
      if (!cycle.stale) {
        return {
          landing: { via: "commit", sha: naming.sha, landedAt: naming.committedAt },
          proof:
            `\`${id}\` is closed on the board, and commit \`${naming.sha.slice(0, 10)}\` in the ` +
            `history of the run's base (${base}) names it`,
        };
      }
      staleCommit =
        `commit \`${naming.sha.slice(0, 10)}\` in the history of the run's base (${base}) names ` +
        `it, but ${cycle.stale}`;
      break;
    }
    case "unreadable":
      return {
        why:
          `\`${id}\` is closed on the board, but whether a commit in ${base} names it could not ` +
          `be read (${naming.detail})`,
      };
    case "none":
      break;
  }

  const ownPr = beads.getPrRef(bead);
  if (ownPr) {
    const landing = await readPr(ownPr);
    if (landing.landed) {
      const work = await ownPullRequestWork({ repoPath, index, bead, ref: ownPr, readCommits });
      if ("why" in work) {
        return refuse(`\`${id}\` is closed on the board and its PR (${ownPr}) is merged — but ${work.why}`);
      }
      return {
        landing: { via: "pr", ref: ownPr, workedAt: work.workedAt },
        proof: `\`${id}\` is closed on the board and its PR (${ownPr}) is merged${landedTail(base, landing)}`,
      };
    }
    return refuse(
      landing.state === "unknown"
        ? `\`${id}\` is closed on the board and anton could not read the state of its PR ` +
            `(${ownPr}) — whether that work landed is exactly what the claim rests on`
        : `\`${id}\` is closed on the board, but its PR (${ownPr}) ${landing.predicate}`,
    );
  }

  const owner = ticketOwnerOf(index, bead);
  const ownerPr = owner ? beads.getPrRef(owner) : undefined;
  if (owner && ownerPr) {
    const landing = await readPr(ownerPr);
    if (landing.landed) {
      const rides = `\`${id}\` is closed on the board and the PR of \`${owner.id}\`, the run target it rides, (${ownerPr})`;
      const carried = await readCommits(ownerPr);
      if (carried.state === "unreadable") {
        return refuse(
          `${rides} is merged, but whether a commit in that PR names \`${id}\` could not be ` +
            `read (${carried.detail}) — whether that PR carried its work is exactly what the ` +
            `claim rests on`,
        );
      }
      const naming = pullRequestCommitNaming(carried.commits, id);
      if (!naming) {
        return refuse(
          `${rides} is merged, but none of the commits GitHub records for that PR names ` +
            `\`${id}\` — the board says it rides \`${owner.id}\` now, and nothing says it did ` +
            `when that PR merged, so the PR is not evidence its work landed`,
        );
      }
      const cycle = await workOfCurrentCycle(repoPath, bead, naming.workedAt, carriedWork(ownerPr));
      if (cycle.stale) {
        return refuse(
          `${rides} is merged, and GitHub records commit \`${naming.sha.slice(0, 10)}\` in ` +
            `that PR naming it — but ${cycle.stale}`,
        );
      }
      return {
        landing: { via: "owner-pr", ownerId: owner.id, ref: ownerPr, workedAt: naming.workedAt },
        proof:
          `${rides} is merged${landedTail(base, landing)}, and GitHub records commit ` +
          `\`${naming.sha.slice(0, 10)}\` in that PR naming it`,
      };
    }
    return refuse(
      landing.state === "unknown"
        ? `\`${id}\` is closed on the board and anton could not read the state of the PR of ` +
            `\`${owner.id}\`, the run target it rides (${ownerPr}) — whether that work landed ` +
            `is exactly what the claim rests on`
        : `\`${id}\` is closed on the board, but the PR of \`${owner.id}\`, the run target it ` +
            `rides, (${ownerPr}) ${landing.predicate} — its run committed it, and that work ` +
            `has not landed in ${base}`,
    );
  }

  const rides = owner ? ` nor \`${owner.id}\`, the run target it rides,` : "";
  return refuse(
    staleCommit
      ? `\`${id}\` is closed on the board, but nothing says its CURRENT work LANDED — neither it${rides} ` +
          `points at a merged PR, and the one commit in ${base} naming it is an earlier cycle's`
      : `\`${id}\` is closed on the board, but nothing says its work LANDED — no commit in ${base} ` +
          `names it, and neither it${rides} points at a merged PR; a ticket closes when its run ` +
          `commits, before the pull request merges`,
  );
}

/** How a refusal names the commit a PR's work was dated by — the bead's own PR, and the one it rides. */
const ownWork = (ref: string, id: string): string =>
  `the newest commit in PR ${ref} committed under \`${id}\` or a ticket of its own`;
const carriedWork = (ref: string): string => `the newest commit in PR ${ref} naming it`;

/**
 * When the work a bead's OWN merged PR carries was last done, held to the bead's current cycle
 * ({@link workOfCurrentCycle}). `why` completes "<the PR> is merged — but …" for every reading that
 * is not proof, an unreadable or empty commit list included: whether the PR carries this cycle's
 * work is exactly what the claim rests on, so neither reads as "it does".
 *
 * The work is dated by the newest commit COMMITTED UNDER the bead or a ticket beneath it — the
 * `<id>: …` subjects anton writes for a run target's own commits and for each ticket's (PR #238
 * review). Not the newest commit of any kind: a bead reopened for rework that keeps its PR pointer
 * has a PR anyone can still push to, and GitHub's "Update branch" adds a merge from the base dated
 * whenever it was clicked. Measured by that, a PR holding nothing of the rework merges as if it
 * did, and another ticket retires against it. A commit under the bead's ids is a run's delivery
 * for it — the one thing that can say the rework is in the PR.
 *
 * With no such commit the PR can still speak for a bead that was NEVER reopened — everything in a
 * bead's own PR is its work, whatever subjects a hand-made one carries — so the history is read,
 * and only a bead with a reopen behind it is refused: the PR has to carry a commit of its own from
 * after that reopen, and this one carries none at all.
 */
async function ownPullRequestWork(args: {
  repoPath: string;
  index: BoardIndex;
  bead: Bead;
  ref: string;
  readCommits: (ref: string) => Promise<PullRequestCommits>;
}): Promise<{ workedAt: string } | { why: string }> {
  const { repoPath, index, bead, ref, readCommits } = args;
  const carried = await readCommits(ref);
  if (carried.state === "unreadable") {
    return {
      why:
        `the commits GitHub records for it could not be read (${carried.detail}) — whether it ` +
        `carries this cycle's work is exactly what the claim rests on`,
    };
  }
  const own = pullRequestCommitUnder(carried.commits, [
    bead.id,
    ...index.descendantsOf(bead.id).map((child) => child.id),
  ]);
  if (own) {
    const cycle = await workOfCurrentCycle(repoPath, bead, own.workedAt, ownWork(ref, bead.id));
    return cycle.stale ? { why: cycle.stale } : { workedAt: own.workedAt };
  }
  const newest = newestPullRequestCommit(carried.commits);
  if (!newest) return { why: `GitHub records no commit in it — nothing dates the work it carried` };
  const reopen = await lastReopenOf(repoPath, bead);
  switch (reopen.state) {
    case "never":
      return { workedAt: newest.workedAt };
    case "unreadable":
      return {
        why:
          `none of the ${carried.commits.length} commits GitHub records in it is committed under ` +
          `\`${bead.id}\` or a ticket of its own, so nothing in it says which cycle's work it holds, ` +
          `and ${reopen.why}`,
      };
    case "reopened":
      return {
        why:
          `the board reopened \`${bead.id}\` at ${reopen.at}, and none of the ` +
          `${carried.commits.length} commits GitHub records in it is committed under \`${bead.id}\` ` +
          `or a ticket of its own — its newest, \`${newest.sha.slice(0, 10)}\` dated ` +
          `${newest.workedAt}, is not that rework, so what the board holds now ` +
          `${bead.status === "closed" ? "is later work under that close" : `is later work still ${bead.status}`}, ` +
          `and nothing says THAT work landed`,
      };
  }
}

/**
 * Is work done at `workedAt` the bead's CURRENT cycle's, or a previous one's (PR #238 review)?
 *
 * `workedAt` dates the WORK — the newest commit a pull request carries — never the merge that
 * landed it. A merge is dated when the PR merged, and a PR still open when its bead was reopened
 * for rework merges unchanged with a date after that reopen: measured by its merge it would pass
 * for the rework, measured by its commits it carries nothing from after the reopen. `what` names
 * the commit as the refusal should read it ({@link ownWork}, {@link carriedWork}).
 *
 * A CLOSED bead's row settles the common case without a history read: work at or after its
 * `closed_at` cannot be an earlier cycle's, since that cycle's work preceded its own close, which
 * preceded the reopen, which preceded this close. An OPEN bead has no such row to ask: bd clears
 * `closed_at` on reopen, and a `closed_at` that survived one would be the very close the reopen
 * undid, so its history is always read.
 *
 * Work that PREDATES the close is ambiguous: a run closes a ticket the moment it commits, a person
 * closes a bead by hand a week after the work landed, and a reopened bead's first cycle's work sits
 * before its second close — the last is the one that must not count, and only the board's history
 * tells it from the others. So the history is read, and the work is stale when the bead was
 * reopened after it: what the board holds now is a later cycle's — closed again, or still open for
 * rework — and this work says nothing about it. Never reopened, or reopened before the work, and it
 * stands. An unreadable history fails closed, for the reason every other read here does.
 *
 * A branch updated from its base after the reopen carries a merge commit dated then and adds no
 * work; a rebase re-dates without adding any, but the older of a commit's two dates
 * ({@link PullRequestCommit}) does not move with it. The first never reaches here as `workedAt`:
 * the callers date a bead's own PR by a commit committed under it ({@link ownPullRequestWork}) and
 * the PR it rides by one naming it, and a merge from the base is neither.
 */
async function workOfCurrentCycle(
  repoPath: string,
  bead: Bead,
  workedAt: string,
  what: string,
): Promise<{ stale?: string }> {
  const worked = Date.parse(workedAt);
  if (Number.isNaN(worked)) {
    return { stale: `when ${what} was committed could not be read ("${workedAt}" is not a date)` };
  }
  const closed = bead.status === "closed";
  const closedAt = closed && typeof bead.closed_at === "string" ? Date.parse(bead.closed_at) : NaN;
  if (!Number.isNaN(closedAt) && worked >= closedAt) return {};

  const reopen = await lastReopenOf(repoPath, bead);
  switch (reopen.state) {
    case "never":
      return {};
    case "unreadable":
      return {
        stale:
          `${what} is dated ${workedAt}, which ` +
          `${closed ? "predates the close the board holds" : `may not be the ${bead.status} work the board holds`}, ` +
          `and ${reopen.why}`,
      };
    case "reopened":
      if (reopen.instant <= worked) return {};
      return {
        stale:
          `${what} is dated ${workedAt}, which is an earlier cycle's — the board reopened ` +
          `\`${bead.id}\` at ${reopen.at}, after it, so what it holds now ` +
          `${closed ? "is later work under that close" : `is later work still ${bead.status}`}, ` +
          `and nothing says THAT work landed`,
      };
  }
}

/**
 * Is a commit in the base naming a closed bead its CURRENT cycle's work (PR #238 review)?
 *
 * Only while the bead has never been reopened. The commit is dated when it entered the base — for
 * the squash anton merges by, the merge itself — and a merge dates nothing about the work it
 * carries: a pull request still open when its bead was reopened and merged unchanged afterwards
 * lands a naming commit dated after the reopen that holds only the cycle the reopen undid. So once
 * the history shows a reopen the commit route is inconclusive either way — an earlier date is the
 * earlier cycle's landing outright, a later one could be either — and the pull request's own
 * commits ({@link workOfCurrentCycle}) are what can still say which cycle's work the base holds.
 * No `closed_at` shortcut, for the same reason: a merge after the second close is still a merge.
 */
async function commitOfCurrentCycle(
  repoPath: string,
  bead: Bead,
  naming: { sha: string; landedAt: string },
): Promise<{ stale?: string }> {
  const reopen = await lastReopenOf(repoPath, bead);
  if (reopen.state === "never") return {};
  if (reopen.state === "unreadable") return { stale: reopen.why };
  const landed = Date.parse(naming.landedAt);
  if (Number.isNaN(landed)) {
    return { stale: `when that landing happened could not be read ("${naming.landedAt}" is not a date)` };
  }
  const holds = bead.status === "closed" ? "is later work under that close" : `is later work still ${bead.status}`;
  if (landed < reopen.instant) {
    return {
      stale:
        `that landing (${naming.landedAt}) is an earlier cycle's — the board reopened \`${bead.id}\` at ` +
        `${reopen.at}, after it, so what it holds now ${holds}, and nothing says THAT work landed`,
    };
  }
  return {
    stale:
      `the board reopened \`${bead.id}\` at ${reopen.at}, and commit \`${naming.sha.slice(0, 10)}\` ` +
      `dates its merge (${naming.landedAt}), not the work it carries — a pull request opened before ` +
      `the reopen lands unchanged with a later date — so which cycle's work the base holds only ` +
      `the pull request's own commits can say`,
  };
}

/**
 * When the bead last left `closed`, from the board's history — or why that could not be read.
 *
 * `bd flatten` erases the record this reads — a board squashed to one version reads as never
 * reopened. Named, not defended against: the operator who flattens has chosen to lose history.
 */
async function lastReopenOf(
  repoPath: string,
  bead: Bead,
): Promise<
  | { state: "never" }
  | { state: "reopened"; at: string; instant: number }
  | { state: "unreadable"; why: string }
> {
  let versions;
  try {
    versions = await beads.history(repoPath, bead.id);
  } catch (error) {
    return {
      state: "unreadable",
      why:
        `whether \`${bead.id}\` was reopened since could not be read ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const at = lastReopen(versions);
  if (at === undefined) return { state: "never" };
  const instant = Date.parse(at);
  if (Number.isNaN(instant)) {
    return {
      state: "unreadable",
      why:
        `the board's history dates \`${bead.id}\`'s last reopen as "${at}", which is not a date — ` +
        `when it was reopened could not be read`,
    };
  }
  return { state: "reopened", at, instant };
}

/**
 * When the bead last left `closed` — the newest version that is not closed and whose predecessor
 * was — or undefined when it never has. `versions` are newest first, as `bd history` returns them.
 */
function lastReopen(versions: readonly { at: string; status: string }[]): string | undefined {
  for (let i = 0; i + 1 < versions.length; i += 1) {
    const version = versions[i]!;
    const before = versions[i + 1]!;
    if (version.status !== "closed" && before.status === "closed") return version.at;
  }
  return undefined;
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
      /**
       * Whether the `not-delivered` marker landed beside the retirement (PR #238 review) — merge
       * finalization's only way to tell a retired ticket reopened in review from one this run's PR
       * carries. False only once bd refused it every time: the retirement stands, but the caller
       * must not release the ticket, or open a pull request, on an unmarked one.
       */
      marked: boolean;
      /** The survivor the `supersedes` edge now points at. */
      replacementId: string;
      /** One line per check that passed — the evidence the note on the bead carries. */
      proof: string[];
      attempted: string;
    }
  | { action: "escalate"; why: string; evidence: string[]; prior?: RepairAttempt }
  /**
   * The job was cancelled while the repair was reading — and it stopped INSIDE the locks, before its
   * first write. Nothing was written, and nothing must be on its account either (PR #238 review):
   * the settlement path promises an aborted ticket writes nothing to the board, so the caller
   * records this in its own log and leaves the bead alone — no refusal note, no stamp, no status.
   */
  | { action: "cancelled"; why: string };

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
 *      elsewhere. A ticket REWRITTEN or RE-HOMED since the agent was prompted is refused on the
 *      same terms (PR #238 review): the claim describes the contract the agent read, for the run
 *      that dispatched it, and the fences below start from the post-report reads, which already
 *      hold the edit or the move. The run-target half of the home needs the board, so it is asked
 *      right after the board is read and before anything is resolved against it.
 *   2. The loop guard and the trust dial ({@link decideRepair}), asked next for `dep-missing`'s
 *      reason: the CLASS here is the agent's own report and nothing about the bead asserts it, so a
 *      second `already-shipped` block on a ticket anton already retired is a diagnosis that has been
 *      disproved — and that answer costs no board read to give (R5.6).
 *   3. The SURVIVOR, then the CLAIM. Resolving the survivor is a board read; verifying reaches git
 *      and possibly `gh`, so the cheap refusal runs first.
 *
 * The WRITE order is the evidence note, then the supersede, then a RE-READ of both ends, then the
 * `not-delivered` marker, then the stamp — and it is deliberately not `dep-missing`'s. A note is a
 * statement, not a fix: written first, a failure that follows leaves a bead saying truthfully what
 * anton verified and still blocked for a human, while the reverse order could settle a ticket with
 * nothing on it explaining why.
 *
 * The MARKER is part of the settlement, not the caller's afterthought (PR #238 review). A retired
 * ticket's work is in the run's base, not its diff; reopened by an operator while the run's pull
 * request sits in review, it is an open child in no diff that PR carries, and merge finalization
 * closes as shipped whatever is open and unmarked. The caller releases the ticket's claim once this
 * returns, and a release is what makes it claimable again — so a marker written after it can land
 * after another run has snapshotted the bead, and that run's claim bookend clears only what its
 * snapshot held. Written here, under the ticket's lock and while the claim still stands, every later
 * claimant either snapshots the marker and clears it, or starts after that clear.
 *
 * The re-read is the cross-process half of the fence (PR #238 review). The locks the write is taken
 * under order only writers in THIS process (beads/claim-lock.ts); on a shared-server board another
 * anton, or a teammate's `bd` from a shell, can rewrite or re-home the ticket, reopen the survivor or
 * swap its PR between the locked reread and the supersede, and nothing orders the two. bd has no
 * conditional write to close that window (anton-od4), so the fence is the same one apply-steps'
 * `assertReservationHeld` uses: the write's own post-write read is the newest read there is, and the
 * retirement is held to the check's bar once more against it — {@link retirementHeld}. The base is
 * part of that read: no bead lock holds a git ref, so the commit or merge that authorized the
 * retirement is asked of the base again beside the board, not taken from the pre-write answer.
 *
 * Nothing is taken back on JUDGEMENT: un-superseding a bead whose retirement verified is not an undo,
 * it is a second decision about work that has already landed, and a stamp that failed after one
 * leaves it standing. The one withdrawal ({@link withdrawRetirement}) is the post-write read proving
 * the supersede closed a ticket the check never verified — rewritten, re-homed, or against a survivor
 * whose evidence had gone — and it takes back only a close the board still shows as anton's own.
 */
export async function repairAlreadyShipped(args: {
  /** Where bd writes go — the project's beads workspace, and the git repo the claim is checked in. */
  repoPath: string;
  /** The ref the run forked from — what "has landed" is measured against (`baseRef`). */
  base: string;
  /**
   * The ticket as `bd show` reads it — the FULL bead, not a `bd list` row (PR #238 review). Its
   * contract is the fence the write is held to ({@link contractRewritten}), and the list-shaped
   * board can omit `description` on some bd versions (issues.ts `ensureDescription`): fenced on
   * that, the under-lock reread's real description would read as a rewrite and every valid
   * retirement in such an environment would refuse.
   */
  bead: Bead;
  /**
   * The ticket as the AGENT was prompted with it — the run's dispatch snapshot, whose contract the
   * claim is a claim about (PR #238 review). `bead` is read after the report, so an edit landing
   * while the agent ran is already in it, and a fence that starts from `bead` would hold the write
   * to the rewritten ticket and never see the drift. Absent, the caller has no earlier read than
   * `bead` and the gate has nothing to compare — see {@link contractDriftedSinceDispatch}.
   *
   * Its parentage is the dispatch-time HOME, held the same way ({@link homeMovedSinceDispatch}):
   * `bead` and the board are both read after the report, so a re-parent landing while the agent ran
   * is already the baseline every later fence starts from, and this snapshot is the only read that
   * still says where the ticket hung when the claim was made about it.
   */
  dispatched?: Bead;
  /**
   * The run target this ticket was DISPATCHED under — `ctx.target.id`, the card whose run the
   * retirement is written on behalf of (PR #238 review). Compared with whose card the ticket rides
   * on the post-report board ({@link ownerMovedSinceDispatch}): a move of an ANCESTOR while the
   * agent ran hands the ticket to another run with nothing written to the ticket itself, so neither
   * `dispatched`'s parent nor its contract can see it. Absent, the caller has not said which run
   * the claim was made for, and the gate has nothing to compare.
   */
  runTargetId?: string;
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
  /**
   * The job's LIVE abort signal (PR #238 review). The caller checked it once before handing the
   * ticket here, but this repair reads git, asks GitHub and waits on write locks — long enough for
   * an operator's kill to land in between. Re-read inside the locks, immediately before the first
   * write: a cancellation that arrives while the check is running retires nothing.
   */
  signal?: AbortSignal;
}): Promise<AlreadyShippedOutcome> {
  const { repoPath, base, bead, dispatched, runTargetId, block, committed, now, autonomy, signal } = args;
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

  // The claim was made about the ticket the agent READ, and a rewrite in the meantime makes it a
  // claim about a ticket that no longer exists. Decided before any read, like gate 1: both beads are
  // already in hand, and no autonomy level makes it acceptable.
  const drifted = dispatched ? contractDriftedSinceDispatch(dispatched, bead) : undefined;
  if (drifted) {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but the ticket was rewritten while the agent was ` +
        `running — the claim is about the ticket as it was dispatched, not the one on the board ` +
        `now, so anton retired nothing.`,
      evidence: [drifted, `the agent reported: ${claim}`],
    };
  }
  // The ticket's HOME at dispatch, on the same two reads: the retirement is written on behalf of
  // the run that dispatched the agent, and a re-parent landing while it ran leaves the ticket open
  // with its contract intact — inside a run this one does not own. The fences under the lock
  // start from the post-report board, which already holds the move (PR #238 review).
  const rehomed = dispatched ? homeMovedSinceDispatch(dispatched, bead) : undefined;
  if (rehomed) return rehomedWhileRunning(bead.id, rehomed, claim);

  const decision = decideRepair(bead, KLASS, block, autonomy);
  if (decision.action === "escalate") return { ...decision };

  const board = args.board ?? (await readBoard(repoPath));
  const index = indexBoard(board);
  // The other half of the dispatch-time home, which needs the board: a move of an ANCESTOR hands
  // the ticket to another run target with nothing written to the ticket or its parent field.
  const disowned = runTargetId ? ownerMovedSinceDispatch(index, bead, runTargetId) : undefined;
  if (disowned) return rehomedWhileRunning(bead.id, disowned, claim);
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

  // The survivor is one of the beads the check just verified — the one whose evidence the write
  // below re-asks for. A survivor the check has no landing for is a bug in the resolve/verify pair,
  // and the safe reading of a bug here is a refusal, never a retirement.
  const landing = verdict.landed[replacementId];
  if (!landing) {
    return {
      action: "escalate",
      why:
        `${bead.id} blocked as \`${KLASS}\`, but anton verified the claim without recording what ` +
        `landed ${replacementId}'s work — it retired nothing rather than settle a ticket on ` +
        `evidence it cannot re-check.`,
      evidence: [`what did hold: ${verdict.proof.join("; ")}`, `the agent reported: ${claim}`],
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

  // Both beads' locks, the ticket's whole SUBTREE beside them, and the board re-read inside them:
  // the board this was decided against is a snapshot, and the one thing a retirement cannot survive
  // is somebody else having settled either end of it in the window — an operator abandoning the
  // ticket, another run closing it, the survivor being reopened because its work turned out not to
  // have landed after all. The subtree question is re-asked under the same locks (PR #238 review):
  // a gardener re-parent hanging work under a bead takes that bead's lock as the new home
  // (apply-steps `lockedBeads`) — the HOME's, not every ancestor's — so an attach under a closed
  // descendant of this ticket would never contend on the ticket alone. Holding every descendant the
  // check saw makes the two orders: the attach either lands before this read, which then finds the
  // newcomer and refuses, or queues behind the supersede and meets a closed home. Against the
  // snapshot alone both would pass, and the newly attached ticket would sit beneath a card nothing
  // will run.
  //
  // The EVIDENCE holder's lock too (PR #238 review): a survivor verified through the PR of the run
  // target it rides has its evidence on THAT bead's pointer, and the PR-ref writers (pr-link.ts,
  // the run's own `pr` step) take the holder's lock — so an owner outside this set could have its
  // merged PR swapped for an open one between `retirementMoved`'s reread and the supersede, with
  // nothing to order the two. Held here, the swap either lands first and the reread refuses it, or
  // queues behind a retirement that verified what was actually there.
  //
  // And the ticket's ANCESTORS, up to and including the run target it rides (PR #238 review). A
  // re-parent holds the moved bead's lock and its new home's, and a move carries everything beneath
  // it: the ticket changes owners when an ancestor is re-homed, with nothing written to the ticket
  // itself. Holding the ticket alone orders nothing against that move, so `targetRehomed`'s reread
  // could accept the old owner and the supersede then close the ticket inside the run it rode into.
  // With the chain held, the move either lands first and the reread refuses it, or queues behind a
  // retirement that closed the ticket where it was checked.
  //
  // The survivor's lock also orders the run's own cross-machine reopen (PR #238 review): a resumed
  // run whose branch lacks the survivor's landed commit reopens it to regenerate, and does so under
  // the same lock (execute-epic-dispatch `reopenForRegeneration`), so it cannot slip between the
  // reread below and the supersede.
  const subtree = index.descendantsOf(bead.id).map((b) => b.id);
  const evidenceHolders = landing.via === "owner-pr" ? [landing.ownerId] : [];
  const ancestors = ancestorChainOf(index, bead.id);
  // What BOTH fences hold the fresh reads to — the check's reads, fixed once so neither fence can be
  // handed a different bar from the other.
  const fence: RetirementFence = {
    repoPath,
    base,
    targetId: bead.id,
    contract: bead,
    checked: index.byId.get(bead.id),
    snapshot: index,
    replacementId,
    landing,
    cited: verdict.cited,
  };
  return withBeadWriteLocks(repoPath, [bead.id, replacementId, ...subtree, ...evidenceHolders, ...ancestors], async () => {
    const locked = await readBoardUnderLock(repoPath, "before");
    const moved =
      typeof locked === "string"
        ? locked
        : ((await retirementMoved({ ...fence, locked })) ??
          (await citedEvidenceMoved(fence)) ??
          strandedUnderLock(locked, bead.id) ??
          subtreeMoved(locked, bead.id, subtree));
    if (moved) {
      return {
        action: "escalate",
        why:
          `${bead.id} blocked as \`${KLASS}\`, but the board moved between the check and the write — ` +
          `anton retired nothing rather than settle a ticket against evidence that had changed.`,
        evidence: [moved, `the retirement anton did not write: ${attempted}`],
      };
    }
    // The last read is done and the first write is next: this is where the abort is asked, because
    // it is the one point that decides whether the cancellation wrote to the board. Everything above
    // was a read the abort does not care about; everything below is the settlement it forbids.
    if (signal?.aborted) {
      return {
        action: "cancelled",
        why:
          `the job was cancelled while anton was checking the \`${KLASS}\` claim on ${bead.id} — ` +
          `the check had passed, and anton wrote nothing rather than settle a ticket the ` +
          `cancellation's author is deciding on (the retirement anton did not write: ${attempted})`,
      };
    }
    // The evidence FIRST (see the header): a note states what anton checked, and a bead carrying it
    // is honest whether or not the retirement below lands.
    await beads.note(repoPath, bead.id, shippedEvidenceNote(verdict));
    await beads.supersede(repoPath, bead.id, replacementId);
    // The write has landed; now the fence the locks cannot hold (see the header). Re-read both ends,
    // the board and the base, and re-ask the check's questions of what they hold NOW — the only read
    // that can have seen a writer from another process. Held, the stamp follows; moved, the
    // retirement is withdrawn if the close is still anton's own, and reported either way.
    const held = await retirementHeld({ ...fence, subtree });
    if (held.state !== "held") {
      return {
        action: "escalate",
        why:
          `${bead.id} blocked as \`${KLASS}\`, and the board moved between the check and the ` +
          `write — anton found out only on re-reading the ticket after its retirement landed, so the ` +
          `retirement is not one it stands behind, and a human decides the ticket.`,
        evidence: [
          held.why,
          await withdrawRetirement({ repoPath, targetId: bead.id, replacementId, held }),
          `the retirement anton wrote: ${attempted}`,
        ],
      };
    }
    // The marker first, the stamp second: the stamp guards the NEXT block, the marker guards the
    // merge of THIS run, and only the marker's absence stops the run from opening that PR. Retried
    // like the skip path's, and reported rather than thrown — the retirement is not taken back over
    // it (see the header), so the caller has to know it stands unmarked.
    const marked = await mustPersist(() => beads.tag(repoPath, bead.id, [LABELS.notDelivered]));
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
    return {
      action: "retired",
      ...(label ? { label } : {}),
      marked,
      replacementId,
      proof: verdict.proof,
      attempted,
    };
  });
}

/**
 * Why either end of the retirement is no longer what it was checked as, read fresh from bd at the
 * write — or undefined when both still are.
 *
 * A read that FAILED is a refusal rather than an assumption either way: anton closes a ticket against
 * a board it could check, and a `bd show` that broke is not a check.
 *
 * The survivor is re-checked against the EVIDENCE that verified it, not against its status (PR #238
 * review). A status reread accepts any bead with any PR on it, which is the window's whole problem:
 * the PR pointer the check read as merged can have been swapped for an open one, or the bead
 * reopened with an unmerged PR attached, and "closed or has a PR" still reads true. So the pointer
 * has to be the one that verified and `gh` has to still call it merged; for a landing the board
 * only spoke for INDIRECTLY — the run target's PR, a commit the base names — the survivor also has
 * to still be the closed ticket that made that evidence its own, since reopening or abandoning it in
 * the window is the human saying otherwise.
 *
 * The TARGET is held to more than "still open" for the same reason (PR #238 review): the claim is
 * about this ticket's contract, and a ticket rewritten in the window is open exactly as before. So
 * is a ticket RE-HOMED in the window ({@link targetRehomed}): moved under another feature, it is
 * open with its contract intact, and the supersede would close it inside a run this one does not own.
 *
 * This is the PRE-write fence, ordered against this process's writers by the locks; its post-write
 * twin, {@link retirementHeld}, asks the same questions after the supersede has landed, which is the
 * only read that can have seen a writer from another process.
 */
async function retirementMoved(args: RetirementFence & {
  /** The whole board, re-read inside the locks. */
  locked: BoardIndex;
}): Promise<string | undefined> {
  const { repoPath, targetId } = args;
  const target = await readBead(repoPath, targetId, "before");
  if (typeof target === "string") return target;
  if (!isOpenWork(target)) {
    return (
      `${targetId} is already settled (${target.status}) — somebody else decided this ticket's ` +
      `outcome, and anton does not rewrite that`
    );
  }
  return retirementDrifted({ ...args, target, when: "before" });
}

/**
 * What both fences compare the fresh reads against: the reads the CHECK was made on, and the ref it
 * measured "landed" against. Neither fence reads these; they are the fixed point, and the fresh read
 * is what is held to them.
 */
interface RetirementFence {
  repoPath: string;
  /** The ref every landing has to be in the history of — the same `base` the check placed it in. */
  base: string;
  targetId: string;
  /**
   * The target's FULL read ahead of the check — the contract the claim was verified against. Held
   * apart from `checked` because the two answer different questions off different reads: the
   * contract lives on a `bd show`, and the ticket's home on the board listing.
   */
  contract: Bead;
  /** The target as it sat on the board the CHECK read — where it hung when the claim was verified. */
  checked: Bead | undefined;
  /** The board the CHECK read — where the target hung when the claim was verified. */
  snapshot: BoardIndex;
  replacementId: string;
  landing: BeadLanding;
  /** Every commit and PR the claim cited — re-asked of the base beside the survivor's own landing. */
  cited: CitedEvidence[];
}

/**
 * The post-write verdict. `overtaken` and `unread` are told apart from `moved` because only `moved`
 * is anton's to take back: the close on the board is anton's own supersede, over a ticket the read
 * proves was not what the check verified. Overtaken, somebody else has already decided the ticket
 * since the write and their decision stands; unread, nothing is known and nothing is undone on it.
 */
type RetirementVerdict =
  | { state: "held" }
  | { state: "moved"; why: string }
  | { state: "overtaken"; why: string }
  | { state: "unread"; why: string };

/**
 * Whether the retirement that just landed closed the ticket the check verified, against the survivor
 * it verified — the cross-process fence (PR #238 review; see the header).
 *
 * The same questions {@link retirementMoved} asked before the write, asked once more after it: the
 * two fences share {@link retirementDrifted} and {@link citedEvidenceMoved}, so neither can hold the
 * ticket to a bar the other does not. One thing differs. The target is held to "closed by THIS
 * supersede" rather than "still open", because the write is the thing being verified — a ticket
 * that reads open, or closed some other way, is one somebody else has decided since.
 *
 * The landing is re-asked of git and `gh` in FULL, not of the board's pointer alone (PR #238
 * review). The bead locks order nothing in the repository: the base is a movable ref, and another
 * run fetching or resetting `origin/<base>` between the pre-write reread and the supersede drops
 * the commit or merge that authorized the retirement with the pointer unchanged — a board-only
 * reread would call that held. So the base is asked again, for every landing and every citation.
 *
 * The board is read whole again for the same reason the pre-write fence read it: whose card the
 * ticket and the survivor ride is decided by their ancestors, and open work attached beneath the
 * ticket by a re-parent this process never saw is visible nowhere else.
 */
async function retirementHeld(
  args: RetirementFence & {
    /** The descendants the CHECK saw and the locks hold — what {@link subtreeMoved} compares to. */
    subtree: readonly string[];
  },
): Promise<RetirementVerdict> {
  const { repoPath, targetId, replacementId, subtree } = args;
  const target = await readBead(repoPath, targetId, "after");
  if (typeof target === "string") return { state: "unread", why: target };
  if (beads.supersededBy(target) !== replacementId) {
    return {
      state: "overtaken",
      why:
        `${targetId} no longer reads as the close anton wrote — it is ${target.status}` +
        `${isOpenWork(target) ? "" : `, superseded by ${beads.supersededBy(target) ?? "nothing"}`} ` +
        `now, so somebody else decided this ticket since the retirement landed, and anton does not ` +
        `rewrite that`,
    };
  }
  const locked = await readBoardUnderLock(repoPath, "after");
  if (typeof locked === "string") return { state: "unread", why: locked };
  const drifted =
    (await retirementDrifted({ ...args, target, locked, when: "after" })) ??
    (await citedEvidenceMoved(args)) ??
    strandedUnderLock(locked, targetId) ??
    subtreeMoved(locked, targetId, subtree);
  return drifted ? { state: "moved", why: drifted } : { state: "held" };
}

/**
 * Take back a retirement the post-write read proved was written against a board that had moved — or
 * say why it stands. Returns the one evidence line the refusal carries for what the board was left
 * as, because whichever way this goes the ticket is a human's to decide and they need to know where
 * to find it.
 *
 * Bounded to what is still OURS, like apply-steps' `undoReparent`: only a `moved` verdict is acted
 * on, because only there did the read prove the close is anton's own supersede. `overtaken` means
 * another hand has decided the ticket since — reopening or closing it over them would be the very
 * stomp this fence exists to catch — and `unread` means nothing is known, so nothing is undone on it.
 *
 * REOPEN FIRST, then the edge. Open is what puts the ticket back in front of a human; the dangling
 * `supersedes` edge on an open bead is inert to every reader (`beads.supersededBy` asks closed
 * first), so a failure between the two leaves a ticket that is correct and merely untidy, and the
 * line says so. A reopen that FAILED leaves the ticket closed on evidence that moved, which is the
 * one outcome this whole fence exists to avoid — so that line says exactly that, and names the
 * command a human runs.
 */
async function withdrawRetirement(args: {
  repoPath: string;
  targetId: string;
  replacementId: string;
  held: Exclude<RetirementVerdict, { state: "held" }>;
}): Promise<string> {
  const { repoPath, targetId, replacementId, held } = args;
  if (held.state === "overtaken") {
    return `anton left the board as it found it — the ticket was decided by somebody else after the retirement landed, and that decision stands`;
  }
  if (held.state === "unread") {
    return (
      `anton could not tell what the board holds and took nothing back — the retirement may stand: ` +
      `check \`bd show ${targetId}\`, and reopen it (\`bd reopen ${targetId}\`, then ` +
      `\`bd dep remove ${targetId} ${replacementId}\`) if it should not`
    );
  }
  try {
    await beads.reopen(repoPath, targetId, `anton: withdrew an \`${KLASS}\` retirement — the board moved between the check and the write`);
  } catch (e) {
    return (
      `anton could NOT withdraw the retirement (${errorText(e)}) — ${targetId} stands closed as ` +
      `superseded by ${replacementId} on evidence that had moved, and a human has to reopen it ` +
      `(\`bd reopen ${targetId}\`, then \`bd dep remove ${targetId} ${replacementId}\`)`
    );
  }
  try {
    await beads.unlink(repoPath, targetId, replacementId);
  } catch (e) {
    return (
      `anton withdrew the retirement: ${targetId} is open again, but its \`supersedes\` edge to ` +
      `${replacementId} could not be removed (${errorText(e)}) — inert while the ticket is open, ` +
      `and \`bd dep remove ${targetId} ${replacementId}\` clears it`
    );
  }
  return `anton withdrew the retirement: ${targetId} is open again and its \`supersedes\` edge to ${replacementId} is gone`;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One end of the retirement, read fresh — or why it could not be. A read that FAILED is a refusal
 * rather than an assumption either way: anton closes a ticket against a board it could check, and a
 * `bd show` that broke is not a check. `when` only words the refusal, so it says which fence it was.
 */
async function readBead(repoPath: string, id: string, when: "before" | "after"): Promise<Bead | string> {
  try {
    const bead = await beads.show(repoPath, id);
    return bead?.id ? bead : `\`${id}\` is no longer on the board`;
  } catch (e) {
    return `\`${id}\` could not be re-read ${when} the retirement (${errorText(e)})`;
  }
}

/**
 * The questions BOTH fences ask once the target's standing has been judged — its contract and its
 * home, then the survivor's evidence — against a fresh read of each. Shared so the post-write fence
 * cannot drift from the pre-write one; only `when` differs, and it only words a refusal.
 *
 * The landing is re-asked in full each time — the PR's merge still in the base's history, the
 * naming commit still reaching it — at the cost of `gh`. The board's pointer alone would not do: the
 * base is a ref no bead lock holds, so the pointer can be unchanged while what it names has left
 * the base ({@link retirementHeld}).
 */
async function retirementDrifted(
  args: RetirementFence & {
    /** The target, freshly read, its standing already judged by the caller. */
    target: Bead;
    /** The whole board, read alongside the target. */
    locked: BoardIndex;
    when: "before" | "after";
  },
): Promise<string | undefined> {
  const { repoPath, base, targetId, contract, checked, snapshot, replacementId, landing, locked, target, when } = args;
  const rewritten = contractRewritten(contract, target);
  if (rewritten) return rewritten;
  if (!checked) {
    return (
      `\`${targetId}\` was not on the board the claim was checked against — anton cannot tell ` +
      `whether the ticket it would close is the one the claim is about`
    );
  }
  const rehomed = targetRehomed(snapshot, checked, locked, target);
  if (rehomed) return rehomed;
  const replacement = await readBead(repoPath, replacementId, when);
  if (typeof replacement === "string") return replacement;

  // Still the PR that verified, and its merge still in the base ({@link stillLandedPullRequest}).
  // ABANDONED is not asked here, on purpose: the check itself reads a merged PR as redeeming an
  // abandoned bead — what shipped is what shipped, whatever the bead was later labelled — and the
  // guard holds the survivor to the check's bar, not a higher one.
  const stillMergedPr = async (holder: Bead, ref: string, whose: string): Promise<string | undefined> => {
    const now = beads.getPrRef(holder);
    if (now !== ref) {
      return (
        `${whose} no longer points at the PR anton verified (${ref}) — it points at ` +
        `${now ? now : "no PR"} now, so what landed is not what was checked, and ${targetId} is ` +
        `not superseded on that evidence`
      );
    }
    return stillLandedPullRequest(repoPath, base, ref, `${whose} PR (${ref})`, targetId);
  };

  switch (landing.via) {
    case "pr":
      return (
        (await stillCurrentCycle(repoPath, replacement, landing, targetId)) ??
        stillMergedPr(replacement, landing.ref, `\`${replacementId}\``)
      );
    case "owner-pr": {
      const settled =
        stillClosedSurvivor(replacement, "the run target's merged PR") ??
        (await stillCurrentCycle(repoPath, replacement, landing, targetId));
      if (settled) return settled;
      const rehomed = stillRidesOwner(locked, targetId, replacementId, landing.ownerId);
      if (rehomed) return rehomed;
      const owner = await readBead(repoPath, landing.ownerId, when);
      if (typeof owner === "string") return owner;
      return stillMergedPr(owner, landing.ref, `\`${landing.ownerId}\`, the run target \`${replacementId}\` rides,`);
    }
    case "commit": {
      const settled =
        stillClosedSurvivor(replacement, "the commit naming it in the base") ??
        (await stillCurrentCycle(repoPath, replacement, landing, targetId));
      if (settled) return settled;
      return stillReachingCommit(repoPath, base, landing.sha, targetId);
    }
  }
}

/**
 * The survivor's landing has to still be its CURRENT cycle's at the write (PR #238 review).
 * {@link stillClosedSurvivor} catches a reopen the window left open on a survivor the check read as
 * closed; a survivor reopened AND closed again before the fence reads it is closed once more, its
 * naming commit or merged PR still in the base, and status alone would call that held — while the
 * rework its latest close describes may be sitting on an unmerged branch. And a survivor verified
 * through its own PR whatever its status (the `pr` landing) passes no status fence at all: reopened
 * in the window with the pointer kept, it is the same bead holding the same merged PR, and only the
 * reopen in its history says the work it holds now is not what that merge shipped. So the check's
 * own question ({@link workOfCurrentCycle}, {@link commitOfCurrentCycle}) is re-asked of the fresh
 * read, whatever it reads as — against the date the check stored, since a merged PR's commits do
 * not change.
 */
async function stillCurrentCycle(
  repoPath: string,
  replacement: Bead,
  landing: BeadLanding,
  targetId: string,
): Promise<string | undefined> {
  const cycle =
    landing.via === "commit"
      ? await commitOfCurrentCycle(repoPath, replacement, landing)
      : await workOfCurrentCycle(
          repoPath,
          replacement,
          landing.workedAt,
          landing.via === "pr" ? ownWork(landing.ref, replacement.id) : carriedWork(landing.ref),
        );
  if (!cycle.stale) return undefined;
  return (
    `\`${replacement.id}\` is not ${replacement.status} on the evidence anton verified — ${cycle.stale}; ` +
    `${targetId} is not superseded on that evidence`
  );
}

/**
 * The PR's merge has to still be in the base's history at the write — the same bar the check held
 * it to, re-asked in full rather than as "still merged" (a PR can no more un-merge than the base can
 * lose a commit, but a force-pushed base can, and the check's answer is the base's history).
 * `subject` names the PR as the refusal should read it: "`anton-x`'s PR (gh-85)", "the cited PR gh-85".
 */
async function stillLandedPullRequest(
  repoPath: string,
  base: string,
  ref: string,
  subject: string,
  targetId: string,
): Promise<string | undefined> {
  const landing = await readPullRequestLanding(repoPath, base, ref);
  if (landing.landed) return undefined;
  return (
    (landing.state === "merged"
      ? `${subject} ${landing.predicate}`
      : `${subject} reads as ${landing.state === "unknown" ? "unreadable" : landing.state} now, not merged`) +
    ` — the evidence ${targetId}'s retirement rested on no longer holds`
  );
}

/**
 * Every commit and PR the claim cited has to still land in the base at the write, not only the one
 * the survivor's landing read (PR #238 review). The check verified the claim as a WHOLE — one cited
 * commit outside the base fails it — and the base is a movable ref, so a citation that held at the
 * check can be gone by the time the locks are taken. Anything already re-asked through the
 * survivor's own landing is skipped: {@link retirementMoved} holds that one to a stricter bar
 * (pointer and standing too), and `gh` is a network call.
 */
async function citedEvidenceMoved(args: {
  repoPath: string;
  base: string;
  targetId: string;
  cited: CitedEvidence[];
  landing: BeadLanding;
}): Promise<string | undefined> {
  const { repoPath, base, targetId, cited, landing } = args;
  const survivor = citedByLanding(landing);
  for (const evidence of cited) {
    if (citesSame(evidence, survivor)) continue;
    const moved =
      evidence.kind === "commit"
        ? await stillReachingCommit(repoPath, base, evidence.sha, targetId)
        : await stillLandedPullRequest(repoPath, base, evidence.ref, `the cited PR ${evidence.ref}`, targetId);
    if (moved) return moved;
  }
  return undefined;
}

/**
 * The naming commit that verified the survivor has to still be in the base's history at the write
 * (PR #238 review). The base is a MOVABLE ref — another run force-fetching `origin/main` while this
 * repair waits on its locks can drop the commit from it — and the check's answer was the base's
 * history, not the commit's existence. Same bar {@link retirementMoved} holds a PR's merge to, so
 * the same refusal: outside, absent and unreadable all mean the evidence no longer holds.
 */
async function stillReachingCommit(
  repoPath: string,
  base: string,
  sha: string,
  targetId: string,
): Promise<string | undefined> {
  const reach = await readCommitReach(repoPath, sha, base);
  if (reach.state === "reaches") return undefined;
  const short = sha.slice(0, 10);
  const what =
    reach.state === "outside"
      ? `commit \`${short}\` is no longer in the history of the run's base (${base})`
      : reach.state === "absent"
        ? `commit \`${short}\` is no longer one this repository has — the run's base (${base}) cannot contain it`
        : `whether commit \`${short}\` still reaches the run's base (${base}) could not be read (${reach.detail})`;
  return `${what} — the evidence ${targetId}'s retirement rested on no longer holds`;
}

/**
 * A survivor whose evidence was spoken for by its CLOSED standing — the base naming it, its run
 * target's PR — has to still be that closed ticket at the write. Reopened, it is work in progress
 * again by the human's own hand; abandoned, it is a recorded won't-do that delivered nothing to be
 * superseded by. Either takes the verification back.
 */
function stillClosedSurvivor(replacement: Bead, spokeFor: string): string | undefined {
  if (beads.isAbandoned(replacement)) {
    return (
      `\`${replacement.id}\` has been abandoned — a recorded won't-do delivered nothing, so ` +
      `${spokeFor} no longer speaks for it`
    );
  }
  if (isOpenWork(replacement)) {
    return (
      `\`${replacement.id}\` is open again (${replacement.status}) — ${spokeFor} spoke for a ` +
      `closed ticket, and it is not one now`
    );
  }
  return undefined;
}

/**
 * The fields a ticket's CONTRACT lives in — the ones a claim about "this ticket's work" is a claim
 * about. Every home the contract can occupy (beads/contract.ts `acceptanceBodies`), plus the title.
 */
const CONTRACT_FIELDS = ["title", "description", "acceptance_criteria", "acceptance", "context", "design"] as const;

/**
 * The human notes on a bead as the dispatch prompt reads them (steps/prompts.ts `ticketSpecSections`
 * hands them to the agent as binding refinements of the contract) — so they are contract too, and
 * both fences below compare them (PR #238 review). Machine notes are left out on purpose: anton
 * appends its own line to the blob on every settlement, and the evidence note this repair writes
 * lands before the post-write fence reads it.
 */
function humanNotesOf(bead: Bead): string {
  return humanNotesPromptBlock(bead.notes) ?? "";
}

/**
 * Why the ticket at the write is no longer the one the claim was checked against — or undefined
 * when its contract still reads as it did (PR #238 review).
 *
 * The claim says THIS ticket's work has landed, and the check proved that about the ticket as it
 * stood. A human rewriting it in the window — an acceptance line added, the goal widened — leaves it
 * open exactly as before, so a status reread passes it through to a supersede that closes the
 * ticket they just redefined on evidence about the one they replaced. `updated_at` is deliberately
 * not the fence (board-picker-plan.ts gives the reason): every write bumps it, and a label stamped
 * in the window is not a rewrite.
 *
 * Both sides are `bd show` reads, on purpose: the fence compares like with like, and a board row
 * that dropped `description` would otherwise read every real description as a rewrite.
 */
function contractRewritten(checked: Bead, now: Bead): string | undefined {
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const changed: string[] = CONTRACT_FIELDS.filter((field) => text(checked[field]) !== text(now[field]));
  if (humanNotesOf(checked) !== humanNotesOf(now)) changed.push("human notes");
  if (changed.length === 0) return undefined;
  return (
    `\`${now.id}\` was rewritten since the check (${changed.join(", ")} changed) — the claim was ` +
    `verified against a ticket that no longer reads the same, and anton will not close the one ` +
    `that replaced it on that evidence`
  );
}

/**
 * Why the ticket the agent was prompted with is not the one the report came back to — or undefined
 * while its contract still reads as dispatched (PR #238 review).
 *
 * Same fields as {@link contractRewritten}, held the same way — a field neither read carries is
 * empty on both, and one the ticket gained while the agent ran (an acceptance list written onto a
 * bare ticket) is drift like any edit. One field is different: the dispatch snapshot began as a
 * board ROW, and on some bd versions the listing drops `description` (issues.ts
 * `ensureDescription`). `readForDispatch` (steps/agent.ts) carries it over from the full read, so a
 * snapshot still without it is one whose dispatch-time `bd show` FAILED — the agent was prompted
 * without the contract's main body, and nothing attests to what it read. That is refused outright
 * rather than compared: a field the snapshot cannot speak for is not a licence to skip it, since
 * the claim would then settle a ticket on a contract the agent never saw.
 *
 * The notes are the bead's as `readForDispatch` built the prompt: read fresh at dispatch, so an
 * operator's note in the window between the run's snapshot and the agent's start reached the agent
 * and is not drift. One appended AFTER that read is an instruction the agent never saw, and a claim
 * made without it does not settle the ticket it now describes. A snapshot with no notes field at
 * all — `bd show` failing at dispatch, on a listing that carries none — is held to "no human notes":
 * the agent was prompted with none, so any on the ticket now are ones it never read.
 */
function contractDriftedSinceDispatch(dispatched: Bead, now: Bead): string | undefined {
  if (dispatched.description === undefined) {
    return (
      `the dispatch-time read of \`${now.id}\` never carried its description — the agent was ` +
      `prompted without the contract's main body, so anton cannot tell whether the claim is about ` +
      `the ticket the board holds, and will not close it on that evidence`
    );
  }
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const changed: string[] = CONTRACT_FIELDS.filter((field) => text(dispatched[field]) !== text(now[field]));
  if (humanNotesOf(dispatched) !== humanNotesOf(now)) changed.push("human notes");
  if (changed.length === 0) return undefined;
  return (
    `\`${now.id}\` no longer reads as it did when the agent was dispatched (${changed.join(", ")} ` +
    `changed while it ran) — the claim was made about the ticket the agent read, and anton will ` +
    `not close the one that replaced it on that evidence`
  );
}

/**
 * Why the ticket's direct home is not the one the agent was dispatched under — or undefined while
 * it still is (PR #238 review).
 *
 * The under-lock fence ({@link targetRehomed}) compares the write's read with the CHECK's, and the
 * check's board is read after the report — so a re-parent that landed while the agent ran is the
 * baseline it starts from, and it passes. The dispatch snapshot is the one read from before the
 * move: the board row the run dispatched from, which carries the parent field the listing writes.
 */
function homeMovedSinceDispatch(dispatched: Bead, now: Bead): string | undefined {
  const was = beads.parentOf(dispatched) ?? "";
  const is = beads.parentOf(now) ?? "";
  if (was === is) return undefined;
  return (
    `\`${now.id}\` was re-homed while the agent was running — it hung under ` +
    `${was ? `\`${was}\`` : "no parent"} when the agent was dispatched and hangs under ` +
    `${is ? `\`${is}\`` : "no parent"} now, so closing it as superseded would settle it inside a ` +
    `run this one does not own`
  );
}

/**
 * Why the ticket no longer rides the run target it was dispatched under — or undefined while it
 * still does (PR #238 review). The ancestor half of {@link homeMovedSinceDispatch}: a
 * `feature → task → subtask` subtask changes run targets when the TASK is re-homed, its own parent
 * field never written (board-index.ts `ticketPathOf`), so only the run's own knowledge of which
 * card it dispatched for can see the move. A ticket that IS its run target rides itself.
 */
function ownerMovedSinceDispatch(index: BoardIndex, now: Bead, runTargetId: string): string | undefined {
  const onBoard = index.byId.get(now.id) ?? now;
  const rides = ticketOwnerOf(index, onBoard)?.id ?? (beads.isRunTarget(onBoard, index.all) ? onBoard.id : "");
  if (rides === runTargetId) return undefined;
  return (
    `\`${now.id}\` no longer rides \`${runTargetId}\`, the run target it was dispatched under — it ` +
    `${rides ? `rides \`${rides}\`` : "rides no run target"} now, so closing it as superseded would ` +
    `settle it inside a run this one does not own`
  );
}

/** The refusal both dispatch-time home fences hand back — one wording, whichever half saw the move. */
function rehomedWhileRunning(id: string, moved: string, claim: string): AlreadyShippedOutcome {
  return {
    action: "escalate",
    why:
      `${id} blocked as \`${KLASS}\`, but the ticket was re-homed while the agent was running — ` +
      `the claim was made for the run that dispatched it, and the ticket now belongs to another, ` +
      `so anton retired nothing.`,
    evidence: [moved, `the agent reported: ${claim}`],
  };
}

/**
 * Why the ticket at the write no longer hangs where the claim was checked — or undefined while it
 * still does (PR #238 review).
 *
 * A re-parent takes the moved bead's lock and its new home's (apply-steps `lockedBeads`), so one
 * that moved THIS ticket has already finished by the time these locks are held — and it leaves the
 * ticket open with its contract untouched, which every other target guard here accepts. But the
 * retirement is written on behalf of the run whose ticket set the check read: `supersede` closes
 * the ticket wherever it now hangs, so the old run would record as retired a ticket that closed
 * inside a feature another run owns. Both the direct parent and the run target are compared,
 * because the two move independently: a `feature → task → subtask` subtask changes owners when the
 * TASK is re-homed, its own parent field never written (board-index.ts `ticketPathOf`).
 */
function targetRehomed(
  snapshot: BoardIndex,
  checked: Bead,
  locked: BoardIndex,
  now: Bead,
): string | undefined {
  const home = (bead: Bead): string => beads.parentOf(bead) ?? "";
  const was = home(checked);
  const is = home(now);
  if (was !== is) {
    return (
      `\`${now.id}\` was re-homed since the check — it hung under ${was ? `\`${was}\`` : "no parent"} ` +
      `and hangs under ${is ? `\`${is}\`` : "no parent"} now, so closing it as superseded would ` +
      `settle it inside a run this one does not own`
    );
  }
  const owner = ticketOwnerOf(snapshot, checked)?.id ?? "";
  const rides = ticketOwnerOf(locked, locked.byId.get(now.id) ?? now)?.id ?? "";
  if (owner === rides) return undefined;
  return (
    `\`${now.id}\` no longer rides ${owner ? `\`${owner}\`` : "the run target"} it was checked ` +
    `under — it ${rides ? `rides \`${rides}\`` : "rides no run target"} now, so closing it as ` +
    `superseded would settle it inside a run this one does not own`
  );
}

/**
 * Why the survivor no longer rides the run target whose merged PR spoke for it — or undefined
 * while it still does (PR #238 review).
 *
 * A re-parent takes the survivor's lock, so it SERIALIZES against this write; serialized is not
 * refused. Re-homed under another card, or detached to run on its own, the survivor's work is no
 * longer what the verified PR carried, and rereading that PR by id would re-verify evidence that
 * stopped being about the survivor. Ownership is read off the locked whole-board read rather than
 * the survivor alone, because it is the ancestors that decide whose card a bead rides.
 */
function stillRidesOwner(
  locked: BoardIndex,
  targetId: string,
  replacementId: string,
  ownerId: string,
): string | undefined {
  const onBoard = locked.byId.get(replacementId);
  if (!onBoard) return `\`${replacementId}\` is no longer on the board`;
  const owner = ticketOwnerOf(locked, onBoard);
  if (owner?.id === ownerId) return undefined;
  return (
    `\`${replacementId}\` no longer rides \`${ownerId}\`, the run target whose merged PR anton ` +
    `verified — it ${owner ? `rides \`${owner.id}\`` : "rides no run target"} now, so that PR no ` +
    `longer speaks for its work, and ${targetId} is not superseded on that evidence`
  );
}

/**
 * The beads a re-parent of which would carry `id` to another home: every ancestor it reaches its
 * run target through, and that run target itself — the two things {@link targetRehomed} compares.
 * Read off the board the CHECK read, since that is the chain the retirement is written against.
 */
function ancestorChainOf(index: BoardIndex, id: string): string[] {
  const checked = index.byId.get(id);
  if (!checked) return [];
  const through = ticketPathOf(index, checked).map((b) => b.id);
  const owner = ticketOwnerOf(index, checked)?.id;
  return owner ? [...through, owner] : through;
}

/**
 * The whole board, re-read INSIDE the write locks — or why it could not be. One read serves every
 * question the retirement asks of the graph rather than of a single bead: the subtree beneath the
 * ticket, and whose card the survivor rides. A board that could not be re-read says nothing, so the
 * retirement refuses and nothing is written.
 */
async function readBoardUnderLock(repoPath: string, when: "before" | "after"): Promise<BoardIndex | string> {
  try {
    return indexBoard(await readBoard(repoPath));
  } catch (e) {
    return `the board could not be re-read ${when} the retirement (${errorText(e)})`;
  }
}

/**
 * Open work beneath the ticket, judged from the board read inside its write lock. The same bar the
 * snapshot was held to before the check ran, re-asked where a concurrent re-parent is ordered
 * against it.
 */
function strandedUnderLock(locked: BoardIndex, targetId: string): string | undefined {
  const open = locked.openDescendants(targetId);
  if (open.length === 0) return undefined;
  return (
    `open work was attached beneath ${targetId} since the check ` +
    `(${open.map((b) => b.id).join(", ")}) — closing it as superseded now would strand that ` +
    `work under a card no run can reach`
  );
}

/**
 * A bead attached beneath the ticket since the check that {@link strandedUnderLock} lets through —
 * one already CLOSED. It strands nothing itself, but it is a home this retirement holds no lock on
 * (the locks cover the subtree the CHECK read), so open work could land under it between this read
 * and the supersede with nothing to order it. Refused, so that the subtree the write settles is
 * exactly the one the locks hold.
 */
function subtreeMoved(
  locked: BoardIndex,
  targetId: string,
  held: readonly string[],
): string | undefined {
  const heldSet = new Set(held);
  const attached = locked.descendantsOf(targetId).filter((b) => !heldSet.has(b.id));
  if (attached.length === 0) return undefined;
  return (
    `a bead was attached beneath ${targetId} since the check ` +
    `(${attached.map((b) => b.id).join(", ")}) — the retirement holds no lock on it, so work ` +
    `could still land under it before the ticket closed`
  );
}

/**
 * The note anton leaves when it REFUSED an `already-shipped` repair — the class bound to the shared
 * formatter, so every repair's refusal reads the same way on a bead.
 */
export function refusalNote(outcome: Extract<AlreadyShippedOutcome, { action: "escalate" }>): string {
  return refusal(KLASS, outcome);
}
