/**
 * The driver's stream-json seam (anton-kvag): line reassembly, event normalization, and the stream
 * state the exit classification reads back. These run without a child process — driver.test.ts
 * covers the same ground end-to-end against fake claude binaries.
 */
import { describe, expect, it } from "vitest";
import {
  consumeLine,
  createLineReader,
  createStreamState,
  toEvents,
  type ClaudeEvent,
} from "./driver-events";

describe("toEvents", () => {
  it("normalizes a system line to its subtype", () => {
    expect(toEvents({ type: "system", subtype: "init", session_id: "s1" })).toEqual([
      { type: "system", text: "init", raw: { type: "system", subtype: "init", session_id: "s1" } },
    ]);
  });

  it("emits the assistant text first, then one event per tool_use block in order", () => {
    const raw = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "think" },
          { type: "tool_use", name: "Read" },
          { type: "text", text: "ing" },
          { type: "tool_use", name: "Edit" },
        ],
      },
    };

    expect(toEvents(raw).map((e) => [e.type, e.text])).toEqual([
      ["assistant", "thinking"],
      ["tool", "Read"],
      ["tool", "Edit"],
    ]);
  });

  it("still emits one event for an assistant message with no renderable blocks", () => {
    // The message must stay visible in the log even when it carries nothing we can render.
    const events = toEvents({ type: "assistant", message: { content: [] } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "assistant" });
    expect(events[0].text).toBeUndefined();
  });

  it("carries the result text, and ignores unknown line types", () => {
    expect(toEvents({ type: "result", result: "done" })[0]).toMatchObject({
      type: "result",
      text: "done",
    });
    expect(toEvents({ type: "stream_event" })).toEqual([]);
  });
});

describe("createLineReader", () => {
  it("emits complete lines only, across chunk boundaries", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"a":1}\n{"b":');
    expect(lines).toEqual(['{"a":1}']);

    reader.push('2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes a trailing line that never got its newline, and only once", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"a":1}');
    expect(lines).toEqual([]);

    reader.flush();
    reader.flush();
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe("consumeLine", () => {
  it("captures the session id, the result line, the transcript, and the last assistant text", () => {
    const state = createStreamState();
    const events: ClaudeEvent[] = [];
    const feed = (raw: unknown) => consumeLine(state, JSON.stringify(raw), (e) => events.push(e));

    feed({ type: "system", subtype: "init", session_id: "sess-9" });
    feed({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } });
    feed({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } });
    feed({ type: "result", subtype: "success", result: "done", session_id: "sess-9" });

    expect(state.initSessionId).toBe("sess-9");
    expect(state.lastAssistantText).toBe("second");
    expect(state.resultRaw).toMatchObject({ type: "result", result: "done" });
    expect(state.transcript).toBe("init\nfirst\nsecond\ndone\n");
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "assistant", "result"]);
  });

  it("ignores blank lines and non-JSON noise rather than failing the run", () => {
    const state = createStreamState();
    const events: ClaudeEvent[] = [];

    consumeLine(state, "   ", (e) => events.push(e));
    consumeLine(state, "not json at all", (e) => events.push(e));

    expect(events).toEqual([]);
    expect(state.transcript).toBe("");
  });
});
