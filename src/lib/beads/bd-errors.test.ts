/**
 * Direct suite for bd-errors.ts (anton-ql1n): the two refusal readers over a rejected `bd` spawn,
 * tested against the module itself rather than through the callers that consume them.
 */
import { describe, expect, it } from "vitest";
import { isMissingBeadError, unclaimableStatus } from "@/lib/beads/bd-errors";

/** A promisified-execFile-shaped failure: message + captured stdout/stderr, as {@link bd} throws. */
const execError = (out: { stdout?: string; stderr?: string }) =>
  Object.assign(new Error("Command failed: bd"), out);

describe("isMissingBeadError", () => {
  it("matches bd's not-found exit, on stderr or on the message alone", () => {
    expect(isMissingBeadError(execError({ stderr: 'Error: no issue found matching "anton-e1"' }))).toBe(true);
    expect(isMissingBeadError(execError({ stderr: "no issues found matching the provided IDs" }))).toBe(true);
    expect(isMissingBeadError(new Error("bd: issue anton-e1 not found"))).toBe(true);
  });

  it("does not match a bd that could not answer at all", () => {
    expect(isMissingBeadError(execError({ stderr: "Error 1105: database is locked" }))).toBe(false);
    expect(isMissingBeadError(new Error("bd timed out after 120000ms"))).toBe(false);
    expect(isMissingBeadError(undefined)).toBe(false);
  });

  it("does not match another missing resource reported as 'not found'", () => {
    expect(isMissingBeadError(execError({ stderr: "Error: database not found" }))).toBe(false);
    expect(isMissingBeadError(execError({ stderr: 'schema "beads" not found' }))).toBe(false);
    expect(isMissingBeadError(new Error("bd: executable not found in $PATH"))).toBe(false);
  });
});

describe("unclaimableStatus", () => {
  it("returns the status bd named, from stderr or from the message alone", () => {
    expect(
      unclaimableStatus(
        execError({ stderr: "Error claiming anton-f5f3: issue not claimable: status blocked\n" }),
      ),
    ).toBe("blocked");
    expect(unclaimableStatus(execError({ stderr: "issue not claimable: status closed" }))).toBe("closed");
    expect(
      unclaimableStatus(new Error("Command failed: bd\nissue not claimable: status in_progress")),
    ).toBe("in_progress");
  });

  it("ignores failures a retry can clear, and an ownership conflict", () => {
    expect(
      unclaimableStatus(execError({ stderr: "Error claiming anton-f5f3: issue already claimed by bob" })),
    ).toBeUndefined();
    expect(unclaimableStatus(execError({ stderr: "Error 1105: database is locked" }))).toBeUndefined();
    expect(unclaimableStatus(new Error("bd update --claim exceeded its 60000ms budget"))).toBeUndefined();
    expect(unclaimableStatus(undefined)).toBeUndefined();
  });
});
