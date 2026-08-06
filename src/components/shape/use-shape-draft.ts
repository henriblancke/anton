"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { createBacklogEpic, errorMessage, killShapeSession } from "./shape-api";
import {
  canSubmitDraft,
  draftGaps,
  isAreaValid,
  type ShapeDraftFields,
} from "./shape-draft";

const EMPTY_DRAFT: ShapeDraftFields = { title: "", goal: "", successCriteria: "", area: "" };

export interface ShapeDraft {
  fields: ShapeDraftFields;
  setField: (key: keyof ShapeDraftFields, value: string) => void;
  /** Seeds title and outcome from the composer text, never over anything already typed. */
  seedFrom: (seed: string) => void;
  /** The still-empty pieces, panel-labelled — drives the line under the Send button. */
  gaps: string[];
  areaValid: boolean;
  /** Every field present and the area label-safe: the draft satisfies the epic contract. */
  complete: boolean;
}

/**
 * The draft epic half of the Add-work surface: the four fields that ARE the epic contract, seeded
 * from the composer when shaping starts and then freely editable as the conversation converges.
 * Validation stays in shape-draft.ts, so what the panel shows and what the route accepts can't
 * drift apart. Knows nothing about the pty session — sending is `useSendToBacklog`.
 */
export function useShapeDraft(): ShapeDraft {
  const [fields, setFields] = useState<ShapeDraftFields>(EMPTY_DRAFT);

  const setField = useCallback((key: keyof ShapeDraftFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const seedFrom = useCallback((seed: string) => {
    setFields((prev) => ({
      ...prev,
      title: prev.title || firstLine(seed),
      goal: prev.goal || seed,
    }));
  }, []);

  return {
    fields,
    setField,
    seedFrom,
    gaps: draftGaps(fields),
    areaValid: isAreaValid(fields.area),
    complete: canSubmitDraft(fields),
  };
}

export interface BacklogSend {
  sending: boolean;
  send: (sessionId: string, fields: ShapeDraftFields) => void;
}

/**
 * Landing the draft: create the bead, kill the pty behind us, then leave for the board. The teardown
 * is fire-and-forget on purpose — a bead that landed must never be reported as failed because the
 * cleanup DELETE didn't. `sending` only unsticks on failure; success navigates away.
 */
export function useSendToBacklog(slug: string): BacklogSend {
  const router = useRouter();
  const [sending, setSending] = useState(false);

  const send = useCallback(
    async (sessionId: string, fields: ShapeDraftFields) => {
      // The footer already gates this, but an incomplete draft must never reach the route — the
      // bead it would create is exactly the unshaped one the contract exists to prevent.
      if (sending || !canSubmitDraft(fields)) return;
      setSending(true);
      try {
        await createBacklogEpic(slug, fields);
        killShapeSession(slug, sessionId);
        toast.success("Draft landed in backlog — approve it when you're ready.");
        router.push(`/projects/${slug}`);
      } catch (err) {
        toast.error(errorMessage(err, "Couldn't send the draft to backlog."));
        setSending(false);
      }
    },
    [router, sending, slug],
  );

  return { sending, send };
}

/** The composer's first line, clipped — a title worth starting from, not the whole brief. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
