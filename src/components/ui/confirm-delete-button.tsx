"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ConfirmDeleteButtonProps {
  /** Fired once the user confirms. May be async; the button shows `pendingLabel` while it runs. */
  onConfirm: () => void | Promise<void>;
  /** Resting label (omit with `iconOnly` for a bare trash button). */
  label?: string;
  /** Second-step label the user clicks to actually delete. */
  confirmLabel?: string;
  pendingLabel?: string;
  /** Render the resting state as an icon-only button (for tight spots like board cards). */
  iconOnly?: boolean;
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  /**
   * Stop click/pointer events from reaching ancestors — required when the button lives inside a
   * clickable card/row (e.g. the board card's full-overlay link). Pair with `pointer-events-auto`.
   */
  stopPropagation?: boolean;
  /** Accessible name for the icon-only resting button. */
  title?: string;
}

/**
 * A destructive action gated behind an inline two-step confirm — no native `confirm()` and no
 * extra dialog. First click arms it (swaps in Confirm + Cancel); Confirm runs `onConfirm`. Arming
 * auto-disarms after a few seconds so a stray click doesn't leave a live delete button lying
 * around. Reused by the ticket modal, epic header, and board card.
 */
export function ConfirmDeleteButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Confirm delete",
  pendingLabel = "Deleting…",
  iconOnly = false,
  size = "sm",
  className,
  stopPropagation = false,
  title,
}: ConfirmDeleteButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  function stop(e: React.MouseEvent | React.PointerEvent) {
    if (stopPropagation) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function disarm() {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setArmed(false);
  }

  function arm(e: React.MouseEvent) {
    stop(e);
    setArmed(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setArmed(false), 4000);
  }

  async function confirm(e: React.MouseEvent) {
    stop(e);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setPending(true);
    try {
      await onConfirm();
      // On success the caller typically unmounts us (closes the modal / removes the card); if not,
      // fall through and disarm so the control returns to rest.
    } finally {
      setPending(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <Button
        type="button"
        variant={iconOnly ? "ghost" : "destructive"}
        size={iconOnly ? "icon-sm" : size}
        onClick={arm}
        onPointerDown={stop}
        title={title ?? label}
        className={cn(
          iconOnly && "text-subtle hover:text-destructive",
          className,
        )}
      >
        <Trash2Icon aria-hidden="true" />
        {iconOnly ? <span className="sr-only">{title ?? label}</span> : label}
      </Button>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Button
        type="button"
        variant="destructive"
        size={size}
        onClick={confirm}
        onPointerDown={stop}
        disabled={pending}
      >
        <Trash2Icon aria-hidden="true" />
        {pending ? pendingLabel : confirmLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={(e) => {
          stop(e);
          disarm();
        }}
        onPointerDown={stop}
        disabled={pending}
      >
        Cancel
      </Button>
    </span>
  );
}
