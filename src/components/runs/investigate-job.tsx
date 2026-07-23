"use client";

import { useState } from "react";
import { SquareTerminalIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PtyTerminal } from "@/components/pty/pty-terminal";

/**
 * POSTs the interactive spawn route with a jobId and normalises every failure — HTTP and network —
 * into one shape. The server resolves the job's live cwd itself (the client never picks a
 * directory); a 409 means the job settled or never reported a cwd, so there's nothing to open.
 */
export async function requestInvestigateSession(
  slug: string,
  jobId: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/projects/${slug}/sessions/interactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `Investigate failed (${res.status})` };
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to open terminal" };
  }
}

/**
 * Opens an interactive terminal in a running job's working directory (anton-gjhu) — a separate
 * claude pty rooted at the cwd the job reported, so the operator can inspect git status and
 * process state while diagnosing a wedged run without touching the job's own process. Only
 * rendered for jobs running on this instance with a resolvable cwd; failures stay inline so a
 * terminal that couldn't open never reads as open.
 */
export function InvestigateJobButton({
  slug,
  jobId,
  onSession,
}: {
  slug: string;
  jobId: string;
  /** Fired with the spawned pty's session id — the row renders the terminal panel off it. */
  onSession: (sessionId: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setStarting(true);
    setError(null);
    const result = await requestInvestigateSession(slug, jobId);
    setStarting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSession(result.sessionId);
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && (
        <span role="alert" className="max-w-56 truncate font-mono text-[11px] text-risk-high">
          {error}
        </span>
      )}
      <Button size="xs" variant="outline" onClick={open} disabled={starting}>
        <SquareTerminalIcon aria-hidden="true" />
        {starting ? "Opening…" : "Investigate"}
      </Button>
    </span>
  );
}

/**
 * The live investigate terminal, expanded under the job row. Closing kills the pty explicitly —
 * unmounting PtyTerminal only aborts the SSE stream, so the claude process behind it would
 * otherwise outlive the panel (same teardown as shape-view).
 */
export function InvestigateTerminal({
  slug,
  sessionId,
  cwd,
  onClose,
}: {
  slug: string;
  sessionId: string;
  /** The job's reported working directory, shown so the operator knows where they landed. */
  cwd: string;
  onClose: () => void;
}) {
  function close() {
    void fetch(`/api/projects/${slug}/sessions/${sessionId}/pty`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {
      /* best-effort teardown — the pty exits on its own if this never lands */
    });
    onClose();
  }

  return (
    <div className="flex flex-col border-t border-border">
      <div className="flex items-center gap-2 bg-card/40 px-6 py-1.5">
        <SquareTerminalIcon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={cwd}>
          {cwd}
        </span>
        <Button size="xs" variant="ghost" className="ml-auto shrink-0" onClick={close}>
          <XIcon aria-hidden="true" />
          Close
        </Button>
      </div>
      <div className="flex h-80 flex-col">
        <PtyTerminal slug={slug} sessionId={sessionId} />
      </div>
    </div>
  );
}
