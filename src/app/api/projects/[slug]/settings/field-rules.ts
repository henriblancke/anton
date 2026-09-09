/**
 * Generic building blocks for a settings-style PATCH body: one rule per key, each turning a raw
 * JSON value into either a validated value or the 400 message that rejects the whole patch.
 *
 * Knows nothing about project settings — the concrete table lives in ./settings-patch.
 */
import type { ZodError, ZodType } from "zod";
import { hasCredentialMarker } from "@/lib/scan-secrets";

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

/** Percent-decode a path segment for credential matching; a malformed escape falls back to raw. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The hostname with its original case. `new URL(...).hostname` lowercases every label, but the
 * value persisted is the raw string and several credential markers are case-sensitive (`AKIA…`,
 * `ghp_…`, `AIza…`) — so a token pasted as a label (`AKIA…​.gateway.example`) would clear the
 * lowercased check yet land in settings_json intact. Recover the label casing from `raw` and scan
 * that; fall back to the normalized form when it can't be located (e.g. an IDN punycode host, which
 * carries no ASCII credential anyway).
 */
function rawHostname(raw: string, parsed: URL): string {
  const at = raw.toLowerCase().indexOf(parsed.hostname);
  return at >= 0 ? raw.slice(at, at + parsed.hostname.length) : parsed.hostname;
}

/** An http(s) URL — a gateway base URL, not a bare host, a file path, or a stray scheme. */
export function httpUrl(max: number): FieldParser<string> {
  return (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "string") return reject(`${key} must be a string`);
    if (raw.length > max) return reject(`${key} too long (max ${max} chars)`);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return reject(`${key} must be a valid http(s) URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reject(`${key} must be an http(s) URL`);
    }
    // Userinfo is a secret in a URL's clothing — storing it verbatim would land a credential in
    // settings_json, exactly the "no secret in anton.db" guarantee this feature rests on.
    if (parsed.username || parsed.password) {
      return reject(
        `${key} must not include credentials — paste the URL without userinfo, ` +
          `and keep the token in the auth-token env var`,
      );
    }
    // A token also hides as a hostname label (`https://sk-secret.gateway.example/v1`): empty
    // userinfo, no query, no path segment carries it, so only a scan of the host labels themselves
    // keeps the no-secret-in-database guarantee. Same detector as the path — shape only, so a
    // legitimate subdomain (`api`, `eu`) rides through.
    if (
      rawHostname(raw, parsed)
        .split(".")
        .some((label) => hasCredentialMarker(label))
    ) {
      return reject(
        `${key} must not embed a credential in its hostname — paste the base URL without the token, ` +
          `and keep it in the auth-token env var`,
      );
    }
    // A query or fragment is the other place a secret hides in a URL (`?api_key=…`, `#token=…`);
    // a gateway BASE URL has no use for either, so forbid both outright rather than sniff for
    // credential-shaped params — same guarantee, no persisted secret.
    if (parsed.search || parsed.hash) {
      return reject(
        `${key} must not include a query or fragment — paste the base URL only, ` +
          `and keep any token in the auth-token env var`,
      );
    }
    // The path is the last place a token hides (`…/sk-secret/v1`). It can't be forbidden outright —
    // a base URL is legitimately versioned (`/v1`, `/openai`) — so reject only segments carrying a
    // shape anton recognises as a credential, the same detector it uses elsewhere. Word/entropy
    // heuristics stay out: they would reject `/v1` and public ids like a Cloudflare account tag.
    //
    // Boundary: hasCredentialMarker is `^`-anchored (host labels and path segments alike), so it
    // catches a token that IS a whole segment/label — the plausible accidental-paste forms — but not
    // one buried as the suffix of a longer token (`…/prefix-AKIA4xyz`). That's an unusual structure
    // no gateway base URL requires, and dropping the anchor would false-positive on ordinary
    // segments that merely start with a known prefix (`/api-v1-gw`). The absolute userinfo/query/
    // fragment rejections above cover the URL components where a secret actually rides.
    if (parsed.pathname.split("/").some((segment) => hasCredentialMarker(safeDecode(segment)))) {
      return reject(
        `${key} must not embed a credential in its path — paste the base URL without the token, ` +
          `and keep it in the auth-token env var`,
      );
    }
    return accept(raw);
  };
}

/** A POSIX env-var NAME: an uppercase identifier, never a value that happens to look like one. */
const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The NAME of an environment variable, e.g. `ANTHROPIC_AUTH_TOKEN` — not its value. A pasted token
 * (lowercase, dashes, an `sk-…` prefix) fails the pattern, and an all-uppercase credential that
 * slips past it (`AKIA…`) is caught by the credential detector, so a secret can never be stored
 * here by mistake: only the name of the var anton reads it from is kept.
 */
export function envVarName(max: number): FieldParser<string> {
  return (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "string") return reject(`${key} must be a string`);
    if (raw.length > max) return reject(`${key} too long (max ${max} chars)`);
    if (!ENV_VAR_NAME.test(raw)) {
      return reject(
        `${key} must be an environment variable NAME like ANTHROPIC_AUTH_TOKEN ` +
          `([A-Z_][A-Z0-9_]*), not a token value`,
      );
    }
    // An all-uppercase credential (`AKIA…`, `SK_LIVE…`) satisfies the identifier pattern, so the
    // shape check alone would let a pasted secret land in settings_json — the one thing this field
    // exists to prevent. Reject anything the credential detector recognises outright.
    if (hasCredentialMarker(raw)) {
      return reject(
        `${key} looks like a credential value, not an environment variable name — ` +
          `paste the NAME of the env var anton reads the token from, not the token itself`,
      );
    }
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
