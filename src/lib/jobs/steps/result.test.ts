/**
 * The step result contract. It carries no runtime code, so these are compile-time assertions —
 * `bun run typecheck` is the gate that runs them, and vitest keeps them next to the suites that
 * depend on the same shapes.
 *
 * What they protect: a caller invoking ONE handler directly (execute-epic does) reads its facts
 * without asserting, which only holds while {@link StepResultWith} keeps them required.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { StepClass, StepDefinition, StepHandler, StepResult, StepResultWith } from "./result";

describe("StepResultWith", () => {
  it("makes the named facts required while the rest stay optional", () => {
    expectTypeOf<StepResultWith<"committed">["facts"]["committed"]>().toEqualTypeOf<boolean>();
    // Everything a handler does NOT promise stays optional, so no call site over-reads it.
    expectTypeOf<StepResultWith<"committed">["facts"]["pr"]>().toBeNullable();
    expectTypeOf<StepResultWith<"committed">>().toExtend<StepResult>();
    expect(true).toBe(true);
  });
});

describe("StepDefinition", () => {
  // The registry maps every step to the same entry point; the floor validator (anton-6b99) reads
  // `class` and `producesDiff` off it, so both must stay on the definition rather than the handler.
  it("describes a step by its uniform handler plus the floor's two facts", async () => {
    const handler: StepHandler = async () => ({ ok: true, detail: "done" });
    const definition: StepDefinition = {
      name: "build",
      class: "additive" satisfies StepClass,
      summary: "the build step",
      producesDiff: true,
      handler,
    };

    expect(await definition.handler({} as never)).toEqual({ ok: true, detail: "done" });
  });
});
