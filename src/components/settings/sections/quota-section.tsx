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
 * The equal-split default is computed off the STAGED budget-aware switch, not the stored one, and
 * applied to EVERY undeclared row: an operator turning pacing on here changes the denominator every
 * share is measured against, and a preview that only caught up after a save would show a split this
 * project is not part of — or, worse, one that does not add up.
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
  // The staged switch decides whether this row is in the split at all, so it replaces the stored
  // flag before anything is counted off the board.
  const staged = quotaProjects.map((p) =>
    p.id === project.id ? { ...p, governed: draft.budgetAware } : p,
  );
  const equalSplitPct = defaultQuotaSharePct(staged.filter((p) => p.governed).length);
  // Every UNDECLARED row rides that same default, so staging the switch moves all of them at once —
  // a third project joining the split takes each of them from 50% to 33%. Refreshing only this row
  // would leave the others on the server's pre-edit default and preview a split that sums to 133%.
  const projects = staged.map((p) => (p.declared ? p : { ...p, sharePct: equalSplitPct }));

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
          projects={projects}
          currentProjectId={project.id}
          share={draft.quotaSharePct}
          reserved={draft.reserveQuotaShare}
          equalSplitPct={equalSplitPct}
          onShareChange={(next) => set("quotaSharePct", next)}
          onReserveChange={(next) => set("reserveQuotaShare", next)}
        />
      </section>
    </div>
  );
}
