import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeOutcomeIds,
  outcomesConfigured,
  parseOutcomes,
  projectOutcomesConfigured,
  readProjectOutcomes,
} from "./outcomes";

describe("parseOutcomes", () => {
  it("parses `id` — summary bullets under ## Outcomes", () => {
    const markdown = [
      "# PRODUCT",
      "",
      "## Outcomes",
      "- `no-touch-delivery` — Approved epics reach a merge-ready PR untouched.",
      "- `trustworthy-board` — Stage is always derived live from beads.",
      "",
      "## Stack",
      "Next.js.",
    ].join("\n");

    const outcomes = parseOutcomes(markdown);

    expect(outcomes).toEqual([
      expect.objectContaining({ id: "codebase-health", retired: false }),
      { id: "no-touch-delivery", summary: "Approved epics reach a merge-ready PR untouched.", retired: false },
      { id: "trustworthy-board", summary: "Stage is always derived live from beads.", retired: false },
    ]);
  });

  it("stops the section at the next heading of any level", () => {
    const markdown = ["## Outcomes", "- `a` — first", "# Not part of it", "- `b` — second"].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "a"]);
  });

  it("stops the section at a Setext heading, not just an ATX one", () => {
    const markdown = [
      "## Outcomes",
      "- `a` — first",
      "Other settings",
      "-----",
      "- `b` — second",
    ].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "a"]);
  });

  it("always includes the built-in codebase-health outcome even when the file omits it", () => {
    const markdown = ["## Outcomes", "- `oriented-operator` — Every run target says why it exists."].join("\n");

    const outcomes = parseOutcomes(markdown);

    expect(outcomes.find((o) => o.id === "codebase-health")).toEqual({
      id: "codebase-health",
      summary: expect.any(String),
      retired: false,
    });
  });

  it("returns only the built-in outcome when the section is missing, and never throws", () => {
    const markdown = "# PRODUCT\n\nNo outcomes here.\n";

    expect(parseOutcomes(markdown)).toEqual([expect.objectContaining({ id: "codebase-health" })]);
    expect(() => parseOutcomes("")).not.toThrow();
    expect(parseOutcomes("").map((o) => o.id)).toEqual(["codebase-health"]);
  });

  it("marks a bullet retired and strips the marker from the summary", () => {
    const markdown = ["## Outcomes", "- `old-outcome` — No longer tracked (retired)."].join("\n");

    const outcome = parseOutcomes(markdown).find((o) => o.id === "old-outcome");

    expect(outcome).toEqual({ id: "old-outcome", summary: "No longer tracked", retired: true });
  });

  it("is case-insensitive on the retired marker", () => {
    const markdown = ["## Outcomes", "- `old` — done (Retired)"].join("\n");

    expect(parseOutcomes(markdown).find((o) => o.id === "old")).toEqual({
      id: "old",
      summary: "done",
      retired: true,
    });
  });

  it("skips malformed bullets rather than throwing", () => {
    const markdown = [
      "## Outcomes",
      "- missing backticks and dash",
      "- `no-em-dash` - uses a hyphen instead of an em dash",
      "- `empty-summary` — ",
      "not a bullet at all",
      "- `valid` — This one parses.",
    ].join("\n");

    expect(parseOutcomes(markdown)).toEqual([
      expect.objectContaining({ id: "codebase-health" }),
      { id: "valid", summary: "This one parses.", retired: false },
    ]);
  });

  it("skips an id that can't survive as an outcome:<id> label", () => {
    const markdown = [
      "## Outcomes",
      "- `release readiness` — a space can't appear in a label suffix.",
      "- `-leading-dash` — a leading dash isn't label-safe either.",
      "- `valid-id` — This one is label-safe.",
    ].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "valid-id"]);
  });

  it("does not parse an example bullet embedded inside a multi-line HTML comment", () => {
    const markdown = [
      "## Outcomes",
      "<!-- Stable ids a run target can point at.",
      "",
      "     Add one bullet per outcome, in that exact form, e.g.:",
      "     - `reports-are-shareable` — Every report leaves the app in a format a customer can open.",
      "",
      "     Left empty (as scaffolded), no outcome id is offered. -->",
    ].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health"]);
  });

  // PR #334 review: a genuine `## Outcomes` section may still contain a fenced example bullet
  // (inside a ```` ``` ```` block, not an HTML comment) — it must render as code, not be offered
  // as a real outcome, the same guarantee the HTML-comment case above already covers.
  it("skips a fenced bullet rather than parsing it as a real outcome", () => {
    const markdown = [
      "## Outcomes",
      "Add one bullet per outcome, in that exact form, e.g.:",
      "```",
      "- `example-id` — Example summary",
      "```",
      "- `real-id` — This one is outside the fence.",
    ].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "real-id"]);
  });

  // PR #334 review: a PRODUCT.md with `## Outcomes` declared twice (e.g. after a merge) used to
  // only ever read the first occurrence, silently dropping ids declared solely in a later one.
  it("collects bullets from every ## Outcomes occurrence, not just the first", () => {
    const markdown = [
      "## Outcomes",
      "- `first` — Declared in the first section.",
      "## Stack",
      "Next.js.",
      "## Outcomes",
      "- `second` — Declared again later.",
    ].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "first", "second"]);
  });

  it("lets a later bullet override the built-in codebase-health entry", () => {
    const markdown = ["## Outcomes", "- `codebase-health` — Custom summary for this project."].join("\n");

    expect(parseOutcomes(markdown)).toEqual([
      { id: "codebase-health", summary: "Custom summary for this project.", retired: false },
    ]);
  });
});

