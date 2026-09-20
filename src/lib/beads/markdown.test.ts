import { describe, expect, it } from "vitest";
import {
  htmlBlockLines,
  isHeading,
  renderedLines,
  scanMarkdown,
  unquote,
  unterminatedCloser,
} from "./markdown";

/** The lines a body renders, as the consumers read them: text only, fence flag dropped. */
const rendered = (source: string) => renderedLines(source).map((line) => line.text);

/** What each line of `source` renders, one entry per source line (delimiters included, as `""`). */
const visible = (source: string) => scanMarkdown(source).map((line) => line.visible);

/** The heading each line opens, `undefined` where none — the fact the contract sections on. */
const headings = (source: string) => scanMarkdown(source).map((line) => line.heading);

describe("isHeading", () => {
  it("accepts ATX headings at every depth, indented up to three spaces", () => {
    expect(isHeading("# Goal")).toBe(true);
    expect(isHeading("###### Goal")).toBe(true);
    expect(isHeading("   ### Goal")).toBe(true);
    expect(isHeading("## Goal ##")).toBe(true); // optional closing sequence
    expect(isHeading("#\tGoal")).toBe(true);
    expect(isHeading("# ")).toBe(true); // a heading with no text is still a heading
    // A bare marker ends the opening sequence at the line's end — still an (empty) heading, so a
    // section holding nothing but one holds no content.
    expect(isHeading("#")).toBe(true);
    expect(isHeading("###")).toBe(true);
  });

  it("rejects what only looks like one", () => {
    expect(isHeading("####### Goal")).toBe(false); // seven `#` is not a heading in CommonMark
    expect(isHeading("#######")).toBe(false); // nor is a bare run of seven
    expect(isHeading("#Goal")).toBe(false); // no space after the marker
    expect(isHeading("    # Goal")).toBe(false); // four spaces is an indented code block
    expect(isHeading("Goal")).toBe(false);
  });

  it("uses the CommonMark parser for non-ATX headings too", () => {
    expect(isHeading("Release notes\n-------------")).toBe(true);
    expect(isHeading("\\# escaped")).toBe(false);
  });
});

