"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

/**
 * The Show/Hide fold the Housekeeping section collapses behind, exactly as `AttentionStrip` does on
 * the board — housekeeping is real but costs nothing until someone looks, so it reports as a summary
 * line with a disclosure rather than as rows competing with "Worth a look" for attention.
 *
 * Takes its content as `children` rather than a list prop: the rows themselves (bead links included)
 * are rendered by the Server Component that owns this disclosure, so the client boundary here is
 * exactly the open/closed toggle and nothing else.
 */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-muted-foreground">{summary}</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {open ? (
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRightIcon className="size-3.5" aria-hidden="true" />
          )}
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <div id={bodyId} className="pt-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}
