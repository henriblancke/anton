"use client";

import { useState } from "react";
import { toast } from "sonner";
import { UserIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useOperator } from "@/lib/use-operator";

/**
 * The human-claim control shared by every run-target surface (epic card, standalone chip, epic
 * detail, ticket dialog). A run target is claimed by assignee only — it does NOT approve or start a
 * run (that's the Approve affordance) — so this maps directly onto the claim route:
 *   - unclaimed        → Claim   (POST /epics/<id>/claim)
 *   - claimed by me    → Release (DELETE /epics/<id>/claim)
 *   - claimed by other → Steal   (POST … { steal: true }), with the owner shown
 *
 * Once approved the claim route locks the assignee (409), and ownership moves only via
 * steal-on-approve. `readOnly` + `canTakeOver` surfaces that one path as Take over
 * (POST /epics/<id>/approve { steal: true }) so the documented flow is reachable from the UI.
 *
 * Writes are optimistic: the shown owner flips immediately and reverts on failure, and the route's
 * error (which names the current owner + the required action, e.g. a lost steal race) surfaces as a
 * toast. `owner` is the server truth (the bead's assignee); when a later poll/refetch moves it past
 * our optimistic base we drop the override and follow the server again.
 */
export function ClaimControl({
  slug,
  itemId,
  owner: serverOwner,
  operator: operatorProp,
  variant = "chip",
  readOnly = false,
  canTakeOver = false,
  className,
  onChanged,
  children,
}: {
  slug: string;
  itemId: string;
  /** The run target's current assignee (bead.assignee); null when unclaimed. */
  owner: string | null;
  /** Override the resolved operator identity (defaults to the shared useOperator hook). */
  operator?: string | null;
  /**
   * `chip` — compact inline, for board cards/chips. `row` — inline, for the detail assignee rows.
   * `stack` — owner name on its own line above the action button, so extra buttons passed as
   * `children` sit beside the claim button in the row below the name (used on the epic card).
   */
  variant?: "chip" | "row" | "stack";
  /**
   * Drop the claim/release/steal controls. Set once a target is approved/locked: the claim route
   * 409s any write to an approved target (ownership then changes only via Approve's
   * steal-on-approve), so offering an action that can't succeed would be misleading.
   */
  readOnly?: boolean;
  /**
   * Whether taking over is offered here. Set it for a `backlog` target: the run is approved but hasn't
   * started, so reassigning it only changes who owns the pending work. Callers leave it false past
   * backlog — a run that is implementing/in-review is already executing under its owner's reservation,
   * and moving that out from under it is a separate decision, not a claim-control affordance.
   *
   * Take over never spawns a duplicate concurrent run: the approve route only enqueues under the new
   * owner when this instance has no job for the epic yet (a cross-instance take-over, where the
   * original owner's job lives on their machine); a same-instance take-over reuses the existing job.
   * See its enqueue gate. Only consulted with `readOnly`; an unapproved target uses the claim-route Steal.
   */
  canTakeOver?: boolean;
  className?: string;
  /** Fired with the new owner after a successful write so callers can refetch/update their copy. */
  onChanged?: (owner: string | null) => void;
  /** Extra buttons rendered in the action row beside the claim button (only in `stack` variant). */
  children?: React.ReactNode;
}) {
  const hookOperator = useOperator();
  const operator = operatorProp !== undefined ? operatorProp : hookOperator;
  const [busy, setBusy] = useState(false);
  // Beads represents a released/never-claimed assignee as "" (`bd assign <id> ""`), not null. Fold an
  // empty/whitespace owner to null so a just-released target reads as Unclaimed (Claim) rather than a
  // blank owner with a Steal button. Applied to both the server prop and the write response below.
  const normalizedServerOwner = serverOwner?.trim() || null;
  // Optimistic override keyed on the server value it was based on. While the server prop still
  // equals `base`, show `value`; once the server moves past `base` (our write landed, or a teammate
  // changed it), discard the override during render and follow the server truth.
  const [override, setOverride] = useState<{ base: string | null; value: string | null } | null>(null);
  if (override && override.base !== normalizedServerOwner) setOverride(null);
  const owner =
    override && override.base === normalizedServerOwner ? override.value : normalizedServerOwner;

  // A known identity is required to claim/release/steal (the route rejects a write it can't attribute
  // to an operator). Until the identity resolves — or when none can be — the owner shows read-only.
  const known = typeof operator === "string" && operator.length > 0;
  const mine = known && owner === operator;

  async function act(kind: Action) {
    const base = normalizedServerOwner;
    const optimisticValue = kind === "release" ? null : (operator ?? owner);
    setBusy(true);
    setOverride({ base, value: optimisticValue });
    try {
      // Take over goes to the approve route (the claim route 409s an approved target); both routes
      // answer with `{ item: { assignee } }` and an `{ error }` naming the owner, so the response
      // handling below is shared.
      const res = await fetch(
        `/api/projects/${slug}/epics/${itemId}/${kind === "takeover" ? "approve" : "claim"}`,
        {
          method: kind === "release" ? "DELETE" : "POST",
          ...(kind === "steal" || kind === "takeover"
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ steal: true }) }
            : {}),
        },
      );
      const data = (await res.json().catch(() => null)) as { item?: { assignee?: string | null }; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `${LABEL[kind]} failed (${res.status})`);
      // Normalize the same way as the prop: a release response carries assignee "" — fold it to null
      // so the optimistic value resolves to Unclaimed, not a blank owner.
      const next = data?.item?.assignee?.trim() || null;
      setOverride({ base, value: next });
      onChanged?.(next);
      toast.success(TOAST[kind]);
    } catch (err) {
      setOverride(null); // revert to server truth
      toast.error(err instanceof Error ? err.message : `${LABEL[kind]} failed`);
    } finally {
      setBusy(false);
    }
  }

  const isRow = variant === "row";
  const isStack = variant === "stack";
  const label = owner ?? "Unclaimed";
  // The one ownership move an approved target allows: steal-on-approve, offered only where the caller
  // vouched it won't start a second run (`canTakeOver`). Nothing to take over when it's unclaimed or
  // already ours.
  const takeOverable = readOnly && canTakeOver && known && owner !== null && !mine;

  const nameEl = (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        isRow ? "" : "font-mono text-[10px]",
        owner ? "text-foreground/85" : "text-subtle",
      )}
      title={
        readOnly
          ? owner
            ? takeOverable
              ? `Claimed by ${owner} — approved; take over re-approves it under your name`
              : `Claimed by ${owner} — locked while approved`
            : "Unclaimed — locked while approved"
          : owner
            ? `Claimed by ${owner}`
            : "Unclaimed"
      }
    >
      <UserIcon className={cn(isRow ? "size-3.5" : "size-3", "shrink-0")} aria-hidden="true" />
      <span className="truncate">{mine ? "You" : label}</span>
    </span>
  );

  const actionEl = readOnly ? (
    takeOverable ? (
      <Button size="xs" variant="outline" onClick={() => act("takeover")} disabled={busy}>
        <UserPlusIcon aria-hidden="true" />
        {busy ? "Taking over…" : "Take over"}
      </Button>
    ) : null
  ) : owner === null ? (
    known ? (
      <Button size="xs" variant="outline" onClick={() => act("claim")} disabled={busy}>
        <UserPlusIcon aria-hidden="true" />
        {busy ? "Claiming…" : "Claim"}
      </Button>
    ) : null
  ) : mine ? (
    <Button size="xs" variant="ghost" onClick={() => act("release")} disabled={busy}>
      <UserMinusIcon aria-hidden="true" />
      {busy ? "Releasing…" : "Release"}
    </Button>
  ) : known ? (
    <Button size="xs" variant="outline" onClick={() => act("steal")} disabled={busy}>
      {busy ? "Stealing…" : "Steal"}
    </Button>
  ) : null;

  // Stack — owner name on its own line, then a button row where the claim action sits beside any
  // extra buttons (Approve, delete) the caller passes as children.
  if (isStack) {
    return (
      <div className={cn("pointer-events-auto flex flex-col gap-2", className)}>
        {nameEl}
        <div className="flex items-center gap-2">
          {actionEl}
          {children}
        </div>
      </div>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        isRow ? "text-[12.5px]" : "pointer-events-auto",
        className,
      )}
    >
      {nameEl}
      {actionEl}
    </span>
  );
}

