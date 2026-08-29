/**
 * Type-only imports are not coupling (anton-yvx9). stringer's `coupling` collector builds its import
 * graph from the source text, so an `import type` / `export type … from` — erased by the compiler,
 * with no runtime edge and no cascading-breakage risk — weighs exactly as much as a value import.
 * The 2026-08-18 scan therefore charted two medium findings that are not true of the tree: an
 * 11-module "circular dependency" closed only by `src/lib/types.ts` (a pure type barrel), and a
 * "types.ts imports 11 modules" fan-out whose every edge disappears at build time.
 *
 * So coupling signals are re-derived here against a VALUE-ONLY import graph, in the same seam that
 * drops findings about untracked files (lib/stringer) — before annotation, so the health record and
 * the triage prompt see one filtered set rather than one counting what the other dropped.
 *
 * Conservative by construction: it only ever subtracts an edge it can PROVE is erased. A module it
 * cannot resolve to a source file it can parse, a component whose members it cannot read, a pass
 * that runs past its parse budget — each leaves the signal exactly as stringer wrote it.
 * Under-filtering costs one triaged bead; over-filtering deletes a real cycle nobody hears about.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { collectorOf, type ScanSignal } from "./scan-severity";

/** The collector these rules are about; every other signal rides through untouched. */
const COUPLING_COLLECTOR = "coupling";

/** Source files anton can read imports out of. A module outside this set is never re-derived. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * How many source files one filter pass will read. A scan can carry dozens of coupling signals, each
 * naming a component; the budget bounds what a nightly pass spends on them. Hitting it means "not
 * proven", so the signals still standing keep their place rather than being dropped unread.
 */
const MODULE_BUDGET = 500;

/** stringer's default fan-out threshold, used only when its own message doesn't name one. */
const DEFAULT_COUPLING_THRESHOLD = 10;

/** One coupling signal the filter removed, and the proof that removed it. */
export interface DroppedCoupling {
  /** The module stringer named, as it spelled it. */
  path: string;
  /** stringer's `Kind` — `circular-dependency` or `high-coupling`. */
  kind: string;
  /** Why it isn't true of the tree, in the terms an operator would check it in. */
  reason: string;
}

/** A high-coupling signal that survived with a corrected import count. */
export interface RecountedCoupling {
  path: string;
  /** stringer's count, type-only edges included. */
  reported: number;
  /** What is left once the erased edges come out — still above the threshold, or it'd be dropped. */
  value: number;
}

/** What the type-only filter did to this scan — every drop and every correction is surfaced. */
export interface CouplingFilter {
  dropped: DroppedCoupling[];
  recounted: RecountedCoupling[];
}

/** An import as it appears in the source, before anything is resolved. */
interface RawEdge {
  spec: string;
  /** The whole statement is erased at compile time (`import type`, or all-`type` named bindings). */
  typeOnly: boolean;
}

/** An import resolved onto a file in the repo. */
interface ResolvedEdge {
  /** Repo-relative path of the imported file. */
  file: string;
  typeOnly: boolean;
  /**
   * The specifier was relative. stringer's graph is built from relative imports only (measured: a
   * `@/lib/x` alias import is absent from its fan-out count), so only these may come off one of its
   * counts — subtracting an edge it never counted would under-report the module twice over.
   */
  relative: boolean;
}

/**
 * Import/export statements as a formatter writes them: anchored at column 0, so a `*`-indented line
 * inside one of this codebase's long doc comments can't match, and bounded by the statement's own
 * `;`, so a non-import `export const …` can't run forward and swallow the next `from "…"`.
 *
 * The body may still cross lines — a wrapped `import { … } from` is one statement and one real edge
 * — but never past the next line-start `import`/`export`, which starts a statement of its own. In a
 * `semi:false` repo that bound is the only one there is: without it `export type Foo = number` runs
 * forward into the value re-export below it, and {@link isTypeOnly} reads the pair as type-only.
 */
const FROM_STATEMENT =
  /^(?:import|export)\b(?:(?!^(?:import|export)\b)[^;])*?\bfrom\s*["']([^"']+)["']/gm;
/** `import "./side-effect"` — no bindings, always a runtime edge. */
const SIDE_EFFECT_IMPORT = /^import\s*["']([^"']+)["']/gm;
/** `import("./x")` / `require("./x")` — value edges wherever they appear, so not anchored. */
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

/**
 * Whether a statement is erased at compile time. `import type …` / `export type …` say so outright;
 * `import { type A, type B }` is elided too, but only while NO binding rides outside the braces —
 * one default or namespace binding makes the whole statement a runtime import.
 */
