"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { describeCron } from "@/lib/jobs/cadence";
import type {
  AutomationScheduleState,
  CadenceOffer,
} from "@/components/settings/automation-table";
import { AUTOMATIONS, SCHEDULE_POLL_MS } from "@/components/settings/settings-constants";
import type { AutomationSchedule } from "@/components/settings/settings-types";
import { useCadenceOffer } from "@/components/settings/use-cadence-offer";

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
  /**
   * A cadence set by hand — it also supersedes a pending offer for that row, and re-opens the
   * question if the write does not land (anton-3xa9).
   */
  setCron: (id: string, cron: string) => Promise<void>;
  /** The pending cadence offer, and the two ways it is answered (anton-3xa9). */
  cadenceOffer: CadenceOffer | null;
  acceptCadenceOffer: () => Promise<void>;
  declineCadenceOffer: () => Promise<void>;
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
  keepProductMasterWeekly,
  patchSettings,
}: {
  slug: string;
  schedules: AutomationSchedule[];
  defaultCrons: Record<string, string>;
  /** Only the open panel polls; the rows are static to everyone else. */
  polling: boolean;
  /** The operator's standing answer to the cadence offer, from a previous session (anton-3xa9). */
  keepProductMasterWeekly: boolean;
  /** A settings PATCH, queued behind the form's own writes — how the opt-out is persisted. */
  patchSettings: (body: Record<string, unknown>) => Promise<Response>;
}): AutomationSchedules {
  const [state, setState] = useState<ScheduleState>(() => seedRows(schedules, defaultCrons));
  // The live mirror of the rows above, written by every update. A handler that resumes after an
  // await still closes over the snapshot its own render captured, and the cadence offer is decided
  // on what the coupled row says NOW — the operator can disable product-master or edit its time
  // while a PATCH is open.
  const rows = useRef(state);
  // The last row the SERVER confirmed, per automation — what a failed write must roll back to. The
  // call-time snapshot cannot serve: writes to one row are queued, so a second toggle clicked while
  // the first is still open reads the first's OPTIMISTIC value and would restore that on failure,
  // leaving the table reporting a state the server never held.
  const committed = useRef(state);
  const writes = useRef<WriteGuard>({ inFlight: 0, completed: 0 });
  // The tail of this panel's PATCHes against each row, so it never has two open on one — a cadence
  // accept and a toggle land on the same automation, and each carries only its own field. The route
  // settles them in arrival order and answers with the row as stored; two in flight means the reply
  // applied LAST can be the one describing the older state, leaving the table reporting a cadence or
  // an enabled flag the server has already moved past.
  const rowWrites = useRef(new Map<string, Promise<void>>());
  // What each of those queued writes ASKED for, oldest first. A response describes the row as of its
  // own write, so a click made behind it — already optimistic on screen, still to be sent — has to
  // survive it: applying the first answer whole puts the superseded state back, and the coupled
  // cadence offer, decided against these rows, is then asked about a state nobody is heading for.
  const rowIntents = useRef(new Map<string, PendingWrite[]>());

  // The one writer of the rows: the ref is the source of truth and the state mirrors it. Stable —
  // it closes over nothing but the two refs — so the poll's effect is not torn down every render.
  const update = useCallback((next: (prev: ScheduleState) => ScheduleState) => {
    rows.current = next(rows.current);
    setState(rows.current);
  }, []);

  useSchedulePoll({ slug, polling, writes, update });

  /**
   * Persist one automation's cadence and/or enabled flag immediately (not via Save) — optimistic,
   * reverted with a toast if the PATCH fails. A missing row is created server-side. The response
   * carries the row as stored, so the next-run readout is the server's recomputed nextRunAt rather
   * than a guess made here.
   *
   * Answers whether the write LANDED, because one caller acts on that and not on the optimistic
   * state: arming the picker offers a cadence change whose whole premise is that the picker is now
   * armed (see {@link useCadenceOffer}).
   */
  async function patchSchedule(
    id: string,
    patch: SchedulePatch,
    message: string,
  ): Promise<boolean> {
    const prev = rows.current[id];
    update((p) => ({ ...p, [id]: { ...prev, ...patch } }));
    const intent = trackIntent(rowIntents, id, patch);
    // Counted at the CALL, not at the send: a patch waiting on the row's queue is still a write this
    // panel owns, and a poll that landed in that window would answer with pre-write times.
    writes.current.inFlight += 1;
    try {
      const stored = await queueRowWrite(rowWrites, id, () => putSchedule(slug, id, patch));
      // The patch landed, so it is server truth now — from the echoed row when the route sends one,
      // and from the fields this write asked for when it does not.
      const confirmed = stored ?? { ...committed.current[id], ...patch };
      committed.current = { ...committed.current, [id]: confirmed };
      // Server truth under the operator's newer intent, never over it.
      if (stored) update((p) => ({ ...p, [id]: { ...stored, ...intent.later() } }));
      toast.success(message);
      return true;
    } catch (err) {
      update((p) => ({ ...p, [id]: reverted(p[id], committed.current[id], patch, intent.later()) }));
      toast.error(err instanceof Error ? err.message : `Failed to update ${id}`);
      return false;
    } finally {
      // In `finally` so a rejected patch also clears the in-flight count — otherwise one network
      // failure would leave the counter above zero and silently stop the poll for the whole session.
      intent.release();
      writes.current.inFlight -= 1;
      writes.current.completed += 1;
    }
  }

  const setCron = (id: string, cron: string) =>
    patchSchedule(id, { cron }, `${id} · ${describeCron(cron)}`);

  const cadence = useCadenceOffer({
    rows,
    initialRows: state,
    keepWeekly: keepProductMasterWeekly,
    patchSettings,
    setCron,
  });

  return {
    state,
    toggle: (id, next) =>
      cadence.aroundToggle(id, next, () =>
        patchSchedule(id, { enabled: next }, `${id} ${next ? "enabled" : "disabled"}`),
      ),
    setCron: (id, cron) => cadence.aroundSetCron(id, () => setCron(id, cron)),
    cadenceOffer: cadence.offer,
    acceptCadenceOffer: cadence.accept,
    declineCadenceOffer: cadence.decline,
  };
}

