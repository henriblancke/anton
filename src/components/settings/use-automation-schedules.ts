"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { describeCron } from "@/lib/jobs/cadence";
import type { AutomationScheduleState } from "@/components/settings/automation-table";
import { AUTOMATIONS, SCHEDULE_POLL_MS } from "@/components/settings/settings-constants";
import type { AutomationSchedule } from "@/components/settings/settings-types";

/** The fields one PATCH may write. Both are optional — a toggle and a cadence edit are separate. */
type SchedulePatch = { cron?: string; enabled?: boolean };

type ScheduleState = Record<string, AutomationScheduleState>;

/**
 * A PATCH and the poll both write the same rows, and the PATCH is the one that knows the truth —
 * its response carries the server's recomputed nextRunAt. These two counters let a poll recognise
 * that it raced a write and drop its own (pre-write) answer rather than applying it on top:
 * `inFlight` catches a write still running, `completed` a write that started AND finished inside the
 * poll's request window, which a plain in-flight check would miss entirely.
 */
interface WriteGuard {
  inFlight: number;
  completed: number;
}

export interface AutomationSchedules {
  state: ScheduleState;
  toggle: (id: string, next: boolean) => Promise<void>;
  setCron: (id: string, cron: string) => Promise<void>;
}

/**
 * The scheduled automations' rows, saved on change rather than on Save.
 *
 * Lives above the panel it feeds so an optimistic cadence edit survives a trip to another section —
 * remounting the panel would re-seed from the SSR snapshot and put the old cadence back on screen.
 */
export function useAutomationSchedules({
  slug,
  schedules,
  defaultCrons,
  polling,
}: {
  slug: string;
  schedules: AutomationSchedule[];
  defaultCrons: Record<string, string>;
  /** Only the open panel polls; the rows are static to everyone else. */
  polling: boolean;
}): AutomationSchedules {
  const [state, setState] = useState<ScheduleState>(() => seedRows(schedules, defaultCrons));
  const writes = useRef<WriteGuard>({ inFlight: 0, completed: 0 });
  useSchedulePoll({ slug, polling, writes, setState });

  /**
   * Persist one automation's cadence and/or enabled flag immediately (not via Save) — optimistic,
   * reverted with a toast if the PATCH fails. A missing row is created server-side. The response
   * carries the row as stored, so the next-run readout is the server's recomputed nextRunAt rather
   * than a guess made here.
   */
  async function patchSchedule(id: string, patch: SchedulePatch, message: string) {
    const prev = state[id];
    setState((p) => ({ ...p, [id]: { ...prev, ...patch } }));
    writes.current.inFlight += 1;
    try {
      const stored = await putSchedule(slug, id, patch);
      if (stored) setState((p) => ({ ...p, [id]: stored }));
      toast.success(message);
    } catch (err) {
      setState((p) => ({ ...p, [id]: reverted(p[id], prev, patch) }));
      toast.error(err instanceof Error ? err.message : `Failed to update ${id}`);
    } finally {
      // In `finally` so a rejected patch also clears the in-flight count — otherwise one network
      // failure would leave the counter above zero and silently stop the poll for the whole session.
      writes.current.inFlight -= 1;
      writes.current.completed += 1;
    }
  }

  return {
    state,
    toggle: (id, next) => patchSchedule(id, { enabled: next }, `${id} ${next ? "enabled" : "disabled"}`),
    setCron: (id, cron) => patchSchedule(id, { cron }, `${id} · ${describeCron(cron)}`),
  };
}

/**
 * Keep the open Automation panel's next-run and last-run times live (anton-ue90).
 *
 * Only the SERVER-OWNED fields are taken from the poll — the two times and the last fire's outcome.
 * Cadence and enabled state are owned by this page's optimistic writes, and letting a poll land on
 * them would let a response that left the server before an edit arrive after it and quietly put the
 * old cadence back on screen — while the editor's own draft, seeded once from the `cron` prop, kept
 * showing the new one.
 */
