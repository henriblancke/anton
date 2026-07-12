"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

interface CopyButtonProps {
  /** The text placed on the clipboard. */
  value: string;
  /** Visible content. Falls back to `value` when omitted. */
  children?: React.ReactNode;
  /** What is being copied, for the tooltip / a11y label (e.g. "epic id"). Defaults to `value`. */
  label?: string;
  className?: string;
  iconClassName?: string;
  /** Render only the copy icon (no visible value/children). */
  iconOnly?: boolean;
}

/**
 * Click-to-copy affordance used everywhere ids and worktree paths appear. Swaps to a check on
 * success and stops propagation so it stays clickable inside cards/rows without triggering their
 * navigation. See anton-a7g follow-ups.
 */
export function CopyButton({
  value,
  children,
  label,
  className,
  iconClassName,
  iconOnly = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handleCopy = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      } catch {
        toast.error("Couldn't copy to clipboard");
      }
    },
    [value],
  );

  const what = label ?? value;

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied" : `Copy ${what}`}
      aria-label={copied ? `Copied ${what}` : `Copy ${what}`}
      className={cn(
        "group/copy pointer-events-auto inline-flex max-w-full items-center gap-1 rounded text-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      {!iconOnly && (children ?? <span className="truncate">{value}</span>)}
      {copied ? (
        <CheckIcon
          className={cn("size-3 shrink-0 text-stage-done", iconClassName)}
          aria-hidden="true"
        />
      ) : (
        <CopyIcon
          className={cn(
            "size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
            iconClassName,
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
