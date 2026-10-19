# Jev is a per-project, explicit, disclosed, fail-safe exception to anton's local-first default
Date: 2026-10-19
Status: accepted

## Decision

A project may opt its decide() calls into TypeSafe's Jev — a hosted HTTP API that answers a
bounded choice/score/yes-no question in milliseconds, at a fraction of a claude-local session's
cost (vendor figures) — instead of running every point against a local claude session. This is a
genuine exception to anton's "nothing leaves your machine" default (`PRODUCT.md`), so it is held
to four rules, each enforced in code rather than left as a convention:

1. **Explicit, per-project, no global switch.** `jevEnabled` lives in one project's settings
   (`project-settings.ts`). There is no machine-wide or cross-project toggle — out of scope,
   anton-p32iy — so opting in is a decision about THIS project's data, never a default that
   quietly follows every repo anton manages.
2. **Disclosed.** Settings lists every registered decide() point and the exact `stateFields` it
   would send (the same list `narrowState` enforces as the untrusted-text boundary, anton-528bw) —
   before the operator ever turns Jev on, not after.
3. **Pinned.** The model version (`jevModel`) must be an exact `jev-X.Y.Z`; `jev-latest` or any
   other moving target is refused both at `jevBackend`'s own construction and at the Settings API
   boundary (`isPinnedJevModel`). A decision log row must always be able to name the one version
   that answered.
4. **Safe to fail.** `jev-fallback.ts`'s composite caller tries jev first on every call and falls
   back to claude-local the instant it throws — a jev outage degrades a decision's latency/cost,
   never its availability. Repeated consecutive failures flip a health flag Settings surfaces, so
   an operator can see a backend quietly going bad instead of only noticing once it affects a run.

Jev's API key is held directly in local settings (`jevApiKey`), not as an env-var NAME the way the
Claude gateway's token is (`claudeAuthTokenEnv`) — see Rejected below for why that indirection
doesn't fit here. The key is never sent back to the Settings UI once stored: the GET/PATCH
responses and the page's SSR props all pass through `redactSecrets`, so only a `apiKeyConfigured`
boolean reaches the browser, never the value.

Jev calls are not claude invocations. A decision answered by jev is recorded in the `decisions`
table with `backend: "jev"` and the returned model version — decide()'s own generic attribution,
shared with every other backend — and never touches the Claude invocation ledger
(`claude-invocations.ts`). Call out explicitly in any PR touching this: a reviewer scanning for a
missing ledger entry on a jev-answered decision would be looking for something that was never
supposed to exist.

## Why

Jev answers in ~70–500ms at a fraction of a claude session's cost, which is what makes
shadow-evaluating every registered point affordable in the first place — a claude-local session
per point would make `shadow` mode itself expensive enough to discourage turning points on. That
benefit only exists because Jev is a hosted API outside anton's process, which is exactly the
thing `PRODUCT.md`'s local-first promise exists to gate. The four rules above are what make
"deliberate exception" true rather than aspirational: an operator who never flips `jevEnabled`
sees no behavior change and nothing of theirs ever leaves the machine.

## Rejected

- **A global, cross-project switch.** Rejected (anton-p32iy, out of scope). A team running the
  opt-in shared Dolt server (`PRODUCT.md`'s other named exception) could have several projects on
  one machine; a global switch would send every one of their decide() calls off-box the moment any
  one project wanted Jev. Per-project keeps the exception scoped to the data the operator actually
  chose to disclose.
- **Token-as-env-var-name indirection, mirroring the Claude gateway.** The gateway's token never
  touches `settings_json` — only the NAME of the env var anton reads it from at spawn time
  (`claudeAuthTokenEnv`), because that token authorizes anton's whole Claude session. Jev has no
  equivalent session to delegate to: it's decide()'s own per-project backend choice, called from
  wherever a job step happens to ask a bounded question, with no single process environment that
  "the Jev call" runs inside. Storing the key directly and redacting it on every read path
  (`redactSecrets`) was the more honest fit than inventing an indirection with nothing to indirect
  through.
- **Deriving backend health from the decisions log**, the way `detectFailureStreak` derives a run
  health streak from run outcomes with no separate persisted flag. Doesn't fit here: the composite
  caller (`jev-fallback.ts`) that retries claude-local internally returns exactly ONE `ModelAnswer`
  to decide(), so a logged row can only ever carry the ONE backend that actually answered — a jev
  failure that fell back to claude-local leaves no durable trace that jev was tried at all. Tracking
  health in-memory, in the composite caller's own closure, was the honest tradeoff given that: it
  resets on restart, which matches anton's own single local process with no distributed state to
  reconcile.
