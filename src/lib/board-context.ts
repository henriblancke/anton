/**
 * The board as /scan-triage needs to see it (anton-ol1l): which open features already own which
 * files, which epics — open or closed — can take a new feature, and every fingerprint an automated
 * producer has already put on the board.
 *
 * Resolved here, in code, rather than left to the triage agent's own `bd` reads. A scan runs
 * unattended, so a board read the agent skips or truncates costs a duplicate bead nobody catches —
 * and the placement rules it would have to re-derive per scan (a feature whose run has started must
 * not grow; a pre-tier epic must not take its first feature; a childless feature must not get its
 * first child) are mechanical. Judgment — does this signal BELONG to that feature — stays with the
 * agent; eligibility does not.
 *
 * Dedup spans producers on purpose: stringer is not the only pass that files beads, so a scan that
 * only checks `stringer:*` fingerprints re-raises what the gardener or a PM pass already raised.
 */
import { beads, type Bead } from "./beads/bd";
import { sectionBody } from "./beads/contract";

/**
 * The automated producers whose fingerprints triage must arbitrate across. Fingerprints are
 * `<producer>:<class>:<hash>` labels; the `<hash>` identifies the underlying issue, so the SAME
 * hash under two namespaces is one issue raised twice — a cross-link, never a second bead.
 */
export const PRODUCER_NAMESPACES = ["stringer", "gardener", "pm"] as const;
export type ProducerNamespace = (typeof PRODUCER_NAMESPACES)[number];

const FINGERPRINT_RE = new RegExp(`^(${PRODUCER_NAMESPACES.join("|")}):([^:\\s]+):([^:\\s]+)$`);

/** How many entries each section of the rendered context carries before it says what it dropped. */
export const MAX_FEATURES = 40;
export const MAX_EPICS = 40;
export const MAX_PRODUCER_BEADS = 80;
/** Per bead — a `touches:` line naming 60 files is noise at the point where it stops being a surface. */
export const MAX_TOUCHES = 12;

/** One fingerprint label, split into the parts triage matches on. */
export interface Fingerprint {
  label: string;
  producer: ProducerNamespace;
  class: string;
  hash: string;
}

/**
 * A bead's declared touch surface as the context carries it: capped at {@link MAX_TOUCHES}, plus how
 * many the cap dropped. The count is not bookkeeping — a signal landing on a dropped file would read
 * as unowned, so the omission is rendered and the agent is told to look the rest up before deciding.
 */
export interface TouchSurface {
  touches: string[];
  touchesOmitted: number;
}

/**
 * An open feature a signal might belong to, with the mechanical verdict on attaching to it. Its
 * `touches` is the whole RUN's surface — the feature's own plus its child tickets' (see
 * {@link buildBoardContext}) — because that is what the feature's PR actually changes.
 */
export interface FeatureCandidate extends TouchSurface {
  id: string;
  title: string;
  /** The epic it hangs under — where a genuinely unowned sibling feature would go instead. */
  epicId?: string;
  /** True when this triage may hang a child ticket here; `attachReason` says why not when false. */
  attachable: boolean;
  attachReason: string;
}

/** An epic, with whether a new feature may hang under it (§4.1's pre-tier trap). */
export interface EpicCandidate {
  id: string;
  title: string;
  area?: string;
  /** bd status — a CLOSED epic is still a candidate, but only after `bd reopen` (§4.1). */
  status: string;
  /** False for a pre-tier epic — its own tickets would stop running the moment a feature lands. */
  attachable: boolean;
  attachReason: string;
}

/** A bead some automated producer already filed, as the dedup check reads it. */
export interface ProducerBead extends TouchSurface {
  id: string;
  title: string;
  status: string;
  fingerprints: Fingerprint[];
}

export interface BoardContext {
  features: FeatureCandidate[];
  epics: EpicCandidate[];
  producers: ProducerBead[];
  /** What each section dropped to stay inside its cap — rendered, never silently swallowed. */
  omitted: { features: number; epics: number; producers: number };
}

