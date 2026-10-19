"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type MarkState = "idle" | "pending" | "done";

/**
 * Whether `el` is currently visible within the nearest scrollable ancestor (or the window, if
 * none). Used as a synchronous substitute for the IntersectionObserver's own (always-async)
 * initial read — see the module comment above.
 */
function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight || document.documentElement.clientHeight;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const containerRect = node.getBoundingClientRect();
      top = Math.max(top, containerRect.top);
      bottom = Math.min(bottom, containerRect.bottom);
      break;
    }
  }
  return rect.bottom > top && rect.top < bottom;
}

/**
 * The digest's own mark-seen affordance (anton-rokar): an explicit button, or reaching the end of
 * the page — either one calls mark-seen; opening the page never does.
 *
 * `until` is this read's own upper bound (`digest-read.ts`'s `ProjectDigest.until`), posted back
 * verbatim — the same "post the `until` you were handed" contract mark-seen/route.ts enforces, so
 * this can never mark past events the page did not actually show.
 *
 * The scroll trigger watches this component's OWN root with an IntersectionObserver rather than a
 * window scroll-position listener, so it fires however the surrounding layout scrolls and needs no
 * resize math. The baseline "already on screen" state is captured synchronously via
 * `getBoundingClientRect` right before `observe()` is called, NOT from the observer's first
 * callback (PR #350 review): that callback is delivered asynchronously, so a fast scroll straight
 * to the end between `observe()` and its delivery can already report `isIntersecting: true` on
 * what looks like the "initial" entry — treating that as the ignorable baseline would silently
 * drop the one event meant to trigger the automatic mark. Every entry in every callback batch is
 * processed (not just the batch's first) for the same reason: a fast scroll can coalesce the
 * baseline and the entering transition into one batch with two entries for this single target.
 */
export function MarkSeenFooter({ slug, until }: { slug: string; until: number }) {
  const [state, setState] = useState<MarkState>("idle");
  const stateRef = useRef<MarkState>("idle");
  const rootRef = useRef<HTMLDivElement>(null);

  const markSeen = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    stateRef.current = "pending";
    setState("pending");
    try {
      const res = await fetch(`/api/projects/${slug}/timeline/mark-seen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenAt: until }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      stateRef.current = "done";
      setState("done");
    } catch (err) {
      // Back to idle, not a stuck "error" state: a retry (another scroll, another click) should be
      // able to try again rather than the button staying dead for the rest of the visit.
      stateRef.current = "idle";
      setState("idle");
      toast.error(err instanceof Error ? err.message : "Failed to mark seen");
    }
  }, [slug, until]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const wasVisibleAtMount = isInViewport(el);
    let skippedInitial = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!skippedInitial) {
          skippedInitial = true;
          if (wasVisibleAtMount) continue;
        }
        if (entry.isIntersecting) void markSeen();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [markSeen]);

  return (
    <div ref={rootRef} className="flex flex-col items-center gap-2 py-8">
      <Button
        type="button"
        size="sm"
        variant={state === "done" ? "outline" : "default"}
        disabled={state !== "idle"}
        onClick={() => void markSeen()}
      >
        {state === "done" ? (
          <>
            <CheckIcon className="size-3.5" aria-hidden="true" />
            Marked as seen
          </>
        ) : state === "pending" ? (
          "Marking…"
        ) : (
          "Mark all as seen"
        )}
      </Button>
      <p className="text-[11px] text-subtle">You&rsquo;re at the end — this also marks it seen.</p>
    </div>
  );
}
