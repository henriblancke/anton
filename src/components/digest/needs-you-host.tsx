"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DigestNeedsYou } from "@/components/health/needs-you-section";
import { TicketDialog } from "@/components/ticket/ticket-dialog";
import type { DigestNeedsYouSummary } from "@/lib/attention";
import type { AutopilotBreaker } from "@/lib/autopilot-breaker";

/**
 * The digest page's one client boundary for its needs-you list (anton-rokar) — mirrors Health's
 * `TicketDialogHost` (ticket-dialog-host.tsx), except `DigestNeedsYou` already takes its callbacks
 * as explicit props (it composes `OperatorQueue`, which does the same) rather than reading a shared
 * context, so this host wires them directly instead of providing one.
 */
export function DigestNeedsYouHost({
  slug,
  summary,
  breaker,
}: {
  slug: string;
  summary: DigestNeedsYouSummary;
  /** The page's streamed breaker read — see `ProjectDigest.breaker` (digest-read.ts). */
  breaker?: Promise<AutopilotBreaker | undefined>;
}) {
  const router = useRouter();
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  return (
    <>
      <DigestNeedsYou
        slug={slug}
        summary={summary}
        breaker={breaker}
        onOpenTicket={setOpenTicketId}
        onDone={() => router.refresh()}
      />
      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
      />
    </>
  );
}
