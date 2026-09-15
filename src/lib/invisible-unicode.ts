/**
 * The rule behind the `control-bytes` gate's Unicode half (anton-33xn): no bidirectional-override
 * or zero-width character belongs in tracked source, alongside the C0 control bytes
 * {@link "./control-bytes"} already rejects.
 *
 * Same consequence as a raw control byte — source that renders differently to a reviewer than it
 * does to the compiler — but a different fault class ("Trojan Source"): these are ordinary,
 * multi-byte UTF-8 sequences, not malformed bytes, so they need decoding rather than byte scanning.
 * A bidi override (U+202A-U+202E, U+2066-U+2069) can visually reorder the characters around it —
 * the classic attack reorders a comment so `/* end admins only` reads as commented-out while the
 * compiler sees the reordered, still-active source. A zero-width character (U+200B-U+200D) hides
 * inside an identifier or string with nothing to see.
 *
 * The allowlist decision, recorded here because this module is where it is enforced: bidi
 * overrides/isolates have no legitimate use in this codebase's source and are rejected
 * unconditionally. Zero-width joiners/non-joiners are rejected unconditionally too — this repo
 * carries no emoji ZWJ sequences today, and ordinary CJK/RTL/emoji text needs none of these
 * codepoints to render correctly (the Unicode bidi algorithm handles direction on its own; overrides
 * exist only to force a *wrong* direction). The one exception is U+FEFF, which doubles as a
 * legitimate UTF-8 byte-order mark: tolerated only as literally the first character of a file, and
 * rejected as the invisible zero-width-no-break-space it otherwise is everywhere else. See
 * `.product/decisions/2026-09-15-invisible-unicode-gate.md`.
 */

/** Bidi overrides (LRE/RLE/PDF/LRO/RLO) and isolates (LRI/RLI/FSI/PDI) — the "Trojan Source" class. */
const BIDI_CONTROL = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/** Zero-width joiner/non-joiner/space, plus the BOM in its zero-width-no-break-space guise. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

/** Names for the codepoints a reader is likely to recognise; the rest report as bare hex. */
const CODEPOINT_NAMES: Record<number, string> = {
  0x202a: "LRE",
  0x202b: "RLE",
  0x202c: "PDF",
  0x202d: "LRO",
  0x202e: "RLO",
  0x2066: "LRI",
  0x2067: "RLI",
  0x2068: "FSI",
  0x2069: "PDI",
  0x200b: "ZWSP",
  0x200c: "ZWNJ",
  0x200d: "ZWJ",
  0xfeff: "BOM",
};

/**
 * Is this codepoint, found at `charIndex` codepoints into the decoded file, forbidden? `charIndex`
 * exists only to let U+FEFF through when it is literally the first character — a real byte-order
 * mark — while still rejecting it as an invisible zero-width-no-break-space anywhere else.
 */
export function isForbiddenCodePoint(codePoint: number, charIndex: number): boolean {
  if (BIDI_CONTROL.has(codePoint)) return true;
  if (codePoint === 0xfeff) return charIndex !== 0;
  return ZERO_WIDTH.has(codePoint);
}

/** One offending codepoint, located the way a compiler locates an error. */
export interface InvisibleUnicodeHit {
  /** The offending codepoint. */
  codePoint: number;
  /** 1-based line, counting LF. */
  line: number;
  /** 1-based column, counted in codepoints — decoded text, not raw bytes. */
  column: number;
}

/** Cap per file, mirroring {@link "./control-bytes".MAX_HITS_PER_FILE} for the same reason. */
export const MAX_HITS_PER_FILE = 10;

/** Every forbidden codepoint in decoded `text`, up to `limit`. Empty means the file is clean. */
export function findInvisibleUnicode(text: string, limit: number = MAX_HITS_PER_FILE): InvisibleUnicodeHit[] {
  const hits: InvisibleUnicodeHit[] = [];
  let line = 1;
  let column = 1;
  let charIndex = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint === 0x0a) {
      line++;
      column = 1;
      charIndex++;
      continue;
    }
    if (isForbiddenCodePoint(codePoint, charIndex)) {
      hits.push({ codePoint, line, column });
      if (hits.length >= limit) break;
    }
    column++;
    charIndex++;
  }
  return hits;
}

/** `U+200B (ZWSP)` for the named codepoints, bare `U+XXXX` for the rest. */
function describeCodePoint(codePoint: number): string {
  const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const name = CODEPOINT_NAMES[codePoint];
  return name ? `${hex} (${name})` : hex;
}

/** `path:line:column: U+202E (RLO)` — the `file:line:col:` shape editors and CI annotations parse. */
export function formatHit(path: string, hit: InvisibleUnicodeHit): string {
  return `${path}:${hit.line}:${hit.column}: ${describeCodePoint(hit.codePoint)}`;
}
