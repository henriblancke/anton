/**
 * Unit tests for the type-only coupling filter (anton-t9kf), against fixture trees on disk: the
 * import graph every drop is proven on, and the two judges that weigh one signal against it.
 *
 * The seam these run under is covered end-to-end in stringer.test.ts. What is checked here is the
 * half that decides whether an architecture finding survives — and, above all, the conservative
 * side of it: every path where anton CANNOT prove an edge is erased has to keep the signal, so a
 * regression that starts deleting real cycles fails here rather than silently in a nightly scan.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScanSignal } from "./scan-severity";
import {
  filterCouplingSignals,
  importGraph,
  judgeCycle,
  judgeFanOut,
  readAliases,
  type Graph,
} from "./scan-coupling";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-coupling-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A source tree — no git, since nothing here is a claim about the index. */
function writeRepo(files: Record<string, string>): string {
  const repo = join(dir, "repo");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body, "utf8");
  }
  return repo;
}

/** A graph over a fresh fixture tree, with the tree's own tsconfig aliases. */
async function graphOf(files: Record<string, string>): Promise<Graph> {
  const repo = writeRepo(files);
  return importGraph(repo, await readAliases(repo));
}

/** stringer's own phrasing: the component's members, alphabetical, and its size in the body. */
function cycle(modules: string[], size = modules.length): ScanSignal {
  return {
    Source: "coupling",
    Kind: "circular-dependency",
    FilePath: modules[0],
    Title: `Circular dependency: ${[...modules, modules[0]].join(" → ")}`,
    Description: `Strongly connected component with ${size} modules forming a dependency cycle.`,
  };
}

function fanOut(path: string, imports: number, threshold = 10): ScanSignal {
  return {
    Source: "coupling",
    Kind: "high-coupling",
    FilePath: path,
    Title: `High coupling: ${path} imports ${imports} modules`,
    Description:
      `Module "${path}" has ${imports} direct dependencies, which is above the threshold of ` +
      `${threshold}.`,
  };
}

describe("importGraph", () => {
  it("resolves relative specifiers, index modules and `.js` spellings onto files on disk", async () => {
    const graph = await graphOf({
      "src/a.ts": [
        `import { b } from "./b";`,
        `import { c } from "./c";`, // src/c/index.ts
        `import { d } from "./nested/d.js";`, // ESM spelling of d.ts
        `import { z } from "zod";`, // an npm package: not a module in this repo
        ``,
      ].join("\n"),
      "src/b.ts": `export const b = 1;\n`,
      "src/c/index.ts": `export const c = 2;\n`,
      "src/nested/d.ts": `export const d = 3;\n`,
    });

    expect(await graph.edgesOf("src/a.ts")).toEqual([
      { file: "src/b.ts", typeOnly: false, relative: true },
      { file: "src/c/index.ts", typeOnly: false, relative: true },
      { file: "src/nested/d.ts", typeOnly: false, relative: true },
    ]);
  });

  it("resolves a module name the way stringer spells it, without an extension", async () => {
    const graph = await graphOf({ "src/a.ts": `export const a = 1;\n`, "src/b/index.ts": `\n` });

    expect(await graph.resolveModule("src/a")).toBe("src/a.ts");
    expect(await graph.resolveModule("src/b")).toBe("src/b/index.ts");
    expect(await graph.resolveModule("internal/api")).toBeUndefined(); // another language's module
  });

  it("resolves alias imports through the repo's own tsconfig paths", async () => {
    const graph = await graphOf({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/a.ts": `import { b } from "@/b";\nexport const a = () => b();\n`,
      "src/b.ts": `export const b = () => 1;\n`,
    });

    // `relative: false` is the whole point: stringer never counted this edge, so nothing may be
    // subtracted for it — but it still proves a runtime dependency for the cycle walk.
    expect(await graph.edgesOf("src/a.ts")).toEqual([
      { file: "src/b.ts", typeOnly: false, relative: false },
    ]);
  });

  it("separates erased edges from the runtime ones", async () => {
    const graph = await graphOf({
      "src/a.ts": [
        `import type { T } from "./t";`,
        `import { type U } from "./u";`,
        `export type { V } from "./v";`,
        `import W, { type X } from "./w";`, // the default binding outranks the inline `type`
        `import { y } from "./y";`,
        `export const a: T | U | X = W ?? y;`,
        ``,
      ].join("\n"),
      ...Object.fromEntries(
        ["t", "u", "v", "w", "y"].map((name) => [`src/${name}.ts`, `export const ${name} = 1;\n`]),
      ),
    });

    expect(await graph.valueTargetsOf("src/a.ts")).toEqual(new Set(["src/w.ts", "src/y.ts"]));
    expect((await graph.edgesOf("src/a.ts"))?.filter((edge) => edge.typeOnly)).toHaveLength(3);
  });

  it("counts side-effect and dynamic imports as runtime edges", async () => {
    const graph = await graphOf({
      "src/a.ts": [
        `import "./register";`,
        `export const load = () => import("./lazy");`,
        `export const legacy = () => require("./old");`,
        ``,
      ].join("\n"),
      "src/register.ts": `export {};\n`,
      "src/lazy.ts": `export const lazy = 1;\n`,
      "src/old.ts": `module.exports = 1;\n`,
    });

    expect(await graph.valueTargetsOf("src/a.ts")).toEqual(
      new Set(["src/register.ts", "src/lazy.ts", "src/old.ts"]),
    );
  });

  it("never resolves a specifier that climbs out of the repo", async () => {
    const graph = await graphOf({ "src/a.ts": `import { secret } from "../../outside";\n` });
    // The escaping target exists — the specifier is refused for where it points, not for missing.
    writeFileSync(join(dir, "outside.ts"), `export const secret = 1;\n`, "utf8");

    expect(await graph.edgesOf("src/a.ts")).toEqual([]);
  });

  it("reads each file once, so a module named by two signals is not re-parsed", async () => {
    const repo = writeRepo({
      "src/a.ts": `import { b } from "./b";\n`,
      "src/b.ts": `export const b = 1;\n`,
    });
    const graph = importGraph(repo, []);

    const first = await graph.edgesOf("src/a.ts");
    writeFileSync(join(repo, "src/a.ts"), `import { c } from "./c";\n`, "utf8");

    expect(await graph.edgesOf("src/a.ts")).toBe(first);
  });

  it("stops resolving once the pass spends its parse budget, rather than reporting no edges", async () => {
    const graph = await graphOf({ "src/a.ts": `import { b } from "./b";\n` });

    // Absent files still cost a read; 500 of them is the whole budget for one filter pass.
    for (let i = 0; i < 500; i += 1) expect(await graph.edgesOf(`src/gone${i}.ts`)).toEqual([]);

    // `undefined` is "not proven", which every judge reads as keep — not "this module imports
    // nothing", which would drop the signal it was asked about.
    expect(await graph.edgesOf("src/a.ts")).toBeUndefined();
    expect(await graph.valueTargetsOf("src/a.ts")).toBeUndefined();
  });
});

