"use client";

import type { Project } from "@/lib/types";
import {
  BeadsStatus,
  Field,
  ModelField,
  SectionHeading,
} from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** What identifies the project — read-only facts, plus the one model knob that applies to all of it. */
export function GeneralSection({ project, form }: { project: Project; form: SettingsForm }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading title="General">
        {/* beads connection is status, not an editable field */}
        <BeadsStatus connected={project.hasBeads} />
      </SectionHeading>
      <div className="grid max-w-xl grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Field label="Name" value={project.name} />
        <Field label="Default branch" value={project.defaultBranch} mono />
        <Field label="Repository path" value={project.repoPath} mono className="sm:col-span-2" />
        <ModelField
          value={form.draft.model}
          onChange={(model) => form.set("model", model)}
          className="sm:col-span-2"
        />
      </div>
    </section>
  );
}
