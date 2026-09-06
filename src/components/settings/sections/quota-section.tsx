"use client";

import { defaultQuotaSharePct, type QuotaShareProject } from "@/lib/quota-share";
import { QuotaShareTable } from "@/components/settings/quota-share-table";
import { SectionHeading } from "@/components/settings/settings-fields";
import { showSection } from "@/components/settings/settings-sections";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * Settings → Quota shares (anton-68hl / R6). How this machine's one weekly Claude quota is divided
 * between the repos running on it.
 *
 * The equal-split default is computed off the STAGED budget-aware switch, not the stored one: an
 * operator turning pacing on here changes the denominator every share is measured against, and a
 * placeholder that only caught up after a save would show a split this project is not part of.
 */
export function QuotaSection({
  form,
  project,
  quotaProjects,
}: {
  form: SettingsForm;
  /** Which row carries the editable controls. */
  project: { id: string };
  /** Every project on this machine, as the server resolved it. */
  quotaProjects: QuotaShareProject[];
}) {
  const { draft, set } = form;
  const governed = quotaProjects.filter((p) =>
    p.id === project.id ? draft.budgetAware : p.governed,
  ).length;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-7">
      <section className="flex flex-col gap-3.5">
        <SectionHeading
          title="Quota shares"
          hint="how one Claude subscription is divided between the repos on this machine"
        />
        {!draft.budgetAware && (
          <span className="text-[11px] text-risk-med">
            Budget-aware execution is off for this project, so no share binds it — it spends unpaced
            alongside the projects that are paced. Turn it on under Concurrency &amp; limits.{" "}
            <button
              type="button"
              onClick={() => showSection("execution")}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Go there
            </button>
          </span>
        )}
        <QuotaShareTable
          projects={quotaProjects.map((p) =>
            // Same reason as the count above: the staged switch decides whether this row is in the
            // split at all, and the table must show the split this edit would produce.
            p.id === project.id ? { ...p, governed: draft.budgetAware } : p,
          )}
          currentProjectId={project.id}
          share={draft.quotaSharePct}
          reserved={draft.reserveQuotaShare}
          equalSplitPct={defaultQuotaSharePct(governed)}
          onShareChange={(next) => set("quotaSharePct", next)}
          onReserveChange={(next) => set("reserveQuotaShare", next)}
        />
      </section>
    </div>
  );
}