/** One write still open on a row, holding the fields it asked for (see {@link rowIntents}). */
interface PendingWrite {
  patch: SchedulePatch;
}

/**
 * Record one write as open on its row, and answer with the two things its own completion needs: the
 * fields any LATER write on that row has already put on screen, and the release to run once this one
 * has settled.
 *
 * `later()` is read at completion rather than captured up front — the clicks it has to defer to are
 * exactly the ones made while this write was open.
 */
function trackIntent(
  open: RefObject<Map<string, PendingWrite[]>>,
  id: string,
  patch: SchedulePatch,
): { later: () => SchedulePatch; release: () => void } {
  const entry: PendingWrite = { patch };
  const queued = open.current.get(id) ?? [];
  queued.push(entry);
  open.current.set(id, queued);
  return {
    later: () => {
      const at = queued.indexOf(entry);
      if (at < 0) return {};
      return queued.slice(at + 1).reduce<SchedulePatch>((all, w) => ({ ...all, ...w.patch }), {});
    },
    release: () => {
      const at = queued.indexOf(entry);
      if (at >= 0) queued.splice(at, 1);
      if (queued.length === 0) open.current.delete(id);
    },
  };
}

/**
 * Send one row's write, queued behind every other one this panel has open against the SAME row (see
 * {@link rowWrites}). Rows are independent, so two automations still write in parallel.
 */
function queueRowWrite<T>(
  queue: RefObject<Map<string, Promise<void>>>,
  id: string,
  send: () => Promise<T>,
): Promise<T> {
  const release = (entry: Promise<void>) => {
    // Only while it is still that row's tail — a later write has already taken the slot otherwise.
    if (queue.current.get(id) === entry) queue.current.delete(id);
  };
  const tail = queue.current.get(id);
  // Straight through when nothing else is open on this row — the queue exists to order concurrent
  // writes, not to defer a lone one behind a microtask. Chained on SETTLE, so a write that threw
  // still lets the next one run.
  const sent = tail ? tail.then(send, send) : send();
  const entry: Promise<void> = sent.then(
    () => release(entry),
    () => release(entry),
  );
  queue.current.set(id, entry);
  return sent;
}

/**
 * Keep the open Automation panel's next-run and last-run times live (anton-ue90).
 *
 * Only the SERVER-OWNED fields are taken from the poll — the two times, the last fire's outcome and
 * where an unsettled fire sits.
 * Cadence and enabled state are owned by this page's optimistic writes, and letting a poll land on
 * them would let a response that left the server before an edit arrive after it and quietly put the
 * old cadence back on screen — while the editor's own draft, seeded once from the `cron` prop, kept
 * showing the new one.
 */
function useSchedulePoll({
  slug,
  polling,
  writes,
  update,
}: {
  slug: string;
  polling: boolean;
  writes: RefObject<WriteGuard>;
  update: (next: (prev: ScheduleState) => ScheduleState) => void;
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
      update((prev) => withTimes(prev, rows));
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
  }, [polling, slug, writes, update]);
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
          pendingRun: row?.pendingRun,
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
        // Assigned, never spread-preserved: a fire that has since settled leaves no pending row, and
        // keeping the previous value would leave the cell claiming work is still in flight.
        pendingRun: row.pendingRun,
      };
  }
  return next;
}

/**
 * Undo only the fields this patch wrote, back to what the server last confirmed. Restoring the whole
 * `committed` row would also roll back a concurrent patch for the same automation (toggle while a
 * cadence save is in flight), leaving the row wrong until reload.
 *
 * A field a queued write has since claimed is left alone for the same reason: that write is what the
 * operator asked for last, and it is still to be sent — rolling it back here would take a click off
 * screen that the row is about to be given anyway.
 */
function reverted(
  current: AutomationScheduleState,
  committed: AutomationScheduleState,
  patch: SchedulePatch,
  later: SchedulePatch,
): AutomationScheduleState {
  return {
    ...current,
    ...(patch.cron !== undefined && later.cron === undefined ? { cron: committed.cron } : {}),
    ...(patch.enabled !== undefined && later.enabled === undefined
      ? { enabled: committed.enabled }
      : {}),
  };
}
