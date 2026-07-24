"use client";

import { useLinkStatus } from "next/link";
import { LoaderCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Instant click feedback for a `next/link` `<Link>` — must render as a descendant of one.
 * The slot is always mounted at a fixed size so toggling never shifts layout; while the
 * navigation is pending it swaps `idle` for a spinner (delayed ~120ms via
 * `anton-nav-pending-in` so prefetched, instant transitions never flash it).
 *
 * Exposes `data-pending` so the parent link can dim itself with a
 * `has-[[data-pending]]:opacity-*` variant.
 */
export function LinkPendingIndicator({
  className,
  idle,
}: {
  className?: string;
  /** Rendered when no navigation is pending (e.g. a chevron the spinner replaces). */
  idle?: React.ReactNode;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      data-pending={pending || undefined}
      aria-hidden="true"
      className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}
    >
      {pending ? (
        <span className="anton-nav-pending-in inline-flex size-full items-center justify-center">
          <LoaderCircleIcon className="size-full animate-spin motion-reduce:animate-none" />
        </span>
      ) : (
        idle
      )}
    </span>
  );
}
