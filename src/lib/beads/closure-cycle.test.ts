import { describe, expect, it } from "vitest";
import type { BeadVersion } from "./bd";
import { currentClosureVersion } from "./closure-cycle";

const version = (hash: string, status: string): BeadVersion => ({
  hash,
  at: "2026-09-09T00:00:00.000Z",
  status,
});

describe("currentClosureVersion", () => {
  it("returns no closure for an empty or live history", () => {
    expect(currentClosureVersion([])).toBeUndefined();
    expect(currentClosureVersion([version("live", "in_progress"), version("old-close", "closed")])).toBeUndefined();
  });

  it("identifies the version that began the current closure", () => {
    expect(currentClosureVersion([version("close", "closed")])).toBe("close");
  });

  it("keeps the closure identity through post-close writes", () => {
    expect(
      currentClosureVersion([
        version("note-write", "closed"),
        version("edge-write", "closed"),
        version("close", "closed"),
        version("before-close", "in_progress"),
      ]),
    ).toBe("close");
  });

  it("distinguishes a same-second reopen and reclose from the prior closure", () => {
    expect(
      currentClosureVersion([
        version("new-close", "closed"),
        version("reopen", "open"),
        version("old-close", "closed"),
      ]),
    ).toBe("new-close");
  });
});
