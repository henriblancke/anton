/**
 * A test fixture's fake password is not a leaked credential (anton-r016). `githygiene`'s
 * committed-secret detector matches on the SHAPE of an assignment — a name containing `PASSWORD`
 * with a string on the right — so every `BEADS_DOLT_PASSWORD: "shared-secret"` in anton's own test
 * setup reads as a leak. The 2026-08-29 scan raised four of them, all CRITICAL, all confirmed fake
 * (bin/anton.test.ts:255, src/lib/beads/bd-env.test.ts:62 and :127, src/lib/beads/config-modes.test.ts:738).
 * They recur nightly, so the health record's critical count never reaches zero and the one signal
 * class that must never be ignored is the class triage has learned to ignore.
 *
 * DEFAULT_SCAN_EXCLUDES cannot express this and neither can a path rule alone: a test file is
 * exactly where a real key gets pasted by accident. So the reported line is resolved against the
 * tree and READ, and the verdict comes from the VALUE — never from the signal's title or kind,
 * which say "Possible generic secret" for a fixture and a live key alike.
 *
 * Conservative by construction, like the coupling and duplication filters it sits beside: a signal
 * is dropped only on positive proof that the line holds a human-written placeholder — a test-file
 * path AND every literal on the line word-shaped, low-entropy, and carrying no credential marker.
 * A file it could not read, a line it could not resolve, a literal it could not classify: each
 * leaves the signal exactly as stringer wrote it. Under-filtering costs one triaged bead;
 * over-filtering makes anton go quiet about a leaked key.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { SECRET_PATTERN, collectorOf, type ScanSignal } from "./scan-severity";

/** The collector these rules are about; every other signal rides through untouched. */
const SECRET_COLLECTOR = "githygiene";

/**
 * How many files one filter pass will read, matching the duplication filter's budget. A scan
 * carrying more committed-secret signals than this is not fixture noise — it is an incident, and
 * the untouched remainder should reach triage at full severity.
 */
const FILE_BUDGET = 200;

/**
 * Directory segments that are test material in every ecosystem anton scans. Whole segments only:
 * `src/lib/latest/` is not a test directory.
 */
const TEST_DIRECTORY =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|testdata|fixtures)(?:\/|$)/i;

/** File names that ARE a test wherever they sit — this repo's `*.test.ts`, plus the other stacks'. */
const TEST_FILENAME =
  /(?:^|\/)(?:conftest\.py|test_[^/]*\.py|[^/]*_test\.(?:go|py|rb|rs|ts|tsx|js)|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|[^/]*\.fixture\.[^/]+)$/i;

/** Whether this path is test material — the first half of the drop, never sufficient on its own. */
export function isTestPath(path: string): boolean {
  return TEST_DIRECTORY.test(path) || TEST_FILENAME.test(path);
}

/**
 * Prefixes and shapes that ARE a credential wherever they sit. Listed rather than inferred: a
 * provider's token is often short, lowercase and dash-separated (`glpat-…`, `sk-…`), so the
 * placeholder shape below would otherwise read one as two English words.
 */
const CREDENTIAL_MARKERS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PGP MESSAGE)-----/, // PEM block
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./, // JWT
  /^(?:sk|pk|rk)[-_](?:live|test|proj|ant)?/i, // OpenAI, Stripe, Anthropic
  /^gh[pousr]_|^github_pat_/, // GitHub
  /^xox[abprs]-/, // Slack
  /^glpat-/, // GitLab
  /^AKIA[0-9A-Z]{8,}/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{10,}/, // Google API key
  /^ya29\./, // Google OAuth
  /^npm_[A-Za-z0-9]{10,}/, // npm
  /^dop_v1_/, // DigitalOcean
  /^SG\.[A-Za-z0-9_-]{10,}/, // SendGrid
  /^hf_[A-Za-z0-9]{10,}/, // Hugging Face
];

/**
 * The one spelling a human uses for a stand-in value: lowercase words joined by `-`/`_`/`.`
 * ("shared-account-secret"). A real credential is not — it carries digits, mixed case, or `/+=` —
 * so anything outside this shape is treated as credential-shaped and keeps its signal.
 *
 * SCREAMING_SNAKE is deliberately NOT a placeholder shape. {@link valuesOn} extracts the VALUE on
 * the right-hand side, never the env var name on the left, so the only thing such a rule could
 * clear is a value that is itself uppercase — `"SEED_DB_PASS1"` and, one character away, a real
 * generated token.
 */
const PLACEHOLDER_SHAPE = /^[a-z]+(?:[-_.][a-z]+)*$/;

