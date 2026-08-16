import { describe, expect, it } from "vitest";
import { isHeading, renderedLines, scanMarkdown, unquote } from "./markdown";

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
  });

  it("rejects what only looks like one", () => {
    expect(isHeading("####### Goal")).toBe(false); // seven `#` is not a heading in CommonMark
    expect(isHeading("#Goal")).toBe(false); // no space after the marker
    expect(isHeading("    # Goal")).toBe(false); // four spaces is an indented code block
    expect(isHeading("#")).toBe(false);
    expect(isHeading("Goal")).toBe(false);
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
        { text: "```js", fenced: true, delimiter: true, visible: "" },
        { text: "## Acceptance", fenced: true, delimiter: false, visible: "## Acceptance" },
        { text: "```", fenced: true, delimiter: true, visible: "" },
        { text: "after", fenced: false, delimiter: false, visible: "after", heading: undefined },
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
  });
});

describe("renderedLines", () => {
  it("drops fence delimiters, strips comments, and keeps fenced content flagged as literal", () => {
    expect(renderedLines("# A\n<!-- c -->\n```\nx\n```\n\nend")).toEqual([
      { text: "# A", fenced: false },
      { text: "", fenced: false },
      { text: "x", fenced: true },
      { text: "", fenced: false },
      { text: "end", fenced: false },
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
