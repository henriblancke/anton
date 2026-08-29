"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { ProposalAutonomy, EarnedKind } from "@/components/settings/settings-autonomy";
import { SECTIONS } from "@/components/settings/settings-sections";
import {
  dirtyFields,
  draftFromSettings,
  settingsPatchBody,
  type SettingsDraft,
} from "@/components/settings/settings-draft";
import type {
  DiscoveredAgent,
  EditableSettings,
  FormulaVariant,
} from "@/components/settings/settings-types";

/** A row identified by a stable local id — what the ordered lists (variants, value labels) hold. */
interface Row {
  id: string;
}

/** Everything a settings panel needs to read the staged edits and drive them. */
export interface SettingsForm {
  draft: SettingsDraft;
  /**
   * What is persisted right now — the SSR row until the first save, then the row the server stored.
   * Panels diff their own fields against this to mark one "unsaved", the same truth the nav dots
   * and the save bar use.
   */
  saved: EditableSettings;
  set: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void;
  /** Flip one bundled agent's membership of the allowlist. */
  toggleAgent: (id: string) => void;
  variants: {
    add: () => void;
    patch: (id: string, patch: Partial<FormulaVariant>) => void;
    /** Move a mapping one place — the list's order is the precedence an operator tunes. */
    move: (id: string, delta: -1 | 1) => void;
    remove: (id: string) => void;
  };
  valueLabels: {
    add: () => void;
    setLabel: (id: string, label: string) => void;
    /** Move a nomination one place — the list's order is the band order an operator tunes. */
    move: (id: string, delta: -1 | 1) => void;
    remove: (id: string) => void;
    /** Nominate a label from the board's own vocabulary, or drop it if already nominated. */
    toggle: (label: string) => void;
    /** What a save would send — also what the vocabulary reads back as "already nominated". */
    nominated: Set<string>;
  };
  armKind: (kindId: string, level: ProposalAutonomy) => void;
  /** Which staged edits differ from what is persisted, keyed by SECTIONS' `dirtyKeys`. */
  dirty: Record<string, boolean>;
  /** The sections those edits live in — what the save bar names. */
  dirtySections: (typeof SECTIONS)[number][];
  saving: boolean;
  save: () => Promise<void>;
}

/**
 * The settings form's whole behaviour: the staged edits, what is dirty, and the save.
 *
 * Lives above the panels rather than inside them because the save bar is in the page header and
 * submits every section at once — an edit made in one panel has to survive switching to another.
 */
export function useSettingsForm({
  slug,
  settings,
  agents,
  bundledAgentIds,
  earned,
}: {
  slug: string;
  settings: EditableSettings;
  agents: DiscoveredAgent[];
  bundledAgentIds: string[];
  earned: Record<string, EarnedKind>;
}): SettingsForm {
  const router = useRouter();
  /**
   * What "saved" currently means — the values every field is diffed against to decide it is dirty.
   *
   * Seeded from the SSR snapshot, then MOVED to the row the server stored on each successful save.
   * The `settings` prop cannot serve as this baseline: it is fixed for the component's lifetime, so
   * after a save the nav dots and the "unsaved in X" line would stay lit until a reload — and worse,
   * an operator who restored a field to its pre-save value would see the Save button go disabled
   * while the server still held the new value, with no way to put the original back.
   */
  const [baseline, setBaseline] = useState<EditableSettings>(settings);
  const [draft, setDraft] = useState<SettingsDraft>(() =>
    draftFromSettings(settings, bundledAgentIds, earned),
  );
  const [saving, setSaving] = useState(false);
  // Local row ids only — never persisted, and never reused, so a React key is stable for the life
  // of the row it was minted for.
  const nextRowId = useRef(draft.variantRows.length + draft.valueLabelRows.length);

  function set<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function updateRows<K extends "variantRows" | "valueLabelRows">(
    key: K,
    fn: (rows: SettingsDraft[K]) => SettingsDraft[K],
  ) {
    setDraft((prev) => ({ ...prev, [key]: fn(prev[key]) }));
  }

  const dirty = dirtyFields(draft, baseline, bundledAgentIds, earned);

  async function save() {
    setSaving(true);
    try {
      const stored = await patchSettings(slug, settingsPatchBody(draft, bundledAgentIds, agents));
      // The new baseline is what the server STORED, not what we sent: the PATCH deep-merges
      // (budgetPolicy), prunes (half-filled variant rows, a missing reviewer we deliberately
      // omitted) and recomputes, so the response row is the only honest answer to "what is saved
      // now". Without this the form keeps diffing against the SSR snapshot for the rest of the
      // session. If the response somehow carries no row we leave the baseline alone rather than
      // guess — an over-eager clear would claim edits were persisted that may not have been.
      if (stored) setBaseline(stored);
      toast.success("Settings saved");
      // The server tree still holds the pre-save row; refresh it so navigating away and back
      // doesn't restore stale values out of the router cache.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return {
    draft,
    saved: baseline,
    set,
    toggleAgent: (id) =>
      setDraft((prev) => {
        const activeAgents = new Set(prev.activeAgents);
        if (!activeAgents.delete(id)) activeAgents.add(id);
        return { ...prev, activeAgents };
      }),
    variants: {
      add: () =>
        updateRows("variantRows", (rows) => [
          ...rows,
          { id: `new-${nextRowId.current++}`, label: "", formula: "" },
        ]),
      patch: (id, patch) =>
        updateRows("variantRows", (rows) =>
          rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        ),
      move: (id, delta) => updateRows("variantRows", (rows) => moved(rows, id, delta)),
      remove: (id) => updateRows("variantRows", (rows) => rows.filter((r) => r.id !== id)),
    },
    valueLabels: {
      add: () =>
        updateRows("valueLabelRows", (rows) => [
          ...rows,
          { id: `new-${nextRowId.current++}`, label: "" },
        ]),
      setLabel: (id, label) =>
        updateRows("valueLabelRows", (rows) =>
          rows.map((r) => (r.id === id ? { ...r, label } : r)),
        ),
      move: (id, delta) => updateRows("valueLabelRows", (rows) => moved(rows, id, delta)),
      remove: (id) => updateRows("valueLabelRows", (rows) => rows.filter((r) => r.id !== id)),
      toggle: (label) =>
        updateRows("valueLabelRows", (rows) =>
          rows.some((r) => r.label.trim() === label)
            ? rows.filter((r) => r.label.trim() !== label)
            : [...rows, { id: `new-${nextRowId.current++}`, label }],
        ),
      nominated: new Set(draft.valueLabelRows.map((r) => r.label.trim()).filter(Boolean)),
    },
    armKind: (kindId, level) =>
      setDraft((prev) => ({
        ...prev,
        proposalAutonomy: { ...prev.proposalAutonomy, [kindId]: level },
      })),
    dirty,
    dirtySections: SECTIONS.filter((s) => s.dirtyKeys.some((key) => dirty[key])),
    saving,
    save,
  };
}

/** Swap a row with its neighbour, or leave the list alone when there is no neighbour to swap with. */
function moved<T extends Row>(rows: T[], id: string, delta: -1 | 1): T[] {
  const at = rows.findIndex((r) => r.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** Persist the whole form. Throws the server's own message so the caller can surface it verbatim. */
async function patchSettings(
  slug: string,
  body: Record<string, unknown>,
): Promise<EditableSettings | undefined> {
  const res = await fetch(`/api/projects/${slug}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const stored = (await res.json().catch(() => null)) as {
    settings?: EditableSettings;
    error?: string;
  } | null;
  if (!res.ok) throw new Error(stored?.error ?? "Save failed");
  return stored?.settings;
}