describe("scanMarkdown", () => {
  it("returns one entry per line and splits on both LF and CRLF", () => {
    const lines = scanMarkdown("a\r\nb\n");
    expect(lines.map((l) => l.text)).toEqual(["a", "b", ""]);
    expect(lines.every((l) => !l.fenced && !l.delimiter)).toBe(true);
  });

  it("reads a heading's depth and its slugged comparison key", () => {
    expect(headings("## Out-of-Scope:")).toEqual([{ depth: 2, key: "outofscope" }]);
    expect(headings("#### Success Criteria")).toEqual([{ depth: 4, key: "successcriteria" }]);
    expect(headings("plain text")).toEqual([undefined]);
  });

  it("slugs a heading past an inline HTML comment, which the render still shows as a heading", () => {
    expect(headings("## Acceptance <!-- markdownlint-disable-line -->")).toEqual([
      { depth: 2, key: "acceptance" },
    ]);
    expect(headings("## Acceptance <!-- unclosed")).toEqual([{ depth: 2, key: "acceptance" }]);
  });

  it("does not open a section for a heading a comment pushes off the start of the line", () => {
    const [line] = scanMarkdown("<!-- x --> ## Not a heading");
    expect(line.heading).toBeUndefined();
    expect(line.visible).toBe(" ## Not a heading");
  });

  describe("fences", () => {
    it("flags the delimiters as punctuation and the content as literal, opening no section", () => {
      expect(scanMarkdown("```js\n## Acceptance\n```\nafter")).toEqual([
        {
          text: "```js",
          fenced: true,
          delimiter: true,
          commented: false,
          headingRest: false,
          visible: "",
          masked: "```js",
        },
        {
          text: "## Acceptance",
          fenced: true,
          delimiter: false,
          commented: false,
          headingRest: false,
          visible: "## Acceptance",
          masked: "## Acceptance",
        },
        {
          text: "```",
          fenced: true,
          delimiter: true,
          commented: false,
          headingRest: false,
          visible: "",
          masked: "```",
        },
        {
          text: "after",
          fenced: false,
          delimiter: false,
          commented: false,
          headingRest: false,
          visible: "after",
          masked: "after",
          heading: undefined,
        },
      ]);
    });

    it("keeps an HTML comment inside a fence as content, not markup", () => {
      const lines = scanMarkdown("```\n<!-- not a comment\n```\n## Real");
      expect(lines[1].visible).toBe("<!-- not a comment");
      // The unclosed `<!--` never entered comment state, so the heading after the fence survives.
      expect(lines[3].heading).toEqual({ depth: 2, key: "real" });
    });

    it("closes only on a matching delimiter: same char, at least as long, nothing after it", () => {
      const lines = scanMarkdown("````\n```\n## in\n````\nout");
      expect(lines.map((l) => l.delimiter)).toEqual([true, false, false, true, false]);
      expect(lines[1].fenced).toBe(true); // a shorter run of the same char is content
      expect(lines[2].heading).toBeUndefined();
      expect(lines[4].fenced).toBe(false);

      // An info string on the candidate closer means it is not a closer.
      expect(scanMarkdown("```\n``` js\nx\n```").map((l) => l.fenced)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      // A tilde fence is not closed by backticks.
      expect(scanMarkdown("~~~\n```\n~~~").map((l) => l.delimiter)).toEqual([true, false, true]);
    });

    it("does not open a backtick fence whose info string contains a backtick", () => {
      const lines = scanMarkdown("``` `bad`\n## Real");
      expect(lines[0]).toMatchObject({ fenced: false, delimiter: false });
      expect(lines[1].heading).toEqual({ depth: 2, key: "real" });
    });

    it("lets an unclosed fence run to the end, so the contract fails closed", () => {
      const lines = scanMarkdown("````\n## Hidden\nstill");
      expect(lines.map((l) => l.fenced)).toEqual([true, true, true]);
      expect(lines[1].heading).toBeUndefined();
    });

    it("allows up to three spaces of indent on a fence", () => {
      expect(scanMarkdown("   ```\nin\n   ```").map((l) => l.delimiter)).toEqual([
        true,
        false,
        true,
      ]);
    });

    it("drops a closing delimiter with trailing whitespace", () => {
      // Closing fences permit trailing spaces. The AST position includes them, so the scanner must
      // locate the delimiter independently rather than slice back from the final source column.
      expect(rendered("```\n```   ")).toEqual([]);
    });
  });

  describe("HTML comments", () => {
    it("strips every comment on a line, keeping the text around them", () => {
      expect(visible("a <!-- x --> b <!-- y --> c")).toEqual(["a  b  c"]);
    });

    it("hides a multi-line comment's body and opens no section inside it", () => {
      const lines = scanMarkdown("<!-- a\n## hidden\n--> tail\n## Real");
      expect(lines.map((l) => l.visible)).toEqual(["", "", " tail", "## Real"]);
      // The line closing the comment cannot open a section — the `-->` occupies the line's start.
      expect(lines.map((l) => l.heading)).toEqual([
        undefined,
        undefined,
        undefined,
        { depth: 2, key: "real" },
      ]);
    });

    it("lets an unclosed comment swallow the rest of the body", () => {
      expect(visible("text <!-- x\n## Hidden")).toEqual(["text ", ""]);
      expect(headings("text <!-- x\n## Hidden")).toEqual([undefined, undefined]);
    });

    it("reads a comment opener inside an inline code span as literal text, not a comment", () => {
      // CommonMark parses no HTML inside a code span, so `<!--` there opens nothing — the heading
      // after it stays visible, and a real comment later on the line is still stripped.
      expect(visible("a `<!--` b <!-- x --> c")).toEqual(["a `<!--` b  c"]);
      expect(visible("see `<!--`\n## Real")).toEqual(["see `<!--`", "## Real"]);
      expect(headings("see `<!--`\n## Real")).toEqual([undefined, { depth: 2, key: "real" }]);
    });

    it("flags the lines that BEGIN inside a comment — the opener's own line is not one of them", () => {
      const commented = (source: string) => scanMarkdown(source).map((l) => l.commented);
      expect(commented("a <!-- x\n## hidden\n--> tail\nafter")).toEqual([false, true, true, false]);
      // Closed and reopened on one line: the next line begins inside the second comment.
      expect(commented("<!--\n--> <!--\nstill")).toEqual([false, true, true]);
      // A `<!--` inside a fence opens nothing, so nothing after it is flagged.
      expect(commented("```\n<!--\n```\nafter")).toEqual([false, false, false, false]);
      expect(commented("<!-- x -->\nafter")).toEqual([false, false]);
    });

    // What a caller that REWRITES a line reads: the comment is gone as content, but every byte of
    // the line is still where the source put it, so an offset into `masked` is an offset into it.
    it("blanks a commented span to spaces, keeping the line's own offsets", () => {
      const source = "a <!-- x --> b <!-- y --> c";
      const [line] = scanMarkdown(source);
      expect(line!.masked).toBe("a            b            c");
      expect(line!.masked.length).toBe(source.length);
      expect(line!.masked.indexOf("b")).toBe(source.indexOf("b"));
    });

    it("blanks a multi-line comment on every line it covers, and an unclosed one to the end", () => {
      const masked = (source: string) => scanMarkdown(source).map((l) => l.masked);
      expect(masked("<!-- a\n## hidden\n--> tail")).toEqual(["      ", "         ", "    tail"]);
      expect(masked("text <!-- x\n## Hidden")).toEqual(["text       ", "         "]);
      // Inside a fence a `<!--` is content, so nothing there is blanked.
      expect(masked("```\n<!-- x -->\n```")).toEqual(["```", "<!-- x -->", "```"]);
    });
  });

  describe("Setext headings", () => {
    /** The heading each line opens, paired with whether it CONTINUES the one above. */
    const setext = (source: string) =>
      scanMarkdown(source).map((l) => [l.heading?.depth ?? null, l.headingRest] as const);

    it("reads an underlined label as the heading it renders, keyed on the label", () => {
      expect(headings("Acceptance Criteria\n===")).toEqual([
        { depth: 1, key: "acceptancecriteria" },
        undefined,
      ]);
      // `-` underlines an h2, and any run of either mark does it — `=` and `-----` alike.
      expect(headings("Acceptance\n-")).toEqual([{ depth: 2, key: "acceptance" }, undefined]);
      expect(headings("Acceptance\n=====")).toEqual([{ depth: 1, key: "acceptance" }, undefined]);
    });

    it("flags every line of the run as the heading's own, the underline included", () => {
      // A multiline paragraph underlined is ONE heading: the key is the first line's, and every
      // line after it is heading text rather than body under it.
      expect(setext("Acceptance\nCriteria\n===\nbody")).toEqual([
        [1, false],
        [null, true],
        [null, true],
        [null, false],
      ]);
    });

    it("needs a paragraph above it — a bare underline is a rule or plain text", () => {
      expect(headings("---")).toEqual([undefined]);
      expect(headings("\n===")).toEqual([undefined, undefined]);
      // A `---` after a blank line closes no paragraph, so the label above stays text.
      expect(headings("Acceptance\n\n---")).toEqual([undefined, undefined, undefined]);
    });

    it("does not reach across a line that opens a block of its own", () => {
      // Each of these ends the paragraph, so the `===` below closes nothing.
      for (const between of ["- item", "> quote", "# ATX", "<div>"]) {
        expect(headings(`Acceptance\n${between}\n===`)[0]).toBeUndefined();
      }
      // A type-7 tag may NOT interrupt a paragraph, so that run really is one heading.
      expect(headings('Acceptance\n<widget x="y">\n===')[0]).toEqual({
        depth: 1,
        key: "acceptance",
      });
      // Indented code may NOT interrupt a paragraph either — it only starts a code block after a
      // blank line — so a four-space line here is paragraph continuation, and the run is one heading.
      expect(headings("Acceptance\n    code\n===")[0]).toEqual({
        depth: 1,
        key: "acceptancecode",
      });
    });

    it("does not let a non-interrupting list marker end a multiline Setext heading", () => {
      // CommonMark: an empty bullet item cannot interrupt an open paragraph, so `*` stays heading
      // text and the h1 closes Acceptance without exposing "Backend" as an authored criterion.
      expect(headings("## Acceptance\nBackend\n*\n===\n- [ ] implement it")[1]).toEqual({
        depth: 1,
        key: "backend",
      });
      // An ordered item that doesn't start at 1 cannot interrupt either, so it also stays heading
      // text rather than closing the run early.
      expect(headings("## Acceptance\nBackend\n2. API\n===\n- [ ] implement it")[1]).toEqual({
        depth: 1,
        key: "backend2api",
      });
      // A nonempty bullet, and an ordered item starting at 1, still interrupt — the heading run
      // never reaches them.
      expect(headings("Acceptance\n- item\n===")[0]).toBeUndefined();
      expect(headings("Acceptance\n1. item\n===")[0]).toBeUndefined();
    });

    it("does not mistake ordered-marker text for a stripped container when it is not nested", () => {
      // `2. ---` still can't interrupt the paragraph, so CommonMark fuses the whole run into one
      // h1 Setext heading. Nothing here is actually inside a list item, so no marker should be
      // peeled before `---` is judged — peeling it would misread it as a thematic break and drop
      // the heading, exposing "Backend"/"2. ---" as authored Acceptance criteria.
      expect(headings("## Acceptance\nBackend\n2. ---\n===\n- [ ] implement it")[1]).toEqual({
        depth: 1,
        key: "backend2",
      });
    });

    it("stops at a thematic break, which ends the paragraph before any underline reaches it", () => {
      // `***` is a rule, not paragraph text: it closes `Acceptance` and opens nothing, so the
      // `===` under it underlines no paragraph at all.
      expect(headings("Acceptance\n***\n===").every((h) => h === undefined)).toBe(true);
    });

    it("does not let a second underline reach back across a heading already made", () => {
      // `A` / `---` is an h2 and `B` / `===` an h1 — two headings, not one run. Walking back over
      // the consumed `---` would swallow the first heading into the second.
      expect(headings("A\n---\nB\n===")).toEqual([
        { depth: 2, key: "a" },
        undefined,
        { depth: 1, key: "b" },
        undefined,
      ]);
    });

    it("keeps an indented continuation line in a multiline Setext heading under a real section", () => {
      // Indented code cannot interrupt the open "Backend" paragraph, so `    API` is heading text
      // and the h1 closes Acceptance — it must not be miscounted as authored Acceptance content.
      expect(headings("## Acceptance Criteria\nBackend\n    API\n===\n- [ ] implement it")).toEqual([
        { depth: 2, key: "acceptancecriteria" },
        { depth: 1, key: "backendapi" },
        undefined,
        undefined,
        undefined,
      ]);
    });

    it("forms a Setext heading from lowercase declaration-shaped prose", () => {
      // CommonMark only gives declarations an uppercase ASCII letter. A lowercase `<!todo` remains
      // in the paragraph, whose underline forms an h1 that closes the h2 Acceptance section.
      expect(headings("## Acceptance\nBackend\n<!todo\n===\n- [ ] implement it")).toEqual([
        { depth: 2, key: "acceptance" },
        { depth: 1, key: "backend" },
        undefined,
        undefined,
        undefined,
      ]);
    });

    it("opens no heading inside a fence or an HTML comment, as the render shows none", () => {
      expect(headings("```\nAcceptance\n===\n```").every((h) => h === undefined)).toBe(true);
      expect(headings("<!--\nAcceptance\n===\n-->").every((h) => h === undefined)).toBe(true);
    });

    it("recovers no Setext heading inside a raw HTML block, which the render shows as raw text", () => {
      // The AST reads the whole script block as one html node, so no heading exists to recover —
      // synthesizing one from the source lines would pass a bead whose Acceptance never renders.
      expect(
        headings("<script>\nAcceptance Criteria\n===\n- [ ] stale\n</script>").every(
          (h) => h === undefined,
        ),
      ).toBe(true);
      // The block closed, so the underlined label after it is a real heading again.
      expect(headings("<script>\nx\n</script>\n\nAcceptance\n===")).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        { depth: 1, key: "acceptance" },
        undefined,
      ]);
    });

    it("recovers a multiline Setext heading nested in a blockquote", () => {
      // Each continuation line still carries the container's own `>` marker — that marker must not
      // read as a block starter interrupting the paragraph mdast already fused into one heading, or
      // `Backend`/`API` render as authored criteria instead of the heading they actually are.
      expect(headings("> Backend\n> API\n> ---\nSome real criterion")).toEqual([
        { depth: 2, key: "backendapi" },
        undefined,
        undefined,
        undefined,
      ]);
      expect(rendered("> Backend\n> API\n> ---\nSome real criterion")).toEqual([
        "> Backend",
        "> API",
        "> ---",
        "Some real criterion",
      ]);
      expect(renderedLines("> Backend\n> API\n> ---\nSome real criterion").map((l) => l.heading)).toEqual([
        true,
        true,
        true,
        false,
      ]);
    });
  });
});

