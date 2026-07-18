/** A parsed Server-Sent Events frame: its `event:` type and joined `data:` payload. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Read a `fetch` response body as a stream of parsed SSE frames. Owns the fiddly,
 * partial-chunk-sensitive framing: a reader, a streaming `TextDecoder`, a string buffer, and the
 * blank-line frame split. Consumers map each `{ event, data }` to their own state.
 *
 * SSE frames are separated by a blank line; each carries `event:` and `data:` lines. A frame with
 * no `event:` defaults to `"message"`; multiple `data:` lines are joined with newlines.
 *
 * `isDisposed` is polled between reads so an aborted/unmounted consumer stops the loop promptly
 * even if the network read hasn't yet rejected.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  isDisposed: () => boolean,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!isDisposed()) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      yield { event, data: dataLines.join("\n") };
    }
  }
}
