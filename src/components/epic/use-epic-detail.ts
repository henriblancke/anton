"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { EpicDetail, ReviewReport } from "@/lib/types";
import { toastContractAdvisory } from "@/components/board/contract-advisory";

/** How a run is paced and worded — `force` re-triggers an in-flight run, `immediate` bypasses pacing. */
export interface RunOptions {
  force?: boolean;
  immediate?: boolean;
}

/** Everything the detail page renders from and every way it can be driven. */
export interface EpicDetailModel {
  /** The settled read; absent while the first fetch is in flight or it failed. */
  detail: EpicDetail | null;
  error: string | null;
  review: ReviewReport | undefined;
  reviewError: string | null;
  reviewLoading: boolean;
  /** Re-run both reads — the error state's retry, and after any write that moved the board. */
  refresh: () => void;
  /** A run POST is in flight; the actions disable rather than double-firing. */
  running: boolean;
  run: (title: string, opts?: RunOptions) => Promise<void>;
  remove: (title: string) => Promise<void>;
  copyWorktreePath: (worktreePath: string) => Promise<void>;
}

/** What the page is looking at — the two reads and the three writes all key off this pair. */
interface EpicTarget {
  slug: string;
  epicId: string;
}

/**
 * The epic detail page's state, held away from its markup so the view stays a render of this model
 * (mirrors `useTicketDialog`). The snapshot and the self-review history are two independent reads,
 * fired in the same commit rather than in sequence: the page paints off the snapshot while the score
 * series fills in.
 */
export function useEpicDetail(target: EpicTarget): EpicDetailModel {
  const [attempt, setAttempt] = useState(0);
  const refresh = () => setAttempt((n) => n + 1);
  const snapshot = useEpicSnapshot(target, attempt);
  const history = useReviewHistory(target, attempt);
  const actions = useEpicActions(target, refresh);

  return { ...snapshot, ...history, refresh, ...actions };
}

/** The detail read itself — the epic, its tickets and their edges, as one deliberately spawn-free GET. */
function useEpicSnapshot({ slug, epicId }: EpicTarget, attempt: number) {
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${epicId}`);
        if (!res.ok) throw new Error(`Failed to load epic (${res.status})`);
        const data = (await res.json()) as { detail: EpicDetail };
        if (cancelled) return;
        setDetail(data.detail);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Failed to load epic"));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, epicId, attempt]);

  return { detail, error };
}

/**
 * The self-review history (anton-tprv), read beside the detail rather than inside it: it costs a
 * hydrated `bd show --include-comments`, and the detail open is deliberately spawn-free (anton-8s1t).
 */
function useReviewHistory({ slug, epicId }: EpicTarget, attempt: number) {
  const [review, setReview] = useState<ReviewReport | undefined>(undefined);
  // Stamped with the read it belongs to, so a failure expires the moment a new one goes out: the
  // retry must render as loading, not as the error it is retrying, and `reviewLoading` is derived
  // from this being null. Stamping rather than clearing keeps the effect free of a cascading
  // setState.
  const [failure, setFailure] = useState<{ read: string; message: string } | null>(null);
  const read = `${slug}/${epicId}/${attempt}`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${epicId}/review`);
        if (!res.ok) throw new Error(`Couldn't load the self-review history (${res.status})`);
        const data = (await res.json()) as { report: ReviewReport };
        if (cancelled) return;
        setReview(data.report);
        setFailure(null);
      } catch (err) {
        // A history that can't be read never blocks the page: the score is a record of past runs,
        // and every action here operates on the beads, not on it.
        if (!cancelled) {
          setFailure({ read, message: errorMessage(err, "Couldn't load the self-review history") });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, epicId, read]);

  const reviewError = failure?.read === read ? failure.message : null;
  return { review, reviewError, reviewLoading: review === undefined && reviewError === null };
}

/** The three writes the page offers: start a run, delete the target, take its worktree path. */
function useEpicActions({ slug, epicId }: EpicTarget, refresh: () => void) {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function run(title: string, opts: RunOptions = {}) {
    // `immediate` carries the run-directly choice (anton-d8i4): true → execute now (bypass pacing),
    // false → queue for optimal usage. Defaults to immediate so the single run/force-run button (and
    // any non-budget-aware project) behaves as it always has — run now.
    const immediate = opts.immediate ?? true;
    setRunning(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epicId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ immediate }),
      });
      if (!res.ok) throw new Error(await failureMessage(res, `Run failed (${res.status})`));
      toast.success(runOutcomeMessage({ force: opts.force, immediate, title }));
      // The run starts with whatever thin sections it has; say so once, here.
      await toastContractAdvisory(res);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "Failed to start run"));
    } finally {
      setRunning(false);
    }
  }

  async function remove(title: string) {
    const res = await fetch(`/api/projects/${slug}/epics/${epicId}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await failureMessage(res, `Delete failed (${res.status})`));
      return;
    }
    toast.success(`Deleted "${title}"`);
    router.push(`/projects/${slug}`);
  }

  async function copyWorktreePath(worktreePath: string) {
    try {
      await navigator.clipboard.writeText(worktreePath);
      toast.success("Worktree path copied", { description: worktreePath });
    } catch {
      toast.error("Couldn't copy worktree path");
    }
  }

  return { running, run, remove, copyWorktreePath };
}

/** What an accepted run is reported as — a re-trigger, a run now, or a queued one. */
export function runOutcomeMessage({
  force,
  immediate,
  title,
}: {
  force?: boolean;
  immediate: boolean;
  title: string;
}): string {
  if (force) return `Re-running "${title}"`;
  return immediate ? `Run started for "${title}"` : `Queued "${title}" for optimal usage`;
}

/** The reason the route gave for refusing a write, or the status-code fallback. */
async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
