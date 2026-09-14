"use client";

import { useOpenBead } from "./ticket-dialog-host";

/**
 * A bead id that opens the shared ticket dialog — the interactive leaf every section's Server
 * Component renders instead of taking on its own `"use client"`. `getTicketDetail` resolves any bead
 * in the project's snapshot (task, bug, epic, feature), so this needs no fallback to a plain link:
 * every id a hygiene finding or a patrol action can name is one this dialog can open.
 */
export function HealthBeadLink({ id }: { id: string }) {
  const onOpenBead = useOpenBead();
  return (
    <button
      type="button"
      onClick={() => onOpenBead(id)}
      className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      title={`Open ${id}`}
    >
      {id}
    </button>
  );
}
