"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { createBacklogFeature, errorMessage, killShapeSession } from "./shape-api";
import {
  canSubmitDraft,
  draftAreaValid,
  draftGaps,
  isNewEpic,
  type EpicDraftFields,
  type FeatureDraftFields,
  type ShapeDraftFields,
} from "./shape-draft";

const EMPTY_FEATURE: FeatureDraftFields = {
  title: "",
  goal: "",
  acceptance: "",
  context: "",
  outOfScope: "",
  verify: "",
};
const EMPTY_EPIC: EpicDraftFields = { title: "", goal: "", successCriteria: "", area: "" };
const EMPTY_DRAFT: ShapeDraftFields = { feature: EMPTY_FEATURE, epicId: "", epic: EMPTY_EPIC };

export interface ShapeDraft {
  fields: ShapeDraftFields;
  setFeatureField: (key: keyof FeatureDraftFields, value: string) => void;
  setEpicField: (key: keyof EpicDraftFields, value: string) => void;
  setEpicId: (id: string) => void;
  /** Seeds the feature's title and goal from the composer text, never over anything already typed. */
  seedFrom: (seed: string) => void;
  /** The still-empty pieces, panel-labelled — drives the line under the Send button. */
  gaps: string[];
  /** Whether the epic is being created here rather than picked off the board. */
  creatingEpic: boolean;
  areaValid: boolean;
  /** Every field present and the area label-safe: the draft satisfies the contract. */
  complete: boolean;
}

/**
 * The draft half of the Add-work surface: the feature contract the founder commits and the epic it
 * attaches to, seeded from the composer when shaping starts and then freely editable as the
 * conversation converges. Validation stays in shape-draft.ts, so what the panel shows and what the
 * route accepts can't drift apart. Knows nothing about the pty session — sending is `useSendToBacklog`.
 */
export function useShapeDraft(): ShapeDraft {
  const [fields, setFields] = useState<ShapeDraftFields>(EMPTY_DRAFT);

  const setFeatureField = useCallback((key: keyof FeatureDraftFields, value: string) => {
    setFields((prev) => ({ ...prev, feature: { ...prev.feature, [key]: value } }));
  }, []);

  const setEpicField = useCallback((key: keyof EpicDraftFields, value: string) => {
    setFields((prev) => ({ ...prev, epic: { ...prev.epic, [key]: value } }));
  }, []);

  const setEpicId = useCallback((id: string) => {
    setFields((prev) => ({ ...prev, epicId: id }));
  }, []);

  const seedFrom = useCallback((seed: string) => {
    setFields((prev) => ({
      ...prev,
      feature: {
        ...prev.feature,
        title: prev.feature.title || firstLine(seed),
        goal: prev.feature.goal || seed,
      },
    }));
  }, []);

  return useMemo(
    () => ({
      fields,
      setFeatureField,
      setEpicField,
      setEpicId,
      seedFrom,
      gaps: draftGaps(fields),
      creatingEpic: isNewEpic(fields),
      areaValid: draftAreaValid(fields),
      complete: canSubmitDraft(fields),
    }),
    [fields, seedFrom, setEpicField, setEpicId, setFeatureField],
  );
}

export interface BacklogSend {
  sending: boolean;
  send: (sessionId: string, fields: ShapeDraftFields) => void;
}

/**
 * Landing the draft: create the beads, kill the pty behind us, then leave for the board. The teardown
 * is fire-and-forget on purpose — a feature that landed must never be reported as failed because the
 * cleanup DELETE didn't. `sending` only unsticks on failure; success navigates away.
 */
export function useSendToBacklog(slug: string): BacklogSend {
  const router = useRouter();
  const [sending, setSending] = useState(false);

  const send = useCallback(
    async (sessionId: string, fields: ShapeDraftFields) => {
      // The footer already gates this, but an incomplete draft must never reach the route — the
      // bead it would create is exactly the unshaped (or parentless) one the contract prevents.
      if (sending || !canSubmitDraft(fields)) return;
      setSending(true);
      try {
        await createBacklogFeature(slug, fields);
        killShapeSession(slug, sessionId);
        toast.success("Feature landed in backlog — approve it when you're ready.");
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
