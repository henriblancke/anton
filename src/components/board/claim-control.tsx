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
  className,
  onChanged,
}: {
  slug: string;
  itemId: string;
  /** The run target's current assignee (bead.assignee); null when unclaimed. */
  owner: string | null;
  /** Override the resolved operator identity (defaults to the shared useOperator hook). */
  operator?: string | null;
  /** `chip` — compact, for board cards/chips. `row` — inline, for the detail assignee rows. */
  variant?: "chip" | "row";
  /**
   * Show the owner without any claim/release/steal control. Set once a target is approved/locked:
   * the claim route 409s any write to an approved target (ownership then changes only via Approve's
   * steal-on-approve), so offering an action that can't succeed would be misleading.
   */
  readOnly?: boolean;
  className?: string;
  /** Fired with the new owner after a successful write so callers can refetch/update their copy. */
  onChanged?: (owner: string | null) => void;
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

  async function act(kind: "claim" | "release" | "steal") {
    const base = normalizedServerOwner;
    const optimisticValue = kind === "release" ? null : (operator ?? owner);
    setBusy(true);
    setOverride({ base, value: optimisticValue });
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${itemId}/claim`, {
        method: kind === "release" ? "DELETE" : "POST",
        ...(kind === "steal"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ steal: true }) }
          : {}),
      });
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
  const label = owner ?? "Unclaimed";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        isRow ? "text-[12.5px]" : "pointer-events-auto",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1",
          isRow ? "" : "font-mono text-[10px]",
          owner ? "text-foreground/85" : "text-subtle",
        )}
        title={
          readOnly
            ? owner
              ? `Claimed by ${owner} — locked while approved (take over via Approve)`
              : "Unclaimed — locked while approved"
            : owner
              ? `Claimed by ${owner}`
              : "Unclaimed"
        }
      >
        <UserIcon className={cn(isRow ? "size-3.5" : "size-3", "shrink-0")} aria-hidden="true" />
        <span className="truncate">{mine ? "You" : label}</span>
      </span>

      {readOnly ? null : owner === null ? (
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
      ) : null}
    </span>
  );
}

const LABEL: Record<"claim" | "release" | "steal", string> = {
  claim: "Claim",
  release: "Release",
  steal: "Steal",
};

const TOAST: Record<"claim" | "release" | "steal", string> = {
  claim: "Claimed",
  release: "Released",
  steal: "Claim stolen",
};

/**
 * Read-only owner display for a child ticket, which inherits its epic's human claim and has no
 * control of its own (claims live on the run target — the epic — not per child).
 */
export function InheritedOwner({
  owner,
  className,
}: {
  /** The parent epic's assignee; null when the epic is unclaimed. */
  owner: string | null;
  className?: string;
}) {
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
