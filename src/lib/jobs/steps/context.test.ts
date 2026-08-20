/**
 * Direct tests for the step context seam: which bead a step speaks for, and whose session it
 * records into.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schema } from "../../db";
import type { Bead } from "../../beads/bd";
import { stepSession, stepSubject } from "./context";
import { closeSandbox, openSandbox, target } from "./step.fixture";

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  sandbox = await openSandbox("steps-context");
});

afterEach(() => closeSandbox(sandbox));

const ticket = (id: string): Bead => ({ ...target, id, title: `ticket ${id}` });

describe("stepSubject — which bead a step speaks for", () => {
  it("names the ticket when a step covers exactly one — the walk's ticket phase", () => {
    expect(stepSubject({ target, tickets: [ticket("anton-a")] }).id).toBe("anton-a");
  });

  // A run-phase step is handed every live ticket and covers all of them, so its session and failure
  // message must not be filed under whichever ticket happened to be first.
  it("names the run target when a step covers several — the walk's run phase", () => {
    expect(stepSubject({ target, tickets: [ticket("anton-a"), ticket("anton-b")] }).id).toBe(target.id);
  });

  it("falls back to the target when a step covers no tickets at all", () => {
    expect(stepSubject({ target, tickets: [] }).id).toBe(target.id);
  });
});

describe("stepSession — one rule for every step that produces output", () => {
  it("opens (and owns) a session when the caller handed none in", async () => {
    const { session, owned } = await stepSession(sandbox.context(), target.id);

    expect(owned).toBe(true);
    const rows = await sandbox.tdb.db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: session.sessionId, kind: "execute", status: "running" });
  });

  // The caller keeping ONE session across several steps is the whole point: a step that opened its
  // own anyway would split one ticket's record in two.
  it("reuses the caller's session, and disclaims ownership of it", async () => {
    const { session: caller } = await stepSession(sandbox.context(), target.id);
    const { session, owned } = await stepSession(
      sandbox.context({ session: caller }),
      target.id,
    );

    expect(owned).toBe(false);
    expect(session.sessionId).toBe(caller.sessionId);
    expect(await sandbox.tdb.db.select().from(schema.sessions)).toHaveLength(1);
  });
});