/** Parse a `<producer>:<class>:<hash>` label; undefined for anything else on the bead. */
export function parseFingerprint(label: string): Fingerprint | undefined {
  const m = FINGERPRINT_RE.exec(label);
  if (!m) return undefined;
  return { label, producer: m[1] as ProducerNamespace, class: m[2], hash: m[3] };
}

/** Every producer fingerprint on a bead, in label order. */
export function fingerprintsOf(bead: Bead): Fingerprint[] {
  const out: Fingerprint[] = [];
  for (const label of bead.labels ?? []) {
    const fp = parseFingerprint(label);
    if (fp) out.push(fp);
  }
  return out;
}

/**
 * The `## Context` body of a bead — its own field when bd carries one, else the description section,
 * read through the CANONICAL contract parser (beads/contract.ts). Not a local regex: the gate accepts
 * a heading at any depth, so a second parser that only took `##` read a conformant `# Context` bead
 * as having no touch surface — routing then saw it as unowned and triage minted work beside the
 * feature already changing those files.
 */
function contextOf(bead: Bead): string {
  if (typeof bead.context === "string" && bead.context.trim()) return bead.context;
  return sectionBody(bead.description, ["context"]) ?? "";
}

/**
 * Extensionless repo-root files a `touches:` line legitimately names. The slash-or-dot test below is
 * what separates a path from prose ("touches: auth, routing"), and it would drop every one of these —
 * leaving the file unowned, so a Stringer signal against it routes into a competing feature even
 * though a run already owns it. Named exhaustively rather than loosened, so prose stays out.
 */
const EXTENSIONLESS_ROOT_FILES =
  /^(Dockerfile|Containerfile|Makefile|Justfile|Taskfile|Procfile|Rakefile|Gemfile|Brewfile|Vagrantfile|Caddyfile|Jenkinsfile|CODEOWNERS)$/i;

