/**
 * The rule behind the `control-bytes` gate (anton-flih): no C0 control byte belongs in a tracked
 * source file.
 *
 * Every reviewer anton has — human, Codex, Claude, its own pre-PR review — reads a diff. A single
 * NUL byte makes git classify a file as binary and print `Binary files differ` instead of a patch,
 * so a whole module can change with nobody seeing a line of it. That is exactly how a bug reached
 * main in `epic-graph.ts` (anton-74f8). `.gitattributes` now forces `diff` on source globs so a
 * patch always renders — which retires that accidental alarm. This is its deliberate replacement,
 * and it fires earlier and louder: in CI, naming the file and the byte offset, rather than at a
 * reviewer who has to notice an absent diff.
 *
 * The CLI shell — path enumeration and reporting — is `scripts/check-control-bytes.ts`. The rule
 * lives here so it is unit-testable, and so a test can pin {@link SOURCE_EXTENSIONS} to the globs
 * `.gitattributes` forces `diff` on: the lint must cover every glob whose alarm was removed.
 */

/**
 * Extensions the gate scans, one per glob in `.gitattributes`. Kept sorted, and kept in step with
 * that file — `control-bytes.test.ts` fails when the two drift, because a glob forced diffable
 * without a matching scan is a file whose only alarm was deleted.
 */
export const SOURCE_EXTENSIONS = [
  "cjs",
  "css",
  "html",
  "js",
  "json",
  "md",
  "mjs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "yaml",
  "yml",
] as const;

const SCANNED = new Set<string>(SOURCE_EXTENSIONS);

/** Is this repo-relative path one the gate scans? Extension match, case-insensitive. */
export function isSourcePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCANNED.has(name.slice(dot + 1).toLowerCase());
}

/** The three C0 bytes source files legitimately contain: TAB, LF, CR. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

/** Names for the control bytes a reader is likely to recognise; the rest report as hex. */
const BYTE_NAMES: Record<number, string> = {
  0x00: "NUL",
  0x07: "BEL",
  0x08: "BS",
  0x0b: "VT",
  0x0c: "FF",
  0x1a: "SUB",
  0x1b: "ESC",
  0x7f: "DEL",
};

/** Is this byte a C0 control (or DEL) that no source file should carry? */
export function isForbiddenByte(byte: number): boolean {
  return (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte)) || byte === 0x7f;
}

/** One offending byte, located the way a compiler locates an error. */
export interface ControlByteHit {
  /** The offending byte value. */
  byte: number;
  /** 1-based line, counting LF. */
  line: number;
  /** 1-based column in BYTES — the unit the offence is measured in, not characters. */
  column: number;
}

/**
 * Cap per file. A truly binary blob misnamed `.json` would otherwise print tens of thousands of
 * hits and bury the report; the first few locate it just as well.
 */
export const MAX_HITS_PER_FILE = 10;

/** Every forbidden byte in `content`, up to `limit`. Empty means the file is clean. */
export function findControlBytes(content: Uint8Array, limit: number = MAX_HITS_PER_FILE): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < content.length; i++) {
    const byte = content[i];
    if (byte === 0x0a) {
      line++;
      lineStart = i + 1;
      continue;
    }
    if (!isForbiddenByte(byte)) continue;
    hits.push({ byte, line, column: i - lineStart + 1 });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** `NUL (0x00)` for the named bytes, bare hex for the rest. */
function describeByte(byte: number): string {
  const hex = `0x${byte.toString(16).padStart(2, "0")}`;
  const name = BYTE_NAMES[byte];
  return name ? `${name} (${hex})` : hex;
}

/** `path:line:column: NUL (0x00)` — the `file:line:col:` shape editors and CI annotations parse. */
export function formatHit(path: string, hit: ControlByteHit): string {
  return `${path}:${hit.line}:${hit.column}: ${describeByte(hit.byte)}`;
}
