/**
 * The invisible-Unicode half of the `control-bytes` gate (anton-33xn) — bidi overrides and
 * zero-width characters, the "Trojan Source" class the C0 byte rule deliberately excluded.
 */
import { describe, expect, it } from "vitest";
import { findInvisibleUnicode, formatHit, isForbiddenCodePoint } from "./invisible-unicode";

// Built via fromCodePoint rather than a literal escape so this test file itself doesn't embed the
// characters this whole gate exists to reject.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);

describe("findInvisibleUnicode", () => {
  it("passes ordinary source with no Unicode at all", () => {
    expect(findInvisibleUnicode("export const x = 1;\nif (x) {\n\treturn x;\n}\n")).toEqual([]);
  });

  it("passes legitimate non-ASCII — accents, CJK, RTL, and emoji", () => {
    expect(findInvisibleUnicode("// café — 日本語 — مرحبا — 🎉🔥😀\n")).toEqual([]);
  });

  it("flags every bidi override and isolate", () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(findInvisibleUnicode(`a${String.fromCodePoint(cp)}b`)).toEqual([{ codePoint: cp, line: 1, column: 2 }]);
    }
  });

  it("flags zero-width joiner, non-joiner, and space", () => {
    for (const cp of [0x200b, 0x200c, 0x200d]) {
      expect(findInvisibleUnicode(`a${String.fromCodePoint(cp)}b`)).toEqual([{ codePoint: cp, line: 1, column: 2 }]);
    }
  });

  it("tolerates U+FEFF as a leading byte-order mark", () => {
    expect(findInvisibleUnicode(`${BOM}export const x = 1;\n`)).toEqual([]);
  });

  it("flags U+FEFF anywhere other than the first character — an invisible ZWNBSP, not a BOM", () => {
    expect(findInvisibleUnicode(`export${BOM} const x = 1;\n`)).toEqual([{ codePoint: 0xfeff, line: 1, column: 7 }]);
  });

  it("locates a hit by line and codepoint column, counting a preceding emoji as one column", () => {
    const content = `const a = 1;\n// 🎉${RLO} evil\n`;
    expect(findInvisibleUnicode(content)).toEqual([{ codePoint: 0x202e, line: 2, column: 5 }]);
  });

  it("caps hits per file so a misnamed blob cannot bury the report", () => {
    const blob = ZWSP.repeat(50);
    expect(findInvisibleUnicode(blob, 10)).toHaveLength(10);
  });

  it("formats a hit with the codepoint's name when it has one, bare hex otherwise", () => {
    expect(formatHit("src/lib/evil.ts", { codePoint: 0x202e, line: 3, column: 5 })).toBe(
      "src/lib/evil.ts:3:5: U+202E (RLO)",
    );
    expect(formatHit("a.ts", { codePoint: 0x2069, line: 1, column: 1 })).toBe("a.ts:1:1: U+2069 (PDI)");
  });
});

describe("isForbiddenCodePoint", () => {
  it("allows U+FEFF only at index 0", () => {
    expect(isForbiddenCodePoint(0xfeff, 0)).toBe(false);
    expect(isForbiddenCodePoint(0xfeff, 1)).toBe(true);
  });

  it("allows ordinary CJK and emoji codepoints unconditionally", () => {
    expect(isForbiddenCodePoint("日".codePointAt(0) as number, 0)).toBe(false);
    expect(isForbiddenCodePoint(0x1f389 /* 🎉 */, 0)).toBe(false);
  });
});
