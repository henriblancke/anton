"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OctagonXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KillError, requestKill, useArmedKill, type KillOutcome } from "@/components/runs/kill-job-button";

/** One job the batch route refused, with the reason it gave. */
export interface BatchKillFailure {
  jobId: string;
  error: string;
}

/** The batch route always answers 200 with both buckets — a refusal per job, never for the batch. */
export interface BatchKillResult {
  cancelled: string[];
  failed: BatchKillFailure[];
}

/** Kills a selected set of jobs in one call, normalised through the shared kill request. */
export function requestBatchJobKill(
  slug: string,
  jobIds: string[],
): Promise<KillOutcome<BatchKillResult>> {
  return requestKill<BatchKillResult>(`/api/projects/${slug}/jobs/cancel`, { jobIds });
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "job" : "jobs"}`;
}

/**
 * Bulk force-kill for the jobs the founder has selected on this page (anton-mjdo.5) — one action
 * to stop a runaway queue instead of arming and confirming twenty rows. Shares the per-row
 * control's arm/confirm/auto-disarm ({@link useArmedKill}) rather than forking it, so both obey
 * the same rule: only ids the server confirmed cancelled are reported killed. Per-job refusals come
 * back in the response's `failed` bucket and are listed here — those rows keep their own status.
 */
export function BulkKillJobsBar({
  slug,
  jobIds,
  onKilled,
  onClear,
}: {
  slug: string;
  /** The current selection, in row order. */
  jobIds: string[];
  /** Fired with the ids the server confirmed cancelled — never the whole selection. */
  onKilled: (cancelledIds: string[]) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const { armed, pending, error, arm, disarm, confirm } = useArmedKill();
  const [failures, setFailures] = useState<BatchKillFailure[]>([]);
  const count = jobIds.length;

  async function confirmKill() {
    const result = await confirm(() => requestBatchJobKill(slug, jobIds));
    if (!result.ok) return;
    setFailures(result.data.failed ?? []);
    if (result.data.cancelled?.length) {
      onKilled(result.data.cancelled);
      router.refresh();
    }
  }

  return (
    <div
      role="region"
      aria-label="Bulk job actions"
      className="ml-auto flex flex-col items-end gap-1.5"
    >
      <div className="flex items-center gap-2">
        <span aria-live="polite" className="font-mono text-[11px] text-muted-foreground">
          {plural(count)} selected
        </span>
        {armed ? (
          <>
            <Button size="xs" variant="destructive" onClick={confirmKill} disabled={pending}>
              <OctagonXIcon aria-hidden="true" />
              {pending ? `Killing ${plural(count)}…` : `Confirm kill ${plural(count)}`}
            </Button>
            <Button size="xs" variant="ghost" onClick={disarm} disabled={pending}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => {
                setFailures([]);
                arm();
              }}
            >
              <OctagonXIcon aria-hidden="true" />
              Force kill {plural(count)}
            </Button>
            <Button size="xs" variant="ghost" onClick={onClear} disabled={pending}>
              Clear selection
            </Button>
          </>
        )}
      </div>

      {error && <KillError>{error}</KillError>}

      {failures.length > 0 && (
        <ul role="alert" className="flex flex-col items-end gap-0.5">
          {failures.map((failure) => (
            <li key={failure.jobId} className="font-mono text-[11px] text-risk-high">
              {failure.jobId}: {failure.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
