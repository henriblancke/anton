"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import type { TicketDetail, TicketNote } from "@/lib/types";
import { toastApprovalOutcome } from "@/components/board/contract-advisory";
import { readAppliedSummary } from "@/components/board/proposal-applied";
import {
  diffTicketPatch,
  draftFromDetail,
  hasTicketChanges,
  runToastMessage,
  type TicketDraft,
  type TicketPatchBody,
} from "./ticket-dialog-utils";

/** The server truth and the edits sitting on top of it — the two always move together. */
export interface LoadedTicket {
  detail: TicketDetail;
  draft: TicketDraft;
}

export interface TicketDialogOptions {
  slug: string;
  ticketId: string;
  onSaved?: (detail: TicketDetail) => void;
  onDeleted?: (ticketId: string) => void;
  onClose: () => void;
}

/** Everything the dialog renders and every way it can be driven — the body's whole behaviour. */
export interface TicketDialogModel {
  /** The settled read; absent while the fetch is in flight or it failed. */
  loaded: LoadedTicket | null;
  /** Why the ticket couldn't be read — shown in place of the form. */
  error: string | null;
  /** Re-run the read (the error state's Try again, and after a claim moves the assignee). */
  retry: () => void;
  set: <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => void;
  /** Throw the unsaved edits away, back to the loaded detail. */
  reset: () => void;
  /** Whether the draft has anything the dialog would PATCH (drives Save/Reset). */
  changed: boolean;
  saving: boolean;
  /** Async so the caller can show its own pending state while the write is in flight. */
  save: () => Promise<void>;
  remove: () => Promise<void>;
  /** Refetch after a PR link, which moved the external ref AND the stage. */
  reloadAfterLink: () => Promise<void>;
  /** Adopt a detail a state control already refreshed (snooze/abandon), keeping unsaved edits. */
  onStateChanged: (detail: TicketDetail) => void;
  /** Merge an appended note into the loaded detail without touching the draft. */
  onNotesAppended: (notes: TicketNote[]) => void;
  /** Approved on the server, or optimistically by our own click. */
  approved: boolean;
  running: boolean;
  run: () => Promise<void>;
}

/**
 * The ticket dialog's state, held away from its markup so the body stays a render of this model
 * (mirrors `useReworkForm`). Composes the four things that move independently: the read, the draft
 * edits on top of it, the save, and the optimistic run.
 */
export function useTicketDialog({
  slug,
  ticketId,
  onSaved,
  onDeleted,
  onClose,
}: TicketDialogOptions): TicketDialogModel {
  const read = useTicketRead(slug, ticketId);
  const { loaded, adopt, edit } = read;
  const publish = useCallback(
    (detail: TicketDetail) => {
      adopt(detail);
      onSaved?.(detail);
    },
    [adopt, onSaved],
  );
  const save = useTicketSave(slug, ticketId, loaded, publish);
  const run = useTicketRun(slug, ticketId, loaded?.detail ?? null);

  async function remove() {
    try {
      await deleteTicket(slug, ticketId);
    } catch (err) {
      toast.error(errorMessage(err, "Delete failed"));
      return;
    }
    toast.success("Ticket deleted");
    onDeleted?.(ticketId);
    onClose();
  }

  return {
    loaded,
    error: read.error,
    retry: read.retry,
    set: (key, value) => edit((l) => ({ ...l, draft: { ...l.draft, [key]: value } })),
    reset: () => edit((l) => ({ ...l, draft: draftFromDetail(l.detail) })),
    changed: read.changed,
    saving: save.saving,
    save: save.save,
    remove,
    reloadAfterLink: () => reloadTicket(slug, ticketId, publish),
    onStateChanged: (detail) => {
      // Snooze/abandon only move the bead's status — keep the operator's unsaved edits and sync just
      // that field so the Status select doesn't offer to patch it back.
      edit((l) => ({ detail, draft: { ...l.draft, status: detail.status } }));
      onSaved?.(detail);
    },
    onNotesAppended: (notes) => edit((l) => ({ ...l, detail: { ...l.detail, notes } })),
    approved: run.approved,
    running: run.running,
    run: run.run,
  };
}

/** An edit applied to a settled read — the only shape a draft mutation can take. */
type TicketEdit = (loaded: LoadedTicket) => LoadedTicket;

/**
 * The ticket read, re-run on every `retry`. Detail and draft are one state so "loaded" is a single
 * fact the body can branch on once, rather than two nullable halves every consumer re-checks.
 */