function isTypeOnly(statement: string): boolean {
  const clause = statement
    .replace(/^(?:import|export)\s*/, "")
    .replace(/\bfrom\s*["'][^"']+["']$/, "");
  if (/^type\b/.test(clause)) return true;
  const open = clause.indexOf("{");
  if (open === -1) return false; // default, namespace, or `export * from` — a value edge
  if (clause.slice(0, open).replace(/,/g, "").trim() !== "") return false;
  const bindings = clause
    .slice(open + 1, clause.lastIndexOf("}"))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return bindings.length > 0 && bindings.every((name) => /^type\s/.test(name));
}

function parseEdges(source: string): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const match of source.matchAll(FROM_STATEMENT)) {
    edges.push({ spec: match[1], typeOnly: isTypeOnly(match[0]) });
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    edges.push({ spec: match[1], typeOnly: false });
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    edges.push({ spec: match[1], typeOnly: false });
  }
  return edges;
}

/** A `"@/*": ["./src/*"]`-shaped tsconfig path mapping, the only form anton resolves. */
export interface AliasRule {
  prefix: string;
  targets: string[];
}

/**
 * The project's path aliases, so a cycle closed by `@/lib/x` is still visible. Best-effort: a
 * tsconfig anton can't read costs alias edges (which only ever ADD proof of a real cycle, so the
 * signal is kept), never a wrong drop.
 */
export async function readAliases(repoPath: string): Promise<AliasRule[]> {
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    config = JSON.parse(await readFile(join(repoPath, "tsconfig.json"), "utf8"));
  } catch {
    return [];
  }
  const paths = config.compilerOptions?.paths;
  if (!paths) return [];
  const base = config.compilerOptions?.baseUrl ?? ".";
  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!pattern.endsWith("/*")) continue;
    const mapped = targets
      .filter((target) => target.endsWith("/*"))
      .map((target) => normalize(join(base, target.slice(0, -2))));
    if (mapped.length > 0) rules.push({ prefix: pattern.slice(0, -1), targets: mapped });
  }
  return rules;
}

