"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { ReviewFinding, ReviewReport, ReworkResult, Ticket } from "@/lib/types";
import {
  initialDraft,
  isDraftComplete,
  reworkCandidates,
  reworkOutcomeMessage,
  reworkPayload,
  toggleKey,
  type ReworkDraft,
  type ReworkPayload,
} from "@/components/epic/rework-draft";

export interface ReworkFormOptions {
  slug: string;
  targetId: string;
  tickets: Ticket[];
  /** The report the surface opening the dialog already holds; absent → the form reads it itself. */
  report?: ReviewReport;
  onClose: () => void;
  onReworked?: (result: ReworkResult) => void;
}

/** Everything the dialog renders and every way it can be driven — the form's whole behaviour. */
export interface ReworkFormModel {
  /** The live tickets this run may send back; empty means there is nothing to do here. */
  candidates: Ticket[];
  draft: ReworkDraft;
  patch: (fields: Partial<ReworkDraft>) => void;
  report: ReviewReport | null;
  /** Why the report couldn't be read — shown in place of the findings, never blocking the submit. */
  reportError: string | null;
  findings: ReviewFinding[];
  isSelected: (key: string) => boolean;
  toggleFinding: (key: string) => void;
  submitting: boolean;
  canSubmit: boolean;
  submit: () => void;
}

/**
 * The rework dialog's state, held away from its markup so the form stays a render of this model.
 * Composes the three things that move independently: the review report it reads, the findings the
 * founder ticks, and the submit that is in flight.
 */
export function useReworkForm({
  slug,
  targetId,
  tickets,
  report: given,
  onClose,
  onReworked,
}: ReworkFormOptions): ReworkFormModel {
  const candidates = reworkCandidates(tickets);
  const [draft, setDraft] = useState<ReworkDraft>(() => initialDraft(candidates));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const { report, reportError } = useReviewReport(slug, targetId, given);
  const { submitting, send } = useReworkSubmit(slug, targetId, (result) => {
    onReworked?.(result);
    onClose();
  });

  const findings = report?.findings ?? [];
  const canSubmit = isDraftComplete(draft) && !submitting;

  return {
    candidates,
    draft,
    patch: (fields) => setDraft((prev) => ({ ...prev, ...fields })),
    report,
    reportError,
    findings,
    isSelected: (key) => selected.has(key),
    toggleFinding: (key) => setSelected((prev) => toggleKey(prev, key)),
    submitting,
    canSubmit,
    submit: () => {
      if (canSubmit) void send(reworkPayload(draft, findings, selected));
    },
  };
}

/** The target's self-review, read once per open unless the page already handed it down. */
function useReviewReport(slug: string, targetId: string, given?: ReviewReport) {
  const [fetched, setFetched] = useState<ReviewReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    if (given) return; // handed down by the page that already loaded it
    let cancelled = false;
    void (async () => {
      try {
        const report = await getReviewReport(slug, targetId);
        if (!cancelled) setFetched(report);
      } catch (err) {
        // A missing report never blocks the action — the founder can still write instructions by
        // hand, which is exactly what this replaces.
        if (!cancelled) setReportError(errorMessage(err, "Couldn't load the review report"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, targetId, given]);

  return { report: given ?? fetched, reportError };
}

/** The send-back itself. Failure keeps the dialog open so the typed instructions survive a retry. */
function useReworkSubmit(slug: string, targetId: string, onDone: (result: ReworkResult) => void) {
  const [submitting, setSubmitting] = useState(false);

  async function send(payload: ReworkPayload) {
    setSubmitting(true);
    try {
      const result = await postRework(slug, targetId, payload);
      toast.success(
        reworkOutcomeMessage(result),
        result.warning ? { description: result.warning } : undefined,
      );
      onDone(result);
    } catch (err) {
      // A 409 clears on its own, so stay put rather than throwing the draft away.
      toast.error(errorMessage(err, "Sending it back failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, send };
}

async function getReviewReport(slug: string, targetId: string): Promise<ReviewReport> {
  const res = await fetch(`/api/projects/${slug}/epics/${targetId}/review`);
  if (!res.ok) throw new Error(`Couldn't load the review report (${res.status})`);
  const data = (await res.json()) as { report: ReviewReport };
  return data.report;
}

async function postRework(
  slug: string,
  targetId: string,
  payload: ReworkPayload,
): Promise<ReworkResult> {
  const res = await fetch(`/api/projects/${slug}/epics/${targetId}/rework`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Sending it back failed (${res.status})`);
  }
  const data = (await res.json()) as { result: ReworkResult };
  return data.result;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
