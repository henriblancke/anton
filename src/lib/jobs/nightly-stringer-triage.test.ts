/**
 * The triage prompt is the contract between what anton resolved for the pass and the rules
 * skills/scan-triage executes against it (anton-ol1l, anton-bz1w). Asserted here without a scan or
 * a claude session: everything the agent must not have to re-derive is in the text, or it isn't.
 */
import { expect, it } from "vitest";
import { buildTriagePrompt } from "./nightly-stringer-triage";

const BOARD = "## Board context — as read\n- feat-1 · attach:child · epic:epic-1";

it("hands triage the scan, the project's severity mapping, and the board it routes against", async () => {
  const prompt = await buildTriagePrompt({
    scanFile: "/tmp/scan-1.json",
    settings: { scanSeverity: { high: { risk: "high", priority: 0 } } },
    boardSection: BOARD,
  });

  expect(prompt).toContain("The stringer scan file to triage is: /tmp/scan-1.json");
  expect(prompt).toContain("AntonSeverity");
  expect(prompt).toContain("do NOT re-derive one");
  expect(prompt).toContain("| high | risk:high | P0 |");
  expect(prompt).toContain(BOARD);
  // The skill itself leads, so its rules are what the session runs on.
  expect(prompt.indexOf("scan-triage")).toBeLessThan(prompt.indexOf("scan file to triage is:"));
});
