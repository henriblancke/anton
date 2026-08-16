/**
 * The Controls theming (anton-xdlj) is a workaround for upstream `@xyflow/react` behaviour, so its
 * value is that it lives in exactly one place: a second copy gets fixed once and drifts silently.
 * These cases pin the variables the workaround needs and scan the tree for any re-declaration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REACT_FLOW_CONTROLS_THEME_CLASS } from "@/components/epic/graph-theme";

const THEME_MODULE = "graph-theme.ts";

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
    const declaring = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => !file.endsWith(THEME_MODULE))
      .filter((file) => readFileSync(`src/${file}`, "utf8").includes("--xy-controls-button-"));

    expect(declaring).toEqual([]);
  });
});
