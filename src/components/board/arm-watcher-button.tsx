"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EyeIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WatcherAutomation } from "@/lib/types";

/**
 * Arms the stall watcher from wherever its absence is being felt (anton-kh98) — so an operator who
 * just learned their queue is unwatched fixes it here, rather than being sent to find two switches
 * in a settings panel they had no reason to open.
 *
 * This is not a read-only switch, and the copy around it says so. The unstick half auto-resumes the
 * two stalls it can prove are safe — a park whose usage window has since reopened, and a bead whose
 * lease died with its machine — so the next sweep after this click can requeue work and spend quota.
 *
 * Still one click, unlike {@link ReArmButton}'s confirm step. A re-arm hands the picker authority to
 * START work the board never began; arming resumes work that was already approved and already
 * running, at the point it stopped. And the same two switches are one click in settings — a confirm
 * here would guard the shortcut while leaving the real switch open, which is theatre. What the
 * authority IS gets stated instead, in the band's copy and in this button's tooltip.
 *
 * Arms every disarmed half in one gesture: detect → act is only useful whole, and an operator who
 * armed run-health and left unstick off would get reports nothing ever raises — the exact silence
 * this button exists to end.
 */
export function ArmWatcherButton({
  slug,
  disarmed,
}: {
  slug: string;
  /** The automations that are off — arming turns on exactly these. */
  disarmed: WatcherAutomation[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function arm() {
    setPending(true);
    try {
      // Sequential, not concurrent: both writes land on the same schedules table through a
      // read-modify-write transaction, and two of those racing is what the settings panel's own
      // serialization exists to avoid.
      for (const type of disarmed) {
        const res = await fetch(`/api/projects/${slug}/schedules`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, enabled: true }),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      toast.success("Stall watcher on", {
        description: "The next sweep resumes quota and dead-lease stalls, and raises the rest here.",
      });
      // The band is server-rendered off the schedule rows, so a refresh is what clears it.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to turn the watcher on");
      setPending(false);
      // A partial arm is a different band (one half left off) — re-read rather than keep showing
      // the state this click started from.
      router.refresh();
    }
  }

  // Names the resume authority and not just the detection, matching the band's copy above it.
  const title =
    `Turn on ${disarmed.join(" and ")}: stalled work is detected, quota and dead-lease ` +
    "stalls resume themselves, and everything else is raised here";

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={pending}
      title={title}
      onClick={() => void arm()}
    >
      <EyeIcon aria-hidden="true" />
      {pending ? "Turning on…" : "Turn on the watcher"}
    </Button>
  );
}