it("flags a fence opened beside a container marker — the marker is the item's or callout's, not the fence's", () => {
  // `> ```` and `- ```` carry the container prefix on the opener's own line, so the delimiters
  // used to read as authored text and `renderedLines` exposed them — an empty fenced block inside
  // a list item or callout then counted as a written rubric with no criterion in it.
  expect(rendered("> ```\n> ```")).toEqual([]);
  expect(rendered("- ```\n- ```")).toEqual([]);
  expect(rendered("> - ```\n> - ```")).toEqual([]);
  // A non-empty container fence still files its content as literal, and its delimiters drop.
  expect(rendered("> ```\n> x\n> ```")).toEqual(["> x"]);
  expect(rendered("- ```\n  x\n  ```")).toEqual(["  x"]);
  // A fence indented one to three columns under a marker still reads as that fence.
  expect(rendered(">   ```\n> x\n> ```")).toEqual(["> x"]);
});

it("keeps trailing fence-length content in an unterminated fence", () => {
  // The AST includes the final line in an unterminated code node. A delimiter-length suffix after
  // authored content is not a closer, so the criterion must remain visible to the contract reader.
  expect(rendered("```markdown\n- [ ] expected ```")).toEqual(["- [ ] expected ```"]);
  expect(rendered("> ```markdown\n> - [ ] expected ```")).toEqual(["> - [ ] expected ```"]);
});