/**
 * Whether the letters read as something a human typed rather than something a generator emitted.
 *
 * No summary statistic answers this on its own, and both of the obvious ones have already been
 * tried here. Bits per character cannot: over 20-character lowercase samples a random blob averages
 * 3.68 bits/char while "local-development-password" reaches 3.77. Vowel counting cannot either: a
 * random alphabet runs 23% vowels against English's ~40%, but the SPREAD swamps the gap, so roughly
 * a quarter of random 20-character blobs land in a word's vowel range — `agqcrawykynuwdrhveoz` sits
 * at 0.35 with no long consonant run and 3.92 bits/char, and every threshold above reads it as a
 * placeholder.
 *
 * What separates them is which letters sit NEXT to each other. English is a small set of legal
 * pairs; a generator draws uniformly and produces `gq`, `qc`, `yk`, `hv`. So the positive test is
 * {@link ENGLISH_BIGRAMS}, and the vowel rules stay as the cheap first cut they always were.
 */
const VOWEL = /[aeiouy]/;
const VOWELS = /[aeiouy]/g;
/** Longer than any English cluster ("passphrase" carries five in `ssphr`). */
const CONSONANT_RUN = /[^aeiouy]{6,}/;
const VOWEL_RATIO_FLOOR = 0.25; // "password" sits exactly here; below it is not a word.
/** Under this, the ratio is noise — one letter either way swings it past any threshold. */
const RATIO_MIN_LETTERS = 4;

/**
 * The letter pairs carrying 98.5% of the bigram mass in `/usr/share/dict/words` (235k words, pairs
 * taken in frequency order until the cumulative share crosses the threshold). Spelled out because
 * there is no shorter way to state what English looks like — and because a table can be re-derived
 * and checked, where a hand-tuned threshold cannot.
 */
const ENGLISH_BIGRAMS = new Set(
  (
    "ab ac ad ae af ag ah ai ak al am an ap ar as at au av aw ax ay az ba bb be bi bl bo br bs bu " +
    "ca cc ce ch ci ck cl co cr ct cu cy da dd de dg di dl dn do dr ds du dy ea eb ec ed ee ef eg " +
    "eh ei el em en eo ep eq er es et eu ev ew ex ey fa fe ff fi fl fo fr ft fu fy ga ge gg gh gi " +
    "gl gm gn go gr gu gy ha he hi hl hm hn ho hr ht hu hy ia ib ic id ie if ig ik il im in io ip " +
    "ir is it iu iv iz ja je jo ju ka ke ki kl ko la lc ld le lf lg li ll lm ln lo lp ls lt lu lv " +
    "ly ma mb me mi mm mn mo mp mu my na nb nc nd ne nf ng nh ni nk nl nm nn no np nr ns nt nu nv " +
    "nw ny oa ob oc od oe of og oh oi ok ol om on oo op or os ot ou ov ow ox oy pa pe ph pi pl po " +
    "pp pr ps pt pu py qu ra rb rc rd re rf rg rh ri rk rl rm rn ro rp rr rs rt ru rv rw ry sa sc " +
    "se sh si sk sl sm sn so sp sq ss st su sw sy ta tc te th ti tl tm to tr ts tt tu tw ty ua ub " +
    "uc ud ue uf ug ui ul um un uo up ur us ut va ve vi vo wa we wh wi wn wo xa xe xi xo xp xt xy " +
    "ya yc yd ye yg yi yl ym yn yo yp yr ys yt za ze zi zo"
  ).split(" "),
);

/**
 * How English a segment's letter pairs are. Measured: the weakest word in the known fixture corpus
 * is "project" at 0.83 (`oj` is rare), while a random 20-character blob averages 0.47.
 */
const BIGRAM_FLOOR = 0.75;
/** Under five letters a segment offers three pairs or fewer — too coarse to carry a verdict. */
const BIGRAM_MIN_LETTERS = 5;
/**
 * Longer than any word in the fixture corpus ("development", 11). An unbroken lowercase run past
 * this is not a word however English its pairs read, and a human writing a long placeholder
 * separates it ("local-development-password"). A concatenated one costs a triaged bead.
 */
const SEGMENT_MAX_LETTERS = 12;

function bigramFit(segment: string): number {
  let english = 0;
  for (let i = 0; i < segment.length - 1; i += 1) {
    if (ENGLISH_BIGRAMS.has(segment.slice(i, i + 2))) english += 1;
  }
  return english / (segment.length - 1);
}

export function looksWritten(value: string): boolean {
  const segments = value.split(/[-_.]/);
  for (const segment of segments) {
    if (segment.length > SEGMENT_MAX_LETTERS) return false;
    if (segment.length >= RATIO_MIN_LETTERS && !VOWEL.test(segment)) return false;
    if (CONSONANT_RUN.test(segment)) return false;
    if (segment.length >= BIGRAM_MIN_LETTERS && bigramFit(segment) < BIGRAM_FLOOR) return false;
  }
  const letters = segments.join("");
  if (letters.length < RATIO_MIN_LETTERS) return true;
  return (letters.match(VOWELS)?.length ?? 0) / letters.length >= VOWEL_RATIO_FLOOR;
}

