"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

/**
 * The Show/Hide fold the Housekeeping section collapses behind — housekeeping is real but costs
 * nothing until someone looks, so it reports as a summary line with a disclosure rather than as rows
 * competing with "Worth a look" for attention. The board folded it the same way before the
 * health-page split (anton-4qf3) moved housekeeping here; the board no longer carries it at all.
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
      {/* Always mounted, hidden when closed, rather than conditionally rendered: `aria-controls`
          above points at this id, and an id that isn't in the DOM is a dangling reference for any
          assistive tech that dereferences it eagerly (ARIA 1.2 permits the forward reference, but
          permitting it is not the same as every AT implementation handling it). Keeping it mounted
          also means the fold never unmounts its children, so nested state survives a toggle. */}
      <div id={bodyId} hidden={!open} className="pt-1">
        {children}
      </div>
    </div>
  );
}