function useTicketRead(slug: string, ticketId: string) {
  const [loaded, setLoaded] = useState<LoadedTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A fresh server truth replaces the draft wholesale — the edits it carries are the saved ones.
  const adopt = useCallback((detail: TicketDetail) => {
    setLoaded({ detail, draft: draftFromDetail(detail) });
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await fetchTicket(slug, ticketId);
        if (!cancelled) adopt(detail);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Failed to load ticket"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, ticketId, attempt, adopt]);

  return {
    loaded,
    error,
    changed: loaded !== null && hasTicketChanges(draftFromDetail(loaded.detail), loaded.draft),
    retry: () => setAttempt((n) => n + 1),
    adopt,
    edit: (update: TicketEdit) => setLoaded((l) => (l === null ? l : update(l))),
  };
}

/** The save itself — a PATCH of only what changed, so an untouched field is never sent. */
function useTicketSave(
  slug: string,
  ticketId: string,
  loaded: LoadedTicket | null,
  publish: (detail: TicketDetail) => void,
) {
  const [saving, setSaving] = useState(false);

  async function save() {
    const patch = pendingPatch(loaded);
    if (patch === null) return;
    setSaving(true);
    try {
      publish(await patchTicket(slug, ticketId, patch));
      toast.success("Ticket updated");
    } catch (err) {
      toast.error(errorMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  return { saving, save };
}

/** The changed fields to PATCH, or null when there is nothing to send. */
function pendingPatch(loaded: LoadedTicket | null): TicketPatchBody | null {
  if (loaded === null) return null;
  const patch = diffTicketPatch(draftFromDetail(loaded.detail), loaded.draft);
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Approval as the run trigger for a standalone task/bug — the same T2 route an epic uses. The
 * affordance flips to Force run on our own click and reverts on failure; the board's own poll
 * refreshes the truth.
 */
function useTicketRun(slug: string, ticketId: string, detail: TicketDetail | null) {
  const [running, setRunning] = useState(false);
  const [optimisticApproved, setOptimisticApproved] = useState(false);
  const approved = detail?.approved === true || optimisticApproved;

  async function run() {
    if (detail === null) return;
    setRunning(true);
    setOptimisticApproved(true);
    try {
      const res = await postApprove(slug, ticketId);
      // The response decides whether a run actually starts, and the run starts with whatever thin
      // sections it has; both are said once, here (mirrors the board chip).
      await toastApprovalOutcome(res, {
        started: runToastMessage(detail.title, approved, await readAppliedSummary(res)),
        title: detail.title,
      });
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(errorMessage(err, "Failed to start run"));
    } finally {
      setRunning(false);
    }
  }

  return { approved, running, run };
}

/**
 * Best-effort refetch after a PR link: the link already succeeded server-side, so a failed read is
 * swallowed and the surface's own poll catches up. `publish` hands the fresh detail to the parent
 * too — TicketsView has no polling and would otherwise show a stale stage.
 */
async function reloadTicket(
  slug: string,
  ticketId: string,
  publish: (detail: TicketDetail) => void,
) {
  try {
    publish(await fetchTicket(slug, ticketId));
  } catch {
    // ignored on purpose — see above
  }
}

function ticketUrl(slug: string, ticketId: string): string {
  return `/api/projects/${slug}/tickets/${ticketId}`;
}

async function fetchTicket(slug: string, ticketId: string): Promise<TicketDetail> {
  const res = await fetch(ticketUrl(slug, ticketId));
  if (!res.ok) throw new Error(`Failed to load ticket (${res.status})`);
  const data = (await res.json()) as { detail: TicketDetail };
  return data.detail;
}

async function patchTicket(
  slug: string,
  ticketId: string,
  patch: TicketPatchBody,
): Promise<TicketDetail> {
  const res = await fetch(ticketUrl(slug, ticketId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Save failed");
  }
  const data = (await res.json()) as { detail: TicketDetail };
  return data.detail;
}

async function deleteTicket(slug: string, ticketId: string): Promise<void> {
  const res = await fetch(ticketUrl(slug, ticketId), { method: "DELETE" });
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? "Delete failed");
}

async function postApprove(slug: string, ticketId: string): Promise<Response> {
  const res = await fetch(`/api/projects/${slug}/epics/${ticketId}/approve`, { method: "POST" });
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? "Run failed");
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
