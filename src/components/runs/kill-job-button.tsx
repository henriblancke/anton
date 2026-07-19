"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OctagonXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * POSTs the cancel route and normalises every failure — HTTP and network — into one shape, so the
 * caller can only ever render "killed" off a real 200 (anton-6jni). A 409 means the job went
 * terminal on its own; the row must keep its own status rather than claim the kill.
 */
export async function requestJobKill(
  slug: string,
  jobId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/projects/${slug}/jobs/${jobId}/cancel`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `Kill failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to kill job" };
  }
}

/**
 * Force-kill control for an in-flight job (anton-6jni). Destructive and unrecoverable — no
 * durability path brings a cancelled job back — so it's gated behind the project's inline two-step
 * confirm rather than firing on first click. Failures stay inline next to the button: a job that
 * refused to die must not read as killed.
 */
export function KillJobButton({
  slug,
  jobId,
  onKilled,
}: {
  slug: string;
  jobId: string;
  /** Fired only on a confirmed 200, so the row can show the terminal state before the refresh lands. */
  onKilled?: () => void;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  function disarm() {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setArmed(false);
  }

  // Auto-disarm so a stray click never leaves a live kill button sitting on a running job.
  function arm() {
    setError(null);
    setArmed(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setArmed(false), 4000);
  }

  async function confirmKill() {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setKilling(true);
    const result = await requestJobKill(slug, jobId);
    setKilling(false);
    setArmed(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onKilled?.();
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && (
        <span role="alert" className="max-w-56 truncate font-mono text-[11px] text-risk-high">
          {error}
        </span>
      )}
      {armed ? (
        <>
          <Button size="xs" variant="destructive" onClick={confirmKill} disabled={killing}>
            <OctagonXIcon aria-hidden="true" />
            {killing ? "Killing…" : "Confirm kill"}
          </Button>
          <Button size="xs" variant="ghost" onClick={disarm} disabled={killing}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="xs" variant="destructive" onClick={arm}>
          <OctagonXIcon aria-hidden="true" />
          Force kill
        </Button>
      )}
    </span>
  );
}
