"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OctagonXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** A kill either landed on a real 200 (carrying whatever the route reported) or it did not. */
export type KillOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * POSTs a cancel route and normalises every failure — HTTP and network — into one shape, so the
 * caller can only ever render "killed" off a real 200 (anton-6jni). A 409 means the job went
 * terminal on its own; the row must keep its own status rather than claim the kill. Shared by the
 * per-row and the batch kill so one refusal reads the same however it was triggered.
 */
export async function requestKill<T>(url: string, body?: unknown): Promise<KillOutcome<T>> {
  try {
    const res = await fetch(
      url,
      body === undefined
        ? { method: "POST" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const parsed = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
    if (!res.ok) {
      return { ok: false, error: parsed?.error ?? `Kill failed (${res.status})` };
    }
    // Both cancel routes always answer 200 with a JSON body, so an unparseable one is a broken
    // response — never a phantom success the batch caller would then read buckets off of.
    if (parsed === null) {
      return { ok: false, error: "Unexpected response from server" };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to kill job" };
  }
}

/** Kills one job through the project-scoped single-job route. */
export function requestJobKill(slug: string, jobId: string): Promise<KillOutcome<unknown>> {
  return requestKill(`/api/projects/${slug}/jobs/${jobId}/cancel`);
}

/** Arming window: long enough to read the confirm, short enough that a stray arm expires unseen. */
const DISARM_MS = 4000;

/**
 * The inline two-step confirm behind every kill — arm, confirm, auto-disarm — owned in one place
 * so the per-row and bulk controls can't drift (anton-mjdo.5). The action must resolve rather than
 * throw ({@link requestKill} guarantees that): `error` is only ever set from a normalised failure,
 * and the caller only learns of a kill from the returned `ok: true`.
 */
export function useArmedKill() {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  const disarm = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setArmed(false);
  }, []);

  // Auto-disarm so a stray click never leaves a live kill button sitting on a running job.
  const arm = useCallback(() => {
    setError(null);
    setArmed(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setArmed(false), DISARM_MS);
  }, []);

  const confirm = useCallback(async <T,>(action: () => Promise<KillOutcome<T>>) => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setPending(true);
    const result = await action();
    setPending(false);
    setArmed(false);
    setError(result.ok ? null : result.error);
    return result;
  }, []);

  return { armed, pending, error, arm, disarm, confirm };
}

/** Inline, truncated failure copy — a job that refused to die must never read as killed. */
export function KillError({ children }: { children: React.ReactNode }) {
  return (
    <span role="alert" className="max-w-56 truncate font-mono text-[11px] text-risk-high">
      {children}
    </span>
  );
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
  const { armed, pending, error, arm, disarm, confirm } = useArmedKill();

  async function confirmKill() {
    const result = await confirm(() => requestJobKill(slug, jobId));
    if (!result.ok) return;
    onKilled?.();
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && <KillError>{error}</KillError>}
      {armed ? (
        <>
          <Button size="xs" variant="destructive" onClick={confirmKill} disabled={pending}>
            <OctagonXIcon aria-hidden="true" />
            {pending ? "Killing…" : "Confirm kill"}
          </Button>
          <Button size="xs" variant="ghost" onClick={disarm} disabled={pending}>
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
