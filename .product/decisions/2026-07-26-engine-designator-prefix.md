# Engine designator: `area:`, kept separate from `domain:`
Date: 2026-07-26
Status: accepted

Settles the open question in [`docs/design/2026-07-26-tier-and-linear-ux.md`](../../docs/design/2026-07-26-tier-and-linear-ux.md)
(§ "Open question") for epic `anton-9pkk`.

## Decision

1. **The engine designator is `area:`.** A single-valued, project-local label carried by
   **epic**-tier beads. It is what the roadmap's Area column shows and what Linear project
   routing keys on. The vocabulary is open — anton never validates the value.
2. **`domain:` is untouched.** It keeps `eng|marketing|bizdev|research|ops` on every tier, per
   `skills/bd/SKILL.md`. A bead may carry both labels; they answer different questions.
   Nothing already on the board is re-labelled.
3. **`area:` joins `LABEL_PREFIXES`** (`src/lib/beads/bd.ts:73`) as a fifth managed prefix, so the
   existing parse / patch / filter machinery covers it and no new label plumbing is invented.
4. **The epic badge is not colour-coded per area.** One hue — `--type-epic` — for every epic badge;
   the value is carried by text. See [Colour](#colour).

## Why

**They are not the same axis.** `domain:` answers *which function of the company owns this work*;
`area:` answers *which product surface this advances*. A marketing bead about the ingest surface is
`domain:marketing` + `area:ingest`. A single-valued fold cannot express that pair at all — it forces
a choice between the org taxonomy and the product taxonomy on every cross-functional bead. The
design's premise that the two classify along one axis holds only on a board that is 100%
engineering, which is the board we have today, not the board the epic tier exists to serve.

**`domain:` is saturated by the shaping ritual, so it cannot carry meaning.** Measured across all
363 beads on 2026-07-26: `domain:eng` 248, `domain:research` 6, `domain:docs` 5. Of 58 epics, 41 are
`domain:eng`, 16 carry no domain at all, 1 is `domain:docs`. Folded, the roadmap ships as a single
row labelled "eng" holding 41 epics, and the design's `not synced — needs area:` empty state becomes
unreachable: a stamped default is indistinguishable from a deliberate designation. Absence has to
stay meaningful for the roadmap to be worth opening. (`domain:docs` is also not one of the five
documented values — the vocabulary has already drifted, which is a reason to stop adding load to it,
not to add more.)

**`domain:` is a shared convention, `area:` is project-local.** `skills/bd/SKILL.md` ships to every
loom project. Widening its five values to hold one project's product surfaces mutates a shared
taxonomy to serve a local need. A project-local prefix is the cheaper blast radius.

**The cost of the fifth prefix is one-time and small** — the prefix list, the ticket filter facet,
the ticket-dialog field, the patch field, and their tests. That is a bounded edit, against a naming
ambiguity ("which prefix do I use?") that every shaper would pay forever.

## Coexistence with what is on the board

- **There is no `area:` label on this board.** Verified 2026-07-26 across all 363 beads (open and
  closed): zero. The `area:ingest` in the design mock is that mock's fictitious demo data
  (Ontology / Knowledge / Ingest Engine), not anton's board. **Nothing to migrate.** Were a stray
  `area:*` to exist, it would be read as-is — the vocabulary is open and unvalidated.
- **No bead is re-labelled.** The 259 existing `domain:` labels stay exactly as they are.
- **Today's 58 epics carry no `area:`,** so they render the hollow `◇` legacy state on the board and
  `not synced — needs area:` on the roadmap. That is the intended, actionable empty state — the user
  tags the epics they want on the roadmap, one at a time, and nothing breaks in the meantime.
- **Single-valued, like every other managed prefix.** `labelValueOf` returns the first match, and
  `buildUpdateArgs` diffs one value per prefix. Two `area:` labels on one bead is a malformed bead,
  not a feature.

## Colour

The mock's three area hues are not new colours — they are existing tokens copied verbatim, which is
exactly why they collide:

| Mock hue | light | dark | is actually |
| --- | --- | --- | --- |
| `--area-ontology` | `#6355e0` | `#8f82ff` | `--type-epic` |
| `--area-knowledge` | `#2c9d68` | `#4fc08a` | `--agent-supabase` |
| `--area-ingest` | `#c05070` | `#f26a86` | `--agent-terraform` |

The Atelier palette holds six chromatic hues plus grey, and every one except iris is already spoken
for by `agent:`, `risk:`, `stage:`, or `type:`. **There is no free hue**, so any per-area hue
assignment collides with an `agent:` dot on the same card by construction. Iris is the one hue no
`agent:` token uses — and it already means "epic" in the work-type language.

So: **one hue for the tier, not per value.** The badge reuses the shipped epic recipe
(`TYPE_BADGE.epic` in `src/components/board/board-utils.ts:51` —
`border-type-epic/30 bg-type-epic/10 text-type-epic`); the "no epic" state stays `--subtle`, as the
mock already has it. Colour then means one thing, and stays stable when an area is added or renamed.

Checked in both themes:

- **Contrast**, badge text on its own 10%-tinted fill over the card: light **4.69:1**, dark
  **4.92:1** — both clear WCAG AA for normal text (badge text is 11px, so the 4.5:1 threshold
  applies, not the large-text 3:1).
- **Separation from every `agent:` dot** (CIE Lab ΔE, nearest first): `agent-fastapi` 41.8 light /
  41.5 dark, `agent-terraform` 74.2 / 74.5, `agent-docker`+`agent-kubernetes` 86.1 / 73.5,
  `agent-supabase` 124.8 / 112.6, `agent-pydantic` 129.8 / 119.3. The closest pair is iris vs the
  `agent-fastapi` blue at ΔE ≈ 42 and 35° of hue separation — the same separation the shipped
  epic-vs-task type badges already rely on.
- One rule everywhere, not two: the roadmap's Area cell uses the same single iris chip. No surface
  assigns a hue per area value — hues stay reserved for `agent:`, `risk:`, `stage:`, and `type:`.

## Rejected

- **Fold `area:` into `domain:`.** Cheapest in code, but it makes cross-functional beads
  unrepresentable, destroys the "needs a designator" empty state behind a stamped default, and
  mutates a taxonomy shared with every other loom project. See Why.
- **A hue per area, from the palette.** Every candidate hue is an `agent:` colour in both themes —
  that is the collision the design flagged, not a tuning problem.
- **Hashing area values onto `--chart-1..5`.** Same six hues, so the same collision, plus the hues
  shuffle whenever an area is added or renamed — a colour code that is not stable is worse than none.
- **De-saturating the area badge** (the design's other option). Fixes the clash by making the badge
  hard to read, and still spends a colour axis on a value the text already carries.

## Consequences for the tickets that consume this

- `anton-9pkk.3` (epic badge) — badge uses `TYPE_BADGE.epic`; add `area` to `LABEL_PREFIXES` and to
  the filter bar's facets alongside the epic filter. No new token in `globals.css`.
- `anton-9pkk.5` (roadmap) — Area column reads `area:` off the epic; an epic without one shows
  `not synced — needs area:`.
- `anton-9pkk.7` (`/shape` + bd skill) — documents `area:` as the epic tier's label and leaves the
  `domain:` values alone.
- `anton-ey0w` (Linear sync) — the project routing table keys on `area:`; unmapped areas are skipped
  and reported.