/** A repo-relative path that stays inside the repo; undefined for anything that escapes it. */
function insideRepo(path: string): string | undefined {
  const rel = normalize(path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : undefined;
}

/**
 * The state one filter pass shares across every signal in the scan: resolutions and file reads are
 * cached so a module named by two signals is read once, and `parsed` is the single budget that
 * bounds the whole pass.
 */
interface GraphState {
  repoPath: string;
  aliases: AliasRule[];
  edges: Map<string, ResolvedEdge[]>;
  files: Map<string, string | undefined>;
  exists: Map<string, boolean>;
  parsed: number;
}

async function isFile(state: GraphState, rel: string): Promise<boolean> {
  const hit = state.exists.get(rel);
  if (hit !== undefined) return hit;
  const found = await stat(join(state.repoPath, rel))
    .then((s) => s.isFile())
    .catch(() => false);
  state.exists.set(rel, found);
  return found;
}

/** The spellings a module path can have on disk — `x.ts`, `x/index.ts`, or the file itself. */
function candidateFiles(base: string): string[] {
  const candidates: string[] = [];
  if (SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext))) candidates.push(base);
  // A `./x.js` specifier under an ESM resolver is `x.ts` on disk — check both spellings.
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${stem}${ext}`, `${stem}/index${ext}`);
  return candidates;
}

/** The source file a module path names; undefined when no spelling of it is a file in the repo. */
async function resolveFile(state: GraphState, base: string): Promise<string | undefined> {
  if (state.files.has(base)) return state.files.get(base);
  let found: string | undefined;
  for (const candidate of candidateFiles(base)) {
    const rel = insideRepo(candidate);
    if (rel && (await isFile(state, rel))) {
      found = rel;
      break;
    }
  }
  state.files.set(base, found);
  return found;
}

/** Where a `@/…`-style specifier lands, or undefined when no alias rule claims it. */
async function resolveAlias(state: GraphState, spec: string): Promise<string | undefined> {
  for (const rule of state.aliases) {
    if (!spec.startsWith(rule.prefix)) continue;
    for (const target of rule.targets) {
      const file = await resolveFile(state, normalize(join(target, spec.slice(rule.prefix.length))));
      if (file) return file;
    }
  }
  return undefined;
}

/** Where a specifier points, or undefined when it isn't a module in this repo (an npm package). */
function resolveSpec(
  state: GraphState,
  fromFile: string,
  spec: string,
): Promise<string | undefined> {
  return spec.startsWith(".")
    ? resolveFile(state, normalize(join(dirname(fromFile), spec)))
    : resolveAlias(state, spec);
}

/** Every import in a file's source, resolved onto the repo; source anton can't read has no edges. */
async function buildEdges(state: GraphState, file: string): Promise<ResolvedEdge[]> {
  const source = await readFile(join(state.repoPath, file), "utf8").catch(() => undefined);
  const resolved: ResolvedEdge[] = [];
  for (const edge of source ? parseEdges(source) : []) {
    const target = await resolveSpec(state, file, edge.spec);
    if (target) {
      resolved.push({ file: target, typeOnly: edge.typeOnly, relative: edge.spec.startsWith(".") });
    }
  }
  return resolved;
}

/** Every import of a file, resolved; `undefined` once the pass has spent its parse budget. */
async function edgesOf(state: GraphState, file: string): Promise<ResolvedEdge[] | undefined> {
  const cached = state.edges.get(file);
  if (cached) return cached;
  if (state.parsed >= MODULE_BUDGET) return undefined;
  state.parsed += 1;
  const resolved = await buildEdges(state, file);
  state.edges.set(file, resolved);
  return resolved;
}

/** The modules a file imports AT RUNTIME; undefined when the budget ran out mid-walk. */
async function valueTargetsOf(state: GraphState, file: string): Promise<Set<string> | undefined> {
  const edges = await edgesOf(state, file);
  if (!edges) return undefined;
  return new Set(edges.filter((edge) => !edge.typeOnly).map((edge) => edge.file));
}

/**
 * The import graph of one repo, as anton can prove it: file reads and resolutions are cached across
 * every signal in the scan, and the shared parse budget bounds the whole pass.
 */
export function importGraph(repoPath: string, aliases: AliasRule[]) {
  const state: GraphState = {
    repoPath,
    aliases,
    edges: new Map(),
    files: new Map(),
    exists: new Map(),
    parsed: 0,
  };
  return {
    resolveModule: (name: string) => resolveFile(state, normalize(name)),
    edgesOf: (file: string) => edgesOf(state, file),
    valueTargetsOf: (file: string) => valueTargetsOf(state, file),
  };
}

export type Graph = ReturnType<typeof importGraph>;

/**
 * Whether the reported component still holds a cycle once erased edges come out — the question the
 * signal actually asked. Confined to the component's own modules on purpose: a walk that wandered
 * out of it would come back with SOMEONE ELSE's cycle (this repo's `projects` ↔ `jobs/service`, a
 * deliberate deferred `await import()` stringer doesn't model) and keep every phantom alive.
 *
 * `undefined` means the graph couldn't be read — the parse budget ran out — which is not "no".
 */
async function componentHasValueCycle(
  graph: Graph,
  files: string[],
): Promise<boolean | undefined> {
  const members = new Set(files);
  const inside = new Map<string, string[]>();
  for (const file of files) {
    const targets = await graph.valueTargetsOf(file);
    if (!targets) return undefined;
    inside.set(file, [...targets].filter((target) => members.has(target)));
  }

  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (file: string): boolean => {
    if (onStack.has(file)) return true;
    if (done.has(file)) return false;
    onStack.add(file);
    const cyclic = (inside.get(file) ?? []).some(visit);
    onStack.delete(file);
    if (!cyclic) done.add(file); // only a node proven cycle-free is worth not revisiting
    return cyclic;
  };
  return files.some(visit);
}

/** The modules of a reported component, out of stringer's `A → B → … → A` title. */
function parseCycleModules(title: string): string[] {
  const body = /^\s*circular dependency:\s*(.+)$/i.exec(title)?.[1];
  if (!body) return [];
  const hops = body
    .split(/\s*(?:→|->)\s*/)
    .map((hop) => hop.trim())
    .filter(Boolean);
  // The path returns to where it started; the node set is what the walk needs.
  if (hops.length > 1 && hops[0] === hops[hops.length - 1]) hops.pop();
  return [...new Set(hops)];
}

/** stringer's own numbers, read back off the message it wrote them into. */
function reportedImports(signal: ScanSignal): number | undefined {
  const text = `${signal.Title ?? signal.title ?? ""} ${signal.Description ?? signal.description ?? ""}`;
  const count = /imports (\d+) modules|has (\d+) direct dependencies/.exec(text);
  if (!count) return undefined;
  return Number(count[1] ?? count[2]);
}

function reportedThreshold(signal: ScanSignal): number {
  const text = `${signal.Description ?? signal.description ?? ""}`;
  const match = /threshold of (\d+)/.exec(text);
  return match ? Number(match[1]) : DEFAULT_COUPLING_THRESHOLD;
}

function filePathOf(signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

function titleOf(signal: ScanSignal): string {
  const raw = signal.Title ?? signal.title;
  return typeof raw === "string" ? raw : "";
}

function kindOf(signal: ScanSignal): string {
  const raw = signal.Kind ?? signal.kind;
  return typeof raw === "string" && raw ? raw : COUPLING_COLLECTOR;
}

/**
 * A verdict on one signal: keep it (corrected, perhaps), or drop it with the proof.
 *
 * This type and the two judges below are exported for the unit tests, which weigh one signal
 * against a fixture tree; production reads them through {@link filterCouplingSignals}.
 */
export type Verdict =
  | { drop: false; recounted?: RecountedCoupling }
  | { drop: true; reason: string };

const KEEP: Verdict = { drop: false };

/**
 * A cycle only the compiler can see is not a cycle. What the title arrows together is the
 * component's MEMBERS, not a path (see {@link erasedEdges}), so the question asked of the source is
 * whether any cycle at all survives among them once the erased edges come out.
 */
export async function judgeCycle(graph: Graph, signal: ScanSignal): Promise<Verdict> {
  const modules = parseCycleModules(titleOf(signal));
  if (modules.length < 2) return KEEP; // nothing to check — stringer said something anton can't read
  // The title has to spell the WHOLE component: a cycle can run through a member it left out.
  const size = componentSize(signal);
  if (size !== undefined && size > modules.length) return KEEP;

  const files: string[] = [];
  for (const member of modules) {
    const file = await graph.resolveModule(member);
    if (!file) return KEEP; // a module anton can't parse (another language, a deleted file)
    files.push(file);
  }

  if ((await componentHasValueCycle(graph, files)) !== false) return KEEP;

  const erased = await erasedEdges(graph, files);
  return {
    drop: true,
    reason:
      `no cycle survives among its ${modules.length} modules once type-only imports are erased` +
      `${erased ? ` (${erased})` : ""}`,
  };
}

/** How many modules stringer says the component holds; undefined when its message didn't say. */
function componentSize(signal: ScanSignal): number | undefined {
  const text = `${signal.Description ?? signal.description ?? ""}`;
  const match = /component with (\d+) modules/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * The erased edges INSIDE the component, named so the drop can be checked by hand. Read off the
 * source rather than off the reported title: stringer lists a component's members alphabetically
 * (measured — `jobs/shell → jobs/step-registry` in the 2026-08-18 scan is not an import at all), so
 * the title's arrows are not a path anyone can verify.
 */
async function erasedEdges(graph: Graph, files: string[]): Promise<string | undefined> {
  const members = new Set(files);
  const erased: string[] = [];
  for (const file of files) {
    for (const edge of (await graph.edgesOf(file)) ?? []) {
      if (edge.typeOnly && members.has(edge.file)) erased.push(`${file} → ${edge.file}`);
    }
  }
  if (erased.length === 0) return undefined;
  const shown = erased.slice(0, 3);
  const rest = erased.length - shown.length;
  return `type-only: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

