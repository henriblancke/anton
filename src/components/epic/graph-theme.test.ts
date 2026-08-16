/**
 * The Controls theming (anton-xdlj) is a workaround for upstream `@xyflow/react` behaviour, so its
 * value is that it lives in exactly one place: a second copy gets fixed once and drifts silently.
 * These cases pin the variables the workaround needs and scan the tree for any re-declaration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REACT_FLOW_CONTROLS_THEME_CLASS } from "@/components/epic/graph-theme";

const THEME_MODULE = "graph-theme.ts";
// Anchored to this file, not the CWD: the scan must cover the same tree however vitest is invoked.
const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("the ReactFlow Controls theme class", () => {
  it.each([
    "background-color",
    "background-color-hover",
    "color",
    "color-hover",
    "border-color",
  ])("drives --xy-controls-button-%s", (variable) => {
    expect(REACT_FLOW_CONTROLS_THEME_CLASS).toContain(`[--xy-controls-button-${variable}:var(--color-`);
  });

  it("is declared in exactly one module", () => {
    const declaring = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => !file.endsWith(THEME_MODULE))
      .filter((file) => readFileSync(join(SRC_ROOT, file), "utf8").includes("--xy-controls-button-"));

    expect(declaring).toEqual([]);
  });
});
