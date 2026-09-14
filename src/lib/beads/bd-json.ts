/**
 * Readers for bd's raw `--json` stdout, shared by the typed seams (./gate, ./cook, ./hygiene) and
 * the board reads in ./bd. Pure over a string: nothing here spawns bd or knows a verb, so each seam
 * can pin its parse against fixture output without the exec path.
 */
/**
 * bd --json returns either a top-level array or a `{ <key>: [...] }` envelope. Normalize to an
 * array. `molecules` is `bd ready --gated`'s envelope (`{ count, molecules }`).
 */
export function asArray<T>(raw: string): T[] {
  const d = JSON.parse(raw || "[]");
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.issues)) return d.issues;
  if (d && Array.isArray(d.results)) return d.results;
  if (d && Array.isArray(d.molecules)) return d.molecules;
  return [];
}

/**
 * Pull the trailing `--json` object out of a bd stdout that also carries progress lines. `bd gate
 * check --json` prints its per-gate verdicts and a "Checked N gates" summary on STDOUT before the
 * JSON, so a plain JSON.parse of the whole stream throws. Scans candidate `{` offsets from the last
 * back to the first and returns the first that parses, so a future nested summary still lands.
 */
export function parseJsonTail(raw: string): unknown {
  // The `i > 0` guard is load-bearing: `lastIndexOf("{", -1)` clamps its start to 0 rather than
  // giving up, so a leading `{` that fails to parse would hand back 0 forever.
  for (let i = raw.lastIndexOf("{"); i >= 0; i = i > 0 ? raw.lastIndexOf("{", i - 1) : -1) {
    try {
      return JSON.parse(raw.slice(i));
    } catch {
      // not the start of the summary object — keep walking left
    }
  }
  return undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/** Include a key only when it has a value, so an absent field stays absent rather than `undefined`. */
export function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
