/**
 * {@link assertSchemaFreshBeforeEpicStart} (PR #281 review) — the schema-only preflight
 * `execute-epic.ts` asks BEFORE `beginEpicRun` touches the `runs` table. Unlike the rest of the
 * checkout-staleness gate, this one can't wait for `prepareEpicRun`: `beginEpicRun`'s first board
 * step, `findOpenRunForEpic`, selects the row with every column the CURRENT schema names, so a
 * pending migration fails that read — a raw "no such column" — before completion can even be
 * decided. This is a pure unit test of the schema half alone; the other three halves and the
 * message-building they share with this one are covered by `execute-epic-prepare.test.ts`'s
 * `staleCheckoutRefusal` suite.
 */
import { describe, expect, it, vi } from "vitest";

const schemaFreshness = vi.fn();

vi.mock("./self-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./self-freshness")>()),
  schemaFreshness: (...args: unknown[]) => schemaFreshness(...args),
  selfRepoRoot: () => "/repo",
}));

const { assertSchemaFreshBeforeEpicStart } = await import("./execute-epic-freshness");
const { isStaleCheckoutError } = await import("./errors");

describe("assertSchemaFreshBeforeEpicStart", () => {
  it("throws a StaleCheckoutError naming the pending migrations, before any board read", () => {
    schemaFreshness.mockReturnValue({
      state: "pending",
      migrations: ["0038_add_base_fork_sha.sql"],
    });

    let thrown: unknown;
    try {
      assertSchemaFreshBeforeEpicStart();
    } catch (e) {
      thrown = e;
    }

    expect(isStaleCheckoutError(thrown)).toBe(true);
    const message = (thrown as Error).message;
    expect(message).toContain("0038_add_base_fork_sha.sql");
    expect(message).toContain("apply them");
    // Exactly one "restart anton" (PR #281 review) — the schema half must not duplicate the
    // trailing clause's own.
    expect(message.match(/restart anton/g)).toHaveLength(1);
  });

  it("does nothing when the schema is current", () => {
    schemaFreshness.mockReturnValue({ state: "current" });
    expect(() => assertSchemaFreshBeforeEpicStart()).not.toThrow();
  });

  it("fails open on a schema read that could not run, like every other half", () => {
    // A database not yet set up, an unreadable migrations dir — refusing a start on a check that
    // never answered would ground a fresh install on no evidence, the same rule the other three
    // halves already follow.
    schemaFreshness.mockReturnValue({
      state: "unknown",
      reason: "anton.db could not be located",
    });
    expect(() => assertSchemaFreshBeforeEpicStart()).not.toThrow();
  });
});