/**
 * Re-price a fan-out against runtime edges. The subtraction is off stringer's OWN count — its graph
 * is the one the threshold was set against — but that count is a FLOOR, not a ceiling: its collector
 * reads single-line statements only, so it misses a multi-line `import { … } from` entirely
 * (measured: a module with 12 single-line imports reports `imports 12 modules`; the same 12 with 4
 * wrapped reports nothing at all). Subtracting from a number that already undercounts prices a
 * module below the fan-out it really has, so anton's own runtime count is the floor no correction
 * may go under — and a module whose runtime edges alone clear the threshold is never dropped.
 */
export async function judgeFanOut(graph: Graph, signal: ScanSignal): Promise<Verdict> {
  const path = filePathOf(signal);
  const reported = reportedImports(signal);
  if (!path || reported === undefined) return KEEP;
  const file = await graph.resolveModule(path);
  if (!file) return KEEP;
  const edges = await graph.edgesOf(file);
  if (!edges) return KEEP;

  const byModule = new Map<string, boolean>();
  for (const edge of edges.filter((e) => e.relative)) {
    byModule.set(edge.file, (byModule.get(edge.file) ?? true) && edge.typeOnly);
  }
  const typeOnly = [...byModule.values()];
  const erased = typeOnly.filter(Boolean).length;
  if (erased === 0) return KEEP;
  const runtime = typeOnly.length - erased;

  const threshold = reportedThreshold(signal);
  const value = Math.max(reported - erased, runtime);
  if (value >= reported) return KEEP; // stringer's number already missed more than anton can subtract
  if (value <= threshold) {
    return {
      drop: true,
      reason:
        `${erased} of its ${reported} imports are type-only, leaving ${value} at runtime — at or ` +
        `below the threshold of ${threshold}`,
    };
  }
  recount(signal, { reported, value, erased });
  return { drop: false, recounted: { path, reported, value } };
}