function useSchedulePoll({
  slug,
  polling,
  writes,
  setState,
}: {
  slug: string;
  polling: boolean;
  writes: RefObject<WriteGuard>;
  setState: (update: (prev: ScheduleState) => ScheduleState) => void;
}) {
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;

    async function refresh() {
      const before = { ...writes.current };
      const rows = before.inFlight > 0 ? undefined : await readSchedules(slug);
      // Re-checked AFTER the await: a write that started and landed while this request was open
      // holds the newer times, so this response is stale even though it arrived later.
      if (cancelled || !rows || raced(writes.current, before)) return;
      setState((prev) => withTimes(prev, rows));
    }

    // Once on arrival, then on the interval. Switching sections is a hash change, not a navigation,
    // so nothing re-reads the server on the way in: without the leading read, a panel opened from a
    // page that had been sitting for an hour would show that hour-old snapshot — and now that the
    // countdown ticks, it would confidently count it down — for the first thirty seconds.
    void refresh();
    const timer = setInterval(refresh, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, slug, writes, setState]);
}

/** Whether a write landed since a read started — which makes that read's answer the older one. */
function raced(now: WriteGuard, before: WriteGuard): boolean {
  return now.inFlight > 0 || now.completed !== before.completed;
}

/**
 * One row per automation this build knows about. `enabled: null` = no schedule row for this project
 * yet (shown as "not scheduled"; editing the row creates it). A row-less automation still shows a
 * cadence — the default one it would be created at — so the picker is never blank.
 */
function seedRows(schedules: AutomationSchedule[], defaultCrons: Record<string, string>): ScheduleState {
  return Object.fromEntries(
    AUTOMATIONS.map((a) => {
      const row = schedules.find((s) => s.type === a.id);
      return [
        a.id,
        {
          enabled: row?.enabled ?? null,
          cron: row?.cron ?? defaultCrons[a.id] ?? "",
          nextRunAt: row?.nextRunAt,
          lastRunAt: row?.lastRunAt,
          lastRun: row?.lastRun,
        },
      ];
    }),
  );
}

/** Write one automation's row. Throws the server's own message so the caller can surface it. */
async function putSchedule(
  slug: string,
  id: string,
  patch: SchedulePatch,
): Promise<AutomationScheduleState | undefined> {
  const res = await fetch(`/api/projects/${slug}/schedules`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: id, ...patch }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Update failed" }));
    throw new Error(error ?? "Update failed");
  }
  const { schedule } = await res.json().catch(() => ({ schedule: undefined }));
  return schedule;
}

/**
 * Read every row back. A transient failure answers `undefined` rather than throwing: the next tick
 * retries, and a failed read must not toast or blank the table — the times simply stay as stale as
 * they were before it ran.
 */
async function readSchedules(slug: string): Promise<AutomationSchedule[] | undefined> {
  try {
    const res = await fetch(`/api/projects/${slug}/schedules`);
    if (!res.ok) return undefined;
    const { schedules } = await res.json();
    return Array.isArray(schedules) ? schedules : undefined;
  } catch {
    return undefined;
  }
}

/** Apply only the poll-owned server fields; a row for a type this build doesn't list isn't ours. */
function withTimes(state: ScheduleState, rows: AutomationSchedule[]): ScheduleState {
  const next = { ...state };
  for (const row of rows) {
    const current = next[row.type];
    if (current)
      next[row.type] = {
        ...current,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
        lastRun: row.lastRun,
      };
  }
  return next;
}

/**
 * Undo only the fields this patch wrote. Restoring the whole `prev` snapshot would also roll back a
 * concurrent patch for the same automation (toggle while a cadence save is in flight), leaving the
 * row wrong until reload.
 */
function reverted(
  current: AutomationScheduleState,
  prev: AutomationScheduleState,
  patch: SchedulePatch,
): AutomationScheduleState {
  return {
    ...current,
    ...(patch.cron !== undefined ? { cron: prev.cron } : {}),
    ...(patch.enabled !== undefined ? { enabled: prev.enabled } : {}),
  };
}
