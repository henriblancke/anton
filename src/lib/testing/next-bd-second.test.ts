/**
 * Unit coverage for the integration harness's stamp-grid wait. The property under test is the one a
 * fixture cannot see failing until a suite goes red for reasons that read like a product bug: a
 * write made at `now` and a board read made after this wait must land on DIFFERENT bd seconds. bd
 * rounds stamps to whole seconds, so the naive "wait to the next boundary" leaves a write at `S.6`
 * (stamped `S+1`) tied with a read at `S+1.05` — the unorderable pair every evidence fence in
 * gardener/apply-plan.ts fails closed on.
 */
import { describe, expect, it } from "vitest";
import { nextBdSecond, settledAfterBdWrites } from "./integration";

/** bd's own stamping: whole seconds, ROUNDED. */
const stampOf = (ms: number) => Math.round(ms / 1_000) * 1_000;

/** How the fence reads a moment: floored to the same grid (apply.ts `toBdStampGrid`). */
const fenceOf = (ms: number) => Math.floor(ms / 1_000) * 1_000;

describe("settledAfterBdWrites", () => {
  // Every sub-second offset, because the failure only shows in the top half: a write at `S.6` is
  // stamped a second AHEAD of the clock it landed on.
  it.each([0, 100, 400, 499, 500, 501, 600, 900, 999])(
    "leaves a write made at S+%ims strictly below the fence a later read sits on",
    (offset) => {
      const wroteAt = 1_700_000_000_000 + offset;

      expect(fenceOf(settledAfterBdWrites(wroteAt))).toBeGreaterThan(stampOf(wroteAt));
    },
  );

  it("waits at most a hair over two seconds — a fixture pause, not a sleep", async () => {
    const started = Date.now();

    await nextBdSecond();

    expect(Date.now() - started).toBeLessThan(2_100);
  });
});
