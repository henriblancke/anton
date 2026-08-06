"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { TicketDialog } from "@/components/ticket/ticket-dialog";

/**
 * The one client boundary the Health page needs (mirrors how `epic-board.tsx` hosts `TicketDialog`
 * with an `onOpenBead`/`setOpenTicketId` pair). The page itself is a read-only report — no polling,
 * no drag/drop — so the interactivity is narrowed to exactly this: a finding's bead id opens the
 * same detail dialog the board uses, instead of duplicating it.
 *
 * A Context, not prop-drilling, because the id can originate from any of four sections nested under
 * Server Components (`WorthALookSection`, `HousekeepingSection`, `AppliedSection`) — those stay plain
 * functions with no `"use client"` of their own, and only the leaf {@link HealthBeadLink} buttons
 * that actually call `onOpenBead` need to reach across the boundary.
 */
const OpenBeadContext = createContext<(beadId: string) => void>(() => {});

export function useOpenBead(): (beadId: string) => void {
  return useContext(OpenBeadContext);
}

export function TicketDialogHost({ slug, children }: { slug: string; children: ReactNode }) {
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  return (
    <OpenBeadContext.Provider value={setOpenTicketId}>
      {children}
      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
      />
    </OpenBeadContext.Provider>
  );
}
