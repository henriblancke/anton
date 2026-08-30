"use client";

import { AutomationTable } from "@/components/settings/automation-table";
import { AUTOMATIONS } from "@/components/settings/settings-constants";
import { PromptField, SectionHeading } from "@/components/settings/settings-fields";
import { showSection } from "@/components/settings/settings-sections";
import type { SettingsForm } from "@/components/settings/use-settings-form";
import type { AutomationSchedules } from "@/components/settings/use-automation-schedules";

/**
 * What anton does on its own, and how often. Full width, because the schedules are records with
 * identical fields and a table is how you compare them (anton-ue90.4).
 */
export function AutomationSection({
  form,
  schedules,
  defaultCrons,
}: {
  form: SettingsForm;
  schedules: AutomationSchedules;
  defaultCrons: Record<string, string>;
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading title="Automation" hint="what anton does on its own, and how often" />
      <AutomationTable
        automations={AUTOMATIONS}
        state={schedules.state}
        defaultCrons={defaultCrons}
        onCronChange={schedules.setCron}
        onToggle={schedules.toggle}
      />
      <ProductMasterPrompt form={form} />
    </section>
  );
}

/**
 * The one automation whose behaviour is a reasoning contract rather than a rule set: product-master
 * judges the board in a fresh claude session, so its prompt is the knob — grouped with the schedule
 * that fires it, not with the run's own prompts.
 */
function ProductMasterPrompt({ form }: { form: SettingsForm }) {
  return (
    <PromptField
      label="Product-master prompt"
      hint="editable · how claude judges what matters next"
      value={form.draft.productMasterPrompt}
      saved={form.saved.productMasterPrompt ?? ""}
      onChange={(value) => form.set("productMasterPrompt", value)}
      placeholder="Override the default product-master reasoning contract. Empty = anton's shipped default (skills/product-master/SKILL.md)."
      // The session and the PASS are two different things, and only one of them can write
      // (anton-4ab3). Said here because this is where an operator decides what the judgment may do:
      // the claude session has no `bd` and reaches no board, but the pass that carries its answer
      // applies any kind armed at `apply` — so "it only proposes" is true of the session and false
      // of the pass.
      footnote={
        <>
          The reasoning contract for the product-master pass. anton appends the board (tiers,
          ordering edges, priorities, ages, sizes, review scores, recent runs) and the report format
          beneath it. The claude session judges and can never write — it has no board access — but
          the pass then files what it proposed and applies whatever kind you armed at{" "}
          <span className="font-mono">apply</span> in{" "}
          <button
            type="button"
            onClick={() => showSection("proposals")}
            className="text-primary underline-offset-2 hover:underline"
          >
            Proposal autonomy
          </button>
          . Empty = shipped default.
        </>
      }
    />
  );
}
