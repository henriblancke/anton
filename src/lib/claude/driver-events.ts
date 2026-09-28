/**
 * The stream-json side of the headless claude driver (anton-kvag): claude's stdout is
 * newline-delimited JSON, and this module turns those bytes into normalized {@link ClaudeEvent}s
 * plus the small amount of stream state the exit classification reads back (the final `result`
 * line, the session id, the transcript). Everything here is pure/self-contained — no process, no
 * spawn — so the driver's streaming path is testable without a child.
 */

/** A normalized event streamed from claude's stream-json output. */
export interface ClaudeEvent {
  /** Coarse kind for the UI/log. `raw` carries the original stream-json object. */
  type: "system" | "assistant" | "tool" | "result" | "error" | "text";
  /** Human-readable text for logs/terminal, when the event has any. */
  text?: string;
  /** The original parsed stream-json line. */
  raw?: unknown;
}

/** True when `value` is a stream-json content block of the given block type. */
function isBlock(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

/** The assistant message's text blocks, concatenated — empty when the message is tool-use only. */
function assistantText(blocks: unknown[]): string {
  return blocks
    .filter((b) => isBlock(b, "text"))
    .map((b) => (b as { text?: string }).text ?? "")
    .join("");
}

/** One `tool` event per tool_use block, in the order claude emitted them. */
function toolEvents(blocks: unknown[], raw: unknown): ClaudeEvent[] {
  return blocks
    .filter((b) => isBlock(b, "tool_use"))
    .map((b) => ({ type: "tool" as const, text: (b as { name?: string }).name, raw }));
}

/**
 * Tools whose whole purpose is to END THE TURN and be woken later (anton-wjfkn): the session hands
 * control back and expects a future invocation to read the result.
 *
 * An autonomous ticket session has no such future — anton reads one final message and settles the
 * ticket on it — so arming one of these is how a session stops mid-work while exiting 0 and looking
 * like a clean finish. Matched by name because that is all the stream carries for the intent; the
 * `run_in_background` case is matched on the input instead ({@link backgroundedTool}), since the tool
 * names that accept it (`Bash`, `Agent`) are also the ordinary foreground ones.
 */
const YIELDING_TOOLS = new Set(["ScheduleWakeup", "Monitor"]);

/** True when a tool_use block asks for its work to run detached from the turn. */
function backgroundedTool(block: unknown): boolean {
  const input = (block as { input?: unknown } | null)?.input;
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { run_in_background?: unknown }).run_in_background === true
  );
}

/**
 * The yield-shaped tools this message armed, by name — empty for an ordinary message.
 *
 * A backgrounded call is recorded under its own tool name with the reason appended, so the park an
 * operator reads names the thing the agent actually did rather than a bare tool name that looks
 * innocent.
 */
