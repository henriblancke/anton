"use client";

import { cn } from "@/lib/utils";
import {
  SECTIONS,
  SECTION_GROUPS,
  showSection,
  type SectionId,
} from "@/components/settings/settings-sections";

/**
 * Switches which panel renders, so every section is one click deep and none of them is reachable
 * only by scrolling past two 8000-character textareas.
 */
export function SettingsNav({
  active,
  dirty,
}: {
  active: SectionId;
  /** Which form fields are unsaved, keyed by SECTIONS' `dirtyKeys` — the per-section dot. */
  dirty: Record<string, boolean>;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex flex-row flex-wrap gap-1 border-border p-3 md:flex-col md:flex-nowrap md:overflow-y-auto md:border-r md:p-4"
    >
      {SECTION_GROUPS.map((group) => (
        <div key={group} className="contents md:block">
          <span className="hidden px-2.5 pt-3 pb-1 font-mono text-[9.5px] tracking-[0.12em] text-subtle uppercase first:pt-0 md:block">
            {group}
          </span>
          {SECTIONS.filter((s) => s.group === group).map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={active === s.id ? "true" : undefined}
              onClick={() => showSection(s.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                active === s.id
                  ? "bg-card font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                s.id === "danger" && active !== s.id && "text-risk-high",
              )}
            >
              <span className="truncate">{s.label}</span>
              {s.dirtyKeys.some((key) => dirty[key]) && (
                <span
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                  title="unsaved changes in this section"
                />
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