describe("readAliases", () => {
  // tsconfig.json is JSONC — `tsc --init` writes one full of `//` comments, and a trailing comma is
  // legal in it. Read with plain `JSON.parse` such a config publishes no mapping at all, and the
  // specifier falls back to its path tail, which binds an unrelated package's same-named module.
  it("reads a tsconfig written as JSONC — comments, block comments and a trailing comma", async () => {
    const repo = writeRepo({
      "tsconfig.json": [
        "{",
        "  // The app's own sources.",
        "  /* baseUrl is what the targets below are relative to. */",
        '  "note": "a // b, c",',
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": { "@/*": ["./src/*"] },',
        "  },",
        "}",
        "",
      ].join("\n"),
    });

    // `note` also proves strings are copied through untouched: a `//` and a `,`-before-`}` inside
    // one, eaten as syntax, would leave a document `JSON.parse` rejects and no rules at all.
    expect(await readAliases(repo)).toEqual([{ prefix: "@/", targets: ["src"] }]);
  });

  // `extends` comes off unvalidated JSON, so a config spelling it as anything but a string reaches
  // the resolver as-is. Before, `null.startsWith` threw a TypeError out through `filterCouplingSignals`
  // and failed the whole nightly pass over one malformed config.
  it("ignores an `extends` value that is not a string instead of throwing", async () => {
    const repo = writeRepo({
      "tsconfig.json": JSON.stringify({ extends: null, compilerOptions: { baseUrl: "." } }),
    });

    await expect(readAliases(repo)).resolves.toEqual([]);
  });

  // ...and one bad entry does not cost the chain the base that IS readable.
  it("follows the string entries of an `extends` array past a malformed one", async () => {
    const repo = writeRepo({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      // An `extends` array is read last-first, so the malformed entry is reached FIRST here.
      "tsconfig.json": JSON.stringify({ extends: ["./tsconfig.base.json", null] }),
    });

    expect(await readAliases(repo)).toEqual([{ prefix: "@/", targets: ["src"] }]);
  });
});

describe("judgeCycle", () => {
  /** Two modules that only reference each other's types — the phantom this filter exists for. */
  const typePair = {
    "src/a.ts": `import type { B } from "./b";\nexport const a = (b: B) => b;\n`,
    "src/b.ts": `import type { A } from "./a";\nexport type B = number;\nexport type A = string;\n`,
  };

  it("drops a cycle no runtime edge closes, and names the erased edges", async () => {
    const graph = await graphOf(typePair);

    const verdict = await judgeCycle(graph, cycle(["src/a", "src/b"]));

    expect(verdict.drop).toBe(true);
    expect(verdict.drop && verdict.reason).toContain("no cycle survives among its 2 modules");
    expect(verdict.drop && verdict.reason).toContain("src/a.ts → src/b.ts");
  });

  it("keeps a cycle closed by value imports", async () => {
    const graph = await graphOf({
      "src/x.ts": `import { y } from "./y";\nexport const x = () => y();\n`,
      "src/y.ts": `import { x } from "./x";\nexport const y = () => x;\n`,
    });

    expect(await judgeCycle(graph, cycle(["src/x", "src/y"]))).toEqual({ drop: false });
  });

  it("drops a phantom cycle even when a real cycle sits next to it in the tree", async () => {
    // src/b imports src/outer for a value, and src/outer cycles with src/other. That cycle belongs
    // to someone else: a walk that wandered into it would keep every phantom alive.
    const graph = await graphOf({
      ...typePair,
      "src/b.ts": `import type { A } from "./a";\nimport { o } from "./outer";\nexport type B = typeof o;\nexport type A = string;\n`,
      "src/outer.ts": `import { other } from "./other";\nexport const o = () => other();\n`,
      "src/other.ts": `import { o } from "./outer";\nexport const other = () => o;\n`,
    });

    expect((await judgeCycle(graph, cycle(["src/a", "src/b"]))).drop).toBe(true);
  });

  it("keeps a component whose title spells fewer modules than stringer says it holds", async () => {
    const graph = await graphOf(typePair);

    // A cycle can run through the member the title left out, so the title is not evidence.
    expect(await judgeCycle(graph, cycle(["src/a", "src/b"], 5))).toEqual({ drop: false });
  });

  it("keeps a component holding a module anton cannot parse", async () => {
    const graph = await graphOf(typePair);

    expect(await judgeCycle(graph, cycle(["src/a", "internal/store"]))).toEqual({ drop: false });
  });

  it("keeps a signal whose title it cannot read as a component", async () => {
    const graph = await graphOf(typePair);

    expect(await judgeCycle(graph, { ...cycle(["src/a"]), Title: "Circular dependency: src/a" })).toEqual({
      drop: false,
    });
    expect(await judgeCycle(graph, { ...cycle(["src/a", "src/b"]), Title: "something else" })).toEqual(
      { drop: false },
    );
  });

  it("keeps a cycle it ran out of budget to disprove", async () => {
    const graph = await graphOf(typePair);
    for (let i = 0; i < 500; i += 1) await graph.edgesOf(`src/gone${i}.ts`);

    expect(await judgeCycle(graph, cycle(["src/a", "src/b"]))).toEqual({ drop: false });
  });
});

describe("judgeFanOut", () => {
  /** A hub with `types` type-only imports and `values` runtime ones, all relative. */
  function hub(types: number, values: number): Record<string, string> {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < types; i += 1) {
      files[`src/t${i}.ts`] = `export type T${i} = ${i};\n`;
      lines.push(`import type { T${i} } from "./t${i}";`);
    }
    for (let i = 0; i < values; i += 1) {
      files[`src/v${i}.ts`] = `export const v${i} = ${i};\n`;
      lines.push(`import { v${i} } from "./v${i}";`);
    }
    files["src/hub.ts"] = `${lines.join("\n")}\nexport const all = [v0];\n`;
    return files;
  }

  it("drops a fan-out whose runtime edges sit at or below the threshold", async () => {
    const graph = await graphOf(hub(4, 8));

    const verdict = await judgeFanOut(graph, fanOut("src/hub", 12));

    expect(verdict.drop).toBe(true);
    expect(verdict.drop && verdict.reason).toContain(
      "4 of its 12 imports are type-only, leaving 8 at runtime",
    );
    expect(verdict.drop && verdict.reason).toContain("threshold of 10");
  });

  it("re-prices a survivor and corrects the number in stringer's own message", async () => {
    const graph = await graphOf(hub(3, 12));
    const signal = fanOut("src/hub", 15);

    const verdict = await judgeFanOut(graph, signal);

    expect(verdict).toEqual({ drop: false, recounted: { path: "src/hub", reported: 15, value: 12 } });
    // The number IS the claim triage acts on, so the signal it keeps has to carry the right one.
    expect(signal.Title).toBe("High coupling: src/hub imports 12 modules");
    expect(signal.Description).toContain("has 12 direct dependencies");
    expect(signal.Description).toContain("3 of the 15 imports stringer counted are type-only");
  });

  it("reads the threshold stringer used, not anton's default", async () => {
    const graph = await graphOf(hub(4, 8));

    // The same 8 runtime edges that were a drop at a threshold of 10 are a real finding at 5.
    expect(await judgeFanOut(graph, fanOut("src/hub", 12, 5))).toEqual({
      drop: false,
      recounted: { path: "src/hub", reported: 12, value: 8 },
    });
  });

  it("keeps a fan-out with nothing to subtract", async () => {
    const graph = await graphOf(hub(0, 12));

    expect(await judgeFanOut(graph, fanOut("src/hub", 12))).toEqual({ drop: false });
  });

  it("never subtracts an alias import stringer's own graph never counted", async () => {
    const files = hub(4, 8);
    files["tsconfig.json"] = JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
    });
    for (let i = 0; i < 3; i += 1) files[`src/al${i}.ts`] = `export type Al${i} = ${i};\n`;
    files["src/hub.ts"] =
      [0, 1, 2].map((i) => `import type { Al${i} } from "@/al${i}";`).join("\n") +
      `\n${files["src/hub.ts"]}`;
    const graph = await graphOf(files);

    const verdict = await judgeFanOut(graph, fanOut("src/hub", 12));

    // 7 edges are erased, but stringer's 12 only ever counted the 4 relative ones — subtracting the
    // alias imports too would price the module below the fan-out its own count describes.
    expect(verdict.drop && verdict.reason).toContain("4 of its 12 imports are type-only");
  });

  it("prices a drop off its own runtime count when stringer's number undercounts", async () => {
    // stringer's collector reads single-line statements only, so a wrapped import is missing from
    // its count entirely; subtracting from that floor would price the module below its real edges.
    const files = hub(4, 9);
    files["src/hub.ts"] = files["src/hub.ts"].replace(
      `import { v0 } from "./v0";`,
      `import {\n  v0,\n} from "./v0";`,
    );
    const graph = await graphOf(files);

    const verdict = await judgeFanOut(graph, fanOut("src/hub", 12));

    // 12 − 4 = 8 would understate it; 9 modules really are imported for a value, still under 10.
    expect(verdict.drop && verdict.reason).toContain("leaving 9 at runtime");
  });

  it("keeps a fan-out stringer undercounted by more than anton can subtract", async () => {
    const graph = await graphOf(hub(3, 12));

    // stringer saw 11 of the 15 statements; 12 runtime edges outrank any subtraction off 11.
    expect(await judgeFanOut(graph, fanOut("src/hub", 11))).toEqual({ drop: false });
  });

  it("keeps a signal missing the path or the count it would judge", async () => {
    const graph = await graphOf(hub(4, 8));

    expect(await judgeFanOut(graph, { ...fanOut("src/hub", 12), FilePath: null })).toEqual({
      drop: false,
    });
    expect(
      await judgeFanOut(graph, { ...fanOut("src/hub", 12), Title: "High coupling", Description: "" }),
    ).toEqual({ drop: false });
    expect(await judgeFanOut(graph, fanOut("src/missing", 12))).toEqual({ drop: false });
  });
});

describe("filterCouplingSignals", () => {
  it("drops what it disproved, keeps the rest in order, and reports both", async () => {
    const repo = writeRepo({
      "src/a.ts": `import type { B } from "./b";\nexport const a = (b: B) => b;\n`,
      "src/b.ts": `import type { A } from "./a";\nexport type B = number;\nexport type A = string;\n`,
    });
    const todo: ScanSignal = { Source: "todos", Kind: "todo", FilePath: "src/a.ts" };

    const result = await filterCouplingSignals(repo, [
      cycle(["src/a", "src/b"]),
      todo,
      { ...fanOut("src/a", 12), Kind: "unknown-coupling-kind" }, // a kind these rules don't know
    ]);

    expect(result.kept).toEqual([todo, expect.objectContaining({ Kind: "unknown-coupling-kind" })]);
    expect(result.coupling.dropped).toMatchObject([
      { path: "src/a", kind: "circular-dependency" },
    ]);
    expect(result.coupling.recounted).toEqual([]);
  });

  it("reads nothing when the scan carries no coupling signal", async () => {
    const signals: ScanSignal[] = [{ Source: "todos", Kind: "todo" }];

    // No repo on disk: an ordinary pass must not touch the filesystem at all.
    const result = await filterCouplingSignals(join(dir, "does-not-exist"), signals);

    expect(result.kept).toBe(signals);
    expect(result.coupling).toEqual({ dropped: [], recounted: [] });
  });
});
