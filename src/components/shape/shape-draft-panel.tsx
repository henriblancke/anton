"use client";

import type { EpicChoice } from "@/lib/backlog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DraftFields } from "./shape-draft-fields";
import { submitHint } from "./shape-draft";
import type { ShapeDraft } from "./use-shape-draft";

const IDLE_HINT = "Lands as an open feature · unapproved";

/**
 * The right pane before shaping starts. The panel is bimodal, so each mode is its own component
 * rather than a `started ?` threaded through every status, field, and footer prop.
 */
export function IdleDraftPanel() {
  return (
    <DraftPanelShell status="not started" footer={<SubmitFooter disabled hint={IDLE_HINT} />}>
      <p className="text-xs leading-relaxed text-subtle">
        Describe the work on the left and start shaping. As the conversation converges, the
        feature&apos;s contract and the epic it hangs off form here — then send it to backlog.
      </p>
    </DraftPanelShell>
  );
}

/** The right pane while a session is live: the feature contract, its epic, and the gated Send. */
export function ShapingDraftPanel({
  draft,
  areas,
  epics,
  sending,
  onSend,
}: {
  draft: ShapeDraft;
  areas: string[];
  epics: EpicChoice[];
  sending: boolean;
  onSend: () => void;
}) {
  return (
    <DraftPanelShell
      status="shaping…"
      footer={
        <SubmitFooter
          disabled={!draft.complete || sending}
          invalid={!draft.areaValid}
          hint={submitHint(draft.gaps, draft.areaValid)}
          onSend={onSend}
        />
      }
    >
      <DraftFields draft={draft} areas={areas} epics={epics} />
    </DraftPanelShell>
  );
}

function DraftPanelShell({
  status,
  footer,
  children,
}: {
  status: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <span className="text-[13px] font-semibold">Draft feature</span>
        <span className="ml-auto font-mono text-[10px] text-subtle">{status}</span>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">{children}</div>
      {footer}
    </div>
  );
}

/** A disabled Send always says why: the hint carries the refusal, the colour marks a bad area. */
function SubmitFooter({
  disabled,
  hint,
  invalid,
  onSend,
}: {
  disabled: boolean;
  hint: string;
  invalid?: boolean;
  onSend?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-card/40 px-5 py-4">
      <Button className="w-full" disabled={disabled} onClick={onSend}>
        Send to backlog
      </Button>
      <span
        className={cn("text-center text-[11px]", invalid ? "text-destructive" : "text-subtle")}
      >
        {hint}
      </span>
    </div>
  );
}
