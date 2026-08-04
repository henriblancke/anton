/**
 * Reading the "what changed" line off an approve response (anton-1t3n).
 *
 * Two properties are the whole reason this helper exists, and each is a way the approve surfaces
 * could misreport a board move that DID land:
 *   • the response is CLONED, so the caller can still hand the same one to the advisory reporter —
 *     a consuming read would silently kill the contract-advisory toast on every proposal approval;
 *   • a body that isn't JSON yields no summary rather than throwing — an approval that succeeded
 *     must never be reported as a failure by its own reporting.
 */
import { describe, expect, it } from "vitest";

import { appliedSummaryOf, readAppliedSummary } from "@/components/board/proposal-applied";

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("appliedSummaryOf", () => {
  it("reads the line an applied proposal answers with", () => {
    expect(appliedSummaryOf({ applied: { summary: " re-parented anton-a under anton-card " } })).toBe(
      "re-parented anton-a under anton-card",
    );
  });

  it.each([
    ["an ordinary approval, which started a run", { runId: "run-9" }],
    ["an apply that answered with no summary", { applied: {} }],
    ["a summary that is only whitespace", { applied: { summary: "   " } }],
    ["a summary that is not a string", { applied: { summary: 7 } }],
    ["a body that is not an object", "applied"],
    ["no body at all", null],
  ])("has nothing to report for %s", (_case, body) => {
    expect(appliedSummaryOf(body)).toBeUndefined();
  });
});

describe("readAppliedSummary", () => {
  it("leaves the response readable for the advisory reporter that runs after it", async () => {
    const res = jsonRes({ applied: { summary: "closed anton-a as shipped" }, advisory: ["anton-1"] });

    expect(await readAppliedSummary(res)).toBe("closed anton-a as shipped");
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toMatchObject({ advisory: ["anton-1"] });
  });

  it("reports no summary for a body that isn't JSON, rather than throwing", async () => {
    await expect(readAppliedSummary(new Response("<html>gateway</html>"))).resolves.toBeUndefined();
  });
});
