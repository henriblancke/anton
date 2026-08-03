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
import { isInFlight, isOpenWork, type BoardIndex } from "./board-index";
import { makeDetection, type GardenerDetection } from "./detections";

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
    if (!isOpenWork(bead) || isInFlight(bead, nowMs)) continue;
    if (!isRunTicket(bead, index.cards)) continue;
    if (index.cards.cardOf(bead) !== undefined) continue;

    const parentId = beads.parentOf(bead);
    const parent = parentId ? index.byId.get(parentId) : undefined;
    if (!parent || !index.isContainer(parent)) continue;

    const features = index.childrenOf(parent.id).filter((c) => c.issue_type === "feature");
    // A feature a run OWNS is not a home: that run already selected the tickets it will work through,
    // so a bead attached now rides along unrun and is left beneath a card the run is about to settle.
    // Apply refuses such a home for the same reason, so proposing one could only end in a refusal.
    const open = features.filter((f) => isOpenWork(f) && !isInFlight(f, nowMs));
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

/** Shorter tokens carry no topic (`the`, `add`, `api` matches everything a board is about). */
const MIN_TOKEN_LENGTH = 4;

/**
 * Function words and process nouns that appear in half the titles on any engineering board. They
 * would make every cluster share a "topic" with every card, so they never count as a signal.
 * Deliberately short: the distinctiveness rule below does the real filtering, and a long stopword
 * list is a second place for the vocabulary to drift.
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
  "task",
  "tasks",
  "issue",
  "issues",
  "thing",
  "stuff",
]);

/**
 * A bead's topic keys: significant title tokens plus its `area:` labels. The two are one namespace
 * on purpose — `area:reports` can't collide with a word — so the distinctiveness rule below applies
 * to a curated label and an inferred word alike.
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
    if (label.startsWith("area:")) keys.add(label);
  }
  return keys;
}

/**
 * Parentless working-layer beads that share one obvious card home. Each is technically a legal
 * standalone run target ("an epic-of-one"), so the smell is not the shape of any single bead — it is
 * a HANDFUL of them orbiting the same feature, which means the board is showing a pile of chips
 * where it should be showing one card's worth of tickets.
 *
 * "Obvious" is defined narrowly, because a wrong regroup is worse than a missed one: a shared topic
 * key counts only if EXACTLY ONE open card carries it, and a bead pointing at two different cards is
 * dropped as ambiguous. A key half the board shares says nothing about where work belongs.
 */
export function detectParentlessClusters(index: BoardIndex, nowMs: number): GardenerDetection[] {
  // Mid-run cards are not homes: their run has already chosen its tickets, so beads moved under one
  // now would never be dispatched and would strand when the run settles the card (apply refuses one
  // for the same reason).
  const homes = index.all.filter(
    (b) => index.cards.ids.has(b.id) && isOpenWork(b) && !isInFlight(b, nowMs),
  );
  const homeKeys = new Map(homes.map((h) => [h.id, topicKeys(h)]));

  const keyOwners = new Map<string, number>();
  for (const keys of homeKeys.values()) {
    for (const key of keys) keyOwners.set(key, (keyOwners.get(key) ?? 0) + 1);
  }

  const members = new Map<string, Array<{ bead: Bead; shared: string[] }>>();
  for (const bead of index.all) {
    if (!isClusterCandidate(bead, nowMs)) continue;
    const keys = topicKeys(bead);

    const matches: Array<{ homeId: string; shared: string[] }> = [];
    for (const home of homes) {
      const shared = [...keys]
        .filter((key) => keyOwners.get(key) === 1 && homeKeys.get(home.id)?.has(key))
        .sort();
      if (shared.length > 0) matches.push({ homeId: home.id, shared });
    }
    // Two candidate homes is not an obvious home. Say nothing rather than pick one.
    if (matches.length !== 1) continue;

    const [match] = matches;
    const group = members.get(match.homeId);
    if (group) group.push({ bead, shared: match.shared });
    else members.set(match.homeId, [{ bead, shared: match.shared }]);
  }

  const detections: GardenerDetection[] = [];
  for (const [homeId, group] of members) {
    if (group.length < MIN_CLUSTER_SIZE) continue;
    const home = index.byId.get(homeId);
    if (!home) continue;
    detections.push(
      makeDetection({
        kind: "parentless-cluster",
        move: "reparent",
        subjects: group.map((m) => m.bead.id),
        target: homeId,
        summary: `${group.length} parentless beads share an obvious home in ${homeId} — re-parent them under it`,
        evidence: [
          `${homeId} ("${home.title}") is the only open board card matching their topic`,
          ...group.map(
            (m) => `${m.bead.id} ("${m.bead.title}") shares ${quoteList(m.shared)} with ${homeId}`,
          ),
          `each is parentless today, so the board shows them as loose chips instead of ${homeId}'s tickets`,
        ],
      }),
    );
  }

  return detections;
}

/** The working layer a cluster can be built from: parentless, still wanted, and not mid-run. */
function isClusterCandidate(bead: Bead, nowMs: number): boolean {
  const type = bead.issue_type ?? "";
  if (type !== "task" && type !== "bug" && type !== "chore") return false;
  if (beads.parentOf(bead)) return false;
  return isOpenWork(bead) && !isInFlight(bead, nowMs);
}

const idList = (list: Bead[]): string => (list.length ? list.map((b) => b.id).join(", ") : "none");

const quoteList = (values: string[]): string => values.map((v) => `"${v}"`).join(", ");