/** A token that reads as a repo path rather than prose — the filter that keeps `touches:` usable. */
function asPath(token: string): string | undefined {
  const cleaned = token
    .replace(/\([^)]*\)?/g, " ") // drop the "(54 lines, exports …)" annotations beads carry
    .replace(/[`*"']/g, " ")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/:\d+(-\d+)?$/, "") // file:14 / file:28-42 — the surface is the file
    .replace(/[.,;]+$/, "");
  if (!cleaned || cleaned.length > 200) return undefined;
  if (EXTENSIONLESS_ROOT_FILES.test(cleaned)) return cleaned;
  return /^[\w@./~-]*[/.][\w@./~-]+$/.test(cleaned) ? cleaned : undefined;
}

/**
 * The files a bead declares it touches, from the `touches:` marker every contract bead carries in
 * its Context. Best-effort by design: this is the routing HINT the agent reasons over, so a bead
 * whose Context is prose contributes nothing rather than garbage.
 */
export function parseTouches(bead: Bead): string[] {
  const context = contextOf(bead);
  const marker = /(^|\n)\s*touches\s*:/i.exec(context);
  if (!marker) return [];
  const after = context.slice(marker.index + marker[0].length);
  const line = after.split(/\n|;/)[0] ?? "";
  const seen = new Set<string>();
  for (const part of line.split(",")) {
    const path = asPath(part);
    if (path) seen.add(path);
  }
  return [...seen];
}

/** Children by parent id, from the inline `parent-child` edges one board read already carries. */
function childrenByParent(board: Bead[]): Map<string, Bead[]> {
  const byId = new Map(board.map((b) => [b.id, b]));
  const out = new Map<string, Bead[]>();
  for (const edge of beads.edgesOf(board)) {
    if (edge.type !== "parent-child") continue;
    const child = byId.get(edge.from);
    if (!child) continue;
    const list = out.get(edge.to);
    if (list) list.push(child);
    else out.set(edge.to, [child]);
  }
  return out;
}

/** A bead's parent id, from either the inline field or its `parent-child` edge. */
function parentOf(bead: Bead): string | undefined {
  if (bead.parent) return bead.parent;
  if (bead.parent_id) return bead.parent_id;
  return (bead.dependencies ?? []).find(
    (d) => d.type === "parent-child" && d.issue_id === bead.id,
  )?.depends_on_id;
}

/** The statuses that make a bead live work — a routing target, and a ticket a feature can strand. */
const OPEN_STATUSES = new Set(["open", "in_progress", "blocked", "deferred"]);

/**
 * Whether this triage may hang a child ticket on an open feature. Mirrors skills/scan-triage §3.2:
 * a run captures its ticket list when it starts, so a ticket added to a feature that is approved,
 * staged, leased or carrying a PR is never implemented — and a childless feature runs ITSELF off its
 * own Acceptance, so its first child would silently replace the spec that gets sent to the agent.
 */
function featureVerdict(bead: Bead, children: Bead[]): { attachable: boolean; reason: string } {
  const labels = bead.labels ?? [];
  if (bead.status !== "open") return { attachable: false, reason: `status:${bead.status}` };
  if (labels.includes("approved")) return { attachable: false, reason: "approved — a run may capture it at any moment" };
  const stage = labels.find((l) => l.startsWith("stage:"));
  if (stage) return { attachable: false, reason: `run in flight (${stage})` };
  // An EXPIRED lease still means a run captured this feature's tickets once; conservative here
  // costs a sibling bead, while attaching to a captured feature costs work that never runs.
  if (beads.runLeaseLabels(bead).length > 0) return { attachable: false, reason: "run-lease present" };
  const pr = beads.getPrRef(bead);
  if (pr) return { attachable: false, reason: `PR ${pr}` };
  if (children.length === 0) {
    return { attachable: false, reason: "childless — its own Acceptance is its ticket" };
  }
  return { attachable: true, reason: "extendable" };
}

/**
 * Whether a new feature may hang under an epic. An epic with only ticket children is itself the run
 * target (the run-target rule); the first feature under it turns it into a container and strands
 * those tickets on no run at all — a migration only a human should decide.
 *
 * Only OPEN tickets can be stranded, so only those count: `children` comes from the whole board read
 * (`--status all`), and counting closed ones flagged an epic whose tickets are all long since done as
 * pre-tier — refusing the one placement its next feature had, for work that cannot strand. A CLOSED
 * feature child still counts above: it proves the epic is a container, which is a claim about shape,
 * not about pending work.
 *
 * The epic's OWN status stays out of this — a closed epic is still a placement candidate; the
 * `bd reopen` precondition rides on its rendered verdict ({@link epicVerdictLine}).
 */
function epicVerdict(children: Bead[]): { attachable: boolean; reason: string } {
  const features = children.filter((c) => c.issue_type === "feature");
  if (features.length > 0) return { attachable: true, reason: `${features.length} feature(s)` };
  const tickets = children.filter(
    (c) => c.issue_type !== "feature" && OPEN_STATUSES.has(c.status),
  );
  if (tickets.length > 0) {
    return {
      attachable: false,
      reason: `PRE-TIER (${tickets.length} ticket child(ren), no feature) — attaching one would strand them`,
    };
  }
  return { attachable: true, reason: "empty" };
}

/** A declared surface, capped and with the cap's cost carried alongside it. */
function capSurface(declared: string[]): TouchSurface {
  return {
    touches: declared.slice(0, MAX_TOUCHES),
    touchesOmitted: Math.max(0, declared.length - MAX_TOUCHES),
  };
}

/**
 * Everything a bead's RUN touches: its own `touches:` plus every descendant's. A feature's run
 * implements its child tickets, so it owns the files they declare — and a child naming a file the
 * feature's own Context doesn't repeat would otherwise leave that file reading as unowned, which is
 * exactly when triage mints a run target beside the feature already changing it.
 *
 * The bead's own paths come first, so the {@link MAX_TOUCHES} cap drops inherited surface before it
 * drops the feature's own. Breadth-first over `parent-child`, visited-guarded — a board read is not
 * a place to trust the edges to be acyclic.
 */
function runSurface(bead: Bead, children: Map<string, Bead[]>): string[] {
  const seen = new Set<string>();
  const visited = new Set<string>();
  const queue: Bead[] = [bead];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    for (const path of parseTouches(current)) seen.add(path);
    queue.push(...(children.get(current.id) ?? []));
  }
  return [...seen];
}

/**
 * Turn one full board read into the context /scan-triage routes and dedupes against. Pure: the
 * caller owns the `bd` read, so this is unit-testable against a fixture board.
 */
export function buildBoardContext(board: Bead[]): BoardContext {
  const children = childrenByParent(board);
  const open = board.filter((b) => OPEN_STATUSES.has(b.status));

  const features: FeatureCandidate[] = open
    .filter((b) => b.issue_type === "feature")
    .map((b) => {
      const verdict = featureVerdict(b, children.get(b.id) ?? []);
      const epicId = parentOf(b);
      return {
        id: b.id,
        title: b.title,
        ...(epicId ? { epicId } : {}),
        ...capSurface(runSurface(b, children)),
        attachable: verdict.attachable,
        attachReason: verdict.reason,
      };
    });

  // Epics span the WHOLE board, unlike every other section: §4.1's correct outcome for a signal is
  // often an epic that is already CLOSED and needs reopening, and §1 declares this section to BE the
  // `bd list --type epic --all` read. Omitting closed ones let unattended triage conclude no home
  // exists and mint a duplicate outcome (or fall back to a parentless bead). Open ones lead, so the
  // MAX_EPICS cap drops closed candidates first.
  // Abandoned epics are the one closed outcome that is NOT reusable: `abandoned` records a human
  // won't-do decision, and offering it as a candidate has triage `bd reopen` it — silently reversing
  // that decision on a signal that merely matched its area.
  const allEpics = board.filter((b) => b.issue_type === "epic" && !beads.isAbandoned(b));
  const epics: EpicCandidate[] = [
    ...allEpics.filter((b) => OPEN_STATUSES.has(b.status)),
    ...allEpics.filter((b) => !OPEN_STATUSES.has(b.status)),
  ].map((b) => {
    const verdict = epicVerdict(children.get(b.id) ?? []);
    const area = (b.labels ?? []).find((l) => l.startsWith("area:"));
    return {
      id: b.id,
      title: b.title,
      ...(area ? { area } : {}),
      status: b.status,
      attachable: verdict.attachable,
      attachReason: verdict.reason,
    };
  });

  const producers: ProducerBead[] = open
    .map((b) => ({ bead: b, fingerprints: fingerprintsOf(b) }))
    .filter(({ fingerprints }) => fingerprints.length > 0)
    .map(({ bead, fingerprints }) => ({
      id: bead.id,
      title: bead.title,
      status: bead.status,
      fingerprints,
      ...capSurface(parseTouches(bead)),
    }));

  return {
    features: features.slice(0, MAX_FEATURES),
    epics: epics.slice(0, MAX_EPICS),
    producers: producers.slice(0, MAX_PRODUCER_BEADS),
    omitted: {
      features: Math.max(0, features.length - MAX_FEATURES),
      epics: Math.max(0, epics.length - MAX_EPICS),
      producers: Math.max(0, producers.length - MAX_PRODUCER_BEADS),
    },
  };
}

/** The heading the triage prompt refers to — one string, so skill and job can't drift apart. */
export const BOARD_CONTEXT_HEADING = "## Board context — the board as anton read it at scan time";

/**
 * A bead's touch surface as the agent reads it. A capped surface says SO: a signal on a file the cap
 * dropped would otherwise read as unowned, and triage would mint a cluster beside the run already
 * changing it — the duplicate §4.0 exists to prevent. So the line names the omission and the lookup
 * that closes it, rather than presenting a partial surface as the whole one.
 */
function surface({ touches, touchesOmitted }: TouchSurface): string {
  if (touches.length === 0) return "(no touch surface declared)";
  return touchesOmitted > 0
    ? `${touches.join(", ")} (+${touchesOmitted} more not shown — \`bd show\` it before deciding this signal is unowned)`
    : touches.join(", ");
}

function omissionLine(count: number, what: string, how = "`bd list`"): string[] {
  return count > 0 ? [`- … and ${count} more ${what} (omitted — ask ${how} for the rest)`] : [];
}

/**
 * An epic's line verdict. A closed epic reads `attach:reopen-first`, never a bare `attach:feature`:
 * linking a feature does not reopen its parent, so a closed epic with open features under it reads
 * as a delivered outcome on the roadmap while its work sits in the backlog (§4.1).
 */
function epicVerdictLine(epic: EpicCandidate): string {
  if (!epic.attachable) return `attach:no (${epic.attachReason})`;
  return OPEN_STATUSES.has(epic.status)
    ? `attach:feature (${epic.attachReason})`
    : `attach:reopen-first (${epic.status} — \`bd reopen ${epic.id}\` before linking; ${epic.attachReason})`;
}

/**
 * Render the context into the triage prompt. Every line is `<id> · <verdict> · …` so the agent can
 * cite the id it routed to, and a human auditing a misroute reads the same line the agent did.
 */
export function formatBoardContext(ctx: BoardContext): string {
  const lines: string[] = [
    BOARD_CONTEXT_HEADING,
    "",
    "Resolved from `bd` on this repo immediately before this prompt — this IS the board read of §1.",
    "`bd show <id>` anything you intend to write to; the verdicts below are mechanical, the judgment",
    "of whether a signal BELONGS somewhere is yours.",
    "",
    "### Open features — the structure a signal routes INTO (§4)",
    "",
    "`attach:child` = this triage may hang a child ticket here. `attach:no` = it may not (reason in",
    "parentheses); a signal that belongs to it becomes its own run target cross-linked",
    "`discovered-from` to it, never a child.",
    "",
  ];

  if (ctx.features.length === 0) {
    lines.push("- (no open features)");
  } else {
    for (const f of ctx.features) {
      const verdict = f.attachable ? "attach:child" : `attach:no (${f.attachReason})`;
      lines.push(
        `- ${f.id} · ${verdict} · epic:${f.epicId ?? "none"} · ${f.title} · touches: ${surface(f)}`,
      );
    }
    lines.push(...omissionLine(ctx.omitted.features, "open feature(s)"));
  }

  lines.push(
    "",
    "### Epics — where a genuinely unowned cluster hangs (§4.1)",
    "",
    "Every epic on the board, **open and closed** — this IS the `bd list --type epic --all` read of",
    "§4.1, so a closed outcome that already owns the surface is visible rather than looking like a",
    "home that doesn't exist. `attach:reopen-first` means it fits but must be reopened before you",
    "link. Open epics are listed first. Abandoned epics are omitted — a won't-do decision is not a",
    "placement candidate; if a signal genuinely revives one, that is a human's call, not this pass's.",
    "",
  );
  if (ctx.epics.length === 0) {
    lines.push("- (no epics on the board)");
  } else {
    for (const e of ctx.epics) {
      lines.push(`- ${e.id} · ${epicVerdictLine(e)} · ${e.area ?? "no area:"} · ${e.title}`);
    }
    lines.push(
      ...omissionLine(ctx.omitted.epics, "epic(s)", "`bd list --type epic --all --json --limit 0`"),
    );
  }

  lines.push(
    "",
    "### Fingerprints already on the board — every producer, not just stringer (§2)",
    "",
    "A `gardener:`/`pm:` line is the same kind of claim from another automated pass. Match a signal",
    "against these by `<hash>` ACROSS namespaces first, then by touched file when the hashes differ.",
    "A match is a `related` cross-link on the existing bead — never a second bead.",
    "",
  );
  if (ctx.producers.length === 0) {
    lines.push("- (no producer-filed beads open)");
  } else {
    for (const p of ctx.producers) {
      const fps = p.fingerprints.map((f) => f.label).join(" · ");
      lines.push(`- ${p.id} · ${p.status} · ${fps} · touches: ${surface(p)} · ${p.title}`);
    }
    lines.push(...omissionLine(ctx.omitted.producers, "producer-filed bead(s)"));
  }

  return lines.join("\n");
}

/** What the prompt carries when the board read failed — never silence, which reads as "empty board". */
export function formatBoardContextUnavailable(reason: string): string {
  return [
    BOARD_CONTEXT_HEADING,
    "",
    `**UNAVAILABLE** — anton could not read the board (${reason}).`,
    "Do the §1 board read yourself (`bd list --json --limit 0`, `bd list --type epic --all --json",
    "--limit 0`) before creating anything. Do NOT treat this as an empty board.",
  ].join("\n");
}
