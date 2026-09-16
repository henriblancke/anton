# The `control-bytes` gate rejects bidi overrides and zero-width characters too
Date: 2026-09-15
Status: accepted

## Decision

Extend the existing `bun run check:control-bytes` gate (anton-flih) to also reject, in every
tracked source file it already scans:

- **Bidi overrides and isolates** — U+202A–U+202E (LRE/RLE/PDF/LRO/RLO), U+2066–U+2069
  (LRI/RLI/FSI/PDI). Rejected **unconditionally, with no allowlist**. Nothing in this codebase's
  source needs to force or isolate text direction, and this is the exact "Trojan Source" class: a
  reviewer sees one rendering, the compiler sees another.
- **Zero-width joiner/non-joiner/space** — U+200B, U+200C, U+200D. Rejected **unconditionally**.
  The repo carries no emoji ZWJ sequences today, and ordinary text — including CJK, RTL, and plain
  emoji — needs none of these codepoints to render; only a *composed* emoji (families, some
  profession emoji) uses ZWJ, and none appear in tracked source. If one is ever needed, that is a
  new decision to make then, not a reason to allowlist ZWJ pre-emptively now.
- **U+FEFF, one exception** — tolerated **only as literally the first character of a file** (a
  genuine UTF-8 byte-order mark). Anywhere else it is the invisible zero-width-no-break-space it
  otherwise is, and is rejected like its zero-width siblings.

Implementation lives in `src/lib/invisible-unicode.ts` (the rule, decoded-text based, tested in
`invisible-unicode.test.ts`) and is wired into the same CLI shell as the C0 byte rule,
`scripts/check-control-bytes.ts` — one gate, two fault classes, no new CI step.

## Why

Same consequence as the C0 control-byte gate this extends (`2026-09-05-source-diffability.md`):
source that renders differently to a reviewer than it compiles. Different mechanism, though — these
are well-formed multi-byte UTF-8 sequences, not malformed bytes, so `.gitattributes diff` does
nothing for them; they need decoding, not byte scanning, which is why they are a separate module
rather than an addition to `control-bytes.ts`'s byte scan.

The allowlist is narrow on purpose. Bidi overrides and ZWJ/ZWNJ/ZWSP have no legitimate role in this
repo's source today, so an unconditional reject costs nothing and closes the whole class. The one
carve-out, U+FEFF at file-start, exists because some tools genuinely emit a BOM and a repo-wide
reject-on-sight would fight real, harmless files instead of the attack.

Three pre-existing zero-width spaces (`src/lib/jobs/cadence.ts`, `src/lib/jobs/cron.ts`,
`.../field-rules.ts`) were escaping a literal `*/` inside `/** */` JSDoc so it wouldn't terminate
the comment early. Fixed in the same change to a visible escape (`*\/`) instead of asking this gate
to tolerate the exact codepoint it exists to catch.

## Rejected

- **Allow ZWJ to support emoji sequences.** No emoji sequence needing it exists in tracked source
  today. Building the carve-out ahead of a real use is speculative; add it when a real one shows up.
- **Allow bidi isolates (U+2066–U+2069) for embedding RTL text in English prose (e.g. a filename in
  Hebrew inside a Markdown doc).** No such usage exists in this repo, and isolates are exactly as
  invisible as overrides to a reviewer — the "safer half" of the class is still the class.
- **Reject U+FEFF everywhere, including file-start.** Would fail real, harmless files that happen to
  carry a BOM (e.g. some editors' UTF-8 output) for no security benefit — the attack needs the
  codepoint mid-file, not at offset zero.
- **Fold this into `control-bytes.ts` as one file.** Byte scanning and decoded-text scanning are
  different operations with different failure modes (invalid UTF-8 doesn't throw, it degrades); a
  separate module keeps each rule's test independently pinned, matching the CLI's existing "rule
  lives in `@/lib`, shell enumerates and reports" split.
