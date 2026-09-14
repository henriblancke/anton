"use client";

import { useEffect, useState } from "react";

export interface JobRowPanels {
  /** Non-null while an investigate pty is live under this row (anton-gjhu). */
  investigateSession: string | null;
  openInvestigate: (sessionId: string) => void;
  closeInvestigate: () => void;
  /** The read-only output viewer under this row (anton-x10l). */
  outputOpen: boolean;
  openOutput: () => void;
  closeOutput: () => void;
}

/**
 * The row owns the investigate pty's lifetime: dropping the session — Close, the job settling out
 * from under the terminal, or this row unmounting — must kill the pty, because unmounting
 * PtyTerminal only aborts the SSE stream and the claude process would outlive the panel until the
 * server-side timeout. Keyed on the session (not a cleanup inside InvestigateTerminal) so dev
 * StrictMode's double-mount of the panel can't kill a live session: at row mount the session is
 * null and the double-invoked effect is a no-op.
 */
function useInvestigatePtyTeardown(slug: string, investigateSession: string | null) {
  useEffect(() => {
    if (!investigateSession) return;
    return () => {
      void fetch(`/api/projects/${slug}/sessions/${investigateSession}/pty`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {
        /* best-effort teardown — the pty exits on its own if this never lands */
      });
    };
  }, [slug, investigateSession]);
}

/**
 * The two live panels a job row can open, and the rule that a panel may not outlive the handle it
 * reads from.
 */
export function useJobRowPanels({
  slug,
  liveCwd,
  sessionId,
}: {
  slug: string;
  /** Where the pty is attached; gone once the job stops running on this instance. */
  liveCwd?: string;
  /** The log the viewer reads. */
  sessionId?: string;
}): JobRowPanels {
  const [investigateSession, setInvestigateSession] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);

  // Job settled while the terminal was open (an RSC refresh dropped the live handle, e.g. after a
  // confirmed kill) → drop the session during render (React's "adjusting state when props change"
  // pattern) so the teardown effect below fires and a later resume can't resurrect a dead session.
  if (investigateSession && !liveCwd) setInvestigateSession(null);
  // Same for the output panel: without this, a job whose session handle went away leaves
  // outputOpen=true and a later resume with a fresh sessionId would silently reopen the panel
  // without a user click.
  if (outputOpen && !sessionId) setOutputOpen(false);

  useInvestigatePtyTeardown(slug, investigateSession);

  return {
    investigateSession,
    openInvestigate: setInvestigateSession,
    closeInvestigate: () => setInvestigateSession(null),
    outputOpen,
    openOutput: () => setOutputOpen(true),
    closeOutput: () => setOutputOpen(false),
  };
}
