"use client";

import type { EpicChoice } from "@/lib/backlog";

import { IdleDraftPanel, ShapingDraftPanel } from "./shape-draft-panel";
import { SessionPane } from "./shape-session-pane";
import { useSendToBacklog, useShapeDraft } from "./use-shape-draft";
import { useShapeSession } from "./use-shape-session";

/**
 * The Add-work / shaping surface (anton-bm4.2). A real `/shape` session runs a `claude` pty streamed
 * to an xterm on the left; on the right the founder shapes a draft feature — the tier anton runs —
 * and commits it to backlog under its epic (anton-h1ds).
 *
 * This component only sequences those two panes. The panes' state is two unrelated concerns and is
 * owned that way: `useShapeSession` holds the live pty, `useShapeDraft` the feature being composed
 * beside it, and `useSendToBacklog` the landing. They meet at exactly two points — the seed handed
 * over when shaping starts, and the session id the send needs to tear the pty down.
 */
export function ShapeView({
  slug,
  projectName,
  areas,
  epics,
}: {
  slug: string;
  projectName: string;
  /** `area:` values already on the board — suggested so surfaces get reused, not re-minted. */
  areas: string[];
  /** The live epics the draft feature may attach to. */
  epics: EpicChoice[];
}) {
  const draft = useShapeDraft();
  const backlog = useSendToBacklog(slug);
  const session = useShapeSession(slug, draft.seedFrom);
  const { sessionId } = session;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{projectName}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Add work</span>
        </div>
        <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary">
          <span className="size-1.5 rounded-full bg-primary anton-pulse" aria-hidden="true" />
          interactive · /shape
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_380px]">
        <SessionPane slug={slug} session={session} />
        {sessionId ? (
          <ShapingDraftPanel
            draft={draft}
            areas={areas}
            epics={epics}
            sending={backlog.sending}
            onSend={() => backlog.send(sessionId, draft.fields)}
          />
        ) : (
          <IdleDraftPanel />
        )}
      </div>
    </div>
  );
}
