/**
 * The two MISPARENTED classes (anton-02oc): work hanging where no run can reach it, and work hanging
 * nowhere at all that obviously belongs somewhere. Both resolve to the same move — `bd update
 * --parent` — so both live here.
 *
 * Neither detector proposes a parent that would recreate the problem: a home must be a BOARD CARD
 * (a feature, or an epic with no feature children). Re-parenting a task under a container epic is
 * exactly the state `detectContainerOrphans` exists to flag.
 */
import { beads, type Bead } from "../beads/bd";
import { isRunTicket } from "../ticket-view";
import { isClaimed, isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

/**
 * Free to be moved, or to have work moved under it: still wanted, no run mid-flight over it, and no
 * run holding a claim on it.
 *
 * The claim is asked separately because {@link isInFlight} cannot see it: a bead that has completed
 * the verified pickup protocol carries the assignee and `in_progress` for as long as it takes its
 * execute job to publish a lease, and reads as free work until then (see {@link isClaimed}). Every
 * bar here matters at BOTH ends of a re-parent — proposing to move a claimed bead hands an approver
 * work another machine owns, and the queued run then parks when it refreshes the board and finds its
 * target is now somebody's child rather than a run target.
 */
const isFree = (bead: Bead, nowMs: number): boolean =>
  isOpenWork(bead) && !isInFlight(bead, nowMs) && !isClaimed(bead);

/**
 * Work whose parent is a CONTAINER epic — the anton-do0q class. An epic with feature children groups
 * run targets rather than being one, so a task hanging directly off it has no card ancestor: the
 * board renders it nowhere and no run ever dispatches it. It is not lost (the epic detail page and
 * the Tickets list still show it), it is simply unreachable by execution, which is the worse half.
 *
 * Only the TOPMOST offender is flagged — a bead whose DIRECT parent is the container. A task under
 * that task is stranded by the same fact, and re-parenting the one above it fixes the whole subtree;
 * proposing a move per descendant would ask an approver to answer the same question N times.
 *
 * The card check is not redundant with the container check: an epic nested under a card epic still
 * carries its children onto that ancestor's card, and work the board already shows is not misfiled.
 */
export function detectContainerOrphans(index: BoardIndex, nowMs: number): GardenerDetection[] {
  const detections: GardenerDetection[] = [];

  for (const bead of index.all) {
    if (!isFree(bead, nowMs)) continue;
    if (!isRunTicket(bead, index.cards)) continue;
    if (index.cards.cardOf(bead) !== undefined) continue;

    const parentId = beads.parentOf(bead);
    const parent = parentId ? index.byId.get(parentId) : undefined;
    if (!parent || !index.isContainer(parent)) continue;

    const features = index.childrenOf(parent.id).filter((c) => c.issue_type === "feature");
    // A feature a run OWNS is not a home: that run already selected the tickets it will work through,
    // so a bead attached now rides along unrun and is left beneath a card the run is about to settle.
    // Apply refuses such a home for the same reason, so proposing one could only end in a refusal.
    const open = features.filter((f) => isFree(f, nowMs));
    // One available feature is an unambiguous home; several (or none) leave the choice to the
    // approver, who gets the candidate list as evidence rather than a coin-flip dressed up as a
    // suggestion.
    const target = open.length === 1 ? open[0] : undefined;

    detections.push(
      makeDetection({
        kind: "container-orphan",
        move: "reparent",
        subjects: [bead.id],
        ...(target ? { target: target.id } : {}),
        summary: target
          ? `${bead.id} hangs off container epic ${parent.id} and rides no board card — re-parent it under ${target.id}`
          : `${bead.id} hangs off container epic ${parent.id} and rides no board card — re-parent it under one of its features`,
        evidence: [
          `${parent.id} is a container epic: its ${features.length} feature child(ren) (${idList(features)}) each run on their own, so the epic itself is not runnable`,
          `${bead.id} (${bead.issue_type ?? "bead"}, ${bead.status}) has no board-card ancestor — no run will dispatch it and the board shows it nowhere`,
          `nothing has shipped it: no PR ref and no live run lease`,
          open.length === 0
            ? `${parent.id} has no feature free to host it — each is settled or mid-run, so the approver may need to shape one first`
            : `available feature homes under ${parent.id}: ${idList(open)}`,
        ],
      }),
    );
  }

  return detections;
}

/** How many parentless beads must agree on a home before "obvious" is a claim worth making. */
export const MIN_CLUSTER_SIZE = 2;

/**
 * How many INFERRED title terms a cluster and its home must hold in common before the match counts
 * as subject matter.
 *
 * Two, because one is a coincidence. This detector used to accept ONE term and call it distinctive
 * whenever exactly one open card carried it — but a board of a few dozen cards makes almost every
 * word unique to one of them, so rarity there measured nothing about topic. `epic`, `instead`,
 * `three`, `copy`, `block`, `route` and `ticket` all cleared that bar, and nine of eleven proposals
 * were declined on sight (anton-9hpp). Two terms every member states is a subject, not a word.
 */
export const MIN_SHARED_TERMS = 2;

/** Shorter tokens carry no topic (`the`, `add`, `api` matches everything a board is about). */
const MIN_TOKEN_LENGTH = 4;

/** The label namespace a human uses to say what a bead is ABOUT, rather than what it says. */
const AREA_PREFIX = "area:";

/**
 * Words that can never be evidence two beads share a SUBJECT, in two families.
 *
 * Function words and process nouns, first — they appear in half the titles on any engineering board.
 * Then the WORKPIECE nouns: `epic`, `feature`, `ticket`, `bead`, `card`, `board`. Every row on a
 * project-management board is one of those, so two rows agreeing on one have agreed about nothing.
 * They are the same category as `task` and `issue`, which this list already held, and leaving them
 * out is how "epic" — the most generic word here — came to drive four proposals at one target.
 *
 * Still deliberately short. The agreement rule below does the real filtering; a list can never
 * encode which words carry topic, which is why it is not asked to.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "when",
  "what",
  "which",
  "while",
  "then",
  "than",
  "over",
  "under",
  "have",
  "make",
  "made",
  "does",
  "using",
  "should",
  "would",
  "could",
  "every",
  "each",
  "some",
  "more",
  "must",
  "never",
  "always",
  "work",
  "thing",
  "stuff",
  "task",
  "tasks",
  "issue",
  "issues",
  "bead",
  "beads",
  "board",
  "card",
  "cards",
  "epic",
  "epics",
  "feature",
  "features",
  "ticket",
  "tickets",
  "runs",
  "proposal",
  "proposals",
]);

/**
 * A bead's topic keys: significant title tokens plus its `area:` labels. The two are one namespace
 * on purpose — `area:reports` can't collide with a word — but they are not worth the same, and
 * {@link statesSubjectMatter} is where that difference is priced.
 *
 * Trailing plurals are folded so `report` and `reports` are the same topic.
 */
export function topicKeys(bead: Bead): Set<string> {
  const keys = new Set<string>();
  for (const raw of (bead.title ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    const token = raw.endsWith("s") && raw.length > MIN_TOKEN_LENGTH ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(token) || STOPWORDS.has(raw)) continue;
    keys.add(token);
  }
  for (const label of bead.labels ?? []) {
    if (label.startsWith(AREA_PREFIX)) keys.add(label);
  }
  return keys;
}

/** A curated `area:` label — the one topic key a person WROTE rather than one we inferred. */
const isCuratedKey = (key: string): boolean => key.startsWith(AREA_PREFIX);

/**
 * Does this set of keys amount to shared SUBJECT MATTER, or is it just words two titles happen to
 * have in common? The whole difference between a proposal a founder acts on and one they close
 * unread, so it is stated once, here.
 *
 * A curated `area:` label is a person's own answer to "what is this about", so one carries the claim
 * by itself. An inferred title term is a guess, and a single guess is noise at board scale — hence
 * {@link MIN_SHARED_TERMS} of them.
 */
function statesSubjectMatter(shared: ReadonlySet<string>): boolean {
  const keys = [...shared];
  return keys.some(isCuratedKey) || keys.length >= MIN_SHARED_TERMS;
}

/** A parentless bead the cluster rule considers, with its topic read once. */
interface Candidate {
  bead: Bead;
  keys: Set<string>;
}

/**
 * One group of loose beads that state the same subject, formed around a key their prospective home
 * states too.
 */
interface TopicGroup {
  members: Bead[];
  /** Every key EVERY member carries — what the group agrees it is about. */
  shared: string[];
  /** The part of that subject the home states as well. Never empty: the anchor is always in it. */
  held: string[];
}

/**
 * The topic groups a home can host: for each key the home states, the loose beads that state it too,
 * kept only when those beads AGREE with each other about the subject.
 *
 * Agreement is the whole fix. Matching each bead against the home on its own private word let five
 * beads sharing nothing but `epic` read as one cluster; requiring the intersection of the members'
 * keys to state subject matter means the group has to be about one thing before it is proposed as
 * one card's tickets.
 *
 * Agreement is asked of a GROUP, not of everything the anchor happens to reach. Two beads that state
 * "escalation banner" between them are a cluster whether or not an unrelated "escalation timeout"
 * bead exists — but intersecting all three collapses to the bare anchor and would discard the pair,
 * so a detector that only ever asked about the whole match set went silent for a reason that has
 * nothing to do with the beads it was about ({@link agreeingSubsets}).
 *
 * Anchors are walked in sorted order so a home hosting two groups yields them in the same order on
 * every patrol, and a membership two anchors both reach is kept ONCE. Anchors overlap freely — a
 * home stating three keys can reach the same pair through two of them — and the detection's subject
 * list de-dupes ids but its EVIDENCE does not, so without this a proposal spelled the same group's
 * lines out twice for a founder to read twice.
 */
function topicGroups(homeKeys: Set<string>, candidates: Candidate[]): TopicGroup[] {
  const groups: TopicGroup[] = [];
  const seen = new Set<string>();
  for (const anchor of [...homeKeys].sort()) {
    const members = candidates.filter((c) => c.keys.has(anchor));
    if (members.length < MIN_CLUSTER_SIZE) continue;
    for (const group of agreeingSubsets(members)) {
      const identity = groupIdentity(group);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const shared = intersectKeys(group.map((m) => m.keys));
      groups.push({
        members: group.map((m) => m.bead),
        shared: [...shared].sort(),
        held: [...shared].filter((key) => homeKeys.has(key)).sort(),
      });
    }
  }
  return groups;
}

/**
 * Which of these beads still sit in a topic group this home can host — the grouping claim
 * {@link detectParentlessClusters} makes, re-asked of whatever is left of a cluster later.
 *
 * A proposal's subject list is the UNION of every group one home hosts, so an escalation pair and a
 * docker pair ride one proposal. Losing a member of each leaves two survivors that agree about
 * nothing, and only the detector's own predicate can say so — hence this, rather than a second
 * reading of the rule in the module that approves the move (apply-plan.ts `regroupSurvivors`).
 */
export function groupedUnder(home: Bead, members: Bead[]): Set<string> {
  const groups = topicGroups(
    topicKeys(home),
    members.map((bead) => ({ bead, keys: topicKeys(bead) })),
  );
  return new Set(groups.flatMap((group) => group.members.map((m) => m.id)));
}

/** A group's membership as one comparable string — what makes two anchors' groups the same group. */
const groupIdentity = (group: Candidate[]): string =>
  group
    .map((m) => m.bead.id)
    .sort()
    .join("+");

/**
 * The subsets of one anchor's matches that state a subject between them: the whole set when it
 * already agrees, and otherwise the sub-groups each further shared key forms.
 *
 * Partitioning by a key rather than searching for maximal agreeing subsets on purpose — the SUBJECT
 * is what an approver checks, so a group is named by the two terms it holds ("escalation" plus
 * "banner"), and every subset this yields carries at least those two by construction. Keys are
 * walked sorted, so a patrol's groups do not depend on the order the board was read in; a
 * membership two keys both reach is folded by the caller, which has to fold across anchors anyway.
 */
function agreeingSubsets(members: Candidate[]): Candidate[][] {
  if (statesSubjectMatter(intersectKeys(members.map((m) => m.keys)))) return [members];

  const subsets: Candidate[][] = [];
  const secondary = new Set(members.flatMap((m) => [...m.keys]));
  for (const key of [...secondary].sort()) {
    const subset = members.filter((m) => m.keys.has(key));
    if (subset.length < MIN_CLUSTER_SIZE) continue;
    if (!statesSubjectMatter(intersectKeys(subset.map((m) => m.keys)))) continue;
    subsets.push(subset);
  }
  return subsets;
}

/** Every key present in all of these sets. */
function intersectKeys(sets: Set<string>[]): Set<string> {
  const [first, ...rest] = sets;
  const shared = new Set(first);
  for (const other of rest) {
    for (const key of shared) if (!other.has(key)) shared.delete(key);
  }
  return shared;
}

/**
 * How many tickets a board card must already carry before "obvious home" is a claim worth making.
 *
 * One, because the question is whether the card is a CONTAINER at all: a leaf feature is one PR's
 * worth of work, and hanging a cluster off it turns somebody's card into somebody else's epic.
 * Stated as a constant because approving a cluster re-asks it against the board as it now is
 * (apply-plan.ts `homeStoppedCarrying`) — a card can lose its last ticket between the two reads.
 */
export const MIN_CARRIED_TICKETS = 1;

/**
 * Does this bead reach its card THROUGH one the caller named — or is it one of them?
 *
 * Naming a bead has to take its subtree with it. `cardOf` walks the WHOLE parent chain, so the
 * moment somebody hand-files a named member under the home, every ticket beneath that member is
 * attributed to the home too — and it reaches the home only by the move being asked for. Counting
 * one would let the ask prove its own container premise with its own proposal subtree, which is the
 * exact circularity dropping the members' own ids exists to close.
 *
 * The walk stops at the first card ancestor: that is where the attribution this mirrors stops.
 */
function ridesOnNamed(index: BoardIndex, bead: Bead, ignore: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  let current: Bead | undefined = bead;
  while (current && !seen.has(current.id)) {
    if (ignore.has(current.id)) return true;
    if (index.cards.ids.has(current.id) && current.id !== bead.id) return false;
    seen.add(current.id);
    const parentId = beads.parentOf(current);
    current = parentId ? index.byId.get(parentId) : undefined;
  }
  return false;
}

/**
 * How many tickets each board card carries, counted through the board's OWN card attribution
 * (`boardCards.cardOf`), so "rides this card" means here what it means on the board itself.
 *
 * Closed tickets count. The question is what ROLE the card plays — does the board already file work
 * of this kind under it — and a card whose eight tickets all shipped answered that question just as
 * clearly as one whose eight are open.
 *
 * `ignore` drops named ids AND everything riding on them ({@link ridesOnNamed}) from the count. It is
 * how the approval re-asks the bar without letting the cluster's own members — which somebody may
 * have filed under the home by hand since the proposal — stand in for the pre-existing tickets that
 * made the home obvious in the first place.
 */
export function ticketsPerCard(
  index: BoardIndex,
  ignore?: ReadonlySet<string>,
): Map<string, number> {
  const carried = new Map<string, number>();
  for (const bead of index.all) {
    if (!isRunTicket(bead, index.cards)) continue;
    if (ignore && ridesOnNamed(index, bead, ignore)) continue;
    const card = index.cards.cardOf(bead);
    if (card) carried.set(card, (carried.get(card) ?? 0) + 1);
  }
  return carried;
}

/**
 * WHICH tickets one card carries, by the same attribution {@link ticketsPerCard} counts them with —
 * `ignore` included, so a named member's descendants are no more evidence here than the member is.
 *
 * The ids rather than the count, because an approval has to hold them: the write half locks the
 * tickets its home's container premise rests on and re-asks the bar over those beads alone
 * (apply-plan.ts `homeCarriesNothing`'s `only`, apply-steps.ts `lockedBeads`). A count is not
 * lockable; a list is.
 */
export function carriedTickets(
  index: BoardIndex,
  cardId: string,
  ignore?: ReadonlySet<string>,
): string[] {
  return index.all
    .filter(
      (bead) =>
        isRunTicket(bead, index.cards) &&
        index.cards.cardOf(bead) === cardId &&
        !(ignore && ridesOnNamed(index, bead, ignore)),
    )
    .map((bead) => bead.id);
}

/**
 * Parentless working-layer beads that share one obvious card home. Each is technically a legal
 * standalone run target ("an epic-of-one"), so the smell is not the shape of any single bead — it is
 * a HANDFUL of them orbiting the same feature, which means the board is showing a pile of chips
 * where it should be showing one card's worth of tickets.
 *
 * "Obvious" is three things, and a claim needs all three (anton-9hpp — the rule this replaced needed
 * none of them and was declined nine times in eleven):
 *
 *   • THE GROUP AGREES. The loose beads state one subject BETWEEN THEM ({@link statesSubjectMatter}),
 *     not a different word each against the card. Rarity is not topic: a board of a few dozen cards
 *     makes almost every word unique to one, which is how `epic` became a home signal.
 *   • THE CARD IS A CONTAINER. It already carries tickets. A leaf feature is one PR's worth of work,
 *     and hanging a cluster off it turns somebody's card into somebody else's epic; "already files
 *     work of this kind" is the far stronger home signal, and the same index answers it.
 *   • NOBODY ELSE CLAIMS THEM. A bead two cards can each host is dropped, because a coin flip
 *     dressed as a suggestion is worse than saying nothing.
 */
export function detectParentlessClusters(index: BoardIndex, nowMs: number): GardenerDetection[] {
  const carried = ticketsPerCard(index);
  // Mid-run cards are not homes: their run has already chosen its tickets, so beads moved under one
  // now would never be dispatched and would strand when the run settles the card (apply refuses one
  // for the same reason).
  const homes = index.all.filter(
    (b) =>
      index.cards.ids.has(b.id) && isFree(b, nowMs) && (carried.get(b.id) ?? 0) >= MIN_CARRIED_TICKETS,
  );
  const candidates: Candidate[] = index.all
    .filter((b) => isClusterCandidate(b, nowMs))
    .map((bead) => ({ bead, keys: topicKeys(bead) }));

  const hosted = new Map<string, TopicGroup[]>();
  for (const home of homes) {
    const groups = topicGroups(topicKeys(home), candidates);
    if (groups.length > 0) hosted.set(home.id, groups);
  }

  const detections: GardenerDetection[] = [];
  const contested = contestedMembers(hosted);
  for (const [homeId, groups] of hosted) {
    const home = index.byId.get(homeId);
    if (!home) continue;
    const settled = groups
      .map((g) => ({ ...g, members: g.members.filter((m) => !contested.has(m.id)) }))
      .filter((g) => g.members.length >= MIN_CLUSTER_SIZE);
    // Ids in fingerprint order, and each bead named once however many groups reached it.
    const subjects = [...new Set(settled.flatMap((g) => g.members.map((m) => m.id)))].sort();
    if (subjects.length < MIN_CLUSTER_SIZE) continue;

    detections.push(
      makeDetection({
        kind: "parentless-cluster",
        move: "reparent",
        subjects,
        target: homeId,
        summary: `${subjects.length} parentless beads share an obvious home in ${homeId} — re-parent them under it`,
        evidence: [
          `${homeId} ("${home.title}") is an open board card that already carries ${carried.get(homeId) ?? 0} ticket(s), so the board already files work of this kind under it`,
          ...settled.flatMap((group) => [
            `${idList(group.members)} all state ${quoteList(group.shared)} — one subject the whole group holds, not a word each happens to share with the card`,
            ...group.members.map((m) => `  ${m.id}: "${m.title}"`),
            `${homeId} states ${quoteList(group.held)} too`,
          ]),
          `each is parentless today, so the board shows them as loose chips instead of ${homeId}'s tickets`,
        ],
      }),
    );
  }

  return detections;
}

/**
 * Loose beads more than one home can host. Their topic points two ways, so no home is OBVIOUS — and
 * this detector's whole licence is obviousness. Collected across every home before any detection is
 * built, because which homes want a bead is not knowable while walking one of them.
 */
function contestedMembers(hosted: Map<string, TopicGroup[]>): Set<string> {
  const homesOf = new Map<string, Set<string>>();
  for (const [homeId, groups] of hosted) {
    for (const group of groups) {
      for (const member of group.members) {
        const claimants = homesOf.get(member.id);
        if (claimants) claimants.add(homeId);
        else homesOf.set(member.id, new Set([homeId]));
      }
    }
  }
  return new Set([...homesOf].filter(([, homes]) => homes.size > 1).map(([id]) => id));
}

/**
 * The tiers a cluster is built FROM: working-layer work that is not itself a board card. Stated
 * apart from {@link isClusterCandidate} because approving a proposal has to re-ask it — a member
 * promoted to a `feature` since the filing has left the cluster, and the tier taxonomy would
 * otherwise read the move as `feature-under-non-epic` and refuse the whole ask (apply-plan.ts
 * `clusterMemberLeftLayer`).
 */
export function isClusterTier(bead: Bead): boolean {
  const type = bead.issue_type ?? "";
  return type === "task" || type === "bug" || type === "chore";
}

/**
 * The working layer a cluster can be built from: parentless, still wanted, and held by nobody — no
 * live run over it and no run claim on it (see {@link isFree}). A parentless task or bug IS a run
 * target, so a claim on one is a machine that has already picked it up.
 */
function isClusterCandidate(bead: Bead, nowMs: number): boolean {
  if (!isClusterTier(bead)) return false;
  if (beads.parentOf(bead)) return false;
  return isFree(bead, nowMs);
}

const idList = (list: Bead[]): string => (list.length ? list.map((b) => b.id).join(", ") : "none");

const quoteList = (values: string[]): string => values.map((v) => `"${v}"`).join(", ");
