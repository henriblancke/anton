"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PowerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The one button that resumes unattended execution after a quality signal stopped it (anton-5c8h).
 *
 * Two-step, unlike every other one-click affordance on this board. A re-arm is not idempotent in the
 * way Resume or Dismiss are: it hands the picker back the authority to start work off the same
 * signal that just said the work was getting worse, and the operator is meant to have read the
 * evidence above it first. The confirm step is the cost of that reading.
 *
 * Who re-armed is the SERVER's answer, never this component's — the route resolves the operator
 * identity — and the toast repeats it back so the author of the decision is visible at the moment
 * it's made, not only in the record.
 */
export function ReArmButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [armed, setArmed] = useState(false);

  async function reArm() {
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${slug}/autopilot/re-arm`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; rearmedBy?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      toast.success("Autopilot re-armed", {
        description: body?.rearmedBy ? `Recorded as ${body.rearmedBy}.` : undefined,
      });
      // The band is read from the server off the latch, so a refresh is what removes it — the board
      // drops its own polled copy the moment a fresh read arrives.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-arm autopilot");
      setPending(false);
      setArmed(false);
      // A refused re-arm usually means someone else already lifted it — re-read rather than leave a
      // band that errors on every subsequent click.
      router.refresh();
    }
  }

  if (!armed) {
    return (
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending}
        title="Clear the breaker and let anton start work again — recorded against your operator identity"
        onClick={() => setArmed(true)}
      >
        <PowerIcon aria-hidden="true" />
        Re-arm
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="destructive"
        disabled={pending}
        onClick={() => void reArm()}
      >
        <PowerIcon aria-hidden="true" />
        {pending ? "Re-arming…" : "Confirm re-arm"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending}
        onClick={() => setArmed(false)}
      >
        Cancel
      </Button>
    </>
  );
}
