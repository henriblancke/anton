import { expect, it } from "vitest";
import { scanMarkdown } from "./markdown";

it("isolates cached scans from caller edits and changed descriptions", () => {
  const source = "## Goal\n\nKeep the authored contract.\n";
  const expected = scanMarkdown(source);
  const edited = scanMarkdown(source);
  edited[0]!.heading!.key = "corrupted";
  edited[1]!.text = "corrupted";
  edited.pop();
  expect(scanMarkdown(source)).toEqual(expected);
  expect(scanMarkdown(source.replace("Goal", "Acceptance"))[0]!.heading!.key).toBe("acceptance");
});

import { acceptanceBody, contractStatusOf, goalBody, validateBeadContract } from "./contract";
import type { Bead } from "./types";

it("invalidates contract reads for edits, acceptance fields, tier and labels without a timestamp change", () => {
  const bead: Bead = { id: "same", title: "Same", status: "open", issue_type: "task", description: "## Goal\nOriginal" };
  expect(goalBody(bead)).toBe("Original");
  expect(contractStatusOf(bead)?.blocking.length).toBeGreaterThan(0);
  bead.description = "## Goal\nRepaired";
  bead.acceptance_criteria = "It works";
  expect(goalBody(bead)).toBe("Repaired");
  expect(acceptanceBody(bead)).toBe("It works");
  expect(contractStatusOf(bead)?.blocking).toEqual([]);
  bead.issue_type = "epic";
  expect(validateBeadContract(bead).some((gap) => gap.section === "area:")).toBe(true);
  bead.labels = ["area:app"];
  expect(validateBeadContract(bead).some((gap) => gap.section === "area:")).toBe(false);
  const violations = validateBeadContract({ ...bead, acceptance_criteria: undefined });
  violations[0]!.message = "corrupted";
  expect(validateBeadContract({ ...bead, acceptance_criteria: undefined })[0]!.message).not.toBe("corrupted");
});
