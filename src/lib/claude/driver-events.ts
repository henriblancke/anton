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

/** Text first, then each tool call; an empty message still yields one event so it stays visible. */
function assistantEvents(raw: Record<string, unknown>): ClaudeEvent[] {
  const content = (raw.message as { content?: unknown[] } | undefined)?.content;
  const blocks = Array.isArray(content) ? content : [];
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
}

export function createStreamState(): StreamState {
  return { transcript: "" };
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
  for (const event of toEvents(parsed)) {
    if (event.text) state.transcript += `${event.text}\n`;
    if (event.type === "assistant" && event.text) state.lastAssistantText = event.text;
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
