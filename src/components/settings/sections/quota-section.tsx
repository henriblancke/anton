"use client";

import { defaultQuotaSharePct, type QuotaShareProject } from "@/lib/quota-share";
import { quotaMeterKey } from "@/lib/quota-meter";
import { QuotaShareTable } from "@/components/settings/quota-share-table";
import { SectionHeading } from "@/components/settings/settings-fields";
import { showSection } from "@/components/settings/settings-sections";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * Settings → Quota shares (anton-68hl / R6). How this project's quota meter is divided between the
 * repos running on this machine that pace against that same meter.
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
  const meterKey = quotaMeterKey({
    claudeBaseUrl: draft.claudeBaseUrl,
    routerConnectionId: draft.routerConnectionId,
  });
  // The staged switch and meter decide whether this row belongs in this split at all. A project's
  // quota share never crosses into another router connection or the Anthropic account pool.
  const staged = quotaProjects.map((p) =>
    p.id === project.id
      ? {
          ...p,
          governed: draft.budgetAware,
          meterKey,
          ...(p.meterKey === meterKey ? {} : { spentWeeklyPct: null, seeded: false }),
        }
      : p,
  );
  const meterProjects = staged.filter((p) => p.meterKey === meterKey);
  const equalSplitPct = defaultQuotaSharePct(meterProjects.filter((p) => p.governed).length);
  // Every UNDECLARED row in this meter rides the same default, so staging the switch moves all of
  // them at once without changing independent quota pools.
  const projects = meterProjects.map((p) => (p.declared ? p : { ...p, sharePct: equalSplitPct }));

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-7">
      <section className="flex flex-col gap-3.5">
        <SectionHeading
          title="Quota shares"
          hint="how this quota meter is divided between projects that use it"
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
          meterKey={meterKey}
          onShareChange={(next) => set("quotaSharePct", next)}
          onReserveChange={(next) => set("reserveQuotaShare", next)}
        />
      </section>
    </div>
  );
}
