"use client";

import { ScrollTextIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RunTerminal } from "@/components/runs/run-terminal";

/**
 * A job's output (anton-x10l), expanded under the job row: the read-only session log viewer
 * attached to the session that job opened. Purely observational — closing just unmounts the viewer
 * (which aborts its SSE fetch); nothing on the server to tear down, unlike the investigate pty.
 *
 * Serves a settled job as well as a running one: the stream endpoint replays a finished session's
 * whole log and ends, so a nightly pass read the next morning shows exactly what it wrote.
 */
export function JobOutputPanel({
  slug,
  sessionId,
  live = false,
  onClose,
}: {
  slug: string;
  /**
   * The job's session — the runner's in-memory handle while it runs here, otherwise the durable
   * link the session row carries (anton-lmps).
   */
  sessionId: string;
  /** Still running: the viewer follows appends rather than announcing a replay. */
  live?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col border-t border-border">
      <div className="flex items-center gap-2 bg-card/40 px-6 py-1.5">
        <ScrollTextIcon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={sessionId}>
          {sessionId}
        </span>
        <Button size="xs" variant="ghost" className="ml-auto shrink-0" onClick={onClose}>
          <XIcon aria-hidden="true" />
          Close
        </Button>
      </div>
      <div className="flex h-80 flex-col">
        <RunTerminal slug={slug} sessionId={sessionId} live={live} />
      </div>
    </div>
  );
}
