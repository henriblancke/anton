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

  it("captures the model that authored the last text-bearing assistant message, not an earlier one", () => {
    const state = createStreamState();
    const feed = (raw: unknown) => consumeLine(state, JSON.stringify(raw));

    feed({
      type: "assistant",
      message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "first" }] },
    });
    feed({
      type: "assistant",
      message: { model: "claude-5-2026-09", content: [{ type: "text", text: "second" }] },
    });
    // A tool-only turn carries a model too, but it never produced text — it must not overwrite
    // the model attributed to the last real answer.
    feed({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "tool_use", name: "Read" }] } });

    expect(state.lastAssistantModel).toBe("claude-5-2026-09");
  });

  it("clears the last assistant model when a later text-bearing message omits it", () => {
    const state = createStreamState();
    const feed = (raw: unknown) => consumeLine(state, JSON.stringify(raw));

    feed({
      type: "assistant",
      message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "first" }] },
    });
    // Same message replaces the text but reports no model — must not keep attributing the new
    // text to the earlier message's model.
    feed({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } });

    expect(state.lastAssistantText).toBe("second");
    expect(state.lastAssistantModel).toBeUndefined();
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

/**
 * anton-wjfkn: a session that arms a wake-up, a monitor or a background job on its FINAL message has
 * not finished — it handed its turn back to something an autonomous ticket run never delivers. The
 * stream is the only place that intent is visible (the exit code is 0 and the agent emits no
 * `ANTON-RESULT`), so the state carries what the last message armed and nothing else.
 */
describe("consumeLine — the yield-shaped tools the last assistant message armed (anton-wjfkn)", () => {
  const feedAll = (...lines: unknown[]) => {
    const state = createStreamState();
    for (const raw of lines) consumeLine(state, JSON.stringify(raw));
    return state;
  };
  const assistant = (...blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });

  it("reports nothing for an ordinary session", () => {
    const state = feedAll(
      assistant({ type: "text", text: "implemented" }, { type: "tool_use", name: "Edit" }),
      { type: "result", subtype: "success", result: "ANTON-RESULT: delivered" },
    );
    expect(state.pendingYields).toEqual([]);
  });

  it("names a ScheduleWakeup and a Monitor the last message armed", () => {
    expect(
      feedAll(assistant({ type: "tool_use", name: "ScheduleWakeup", input: { delaySeconds: 600 } }))
        .pendingYields,
    ).toEqual(["ScheduleWakeup"]);
    expect(feedAll(assistant({ type: "tool_use", name: "Monitor", input: {} })).pendingYields).toEqual([
      "Monitor",
    ]);
  });

  // The tools that TAKE `run_in_background` are the ordinary foreground ones, so the intent is in the
  // input rather than the name — and the recorded name says which it was, so the park an operator
  // reads names the thing the agent actually did.
  it("names a backgrounded call by its tool and the reason it counts", () => {
    const state = feedAll(
      assistant({ type: "tool_use", name: "Bash", input: { command: "bun test", run_in_background: true } }),
    );
    expect(state.pendingYields).toEqual(["Bash (run_in_background)"]);
  });

  it("leaves a FOREGROUND call of the same tool alone", () => {
    const state = feedAll(assistant({ type: "tool_use", name: "Bash", input: { command: "bun test" } }));
    expect(state.pendingYields).toEqual([]);
  });

  // A Monitor armed mid-session and then read is ordinary work; only the message the session ENDED on
  // says the turn was handed back. So a later message clears an earlier arm.
  it("keeps only the LAST message's arms, so a monitor that was read clears", () => {
    const state = feedAll(
      assistant({ type: "tool_use", name: "Monitor", input: {} }),
      assistant({ type: "text", text: "the monitor reported green" }),
      { type: "result", subtype: "success", result: "ANTON-RESULT: delivered" },
    );
    expect(state.pendingYields).toEqual([]);
  });

  it("carries every arm when one message makes several", () => {
    const state = feedAll(
      assistant(
        { type: "text", text: "kicking off the suite" },
        { type: "tool_use", name: "Bash", input: { command: "bun test", run_in_background: true } },
        { type: "tool_use", name: "ScheduleWakeup", input: { delaySeconds: 270 } },
      ),
    );
    expect(state.pendingYields).toEqual(["Bash (run_in_background)", "ScheduleWakeup"]);
  });
});
