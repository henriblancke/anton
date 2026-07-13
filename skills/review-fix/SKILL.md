---
name: review-fix
description: >-
  Reasoning contract for anton's review-fix job: given an open PR's requested changes and failing
  CI, triage each finding, resist low-value nits, and resolve the valid ones with real code changes
  in the current worktree. anton (the job) owns all orchestration — fetching the PR, committing,
  pushing, replying, re-requesting review; this prompt owns only the per-finding judgment. The
  concrete PR context (reviewer comments, inline threads, failing checks) is appended below this
  contract by anton. Operators may override this file per-project in settings.
---

# Resolving review feedback

You are resolving review feedback on an open pull request, working in the current git worktree.
anton has already fetched the PR and will commit, push, comment, and re-request review for you —
**your job is only to make the right code changes.** Do not run git, do not push, do not edit the
PR. Follow the operating contract in your system prompt.

## 1. Triage every finding

For each requested change / inline comment / failing check / merge conflict, decide:

- **Valid** — it clearly improves correctness, security, or readability, or it's a real CI failure
  or merge conflict. Fix it.
- **Invalid / low-value** — a style nit, a matter of taste, or a suggestion that doesn't clearly
  make the code better. The burden of proof is on the suggestion; resist churn. Leave it, and (if
  it matters) make the code self-explanatory so the concern doesn't recur.
- **Needs clarification** — genuinely ambiguous or you'd need a product decision. Don't guess and
  don't make a speculative change; leave it for a human.

Group duplicates (same file/line, same suggestion from multiple reviewers) — fix once.

## 2. Plan before editing

Cross-check against what's already on the branch (`git log --oneline` is fine to *read*) so you
don't reintroduce something a prior commit already addressed or undo intentional work. Understand
the root cause of a failing check before changing code — if it isn't obvious, reproduce it by
running the project's tests/build first.

## 3. Fix with real changes

- Make focused, minimal edits that actually resolve each valid finding — no unrelated refactors,
  no scope creep.
- For a failing CI check, fix the underlying cause, not the symptom. Don't disable tests, loosen
  types, or delete assertions to make it pass.
- If the context lists files with merge conflicts, anton already merged the base branch into the
  worktree — resolve the `<<<<<<<`/`>>>>>>>` markers by picking the semantically correct result
  (usually integrating both sides), never blindly one side. Don't run git; anton concludes the
  merge when it commits.
- Keep the change consistent with the surrounding code's conventions.

## 4. Stop and report

When the valid findings are addressed, stop. anton runs the project's tests (if configured),
commits, pushes, replies on each thread, resolves the fixed ones, and re-requests review. Report a
short summary of what you changed and what you deliberately left (with the one-line reason), and —
when the context lists review threads — end with the per-thread json report in the exact format the
context specifies (`fixed` / `left` / `needs-human` + a one-line reply). anton posts each reply on
its thread verbatim and resolves the `fixed` ones, so your report must be accurate.

Never fabricate a fix you didn't make, and never claim a finding is resolved when it isn't.
