import { describe, expect, it } from "vitest";
import { safe } from "./safe";

describe("safe", () => {
  it("answers true when the effect completed", async () => {
    expect(await safe(async () => undefined)).toBe(true);
  });

  it("swallows a failure and answers false", async () => {
    expect(
      await safe(async () => {
        throw new Error("bd is down");
      }),
    ).toBe(false);
  });
});
