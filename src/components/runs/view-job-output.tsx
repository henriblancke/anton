"use client";

import { ScrollTextIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RunTerminal } from "@/components/runs/run-terminal";

/**
 * Live output for a running job (anton-x10l), expanded under the job row: the read-only session
 * log viewer attached to the session the job's handler reported. Purely observational — closing
 * just unmounts the viewer (which aborts its SSE fetch); nothing on the server to tear down,
 * unlike the investigate pty.
 */
export function JobOutputPanel({
  slug,
  sessionId,
  onClose,
}: {
  slug: string;
  /** The running job's live session, resolved server-side from the runner's in-memory handle. */
  sessionId: string;
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
        <RunTerminal slug={slug} sessionId={sessionId} live />
      </div>
    </div>
  );
}