/**
 * Density backstop for the blobs that happen to fall in a word's vowel range. Ungated by length on
 * purpose: a value shorter than 16 characters cannot reach this floor at all (entropy caps at
 * log2(length)), so the rule is self-limiting where a length gate would be an exemption. Measured:
 * the known fixtures top out at 3.46 and the densest plausible placeholder phrase at 3.78.
 */
const ENTROPY_FLOOR = 4.0;

/** Shannon entropy in bits per character — how much a value looks like it was generated. */
export function entropyOf(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Whether a literal reads as a real credential. The default answer is yes: only a value that is
 * positively human-written — a known-safe shape, no credential marker, word-like letters, and not
 * dense enough to be generated — is anything else.
 *
 * The residual case, accepted knowingly: a REAL credential a human chose as a lowercase word
 * ("huntertwo") reads identically to a fixture's placeholder and loses its signal. Nothing textual
 * separates them — `bd-env.test.ts:127`, one of the hits this exists to clear, assigns the bare
 * word `"explicit"` — so a stricter positive marker would only trade this miss for a permanently
 * critical health record. The drop is bounded instead: test paths only, and never silent —
 * {@link describeSecretFilter} names every dropped line and value in the session log.
 */
export function isCredentialShaped(value: string): boolean {
  if (CREDENTIAL_MARKERS.some((marker) => marker.test(value))) return true;
  if (!PLACEHOLDER_SHAPE.test(value)) return true;
  if (!looksWritten(value)) return true;
  return entropyOf(value) >= ENTROPY_FLOOR;
}

/** Quoted string literals, in all three JS spellings plus the single-quoted forms other stacks use. */
const QUOTED = [
  /"((?:[^"\\]|\\.)*)"/g,
  /'((?:[^'\\]|\\.)*)'/g,
  /`((?:[^`\\]|\\.)*)`/g,
] as const;

/** An unquoted right-hand side, as a `.env` / YAML / shell export line spells it. */
const BARE_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[:=]\s*([^\s#'"`,]+)\s*,?\s*$/;

/**
 * A quoted literal that a `:` turns into a mapping key — how JSON, YAML and Python fixtures spell
 * `"BEADS_DOLT_PASSWORD": "shared-secret"`. The key is a NAME, and reading it as a value made the
 * whole line credential-shaped on the SCREAMING_SNAKE alone, so the fixture kept its signal.
 *
 * Anchored on the left to a line start, `{` or `,` — where a mapping entry can actually begin — so
 * a ternary's `cond ? "sk-live-…" : ""` stays a value the filter has to clear on its own merits.
 */
