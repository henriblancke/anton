# Source diffability: `.gitattributes diff` + a control-byte CI gate
Date: 2026-09-05
Status: accepted

## Decision

Adopt **both halves**, as one change:

1. `.gitattributes` sets `diff` — and only `diff` — on the repo's source globs, so git always
   renders a patch for them instead of `Binary files differ`.
2. A blocking CI gate, `bun run check:control-bytes`, rejects C0 control bytes (NUL and friends)
   in tracked source files. Its scanned extension set is pinned to the `.gitattributes` globs by a
   test, so neither half can quietly outgrow the other.

Adopting (1) without (2) is explicitly **not** an option: the second is what makes the first safe.

## Why

anton's reviewers are diff-based — humans, Codex, Claude Code review, and anton's own pre-PR review
all read patches. A file git classifies as binary is a file nobody reviews. That is not
hypothetical: a stray NUL byte in `src/lib/epic-graph.ts` made the whole module opaque to every
reviewer until someone noticed the absence (anton-74f8). Silent unreviewed code is the larger risk,
so diffability wins.

`Binary files differ` *was* a real alarm, and forcing `diff` removes it — a genuine downside, which
is why the review of anton-74f8 was right to pull the bare `.gitattributes` back out. But it is a
bad alarm on its merits: it fires only as a side effect, only for NUL specifically, only in the
first 8000 bytes, and only if a human notices that a diff they expected is missing. It degrades the
automated reviewers rather than stopping them. A dedicated lint fires deterministically, in CI,
before review, naming the file and the byte offset — earlier, louder, and over a wider fault class
(every C0 control byte plus DEL, not just NUL).

`diff` is set without `text` on purpose. `text` additionally switches on end-of-line normalisation,
which buys this nothing today and would surprise a Windows checkout later. The narrow attribute is
the whole ask.

## Rejected

- **Rely on git content detection alone.** Keeps the accidental alarm, but keeps the failure mode
  that motivated the ticket: an entire module invisible to every reviewer, discovered by luck.
- **`.gitattributes` alone (the anton-74f8 shape).** Trades a weak alarm for none at all.
- **`text diff`.** Drags in CRLF normalisation for no benefit here.
- **A pre-commit hook instead of CI.** Hooks are skippable (`--no-verify`) and are not installed for
  every contributor; a gate that can be bypassed is not the alarm this replaces. Pre-commit stays
  scoped to lint + typecheck, as documented in CONTRIBUTING.md.
- **Also rejecting invisible Unicode (bidi overrides, zero-width joiners — "Trojan Source").** Real,
  but a different fault class: multi-byte sequences that render as nothing rather than raw control
  bytes, needing their own allowlist thinking. Filed separately rather than smuggled in here.