type Action = "claim" | "release" | "steal" | "takeover";

const LABEL: Record<Action, string> = {
  claim: "Claim",
  release: "Release",
  steal: "Steal",
  takeover: "Take over",
};

const TOAST: Record<Action, string> = {
  claim: "Claimed",
  release: "Released",
  steal: "Claim stolen",
  takeover: "Taken over",
};

/**
 * Read-only owner display for a child ticket, which inherits its epic's human claim and has no
 * control of its own (claims live on the run target — the epic — not per child).
 */
export function InheritedOwner({
  owner: epicOwner,
  className,
}: {
  /** The parent epic's assignee; null when the epic is unclaimed. */
  owner: string | null;
  className?: string;
}) {
  // A released epic claim arrives as "" (`bd assign <id> ""`), which would otherwise render as a
  // blank owner under an "unclaimed" title. Fold it to null exactly as ClaimControl does.
  const owner = epicOwner?.trim() || null;
  return (
    <span
      className={cn("inline-flex items-center gap-1", owner ? "text-foreground/85" : "text-subtle", className)}
      title={owner ? `Inherited from the epic, claimed by ${owner}` : "The epic is unclaimed"}
    >
      <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{owner ?? "Unclaimed"}</span>
      <span className="text-subtle">· inherited</span>
    </span>
  );
}

/**
 * Read-only owner display for a parentless bead that is NOT a run target (a `learning`/`chore`/etc.
 * with no epic): the claim route 422s it via `isRunTarget`, so it has no interactive claim control —
 * we just surface its assignee, mirroring InheritedOwner's shape without the epic-inheritance framing.
 */
export function StaticOwner({
  owner: rawOwner,
  className,
}: {
  /** The bead's assignee; null when unclaimed. */
  owner: string | null;
  className?: string;
}) {
  const owner = rawOwner?.trim() || null;
  return (
    <span
      className={cn("inline-flex items-center gap-1", owner ? "text-foreground/85" : "text-subtle", className)}
      title={owner ? `Claimed by ${owner}` : "Unclaimed — not a run target"}
    >
      <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{owner ?? "Unclaimed"}</span>
    </span>
  );
}
