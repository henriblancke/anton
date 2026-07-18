"use client";

import { useEffect, useRef, useState } from "react";

import { readSseFrames } from "@/lib/sse-frames";

import "@xterm/xterm/css/xterm.css";

/**
 * Interactive xterm.js terminal bound to a live pty session (anton-bm4.1). Unlike {@link RunTerminal}
 * (read-only, tails a headless log), this is bidirectional: it replays the session's output buffer,
 * follows live output over SSE, and sends keystrokes/resizes back to the pty. The `sessionId` must
 * already be spawned (POST `…/sessions/interactive`); wiring `/shape` onto it is anton-bm4.2.
 *
 * Data frames are base64 of UTF-8 bytes, so ANSI/control sequences round-trip intact. xterm is
 * imported dynamically (client-only — it touches `window` on construction). On unmount the SSE is
 * aborted and the terminal disposed; the pty itself is torn down by the owner (DELETE `…/pty`).
 */
export type PtyTerminalState = "connecting" | "streaming" | "ended" | "error";

export function PtyTerminal({
  slug,
  sessionId,
  onStateChange,
  onExit,
}: {
  slug: string;
  sessionId: string;
  onStateChange?: (state: PtyTerminalState) => void;
  /** Called once with the pty's exit code when the session ends. */
  onExit?: (exitCode: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PtyTerminalState>("connecting");

  // Keep the latest callbacks without re-running the connect effect on every render.
  const onStateChangeRef = useRef(onStateChange);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
    onExitRef.current = onExit;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const base = `/api/projects/${slug}/sessions/${sessionId}/pty`;
    const controller = new AbortController();
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit: any = null;
    let onResize: (() => void) | null = null;

    const setPhase = (s: PtyTerminalState) => {
      if (disposed) return;
      setState(s);
      onStateChangeRef.current?.(s);
    };

    setPhase("connecting");

    // Fire-and-forget control messages; a dead session (409) just means the pty already exited.
    const post = (payload: unknown) => {
      void fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => {
        /* aborted / offline — nothing actionable */
      });
    };

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      // Read the base color tokens (hex) — the `--color-*` Tailwind aliases resolve to a literal
      // `var(--card)` string xterm can't parse, so pull the raw `--card`/`--foreground`/`--primary`.
      const css = getComputedStyle(document.documentElement);
      const readVar = (name: string, fallback: string) => {
        const v = css.getPropertyValue(name).trim();
        return v && !v.startsWith("var(") ? v : fallback;
      };

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily:
          'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.4,
        scrollback: 10_000,
        theme: {
          background: readVar("--card", "#1c1a17"),
          foreground: readVar("--foreground", "#f3f0ea"),
          cursor: readVar("--primary", "#8f82ff"),
          selectionBackground: "rgba(143,130,255,0.28)",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      const sendResize = () => {
        try {
          fit?.fit();
        } catch {
          /* host not laid out yet */
        }
        if (term && Number.isFinite(term.cols) && Number.isFinite(term.rows)) {
          post({ type: "resize", cols: term.cols, rows: term.rows });
        }
      };
      sendResize();

      // Keystrokes → pty stdin. This is what makes the terminal interactive.
      term.onData((data: string) => post({ type: "input", data }));

      onResize = () => sendResize();
      window.addEventListener("resize", onResize);

      try {
        const res = await fetch(base, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        if (disposed) return;
        setPhase("streaming");

        for await (const { event, data } of readSseFrames(res.body, () => disposed)) {
          if (event === "data") {
            // base64 → bytes; xterm renders the raw terminal stream (ANSI, cursor moves, UTF-8).
            term.write(base64ToBytes(data));
          } else if (event === "exit") {
            if (!disposed) {
              onExitRef.current?.(Number(data) || 0);
              setPhase("ended");
            }
          }
        }
        if (!disposed) setPhase("ended");
      } catch (err) {
        if (!disposed && (err as Error).name !== "AbortError") setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (onResize) window.removeEventListener("resize", onResize);
      try {
        term?.dispose();
      } catch {
        /* already disposed */
      }
    };
  }, [slug, sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">
          Terminal
        </span>
        <StatusDot state={state} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-card px-3 py-2" ref={hostRef} />
    </div>
  );
}

/** Decode a base64 `data:` payload into the raw bytes xterm expects. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function StatusDot({ state }: { state: PtyTerminalState }) {
  const meta: Record<PtyTerminalState, { label: string; dot: string; pulse?: boolean }> = {
    connecting: { label: "connecting", dot: "bg-stage-backlog", pulse: true },
    streaming: { label: "live", dot: "bg-stage-implementing", pulse: true },
    ended: { label: "ended", dot: "bg-stage-done" },
    error: { label: "stream error", dot: "bg-risk-high" },
  };
  const m = meta[state];
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-subtle">
      <span
        className={`size-1.5 rounded-full ${m.dot} ${m.pulse ? "anton-pulse" : ""}`}
        aria-hidden="true"
      />
      {m.label}
    </span>
  );
}
