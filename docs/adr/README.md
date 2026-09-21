# Architecture Decision Records

Decisions that bind future work — the ones a later contributor would otherwise re-litigate or
silently break. One file per decision, numbered, never edited after acceptance except to mark a
supersession.

A design document (`docs/plans/`) says what is being built. An ADR says what every *subsequent*
feature must honour. If a decision only affects the thing being built right now, it belongs in the
design doc, not here.

| # | Title | Status |
|---|---|---|
| [0001](0001-every-feature-is-instrumented.md) | Every feature is instrumented into the delivery ledger | accepted |

## Format

Frontmatter (`title`, `status`, `date`, `deciders`, `supersedes`), then:

- **Context** — the forces, and the failure mode the decision prevents.
- **Decision** — what is now binding, stated concretely enough to review against.
- **Consequences** — positive *and* negative. An ADR with no costs listed has not been thought
  through.
- **Alternatives considered** — what was rejected and why, so it is not re-proposed.

Statuses: `proposed` · `accepted` · `superseded by ADR-NNNN` · `deprecated`.