it("drops the delimiters of a fence nested in several containers, empty ones included", () => {
  // The closer carries every container marker (`> > ````), and stripping only the first `>` left
  // the rest to render as authored text — an Acceptance section holding a bare nested fence then
  // passed `validateBeadContract` with no criterion in it.
  expect(rendered("> > ```\n> > ```")).toEqual([]);
  expect(rendered("> > > ```\n> > > ```")).toEqual([]);
  expect(rendered("> - - ```\n> - - ```")).toEqual([]);
  // The ordered marker has five columns of continuation indentation. The AST's code column points
  // at the delimiter past it, so both delimiter lines must use that column rather than only peeling
  // markers from the closer.
  expect(rendered("123. ```\n     ```")).toEqual([]);
  expect(rendered("## Acceptance\n> > ```\n> > ```")).toEqual(["## Acceptance"]);
  // A non-empty nested fence still files its content as literal, and both delimiters drop.
  expect(rendered("> > ```\n> > x\n> > ```")).toEqual(["> > x"]);
});

it("closes a container-nested fence whose closer reaches the item's column with a tab, not spaces", () => {
  // CommonMark measures a list item's continuation by visual column, not source spelling — a tab
  // and enough spaces that land on the same column both keep a closer inside the item. Comparing
  // the closer against a fixed run of spaces (the opener's own spelling, expanded) missed a tab
  // closer at that column: the fence stayed unterminated, and its closing delimiter rendered as
  // authored content instead of dropping.
  expect(rendered("-\t```\n\tx\n\t```")).toEqual(["\tx"]);
  expect(rendered("-\t```\n\tx\n   ```")).toEqual(["\tx"]);
  expect(rendered("- ```\n\tx\n\t```")).toEqual(["\tx"]);
});