const MAPPING_KEY_LEFT = /(?:^|[{,])\s*$/;
const MAPPING_KEY_RIGHT = /^\s*:/;

/**
 * Every value the flagged line could be talking about. Both spellings are collected rather than
 * guessed between: the detector matched somewhere on this line, and a filter that picked the wrong
 * literal would clear a signal it never actually read. Only a quoted mapping KEY is skipped — it
 * names the value rather than being one, and no detector ever meant it.
 */
export function valuesOn(line: string): string[] {
  const values: string[] = [];
  for (const pattern of QUOTED) {
    for (const match of line.matchAll(pattern)) {
      const body = match[1];
      if (!body) continue;
      const left = line.slice(0, match.index);
      const right = line.slice(match.index + match[0].length);
      if (MAPPING_KEY_LEFT.test(left) && MAPPING_KEY_RIGHT.test(right)) continue;
      values.push(body);
    }
  }
  if (values.length === 0) {
    const bare = BARE_ASSIGNMENT.exec(line);
    if (bare?.[1]) values.push(bare[1]);
  }
  return values;
}

/** One committed-secret signal the filter removed, and the proof that removed it. */
export interface DroppedSecret {
  /** The file stringer named, as it spelled it. */
  path: string;
  /** The 1-based line the filter read. */
  line: number;
  /** stringer's `Kind` — `committed-secret`. */
  kind: string;
  /**
   * Why the line holds no credential, quoting the values it holds instead. Safe to log by
   * construction: a value only reaches here after being proven word-shaped and low-entropy, and
   * quoting it is the only way an operator can check the verdict without re-reading the file.
   */
  reason: string;
}

/** What the fixture-secret filter did to this scan — every drop is surfaced, never silent. */
export interface SecretFilter {
  dropped: DroppedSecret[];
}

/** A repo-relative path that stays inside the repo; undefined for anything that escapes it. */
function insideRepo(repoPath: string, raw: string): string | undefined {
  const rel = isAbsolute(raw) ? relative(repoPath, raw) : normalize(raw);
  return rel && rel !== "." && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : undefined;
}

function filePathOf(signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

function kindOf(signal: ScanSignal): string {
  const raw = signal.Kind ?? signal.kind;
  return typeof raw === "string" && raw ? raw : SECRET_COLLECTOR;
}

/** The words a signal's own vocabulary is matched against — the same haystack scan-severity uses. */
function haystackOf(signal: ScanSignal): string {
  return [signal.Kind ?? signal.kind, ...(signal.Tags ?? signal.tags ?? [])]
    .filter(Boolean)
    .join(" ");
}

/**
 * Whether this signal is a committed-secret claim. Keyed off the same {@link SECRET_PATTERN} that
 * classes a `githygiene` finding as `security`, so the filter and the classifier can never disagree
 * about which signals are secrets.
 */
function isSecretSignal(signal: ScanSignal): boolean {
  return collectorOf(signal) === SECRET_COLLECTOR && SECRET_PATTERN.test(haystackOf(signal));
}

/** Source lines for one repo, read once per file and shared across every signal. */
function sourceIndex(repoPath: string) {
  const cache = new Map<string, string[] | undefined>();
  let read = 0;

  return async function linesOf(path: string): Promise<string[] | undefined> {
    const rel = insideRepo(repoPath, path);
    if (!rel) return undefined;
    if (cache.has(rel)) return cache.get(rel);
    if (read >= FILE_BUDGET) return undefined;
    read += 1;
    let lines: string[] | undefined;
    try {
      lines = (await readFile(join(repoPath, rel), "utf8")).split("\n");
    } catch {
      lines = undefined;
    }
    cache.set(rel, lines);
    return lines;
  };
}

/** Why this signal is fixture noise, or undefined when the filter could not prove it. */
async function judge(
  linesOf: ReturnType<typeof sourceIndex>,
  signal: ScanSignal,
): Promise<string | undefined> {
  const path = filePathOf(signal);
  if (!path || !isTestPath(path)) return undefined;

  const line = Number(signal.Line ?? signal.line);
  if (!Number.isInteger(line) || line <= 0) return undefined;

  const lines = await linesOf(path);
  const source = lines?.[line - 1];
  if (source === undefined) return undefined;

  const values = valuesOn(source);
  if (values.length === 0) return undefined;
  if (values.some(isCredentialShaped)) return undefined;

  return `a test fixture assigning ${values.map((v) => JSON.stringify(v)).join(", ")}`;
}

/**
 * Drop the committed-secret signals that describe a test fixture, and say which. Runs BEFORE
 * annotation, in lib/stringer's one filter seam, so the health record's per-severity counts and the
 * triage prompt describe the same set.
 *
 * Only reached when a scan actually carries a secret signal, so an ordinary pass reads no files.
 */
export async function filterSecretSignals(
  repoPath: string,
  signals: ScanSignal[],
): Promise<{ kept: ScanSignal[]; secrets: SecretFilter }> {
  const relevant = signals.filter(isSecretSignal);
  if (relevant.length === 0) return { kept: signals, secrets: { dropped: [] } };

  const linesOf = sourceIndex(repoPath);
  const verdicts = new Map<ScanSignal, string>();
  for (const signal of relevant) {
    const reason = await judge(linesOf, signal);
    if (reason !== undefined) verdicts.set(signal, reason);
  }

  const dropped: DroppedSecret[] = [];
  const kept = signals.filter((signal) => {
    const reason = verdicts.get(signal);
    if (reason === undefined) return true;
    dropped.push({
      path: filePathOf(signal) ?? "",
      line: Number(signal.Line ?? signal.line),
      kind: kindOf(signal),
      reason,
    });
    return false;
  });
  return { kept, secrets: { dropped } };
}

/**
 * What the fixture-secret filter did, for the session log; undefined when it changed nothing.
 *
 * A silent secret filter is the worst kind: the count comes first so the size of the drop is the
 * first thing read, and each entry names the line and the value, so "a fixture password" stays
 * distinguishable from "anton stopped reporting a leaked key" without re-running the scan.
 */
export function describeSecretFilter(filter: SecretFilter): string | undefined {
  if (filter.dropped.length === 0) return undefined;
  const shown = filter.dropped.slice(0, 10);
  const rest = filter.dropped.length - shown.length;
  return (
    `dropped ${filter.dropped.length} committed-secret signal(s) over test fixtures: ` +
    `${shown.map((d) => `${d.path}:${d.line} (${d.kind} — ${d.reason})`).join("; ")}` +
    `${rest > 0 ? ` (+${rest} more)` : ""}`
  );
}
