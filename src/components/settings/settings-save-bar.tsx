"use client";

import { Button } from "@/components/ui/button";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * The page header's save control. The COUNT is the point, not the button: it names what a save will
 * actually submit, from anywhere in the page. Automation is absent from it on purpose — it saves on
 * change.
 */
export function SettingsSaveBar({ form }: { form: SettingsForm }) {
  const sections = form.dirtySections;
  return (
    <span className="ml-auto flex items-center gap-2.5">
      {sections.length > 0 && (
        <span
          className="text-[11.5px] text-subtle"
          title={sections.map((s) => s.label).join(", ")}
        >
          unsaved in{" "}
          <span className="text-primary">
            {sections.length === 1
              ? sections[0].label.toLowerCase()
              : `${sections.length} sections`}
          </span>
        </span>
      )}
      <Button size="sm" onClick={form.save} disabled={form.saving || sections.length === 0}>
        {form.saving ? "Saving…" : "Save changes"}
      </Button>
    </span>
  );
}
