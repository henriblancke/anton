"use client";

import type { Project } from "@/lib/types";
import { DeleteProjectDialog } from "@/components/settings/delete-project-dialog";
import { PruneBeadsSection } from "@/components/settings/prune-beads-section";
import { SectionHeading } from "@/components/settings/settings-fields";

/** What cannot be undone — every control here destroys state, so each states what it destroys. */
export function DangerSection({ project }: { project: Project }) {
  return (
    <section className="flex max-w-2xl flex-col gap-3.5">
      <SectionHeading title="Danger zone" tone="danger" />
      <div className="flex items-center gap-3.5 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-risk-high">Delete project</span>
          <span className="text-xs text-muted-foreground">
            Destroys anton&apos;s state — settings, runs, worktrees. Repo &amp; beads are untouched.
          </span>
        </div>
        <span className="ml-auto">
          <DeleteProjectDialog project={project} />
        </span>
      </div>
      {/* Prune closed beads (anton-uobe): permanent deletion, gated behind preview + confirm */}
      <div className="flex flex-col gap-3 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-risk-high">Prune closed beads</span>
          <span className="text-xs text-muted-foreground">
            Permanently deletes piled-up closed beads (they bloat the export and slow queries). Open
            and in-progress beads are never touched.
          </span>
        </div>
        <PruneBeadsSection project={project} />
      </div>
    </section>
  );
}
