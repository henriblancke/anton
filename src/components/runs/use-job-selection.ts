"use client";

import { useMemo, useState } from "react";

import type { JobSummary } from "@/lib/jobs-view";
import { selectableJobIds } from "@/components/runs/job-view-utils";

/** Stable empty selection, so a reset can't churn identity on every render. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface JobSelection {
  /** Rows the founder may act on in bulk, in row order. */
  selectableIds: string[];
  /** Selected ∩ selectable — what a bulk kill would act on. */
  selected: string[];
  allSelected: boolean;
  isSelected: (jobId: string) => boolean;
  isKilled: (jobId: string) => boolean;
  toggle: (jobId: string, checked: boolean) => void;
  selectAll: (checked: boolean) => void;
  clear: () => void;
  markKilled: (ids: string[]) => void;
}

/**
 * The jobs list's grouping and kill bookkeeping, held apart from what renders it. Confirmed kills
 * live here rather than per row so the bulk bar and the per-row button write to the same place —
 * only ever grown from a 200, so a refused kill leaves the job's own status alone.
 */
export function useJobSelection(jobs: JobSummary[]): JobSelection {
  const [killedIds, setKilledIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  // Selection may only ever cover rows on screen, so it is keyed to exactly the rows rendered.
  const rowsKey = useMemo(() => jobs.map((job) => job.id).join("|"), [jobs]);
  const [renderedRowsKey, setRenderedRowsKey] = useState(rowsKey);
  if (renderedRowsKey !== rowsKey) {
    // A different result set is on screen (filter or page changed) — drop the selection during
    // render so a stale one can never be killed against rows the founder is no longer looking at.
    // Local kill state goes with it: the freshly loaded rows carry the server's own status.
    setRenderedRowsKey(rowsKey);
    setSelectedIds(EMPTY_IDS);
    setKilledIds(EMPTY_IDS);
  }

  const selectableIds = selectableJobIds(jobs, killedIds);
  const selected = selectableIds.filter((id) => selectedIds.has(id));

  return {
    selectableIds,
    selected,
    allSelected: selectableIds.length > 0 && selected.length === selectableIds.length,
    isSelected: (jobId) => selectedIds.has(jobId),
    isKilled: (jobId) => killedIds.has(jobId),
    toggle: (jobId, checked) =>
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (checked) next.add(jobId);
        else next.delete(jobId);
        return next;
      }),
    selectAll: (checked) => setSelectedIds(checked ? new Set(selectableIds) : EMPTY_IDS),
    clear: () => setSelectedIds(EMPTY_IDS),
    markKilled: (ids) => {
      setKilledIds((prev) => new Set([...prev, ...ids]));
      setSelectedIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    },
  };
}