function yieldingTools(blocks: unknown[]): string[] {
  const names: string[] = [];
  for (const block of blocks) {
    if (!isBlock(block, "tool_use")) continue;
    const name = (block as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    if (YIELDING_TOOLS.has(name)) names.push(name);
    else if (backgroundedTool(block)) names.push(`${name} (run_in_background)`);
  }
  return names;
}

/** An assistant message's content blocks — `[]` when the line carries none in the expected shape. */
function messageBlocks(raw: Record<string, unknown>): unknown[] {
  const content = (raw.message as { content?: unknown[] } | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

/** Text first, then each tool call; an empty message still yields one event so it stays visible. */
function assistantEvents(raw: Record<string, unknown>): ClaudeEvent[] {
  const blocks = messageBlocks(raw);
  const events: ClaudeEvent[] = [];

  const text = assistantText(blocks);
  if (text) events.push({ type: "assistant", text, raw });
  events.push(...toolEvents(blocks, raw));

  if (events.length === 0) events.push({ type: "assistant", raw });
  return events;
}

/** Normalize one parsed stream-json line into zero or more `ClaudeEvent`s. */
export function toEvents(raw: Record<string, unknown>): ClaudeEvent[] {
  if (raw.type === "system") {
    return [{ type: "system", text: typeof raw.subtype === "string" ? raw.subtype : undefined, raw }];
  }
  if (raw.type === "assistant") return assistantEvents(raw);
  if (raw.type === "result") {
    return [{ type: "result", text: typeof raw.result === "string" ? raw.result : undefined, raw }];
  }
  return [];
}

/** Reassembles newline-framed JSON from stdout chunks, which split lines at arbitrary bytes. */
export interface LineReader {
  /** Feed one raw stdout chunk; emits every complete line it completes. */
  push(chunk: string): void;
  /** Emit the trailing partial line at end of stream, when it holds anything. */
  flush(): void;
}

export function createLineReader(onLine: (line: string) => void): LineReader {
  let buffered = "";
  return {
    push(chunk) {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffered.trim()) onLine(buffered);
      buffered = "";
    },
  };
}

/** What the stream leaves behind for the exit classification — see {@link consumeLine}. */
export interface StreamState {
  /** The final `result` line, when claude emitted one. */
  resultRaw?: Record<string, unknown>;
  /**
   * Claude's session id captured from the `system` init event — emitted at session start, BEFORE
   * any work. Held separately so a mid-stream death that never reaches the final `result` event
   * still surfaces an id the runner can `claude --resume` (anton-juar).
   */
  initSessionId?: string;
  /**
   * All human-readable text Claude emitted (assistant + result), so the usage-limit scan sees the
   * quota signal wherever it lands — Claude Code has surfaced "usage limit reached" in the final
   * result field, in an assistant text block, or on stderr depending on how it exited. Scanning
   * only the result field risked misclassifying a real quota hit as a plain error, which burns
   * maxAttempts and parks instead of rescheduling (anton-ner.2).
   */
  transcript: string;
  /**
   * The last assistant text block — the `text` fallback for a success that omits the final
   * `result` field (anton-juar).
   */
  lastAssistantText?: string;
  /**
   * The yield-shaped tools the LAST assistant message armed (anton-wjfkn) — see
   * {@link YIELDING_TOOLS}.
   *
   * Only the last message's, because that is the question: a `Monitor` armed mid-session and then
   * read is ordinary work, while one armed by the message the session ENDED on is a turn handed back
   * to a wake-up that will never come. Reset on every assistant message with content, so a later
   * ordinary message clears an earlier arm.
   */
  pendingYields: string[];
  /**
   * The `model` the SAME message reported (anton-528bw) — the model that actually authored
   * {@link lastAssistantText}/the final result text, as opposed to `modelUsage`'s per-model spend
   * map, which lists every model the session touched (including sidecars) in no meaningful order.
   * Captured only alongside a text-bearing assistant message, so it always names the model that
   * produced the text a caller goes on to parse, never a tool-only turn's model.
   */
  lastAssistantModel?: string;
}

export function createStreamState(): StreamState {
  return { transcript: "", pendingYields: [] };
}

/** One stream-json line, or undefined when the line is blank or not JSON (claude prints both). */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Latch the two lifecycle markers the exit classification needs off the raw line. */
function captureMarkers(state: StreamState, parsed: Record<string, unknown>): void {
  if (parsed.type === "result") state.resultRaw = parsed;
  if (parsed.type === "system" && typeof parsed.session_id === "string") {
    state.initSessionId = parsed.session_id;
  }
}

function captureEvents(
  state: StreamState,
  parsed: Record<string, unknown>,
  onEvent?: (event: ClaudeEvent) => void,
): void {
  if (parsed.type === "assistant") state.pendingYields = yieldingTools(messageBlocks(parsed));
  for (const event of toEvents(parsed)) {
    if (event.text) state.transcript += `${event.text}\n`;
    if (event.type === "assistant" && event.text) {
      state.lastAssistantText = event.text;
      const message = (parsed.message ?? undefined) as Record<string, unknown> | undefined;
      // Set from THIS message, never left over from an earlier one: a model-less text-bearing
      // message must not inherit a stale model an earlier message reported, or a caller (e.g.
      // claudeLocalBackend's answeringModel) attributes the final text to the wrong model.
      state.lastAssistantModel = typeof message?.model === "string" ? message.model : undefined;
    }
    onEvent?.(event);
  }
}

/** Fold one raw stdout line into `state`, forwarding every event it yields to `onEvent`. */
export function consumeLine(
  state: StreamState,
  line: string,
  onEvent?: (event: ClaudeEvent) => void,
): void {
  const parsed = parseLine(line);
  if (!parsed) return;
  captureMarkers(state, parsed);
  captureEvents(state, parsed, onEvent);
}
