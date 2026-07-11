"use client";

import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js terminal attached to a session's SSE log stream (anton-qbz.2). Replays the session's
 * existing log then follows live appends; a finished session simply replays and stops. xterm is
 * imported dynamically (client-only — it touches `window` on construction). Read-only: this is a
 * view of headless-claude output, not an interactive shell.
 *
 * `sessionId == null` renders an idle placeholder (a run with no session yet).
 */
export function RunTerminal({
  slug,
  sessionId,
  live,
}: {
  slug: string;
  sessionId: string | null;
  /** Whether the attached session is still running — drives the status line. */
  live: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "streaming" | "ended" | "error">(
    sessionId ? "connecting" : "idle",
  );

  useEffect(() => {
    if (!sessionId || !hostRef.current) {
      setState(sessionId ? "connecting" : "idle");
      return;
    }

    const host = hostRef.current;
    const controller = new AbortController();
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit: any = null;
    let onResize: (() => void) | null = null;

    setState("connecting");

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      // Read the base color tokens (hex) — the `--color-*` Tailwind aliases resolve to a literal
      // `var(--card)` string that xterm can't parse, so pull `--card`/`--foreground`/`--primary`.
      const css = getComputedStyle(document.documentElement);
      const readVar = (name: string, fallback: string) => {
        const v = css.getPropertyValue(name).trim();
        return v && !v.startsWith("var(") ? v : fallback;
      };

      term = new Terminal({
        convertEol: true,
        disableStdin: true,
        cursorBlink: false,
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
      try {
        fit.fit();
      } catch {
        /* host not laid out yet — a later resize will fit */
      }

      onResize = () => {
        try {
          fit?.fit();
        } catch {
          /* ignore transient layout errors */
        }
      };
      window.addEventListener("resize", onResize);

      try {
        const res = await fetch(`/api/projects/${slug}/sessions/${sessionId}/stream`, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        if (disposed) return;
        setState("streaming");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // SSE frames are separated by a blank line; each carries an `event:` and `data:` lines.
        while (!disposed) {
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
            const data = dataLines.join("\n");

            if (event === "log") {
              term.write(data.endsWith("\n") ? data : data + "\r\n");
            } else if (event === "end") {
              if (!disposed) setState("ended");
            }
          }
        }
        if (!disposed) setState((s) => (s === "streaming" ? "ended" : s));
      } catch (err) {
        if (!disposed && (err as Error).name !== "AbortError") setState("error");
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
        <StatusDot state={state} live={live} />
      </div>
      {sessionId ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-card px-3 py-2" ref={hostRef} />
      ) : (
        <div className="flex min-h-[200px] flex-1 items-center justify-center bg-card">
          <p className="max-w-xs text-center text-xs leading-relaxed text-subtle">
            No session has attached to this run yet. Live claude output streams here once execution
            starts.
          </p>
        </div>
      )}
    </div>
  );
}

function StatusDot({
  state,
  live,
}: {
  state: "idle" | "connecting" | "streaming" | "ended" | "error";
  live: boolean;
}) {
  const meta: Record<typeof state, { label: string; dot: string; pulse?: boolean }> = {
    idle: { label: "idle", dot: "bg-subtle" },
    connecting: { label: "connecting", dot: "bg-stage-backlog", pulse: true },
    streaming: {
      label: live ? "live" : "replaying",
      dot: "bg-stage-implementing",
      pulse: true,
    },
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
