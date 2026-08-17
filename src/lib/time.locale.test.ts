/**
 * The canonical display locale (anton-icda) is a lint rule, so it is worth exactly its coverage: a
 * rule that only catches a bare `toLocaleString()` still waves through the
 * `toLocaleDateString(undefined, …)` spelling PR #132 actually found, and vice versa. These cases
 * run the project's real eslint config over a `src` path and pin both spellings — plus that an
 * explicit locale passes, so the rule can't be "satisfied" by deleting the formatting instead.
 */
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { DISPLAY_LOCALE, formatExactTime } from "@/lib/time";

/** Any path under `src` — the convention is repo-wide, not per-directory. */
const SOURCE_FILE = "src/lib/time.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint();
});

async function localeErrors(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: SOURCE_FILE });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message ?? "");
}

describe("the canonical display locale", () => {
  it.each([
    ["an omitted locale", "export const x = new Date().toLocaleString();"],
    ["an explicit undefined locale", "export const x = new Date().toLocaleString(undefined);"],
    [
      "an undefined locale with options",
      "export const x = new Date().toLocaleDateString(undefined, { month: 'short' });",
    ],
    ["an omitted locale on times", "export const x = new Date().toLocaleTimeString();"],
    // Case mapping is locale-sensitive too (Turkish dotless i), and diverges the same way.
    ["an omitted locale on string case", "export const x = 'ABC'.toLocaleLowerCase();"],
  ])("rejects %s", async (_label, source) => {
    expect(await localeErrors(source)).toHaveLength(1);
  });

  it.each([
    [
      "the shared constant",
      "import { DISPLAY_LOCALE } from '@/lib/time';\nexport const x = new Date().toLocaleString(DISPLAY_LOCALE, { dateStyle: 'medium' });",
    ],
    ["a literal locale", "export const x = new Date().toLocaleDateString('en-US');"],
  ])("allows %s", async (_label, source) => {
    expect(await localeErrors(source)).toEqual([]);
  });

  // The decision itself, not just its enforcement. Asserted as the en-US *signature* rather than a
  // literal string: the timezone is deliberately still the host's, so the digits move between
  // machines while the shape — "Aug 17, 2026, 1:34 PM", never "17.08.2026, 13:34" — does not.
  it("formats against the pinned locale rather than the host's", () => {
    expect(DISPLAY_LOCALE).toBe("en-US");
    expect(formatExactTime("2026-08-17T12:34:00Z")).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s(AM|PM)$/,
    );
  });
});