/**
 * Correct the count in stringer's own message. The number is the whole claim — the board named a
 * bead after step-registry's "17 imports" — so a signal that survives has to carry the one triage
 * should act on, not the one that counted erased edges.
 */
function recount(
  signal: ScanSignal,
  counts: { reported: number; value: number; erased: number },
): void {
  const note =
    ` (anton: ${counts.erased} of the ${counts.reported} imports stringer counted are type-only, ` +
    `erased at compile time — ${counts.value} are runtime dependencies)`;
  const title = signal.Title ?? signal.title;
  if (typeof title === "string") {
    const corrected = title.replace(/imports \d+ modules/, `imports ${counts.value} modules`);
    if (signal.Title !== undefined) signal.Title = corrected;
    else signal.title = corrected;
  }
  const description = signal.Description ?? signal.description;
  if (typeof description === "string") {
    const corrected =
      description.replace(
        /has \d+ direct dependencies/,
        `has ${counts.value} direct dependencies`,
      ) + note;
    if (signal.Description !== undefined) signal.Description = corrected;
    else signal.description = corrected;
  }
}

/**
 * Drop the coupling signals that only the type system can see, and correct the counts of the ones
 * that survive. Runs BEFORE annotation, in lib/stringer's one filter seam, so the health record's
 * counts and the triage prompt's file describe the same set.
 *
 * Only reached when a scan actually carries a coupling signal, so an ordinary pass reads no files.
 */
export async function filterCouplingSignals(
  repoPath: string,
  signals: ScanSignal[],
): Promise<{ kept: ScanSignal[]; coupling: CouplingFilter }> {
  const relevant = signals.filter((signal) => collectorOf(signal) === COUPLING_COLLECTOR);
  if (relevant.length === 0) return { kept: signals, coupling: { dropped: [], recounted: [] } };

  const graph = importGraph(repoPath, await readAliases(repoPath));
  const verdicts = new Map<ScanSignal, string>();
  const recounted: RecountedCoupling[] = [];

  for (const signal of relevant) {
    const kind = kindOf(signal);
    const verdict =
      kind === "circular-dependency"
        ? await judgeCycle(graph, signal)
        : kind === "high-coupling"
          ? await judgeFanOut(graph, signal)
          : KEEP;
    if (verdict.drop) verdicts.set(signal, verdict.reason);
    else if (verdict.recounted) recounted.push(verdict.recounted);
  }

  const dropped: DroppedCoupling[] = [];
  const kept = signals.filter((signal) => {
    const reason = verdicts.get(signal);
    if (reason === undefined) return true;
    dropped.push({ path: filePathOf(signal) ?? "", kind: kindOf(signal), reason });
    return false;
  });
  return { kept, coupling: { dropped, recounted } };
}

/**
 * What the type-only filter did, for the session log; undefined when it changed nothing.
 *
 * Every drop carries its reason: this filter deletes an architecture finding, and the log is the
 * only place it still exists, so "phantom cycle through a type barrel" has to be distinguishable
 * from "anton stopped reporting a real cycle" without re-running the scan.
 */
export function describeCouplingFilter(filter: CouplingFilter): string | undefined {
  const lines: string[] = [];
  if (filter.dropped.length > 0) {
    const shown = filter.dropped.slice(0, 10);
    const rest = filter.dropped.length - shown.length;
    lines.push(
      `dropped ${filter.dropped.length} coupling signal(s) that describe no runtime coupling: ` +
        `${shown.map((d) => `${d.path} (${d.kind} — ${d.reason})`).join("; ")}` +
        `${rest > 0 ? ` (+${rest} more)` : ""}`,
    );
  }
  if (filter.recounted.length > 0) {
    lines.push(
      `recounted ${filter.recounted.length} high-coupling signal(s) without their type-only ` +
        `imports: ${filter.recounted.map((r) => `${r.path} ${r.reported}→${r.value}`).join("; ")}`,
    );
  }
  return lines.length > 0 ? lines.join("; ") : undefined;
}
