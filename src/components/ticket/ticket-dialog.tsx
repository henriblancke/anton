"use client";

import type { TicketDetail } from "@/lib/types";
import { ErrorState } from "@/components/ui/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TicketDetailsSection } from "./ticket-details-section";
import { ContractField, TitleField } from "./ticket-dialog-fields";
import { TicketDialogFooter } from "./ticket-dialog-footer";
import { TicketDialogHeader } from "./ticket-dialog-header";
import { TicketNotes } from "./ticket-notes";
import { TicketStateBar } from "./ticket-state-bar";
import { useTicketDialog, type LoadedTicket, type TicketDialogModel } from "./use-ticket-dialog";

export interface TicketDialogProps {
  slug: string;
  /** The ticket to inspect; the dialog fetches its detail when opened. */
  ticketId: string | null;
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save, with the refreshed detail — so call sites can refetch lists. */
  onSaved?: (detail: TicketDetail) => void;
  /** Fired after a successful delete — so call sites can drop the ticket from their lists. */
  onDeleted?: (ticketId: string) => void;
}

/**
 * Controlled popup showing a ticket's full contract in ONE always-editable form: every field is
 * live (no view↔edit toggle), Save PATCHes only what changed, and Delete removes the bead behind
 * an inline confirm. Body is keyed on `ticketId` so switching tickets fully remounts it (fresh
 * fetch + fresh draft).
 */
export function TicketDialog({ slug, ticketId, open, onClose, onSaved, onDeleted }: TicketDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* Widen as the viewport allows — the contract textareas + notes get room, and the Details grid
          breathes — while the mobile cap (max-w-[calc(100%-2rem)]) still keeps it inset on small screens.
          `pb-0` drops the scroll container's bottom padding so the sticky footer can pin truly flush to
          the modal's bottom edge (no padding gap, no negative-margin compensation). */}
      <DialogContent className="max-h-[85vh] overflow-y-auto pb-0 sm:max-w-xl md:max-w-2xl xl:max-w-3xl">
        <DialogTitle className="sr-only">{ticketId ? `Ticket ${ticketId}` : "Ticket"}</DialogTitle>
        <DialogDescription className="sr-only">
          View and edit this ticket&apos;s fields.
        </DialogDescription>
        {open && ticketId ? (
          <TicketDialogBody
            key={ticketId}
            slug={slug}
            ticketId={ticketId}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The read's three outcomes — failed, still loading, loaded — and nothing else. */
function TicketDialogBody({
  slug,
  ticketId,
  onSaved,
  onDeleted,
  onClose,
}: {
  slug: string;
  ticketId: string;
  onSaved?: (detail: TicketDetail) => void;
  onDeleted?: (ticketId: string) => void;
  onClose: () => void;
}) {
  const model = useTicketDialog({ slug, ticketId, onSaved, onDeleted, onClose });

  if (model.error) {
    return <ErrorState message={model.error} onRetry={model.retry} layout="dialog" />;
  }
  if (!model.loaded) return <TicketDialogSkeleton />;
  return <TicketDialogForm slug={slug} ticketId={ticketId} loaded={model.loaded} model={model} />;
}

/**
 * A render of `useTicketDialog` — the behaviour lives there, the layout is spelled out here:
 * identity, then state, then the always-editable contract, then the notes channel, then the actions.
 */
function TicketDialogForm({
  slug,
  ticketId,
  loaded: { detail, draft },
  model,
}: {
  slug: string;
  ticketId: string;
  loaded: LoadedTicket;
  model: TicketDialogModel;
}) {
  return (
    <div className="flex flex-col gap-4">
      <TicketDialogHeader
        slug={slug}
        detail={detail}
        approved={model.approved}
        onLinked={model.reloadAfterLink}
        onClaimChanged={model.retry}
      />

      {/* state — stage track + Active/Snoozed/Abandoned resolution, replacing the header chips,
          the Status `deferred` special-case, and the footer Snooze/Abandon buttons */}
      <TicketStateBar
        slug={slug}
        ticketId={ticketId}
        detail={detail}
        onChanged={model.onStateChanged}
      />

      <TitleField value={draft.title} onChange={(v) => model.set("title", v)} />

      <TicketDetailsSection draft={draft} deferred={detail.deferred} set={model.set} />

      <ContractField
        label="Goal"
        value={draft.goal}
        onChange={(v) => model.set("goal", v)}
        rows={3}
        placeholder="What this ticket accomplishes."
      />

      <ContractField
        label="Acceptance"
        value={draft.acceptance}
        onChange={(v) => model.set("acceptance", v)}
        rows={5}
        placeholder={"One criterion per line, e.g.\n- [ ] Edit mode gains contract editing"}
      />

      <ContractField
        label="Description"
        hint="Context, Out of scope, Verify — the rest of the contract"
        value={draft.body}
        onChange={(v) => model.set("body", v)}
        rows={6}
        placeholder="The remaining contract markdown."
      />

      {/* Notes stay first-class and open beside the contract — the steering the executor reads at
          dispatch. A left accent rail marks it as its own channel, not just another field (anton-q02q). */}
      <div className="rounded-xl border border-border bg-raised/30 p-3.5 shadow-[inset_2px_0_0_var(--primary)]">
        <TicketNotes
          slug={slug}
          ticketId={ticketId}
          notes={detail.notes}
          onAppended={model.onNotesAppended}
        />
      </div>

      <TicketDialogFooter
        detail={detail}
        approved={model.approved}
        running={model.running}
        saving={model.saving}
        changed={model.changed}
        onRun={model.run}
        onReset={model.reset}
        onSave={model.save}
        onDelete={model.remove}
      />
    </div>
  );
}

function TicketDialogSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading ticket">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="anton-shimmer h-3 w-24 rounded" />
          <span className="anton-shimmer h-6 w-20 rounded-full" />
        </div>
        <span className="anton-shimmer h-5 w-3/4 rounded" />
        <div className="flex gap-1.5">
          <span className="anton-shimmer h-4 w-16 rounded-md" />
          <span className="anton-shimmer h-4 w-16 rounded-md" />
        </div>
      </div>
      <span className="anton-shimmer h-3 w-1/4 rounded" />
      <span className="anton-shimmer h-14 w-full rounded" />
    </div>
  );
}