describe("renderedLines", () => {
  it("drops fence delimiters, strips comments, and keeps fenced content flagged as literal", () => {
    expect(renderedLines("# A\n<!-- c -->\n```\nx\n```\n\nend")).toEqual([
      { text: "# A", fenced: false, heading: true },
      { text: "", fenced: false, heading: false },
      { text: "x", fenced: true, heading: false },
      { text: "", fenced: false, heading: false },
      { text: "end", fenced: false, heading: false },
    ]);
  });

  it("renders a template placeholder as blank — a comment says nothing the reader can see", () => {
    expect(rendered("## Acceptance\n<!-- add criteria here -->")).toEqual(["## Acceptance", ""]);
    expect(rendered("<!-- a\nb")).toEqual(["", ""]);
  });

  it("keeps blank lines, so a body's shape survives the render", () => {
    expect(rendered("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("keeps an empty fenced block as nothing but its dropped delimiters", () => {
    expect(renderedLines("```\n```")).toEqual([]);
  });
});

describe("unterminatedCloser", () => {
  it("is undefined for a body that ends outside any construct", () => {
    expect(unterminatedCloser("## Goal\nText\n```\ncode\n```\n<!-- note -->\ntail")).toBeUndefined();
  });

  it("is the fence's own delimiter — same character, same length — for an unclosed fence", () => {
    expect(unterminatedCloser("intro\n```ts\ncode")).toBe("```");
    expect(unterminatedCloser("intro\n~~~~\ncode\n```")).toBe("~~~~");
  });

  it("is the comment closer for an unclosed HTML comment, even one spanning lines", () => {
    expect(unterminatedCloser("intro <!-- open")).toBe("-->");
    expect(unterminatedCloser("intro\n<!--\nstill hidden")).toBe("-->");
  });

  it("does not read a `<!--` inside a fence as a comment — the render treats it as content", () => {
    expect(unterminatedCloser("```\n<!-- literal\n```")).toBeUndefined();
  });

  it("does not mistake fence-looking text inside closed comments or raw HTML for a fence", () => {
    expect(unterminatedCloser("<!--\n```\n-->")).toBeUndefined();
    expect(unterminatedCloser("<script>\n```\n</script>")).toBeUndefined();
  });

  it("does not read a `<!--` inside a closed raw HTML block as a comment opener", () => {
    // `htmlBlockLines` already marks these lines as raw HTML content, hiding all Markdown
    // structure — including comment syntax. Without consulting it, this fallback scan reported
    // the block's own `<!--` as unterminated and appended a stray `-->` after the closing tag.
    expect(unterminatedCloser("<script>\n<!--\n</script>")).toBeUndefined();
    expect(unterminatedCloser("<pre>\n<!--\n</pre>")).toBeUndefined();
  });

  it("is the closing tag of a persistent HTML block the body ends inside", () => {
    // These blocks end at their own closing text, not at a blank line, so anything appended after
    // one lands inside it — hidden in every renderer while this scanner still read the heading,
    // reporting a section the founder could not see.
    expect(unterminatedCloser("## Goal\ng\n\n<script>\nvar x = 1;")).toBe("</script>");
    expect(unterminatedCloser("<pre>\ncode")).toBe("</pre>");
    expect(unterminatedCloser("<STYLE>\n.a{}")).toBe("</style>");
    expect(unterminatedCloser("<textarea>\nx")).toBe("</textarea>");
    expect(unterminatedCloser("<?php\nx")).toBe("?>");
    expect(unterminatedCloser("<![CDATA[\nx")).toBe("]]>");
    expect(unterminatedCloser("<!DOCTYPE html")).toBe(">");
  });

  it("is undefined once the HTML block closes, on its own line or the opener's", () => {
    expect(unterminatedCloser("<script>\nvar x = 1;\n</script>")).toBeUndefined();
    expect(unterminatedCloser("<script>alert(1)</script>")).toBeUndefined();
    expect(unterminatedCloser("<!DOCTYPE html>")).toBeUndefined();
  });

  it("closes the construct inside the container that opened it", () => {
    // This scanner reads fences flat, so a fence indented into a list item is recorded as an
    // ordinary one. An unindented closer does not close it: CommonMark uses the dedent to leave the
    // ITEM first — which ends the fence with it — and then reads the delimiter as a new top-level
    // opener that swallows everything appended below, while this scanner still reported it closed.
    expect(unterminatedCloser("- example\n  ```\n  old")).toBe("  ```");
    expect(unterminatedCloser("- example\n  <!--\n  old")).toBe("  -->");
    expect(unterminatedCloser("- example\n  <script>\n  old")).toBe("  </script>");
    // A block can open on the CONTAINER's own line, where the raw text hides the tag behind the
    // marker: `- <script>` starts the block inside the item, and reading the line unpeeled found no
    // opener at all — so the heading under it was reported written while the render hid it as raw
    // HTML, and the appended section landed inside a block nobody closed.
    expect(unterminatedCloser("- <script>\n  ## Acceptance Criteria")).toBe("  </script>");
    expect(unterminatedCloser("> <script>\n> ## Acceptance Criteria")).toBe("> </script>");
    expect(unterminatedCloser("1. <pre>\n   code")).toBe("   </pre>");
    // The innermost open construct is the one whose indentation is carried.
    expect(unterminatedCloser("  ```\nold\n  ```\n- item\n  ~~~\nmore")).toBe("  ~~~");
    // A construct opened at the top level still closes there.
    expect(unterminatedCloser("intro\n```ts\ncode")).toBe("```");
    // A tab after the marker is VISUAL indentation: CommonMark expands it to the next
    // four-column stop, so `-\t` puts the item's content at column 4. Two source characters
    // measured as two spaces placed the closer outside the item — leaving the item had already
    // ended the fence, so the delimiter opened a new top-level one and swallowed the append.
    expect(unterminatedCloser("-\t```md\n    some content")).toBe("    ```");
    expect(unterminatedCloser("-\t```md\n\tcontent")).toBe("    ```");
    expect(unterminatedCloser("1.\t```\n    code")).toBe("    ```");
    // A blockquote nested inside a list item must keep the list's indentation in front of the `>`:
    // dropping it left a bare `> ` closer, which leaves the list (already closed by the fence) and
    // opens a new top-level quoted fence that swallows everything appended after it.
    expect(unterminatedCloser("- > ```md\n  > sample")).toBe("  > ```");
    // A closer at a wide list item's own indentation (5 columns, from a two-digit ordinal marker)
    // still terminates the fence — the AST reports the code node ending at EOF just because it is
    // the document's last content, but the raw final line's container-relative spelling already
    // closes it, so no synthetic closer should be appended.
    expect(unterminatedCloser("123. ```\n     sample\n     ```")).toBeUndefined();
  });

  it("does not let a closed fence's own content reopen it as a synthetic closer", () => {
    // The AST already closed this backtick fence; its literal `~~~` content line is not a
    // delimiter. Scanning it as one anyway replaced the tracked backtick opener with that tilde
    // run, so the real backtick closer below then read as a fresh opener — reporting a spurious
    // unterminated fence for a construct that was already closed.
    expect(unterminatedCloser("## Acceptance\n```\nfirst\n~~~\nsecond\n```\ntrailing prose")).toBeUndefined();
    // A genuinely unterminated fence past a closed one — whose own content also looks fenced —
    // must still be found.
    expect(unterminatedCloser("```\nfirst\n~~~\nsecond\n```\n- item\n  ~~~\nopen")).toBe("  ~~~");
  });

  it("opens no HTML block from a tag the render never shows or reads as text", () => {
    // Inside a fence or a comment the tag is content, not markup.
    expect(unterminatedCloser("```\n<script>\n```")).toBeUndefined();
    expect(unterminatedCloser("<!-- <script> -->")).toBeUndefined();
    // A blank line ends conditions 6 and 7, so a section appended below one is read as written.
    expect(unterminatedCloser("<div>\nx")).toBeUndefined();
    expect(unterminatedCloser('<span x="y">')).toBeUndefined();
    // A tag opened MID-line is inline HTML, which starts no block at all.
    expect(unterminatedCloser("see <script> in the note")).toBeUndefined();
    // HTML declarations require an uppercase ASCII letter. A lowercase declaration-shaped line is
    // prose, so it cannot swallow a section appended below it.
    expect(unterminatedCloser("<!todo\n## Acceptance")).toBeUndefined();
  });

  it("parses quoted attributes in a type-7 tag", () => {
    expect(htmlBlockLines('<widget title="a > b">\n## Acceptance Criteria')).toEqual([true, true]);
    expect(unterminatedCloser('<widget title="a > b">\n## Acceptance Criteria')).toBeUndefined();
  });

  it("does not let a type-7 tag interrupt a paragraph", () => {
    expect(htmlBlockLines('intro\n<widget>\n## Acceptance Criteria')).toEqual([false, false, false]);
  });

  it("lets a list item interrupt the paragraph before a type-7 tag", () => {
    // The list marker ends `intro`'s paragraph. Its widget is therefore a blank-terminated raw
    // HTML block, and the indented heading is hidden rather than a visible Acceptance heading.
    expect(htmlBlockLines("intro\n- <widget>\n  ## Acceptance Criteria")).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("recognizes a type-7 tag after non-paragraph blocks", () => {
    expect(htmlBlockLines('---\n<widget>\n## Acceptance Criteria')).toEqual([false, true, true]);
    expect(htmlBlockLines('-\n<widget>\n## Acceptance Criteria')).toEqual([false, true, true]);
    expect(htmlBlockLines('    code\n<widget>\n## Acceptance Criteria')).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe("htmlBlockLines", () => {
  it("marks every line a persistent HTML block holds, the opener included", () => {
    // A heading inside one renders as raw script text, or as nothing at all, while the scanner —
    // which models no HTML block — reports it as a section. A caller deciding whether a section is
    // THERE must not count it.
    expect(htmlBlockLines("## Goal\ng\n\n<script>\n## Acceptance Criteria\n- [ ] old")).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(htmlBlockLines("<script>\nx\n</script>\n\n## Acceptance")).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    // A block that opens and closes on one line holds only that line.
    expect(htmlBlockLines("<script>alert(1)</script>\n## Acceptance")).toEqual([true, false]);
  });

  it("marks a block opened behind a list or blockquote marker", () => {
    // CommonMark opens the item's content on the marker's own line, so `- <script>` starts the
    // block INSIDE the item. Testing the raw line missed the opener, so the indented heading read
    // as a written section while every renderer hid it — and reconciliation replaced boxes nobody
    // could see instead of appending a section that renders.
    expect(htmlBlockLines("- <script>\n  ## Acceptance Criteria\n  - [ ] stale")).toEqual([
      true,
      true,
      true,
    ]);
    // A blank is allowed inside the item, so it does not close the persistent block before the
    // indented Acceptance-looking heading or its explicit closer.
    expect(htmlBlockLines("- <script>\n  raw\n\n  ## Acceptance Criteria\n  - [ ] stale\n  </script>")).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(htmlBlockLines("> <script>\n> ## Acceptance Criteria")).toEqual([true, true]);
    // A persistent block ends with the container that holds it. The unquoted heading is visible;
    // carrying the HTML state across the quote boundary hid it and caused reconciliation to append
    // a duplicate Acceptance section.
    expect(htmlBlockLines("> <script>\n> raw\n## Acceptance Criteria\n- [ ] stale")).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // A type-6 block's content is raw HTML until its blank terminator, even inside a list.
    expect(htmlBlockLines("- <div>\n  x\n\n## Acceptance")).toEqual([true, true, false, false]);
    expect(htmlBlockLines("- see <script> in the note\n## Acceptance")).toEqual([false, false]);
  });

  it("opens no block where the render reads the tag as content or ends it at a blank line", () => {
    expect(htmlBlockLines("```\n<script>\n```\n## Acceptance")).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(htmlBlockLines("<!-- <script> -->\n## Acceptance")).toEqual([false, false]);
    // Condition 6 hides its nonblank content, then the blank ends it and the heading below is text.
    expect(htmlBlockLines("<div>\nx\n\n## Acceptance")).toEqual([true, true, false, false]);
    expect(htmlBlockLines("see <script> in the note\n## Acceptance")).toEqual([false, false]);
  });

  it("starts no block inside one that ends at a blank line", () => {
    // `<script>` is raw content of the `<div>` block, which the blank line ends — so the heading
    // below renders, and nothing after it is hidden by a `</script>` nobody wrote.
    expect(htmlBlockLines("<div>\n<script>\n\n## Acceptance Criteria\n- [ ] stale")).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(unterminatedCloser("<div>\n<script>\n\n## Acceptance Criteria")).toBeUndefined();
    // Past the blank line the block is over, so a persistent opener there is its own block again.
    expect(htmlBlockLines("<div>\nx\n\n<script>\n## Acceptance")).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it("recognizes a complete custom tag at a block boundary", () => {
    // A condition-7 HTML block is raw through its next blank line. Its heading is not a rendered
    // Acceptance heading and reconciliation must append a visible one instead of replacing it.
    expect(htmlBlockLines("<widget>\n## Acceptance Criteria\n- [ ] stale\n")).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Condition 7 cannot interrupt a paragraph, so this remains ordinary prose.
    expect(htmlBlockLines("An explanation\n<widget>\n## Acceptance Criteria")).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("ends a persistent block when its list container ends", () => {
    expect(htmlBlockLines("- <script>\n  raw\n## Acceptance Criteria\n- [ ] stale")).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("ends a blank-terminated block when its list container ends", () => {
    // The dedented heading is no longer part of the list's raw HTML block. It must be scanned as
    // normal Markdown, so a later persistent opener is not incorrectly ignored either.
    expect(htmlBlockLines("- <div>\n  raw\n<script>\n## Acceptance Criteria")).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("unquote", () => {
  it("strips blockquote markers, nesting included", () => {
    expect(unquote("> TODO — fill this in")).toBe("TODO — fill this in");
    expect(unquote(">TODO")).toBe("TODO");
    expect(unquote("> > nested")).toBe("nested");
    expect(unquote(">>nested")).toBe("nested");
    expect(unquote(">\ttabbed")).toBe("tabbed");
    expect(unquote("   > indented")).toBe("indented");
    expect(unquote(">")).toBe("");
  });

  it("leaves text that carries no marker alone", () => {
    expect(unquote("plain")).toBe("plain");
    expect(unquote("    > four spaces is code, not a callout")).toBe(
      "    > four spaces is code, not a callout",
    );
    expect(unquote("")).toBe("");
  });

  it("takes only the marker, not the spacing the content keeps", () => {
    expect(unquote(">   padded")).toBe("  padded");
  });
});
