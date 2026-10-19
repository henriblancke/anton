"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type MarkState = "idle" | "pending" | "done";

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
 * resize math. Its first callback is deliberately IGNORED: that callback reports the state the
 * observer found on `observe()`, not a scroll the operator made — on a short or empty window this
 * footer can already be on screen before anything moved, and opening the page must never read as
 * having reached its end.
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
    let skippedInitial = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (!skippedInitial) {
        skippedInitial = true;
        return;
      }
      if (entry.isIntersecting) void markSeen();
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