describe("outcomesConfigured", () => {
  it("is false when the file has no ## Outcomes section — a project predating this feature", () => {
    expect(outcomesConfigured("")).toBe(false);
    expect(outcomesConfigured("# PRODUCT\n\nNo outcomes here.\n")).toBe(false);
  });

  // A `## Outcomes` section on its own decides nothing — a freshly scaffolded project has the
  // heading (skills/setup/templates/.product/PRODUCT.md) with nothing real under it yet, and that
  // must gate exactly like no section at all, not like a closed set of zero outcomes.
  it("is still false when the section exists but carries no real outcome — empty, or only unparseable content", () => {
    expect(outcomesConfigured("## Outcomes\n")).toBe(false);
    expect(
      outcomesConfigured(["## Outcomes", "<!-- fill this in with your own outcomes -->"].join("\n")),
    ).toBe(false);
  });

  it("is still false when the only bullet overrides the built-in codebase-health entry", () => {
    expect(
      outcomesConfigured(["## Outcomes", "- `codebase-health` — Custom summary."].join("\n")),
    ).toBe(false);
  });

  it("is true once a real, non-built-in outcome bullet parses", () => {
    expect(outcomesConfigured(["## Outcomes", "- `a` — first"].join("\n"))).toBe(true);
  });
});

describe("activeOutcomeIds", () => {
  it("keeps non-retired ids and drops ones marked retired", () => {
    const outcomes = parseOutcomes(
      ["## Outcomes", "- `live` — Still offered.", "- `dead` — Gone (retired)."].join("\n"),
    );
    expect(activeOutcomeIds(outcomes)).toEqual(new Set(["codebase-health", "live"]));
  });
});

describe("readProjectOutcomes", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "anton-outcomes-"));
    temps.push(repoPath);
    return repoPath;
  }

  it("reads .product/PRODUCT.md's ## Outcomes relative to the repo root", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".product"), { recursive: true });
    writeFileSync(
      join(repo, ".product", "PRODUCT.md"),
      "## Outcomes\n\n- `reports-are-shareable` — Every report leaves the app.\n",
    );

    const outcomes = await readProjectOutcomes(repo);
    expect(outcomes.map((o) => o.id)).toEqual(["codebase-health", "reports-are-shareable"]);
  });

  it("resolves to just the built-in outcome when PRODUCT.md is absent, never throwing", async () => {
    const outcomes = await readProjectOutcomes(tempRepo());
    expect(outcomes.map((o) => o.id)).toEqual(["codebase-health"]);
  });
});

describe("projectOutcomesConfigured", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "anton-outcomes-configured-"));
    temps.push(repoPath);
    return repoPath;
  }

  it("is false when PRODUCT.md is absent", async () => {
    expect(await projectOutcomesConfigured(tempRepo())).toBe(false);
  });

  it("is false when PRODUCT.md exists but has no ## Outcomes section — an upgraded project", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".product"), { recursive: true });
    writeFileSync(join(repo, ".product", "PRODUCT.md"), "# PRODUCT\n\nNo outcomes section yet.\n");
    expect(await projectOutcomesConfigured(repo)).toBe(false);
  });

  // A freshly `/setup`-scaffolded project has the section (skills/setup/templates/.product/PRODUCT.md)
  // but nothing real under it until the founder fills it in — same gap as no section at all.
  it("is false when PRODUCT.md's ## Outcomes section is still just the bundled placeholder", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".product"), { recursive: true });
    writeFileSync(
      join(repo, ".product", "PRODUCT.md"),
      "## Outcomes\n\n<!-- fill this in with your own outcomes -->\n",
    );
    expect(await projectOutcomesConfigured(repo)).toBe(false);
  });

  it("is true once PRODUCT.md declares ## Outcomes", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".product"), { recursive: true });
    writeFileSync(
      join(repo, ".product", "PRODUCT.md"),
      "## Outcomes\n\n- `reports-are-shareable` — Every report leaves the app.\n",
    );
    expect(await projectOutcomesConfigured(repo)).toBe(true);
  });

  // Regression guard for the actual bundled scaffold: its `## Outcomes` comment includes a
  // worked example bullet (`- \`reports-are-shareable\` — ...`) that must stay unparseable, or a
  // freshly `/setup`-scaffolded, unedited project reads as already having a real outcome.
  it("is false for the unedited bundled skills/setup/templates/.product/PRODUCT.md scaffold", () => {
    const templatePath = join(
      import.meta.dirname,
      "..",
      "..",
      "skills",
      "setup",
      "templates",
      ".product",
      "PRODUCT.md",
    );
    const markdown = readFileSync(templatePath, "utf8");
    expect(outcomesConfigured(markdown)).toBe(false);
  });
});
