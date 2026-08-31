"use client";

import { useSyncExternalStore } from "react";

/**
 * The settings sections, in lifecycle order (anton-ue90.3): what identifies the project, then what
 * happens while a run works, then what has to pass before a PR opens, then what runs on a schedule,
 * then what cannot be undone.
 *
 * Every section that renders is listed here, and the nav SWITCHES which one renders — the previous
 * list named six of eight and only repainted a highlight. `dirtyKeys` names the form fields a
 * section owns, so the save bar can say which section is unsaved instead of offering a bare button
 * on a page whose top is out of view.
 */
export const SECTIONS = [
  {
    id: "general",
    label: "General",
    group: "The project",
    dirtyKeys: ["model"],
  },
  { id: "agents", label: "Active agents", group: "The project", dirtyKeys: ["agents"] },
  {
    id: "prompt",
    label: "Execution prompt",
    group: "While a run works",
    dirtyKeys: ["seedPrompt"],
  },
  {
    id: "variants",
    label: "Pipeline variants",
    group: "While a run works",
    dirtyKeys: ["formulaVariants"],
  },
  {
    id: "execution",
    label: "Concurrency & limits",
    group: "While a run works",
    dirtyKeys: [
      "concurrency",
      "jobTimeoutMinutes",
      "ticketTimeoutMinutes",
      "maxRetries",
      "autonomy",
      "conventionalCommits",
      "budget",
    ],
  },
  {
    id: "autopilot",
    label: "Autopilot brakes",
    group: "While a run works",
    dirtyKeys: ["autopilot"],
  },
  {
    id: "value",
    label: "Work value",
    group: "While a run works",
    dirtyKeys: ["valueLabels"],
  },
  { id: "gates", label: "Verify gates", group: "Before the PR opens", dirtyKeys: ["gates"] },
  {
    id: "review",
    label: "Self-review",
    group: "Before the PR opens",
    dirtyKeys: ["review"],
  },
  {
    id: "review-fix",
    label: "Review-fix",
    group: "Before the PR opens",
    dirtyKeys: ["reviewFixPrompt"],
  },
  {
    id: "automation",
    label: "Automation",
    group: "On a schedule",
    dirtyKeys: ["productMasterPrompt"],
  },
  {
    id: "proposals",
    label: "Proposal autonomy",
    group: "On a schedule",
    dirtyKeys: ["proposalAutonomy"],
  },
  { id: "danger", label: "Danger zone", group: "Irreversible", dirtyKeys: [] },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** Group headings in the order the sections above declare them. */
export const SECTION_GROUPS = SECTIONS.reduce<string[]>(
  (groups, s) => (groups.includes(s.group) ? groups : [...groups, s.group]),
  [],
);

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

export function isSectionId(value: string): value is SectionId {
  return SECTION_IDS.has(value);
}

/**
 * `history.replaceState` fires no event, so a section change has to announce itself for the store
 * below to re-read the URL. Same-tab only, which is all this needs.
 */
const SECTION_CHANGE_EVENT = "anton:settings-section";

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener(SECTION_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(SECTION_CHANGE_EVENT, onChange);
  };
}

/**
 * The displayed panel, read from the URL rather than mirrored into React state (anton-ue90.3).
 *
 * `useSyncExternalStore` and not a state-seeding effect: the hash is an external system, the server
 * has no access to it, and this is the shape that renders "general" on the server and the real
 * section on the client without a hydration mismatch or a cascading render. An unknown or absent
 * hash falls back rather than rendering a blank body.
 */
export function useActiveSection(): SectionId {
  const hash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.slice(1),
    () => "",
  );
  return isSectionId(hash) ? hash : "general";
}

export function showSection(id: SectionId): void {
  // replaceState, not a router navigation: this is which panel is on screen, not a new page, and
  // pushing it would turn Back into "undo the last tab click" nine times over.
  window.history.replaceState(null, "", `#${id}`);
  window.dispatchEvent(new Event(SECTION_CHANGE_EVENT));
}
