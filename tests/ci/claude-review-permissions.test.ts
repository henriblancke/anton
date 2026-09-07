/**
 * This repo's own CI, not anything anton ships: the review workflow's tool allowlist, pinned
 * against the commands its own prompt hands the agent (anton-9zzu).
 *
 * A `Bash(prefix:*)` rule matches on WHITESPACE-DELIMITED TOKENS: the command's leading tokens must
 * equal the rule's, and there are no globs. A rule that ends mid-token therefore matches nothing —
 * and it fails SILENTLY, because a denied tool call is not an error: the agent improvises, the job
 * still reports success. `Bash(gh api .../issues/comments/:*)` was exactly that rule, and the
 * improvisation was "post a new summary", 52 times on one PR.
 *
 * The semantics asserted here were established empirically against Claude Code 2.1.263
 * (`claude -p --permission-mode default --allowedTools <rule>`), not read off documentation:
 *   • `Bash(x/:*)` DENIES `x/123 …` but ALLOWS `x/ 123 …` — the boundary is whitespace, so no rule
 *     can ever cover a path with a variable id glued to it.
 *   • `*` is not a wildcard inside a rule: `Bash(x/*:*)` denies `x/123` too.
 *   • A trailing `|| true` does not need a rule of its own.
 *
 * So the assertion that matters is the last one: every command the prompt tells the agent to run is
 * covered by the allowlist the same workflow passes.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const WORKFLOW = join(REPO_ROOT, ".github/workflows/claude-code-review.yml");
const HELPER = ".github/scripts/pr-comment.sh";

/** What GitHub substitutes before the agent ever sees the prompt. Values are arbitrary but shared. */
const EXPRESSIONS: Record<string, string> = {
  "github.repository": "owner/repo",
  "github.repository_owner": "owner",
  "github.event.repository.name": "repo",
  "github.event.pull_request.number": "42",
  "env.REVIEW_BOT_LOGIN": "claude[bot]",
  "env.REVIEW_FILE": ".github/CODE_REVIEW.md",
  "env.REVIEW_LABEL": "claude-approved",
  "env.REVIEW_LABEL_THRESHOLD": "7",
};

/**
 * Unknown expressions throw rather than resolve to junk — a new one has to be taught to this test.
 * `secrets.*` / `vars.*` are the exception: they configure the action, never a command's identity.
 */
function render(text: string): string {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    if (/^(secrets|vars)\./.test(expr)) return "x";
    const value = EXPRESSIONS[expr];
    if (value === undefined) throw new Error(`unknown workflow expression: \${{ ${expr} }}`);
    return value;
  });
}

const workflow = render(readFileSync(WORKFLOW, "utf8"));

type Rule = { readonly prefix: readonly string[]; readonly anyArgs: boolean };

const tokenize = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

function parseRules(source: string): Rule[] {
  const list = /--allowedTools\s*\n\s*"([^"]+)"/.exec(source);
  if (!list) throw new Error("could not find the --allowedTools list in the workflow");
  return list[1]
    .split(",")
    .map((entry) => /^Bash\((.*)\)$/.exec(entry.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const anyArgs = m[1].endsWith(":*");
      return { prefix: tokenize(anyArgs ? m[1].slice(0, -2) : m[1]), anyArgs };
    });
}

/**
 * Split a command the way the matcher does: each piece of a pipeline or `&&`/`||`/`;` chain is
 * checked on its own. Quotes are respected — the prompt's jq programs and GraphQL queries are full
 * of `|` that is data, not a pipe.
 */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "|" || char === "&" || char === ";") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Shell builtins the matcher never asks about — verified: `… 2>/dev/null || true` is not denied. */
const ALWAYS_SAFE = new Set(["true", "false", ":"]);

function isPermitted(command: string, rules: Rule[]): boolean {
  return segments(command).every((segment) => {
    const cmd = tokenize(segment);
    if (cmd.length === 1 && ALWAYS_SAFE.has(cmd[0])) return true;
    return rules.some((rule) =>
      rule.anyArgs
        ? rule.prefix.every((token, i) => cmd[i] === token)
        : rule.prefix.length === cmd.length && rule.prefix.every((token, i) => cmd[i] === token),
    );
  });
}

/**
 * The commands the prompt hands the agent: every backticked span that is an invocation. Prose names
 * a CLI without backticking a command, so anything matching here is meant to be run — and must be
 * allowed.
 */
function promptCommands(source: string): string[] {
  const prompt = source.slice(source.indexOf("prompt: |"));
  return [...prompt.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((span) => span.startsWith("gh ") || span.startsWith(".github/scripts/"))
    .map((span) => span.replace(/<[A-Za-z_][A-Za-z0-9_]*>/g, "1")); // <id>, <index>, <threadId>
}

describe("the Bash allowlist matcher", () => {
  const rule = (text: string): Rule[] => parseRules(`--allowedTools\n            "${text}"`);

  it("denies a prefix that ends mid-token — the bug that broke the sticky summary", () => {
    const rules = rule("Bash(gh api repos/owner/repo/issues/comments/:*)");
    expect(isPermitted("gh api repos/owner/repo/issues/comments/123 -X PATCH", rules)).toBe(false);
  });

  it("allows the same prefix once the id is a separate token", () => {
    const rules = rule("Bash(gh api repos/owner/repo/issues/comments/:*)");
    expect(isPermitted("gh api repos/owner/repo/issues/comments/ 123", rules)).toBe(true);
  });

  it("treats `*` inside a rule as a literal, not a wildcard", () => {
    const rules = rule("Bash(gh api repos/owner/repo/issues/comments/*:*)");
    expect(isPermitted("gh api repos/owner/repo/issues/comments/123 -X PATCH", rules)).toBe(false);
  });

  it("checks every segment of a pipeline, and ignores `|` inside quotes", () => {
    const rules = rule("Bash(gh pr view:*),Bash(jq:*)");
    expect(isPermitted("gh pr view 42 | jq -r '.a | .b'", rules)).toBe(true);
    expect(isPermitted("gh pr view 42 | sed s/a/b/", rules)).toBe(false);
  });

  it("does not require a rule for a trailing `|| true`", () => {
    expect(isPermitted("gh label create 'x' 2>/dev/null || true", rule("Bash(gh label create:*)"))).toBe(true);
  });
});

describe("the claude-code-review workflow", () => {
  const rules = parseRules(workflow);

  it.each(promptCommands(workflow))("allows the command it tells the agent to run: %s", (command) => {
    expect(isPermitted(command, rules)).toBe(true);
  });

  it("routes the sticky summary through the helper script", () => {
    expect(isPermitted(`${HELPER} sticky <<'MARKDOWN'`, rules)).toBe(true);
  });

  it("leaves no second route to a PR comment, so a duplicate summary is unreachable", () => {
    expect(isPermitted("gh pr comment 42 --body-file -", rules)).toBe(false);
    expect(isPermitted("gh pr comment 42 --edit-last --body x", rules)).toBe(false);
    expect(isPermitted("gh api repos/owner/repo/issues/42/comments -X POST -F body=@-", rules)).toBe(false);
  });

  it("ships the helper script executable — the allowlist names the path, not an interpreter", () => {
    const mode = statSync(join(REPO_ROOT, HELPER)).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});
