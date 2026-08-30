/**
 * Generic building blocks for a settings-style PATCH body: one rule per key, each turning a raw
 * JSON value into either a validated value or the 400 message that rejects the whole patch.
 *
 * Knows nothing about project settings — the concrete table lives in ./settings-patch.
 */
import type { ZodError, ZodType } from "zod";

export type FieldResult<V> = { ok: true; value: V | undefined } | { ok: false; error: string };

export type FieldParser<V> = (raw: unknown, key: string) => FieldResult<V> | Promise<FieldResult<V>>;

export const accept = <V>(value: V | undefined): FieldResult<V> => ({ ok: true, value });
export const reject = <V>(error: string): FieldResult<V> => ({ ok: false, error });

/** `null` / `""` mean "clear back to the default" for every settings key, never "store empty". */
export const isClear = (raw: unknown): boolean => raw == null || raw === "";

/** Strict on type: a JSON body carries real numbers, so `"3"` / `true` are client bugs, not input. */
export function integerInRange(range: { min: number; max: number }): FieldParser<number> {
  return (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < range.min || raw > range.max) {
      return reject(`${key} must be an integer in [${range.min}, ${range.max}]`);
    }
    return accept(raw);
  };
}

export function boundedString(max: number): FieldParser<string> {
  return (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "string") return reject(`${key} must be a string`);
    if (raw.length > max) return reject(`${key} too long (max ${max} chars)`);
    return accept(raw);
  };
}

export const booleanValue: FieldParser<boolean> = (raw, key) => {
  if (isClear(raw)) return accept(undefined);
  if (typeof raw !== "boolean") return reject(`${key} must be a boolean`);
  return accept(raw);
};

export function oneOf(allowed: ReadonlySet<string>): FieldParser<string> {
  return (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "string" || !allowed.has(raw)) return reject(`Unsupported ${key}: ${raw}`);
    return accept(raw);
  };
}

/** How a rejected schema parse is spelled out to the operator. */
export type IssueDetail = (error: ZodError) => string;

/** The first issue's message alone — for flat policies where the message names the knob. */
export const messageDetail =
  (fallback: string): IssueDetail =>
  (error) =>
    error.issues[0]?.message ?? fallback;

/** Path-prefixed first issue — for per-key maps, where which entry failed is the useful half. */
export const pathDetail: IssueDetail = (error) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "policy"}: ${issue.message}` : "invalid";
};

/**
 * Strict schema validation: a bad value 400s rather than persisting a policy that would misbehave
 * at run time. `clearOnEmptyArray` covers the list settings whose empty state IS the absent state.
 */
export function schemaValue<V>(
  schema: ZodType<V>,
  detail: IssueDetail,
  { clearOnEmptyArray = false }: { clearOnEmptyArray?: boolean } = {},
): FieldParser<V> {
  return (raw, key) => {
    if (isClear(raw) || (clearOnEmptyArray && Array.isArray(raw) && raw.length === 0)) {
      return accept(undefined);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return reject(`Invalid ${key}: ${detail(parsed.error)}`);
    return accept(parsed.data);
  };
}

export interface FieldRule<T> {
  readonly key: keyof T & string;
  apply(raw: unknown, target: Partial<T>): Promise<string | null>;
}

/** Binds a parser to one key, so the value type is checked against that key's type. */
export function fieldRule<T, K extends keyof T & string>(
  key: K,
  parse: FieldParser<NonNullable<T[K]>>,
): FieldRule<T> {
  return {
    key,
    async apply(raw, target) {
      const result = await parse(raw, key);
      if (!result.ok) return result.error;
      target[key] = result.value as T[K];
      return null;
    },
  };
}

/**
 * Applies every rule whose key is PRESENT in the body — absent means "leave untouched", which is
 * what makes a partial patch partial. Returns the first rejection, leaving `target` unused.
 */
export async function applyFieldRules<T>(
  rules: readonly FieldRule<T>[],
  body: Record<string, unknown>,
  target: Partial<T>,
): Promise<string | null> {
  for (const rule of rules) {
    if (!(rule.key in body)) continue;
    const error = await rule.apply(body[rule.key], target);
    if (error) return error;
  }
  return null;
}
