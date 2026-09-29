/**
 * Unit tests for classifyFailureCause (anton-nwnm8) — a pure, model-free mapping from a settled
 * run's `runs.error` text to a coarse cause label. The corpus below is drawn from real error text
 * this codebase actually constructs (see execute-epic-freshness.ts, git/ops.ts, git/worktree.ts,
 * claude/driver-exit.ts, claude/driver-limits.ts, and the gate-failure call sites), not synthesized
 * to game the regex — several are quoted from doc comments that record them "observed verbatim in
 * anton.db".
 */
import { describe, expect, it } from "vitest";
import { classifyFailureCause } from "./failure-cause";

describe("classifyFailureCause", () => {
  it("classifies the self-freshness refusal as freshness", () => {
    const error =
      "anton is running behind its own latest code, so it will not start new work: its checkout is " +
      "3 commit(s) behind origin/main — run `git pull` in /home/anton/anton, then restart anton. " +
      "New epics are still assigned; only starting a NEW run is stopped.";
    expect(classifyFailureCause(error)).toBe("freshness");
  });

  it("classifies a bare stale-checkout prefix as freshness even with no further detail", () => {
    const error = "anton is running behind its own latest code, so it will not start new work: unknown cause.";
    expect(classifyFailureCause(error)).toBe("freshness");
  });

  it("classifies a lint gate failure as gate", () => {
    expect(classifyFailureCause("lint gate failed for anton-8x1k (exit 1)")).toBe("gate");
  });

  it("classifies a tests gate failure as gate", () => {
    expect(classifyFailureCause("tests gate failed for anton-vzhf (exit 1)")).toBe("gate");
  });

  it("classifies a typecheck gate failure recorded after a review round as gate", () => {
    expect(classifyFailureCause("typecheck gate failed after review round 2 for anton-sm1l (exit 2)")).toBe("gate");
  });

  it("classifies a verify gate failure recorded after review-fix as gate", () => {
    const error =
      "verify gate failed after review-fix for PR #281 (exit 1)\n\n" +
      "> vitest run\n\nFAIL src/lib/jobs/runner.test.ts";
    expect(classifyFailureCause(error)).toBe("gate");
  });

  it("classifies the terse usage-limit banner as quota", () => {
    expect(classifyFailureCause("Claude AI usage limit reached|1700000000")).toBe("quota");
  });

  it("classifies the 5-hour limit banner as quota", () => {
    expect(classifyFailureCause("5-hour limit reached · resets 9pm (America/New_York)")).toBe("quota");
  });

  it("classifies the weekly limit banner as quota", () => {
    expect(classifyFailureCause("weekly limit reached · resets Mon 12:00am (UTC)")).toBe("quota");
  });

  it("classifies the monthly spend-limit banner as quota", () => {
    expect(
      classifyFailureCause("You've hit your monthly spend limit · raise it at claude.ai/settings/usage"),
    ).toBe("quota");
  });

  it("classifies the session-limit banner as quota", () => {
    expect(
      classifyFailureCause("You've hit your session limit · resets 9pm (America/New_York)"),
    ).toBe("quota");
  });

  it("classifies the out-of-usage-credits banner as quota", () => {
    const error =
      "You're out of usage credits. Switch to another model, or manage usage credits at " +
      "claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
    expect(classifyFailureCause(error)).toBe("quota");
  });

  it("classifies a wrapped rate_limit_error API envelope as quota", () => {
    const error =
      'API Error: 503 [claude/claude-opus-5] [429]: {"type":"error","error":{"type":"rate_limit_error",' +
      '"message":"This request would exceed your organization\'s per-minute rate limit (reset after 2m 41s)."}}';
    expect(classifyFailureCause(error)).toBe("quota");
  });

  it("classifies a wrapped gateway billing-stop envelope as quota", () => {
    const error =
      'API Error: 503 [openrouter/some-model] [402]: {"error":{"message":"This request requires more ' +
      'credits, please top-up your account."}}';
    expect(classifyFailureCause(error)).toBe("quota");
  });

  it("classifies a rejected git push carrying a failing pre-push hook's test output as infra", () => {
    const error =
      "git push failed (exit 1): husky - pre-push hook exited with code 1 (error)\n\n> test\n> vitest run\n\n" +
      "FAIL src/lib/git/ops.test.ts";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a local pre-push hook decline as infra", () => {
    expect(
      classifyFailureCause(
        "a local pre-push hook declined the push: husky - pre-push hook exited with code 1 (error)",
      ),
    ).toBe("infra");
  });

  it("classifies a remote pre-receive hook decline as infra", () => {
    expect(
      classifyFailureCause("the remote's pre-receive hook declined the push — remote policy, not a transport fault"),
    ).toBe("infra");
  });

  it("classifies a worktree rebase that never started as infra", () => {
    const error =
      "[worktree] anton/anton-nwnm8 could not be rebased onto main — the rebase never started " +
      "(fatal: Needed a single revision). Resolve in /home/anton/worktrees/anton-nwnm8 and retry.";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a worktree branch diverging and failing to rebase cleanly as infra", () => {
    const error =
      "[worktree] anton/anton-nwnm8 diverges from main and could not be rebased onto it cleanly — " +
      "refusing to discard its commits. Unique commits:\nabc1234 fix: foo\nResolve the conflict in " +
      "/home/anton/worktrees/anton-nwnm8 and retry (fatal: could not apply abc1234)";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a permanent local push failure (index.lock) as infra", () => {
    expect(
      classifyFailureCause(
        "a permanent local failure, not a transport fault: Unable to create '/repo/.git/index.lock': File exists.",
      ),
    ).toBe("infra");
  });

  it("classifies a pre-push hook decline whose own output quotes a gate failure as infra, not gate", () => {
    const error = "a local pre-push hook declined the push: lint gate failed for anton-8x1k (exit 1)";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a deterministic non-zero claude exit as agent", () => {
    const error =
      "claude exited with code 1: I've made the changes but two tests still fail due to a flaky mock " +
      "and I couldn't isolate the cause before running out of turns.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a stalled claude session as infra, not agent — a driver watchdog kill, not the agent's doing", () => {
    expect(classifyFailureCause("claude produced no output for 5m — killed as stalled")).toBe("infra");
  });

  it("classifies a claude exit with no result event as infra, not agent — a truncated stream, not a deterministic failure", () => {
    expect(classifyFailureCause("claude exited without a result event")).toBe("infra");
  });

  it("classifies a claude exit whose detail carries a transient network signature as infra, not agent", () => {
    const error = "claude exited with code 1: Connection closed mid-response (ECONNRESET)";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a claude exit whose detail carries a bare upstream status code as infra, not agent", () => {
    const error = "claude exited with code 1: API Error: 503 Service Unavailable";
    expect(classifyFailureCause(error)).toBe("infra");
  });

  it("classifies a refused/nonexistent model id as agent", () => {
    const error =
      'claude refused to start: the model "claude-opus-4-8" doesn\'t exist, or the configured account ' +
      "or gateway credential doesn't have access to it. Configured in this project's settings as the " +
      "General default model or a matching Model routing rule (settings_json.modelRoutes) — or, if " +
      "neither is set, inherited from Claude Code's own default configuration outside this project. " +
      "Fix the id there if it's wrong, or grant that account/credential access to the model if the id " +
      "is correct — retrying alone will not resolve either case.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a deterministic exit whose own report merely quotes a quota phrase as agent, not quota", () => {
    const error =
      "claude exited with code 1: Narrowed the monthly spend limit matcher, but the push failed.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a deterministic exit whose own report narrates a pre-push hook decline as agent, not infra", () => {
    const error =
      "claude exited with code 1: the pre-push hook declined while I was working through the last commit.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a deterministic exit whose own report narrates a gate failure as agent, not gate", () => {
    const error = "claude exited with code 1: the lint gate failed locally before I could push.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a gate failure whose captured test output merely quotes a stall/no-result phrase as gate, not agent", () => {
    const error =
      "verify gate failed for anton-abcd (exit 1)\n\n> vitest run\n\nFAIL src/lib/claude/driver-exit.test.ts\n" +
      'AssertionError: expected error message "claude exited without a result event" to be thrown';
    expect(classifyFailureCause(error)).toBe("gate");
  });

  it("classifies a step:implement dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("claude reported an error for anton-a1b2: the model gave up")).toBe("agent");
  });

  it("classifies a step:claude dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("claude reported an error for step implement: the model gave up")).toBe("agent");
  });

  it("classifies a review-fix dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("claude reported an error resolving PR #281: unknown")).toBe("agent");
  });

  it("classifies a review-gate dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("claude reported an error reviewing anton-gate1: unknown")).toBe("agent");
  });

  it("classifies a product-master dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("the product-master session reported an error: unknown")).toBe("agent");
  });

  it("classifies a scan-triage dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("scan-triage reported an error: unknown")).toBe("agent");
  });

  it("classifies a describer dispatch that self-reported is_error as agent", () => {
    expect(classifyFailureCause("describer reported an error for anton-a1b2: unknown")).toBe("agent");
  });

  it("classifies an explicit self-reported agent block as agent", () => {
    const error =
      "anton-y1u2y was self-reported blocked by the agent (blocked — dep-missing — waiting on anton-abcd) " +
      "even though it committed changes. Blocking the ticket for operator review and halting the epic — " +
      "the agent declared the work incomplete, so closing it would be a false success.";
    expect(classifyFailureCause(error)).toBe("agent");
  });

  it("classifies a gate failure whose captured output quotes the self-report phrase as gate, not agent", () => {
    const error =
      "verify gate failed for anton-abcd (exit 1)\n\n> vitest run\n\nFAIL src/lib/failure-cause.test.ts\n" +
      'AssertionError: expected "anton-y1u2y was self-reported blocked by the agent (blocked — ' +
      'dep-missing — waiting on anton-abcd) even though it committed changes." to be classified as agent';
    expect(classifyFailureCause(error)).toBe("gate");
  });

  it("classifies a gate failure whose captured output quotes an infra phrase as gate, not infra", () => {
    const error =
      "verify gate failed after review-fix for PR #281 (exit 1)\n\n> vitest run\n\n" +
      "FAIL src/lib/git/worktree.test.ts\n" +
      'AssertionError: expected message to contain "[worktree] anton/anton-nwnm8 could not be ' +
      'rebased onto main"';
    expect(classifyFailureCause(error)).toBe("gate");
  });

  it("classifies the measured 'operation was aborted' reason as unknown, not agent", () => {
    expect(classifyFailureCause("The operation was aborted")).toBe("unknown");
  });

  it("classifies an unrecognized error string as unknown", () => {
    expect(
      classifyFailureCause("TypeError: Cannot read properties of undefined (reading 'toLowerCase')"),
    ).toBe("unknown");
  });

  it("classifies a missing error as unknown", () => {
    expect(classifyFailureCause(undefined)).toBe("unknown");
    expect(classifyFailureCause(null)).toBe("unknown");
  });

  it("classifies an empty error string as unknown", () => {
    expect(classifyFailureCause("")).toBe("unknown");
  });

  it("never throws on an unmatched string", () => {
    expect(() => classifyFailureCause("the variable name `tmp2` is unclear")).not.toThrow();
    expect(classifyFailureCause("the variable name `tmp2` is unclear")).toBe("unknown");
  });
});
