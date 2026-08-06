import type { ProjectHealth } from "@/lib/health";
import { AppliedSection } from "./applied-section";
import { CodebaseSignalsSection } from "./codebase-signals-section";
import { HealthRail } from "./health-rail";
import { HousekeepingSection } from "./housekeeping-section";
import { TicketDialogHost } from "./ticket-dialog-host";
import { WorthALookSection } from "./worth-a-look-section";

/**
 * A project nothing has ever checked must not read as a green "all clear" — the honesty contract
 * this whole page exists to keep (see lib/attention.ts's docblock). Every section above already
 * omits itself when it has nothing to say, which is honest on its own, but a page with all four
 * sections gone reads as blank rather than as "unchecked" unless something names that explicitly.
 * Shown only when literally nothing has ever run: a project that WAS patrolled or scanned or scored
 * gets its "nothing found" told by the section/rail that ran the check, not by this banner.
 */
function NeverCheckedBanner() {
  return (
    <section className="rounded-xl border border-dashed border-border bg-card/40 px-3 py-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Nothing has checked this project yet</p>
      <p className="mt-1">
        No patrol has run, no nightly scan has completed, and no run has been self-reviewed — there
        is nothing here to call clean, only nothing yet reported.
      </p>
    </section>
  );
}

/**
 * The Health page's report body — layout "C: report + vitals rail" (anton-ue90.1 split). A two-column
 * read-only report on wide screens, stacking to one column below ~900px: the main column's sections
 * each omit themselves when they have nothing to say, and the rail beside them always renders,
 * carrying the clean-vs-never-checked distinction for the page as a whole.
 *
 * `TicketDialogHost` is the page's one client boundary (mirrors `epic-board.tsx`'s `TicketDialog` +
 * `onOpenBead` pair): everything else here is a Server Component, and only the leaf bead-link buttons
 * nested inside it reach across that boundary.
 */
export function HealthReport({ slug, health }: { slug: string; health: ProjectHealth }) {
  const neverChecked = !health.hygiene && !health.scanHealth && !health.trajectory;

  return (
    <TicketDialogHost slug={slug}>
      <div className="flex flex-col gap-4 min-[900px]:flex-row min-[900px]:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {neverChecked ? <NeverCheckedBanner /> : null}
          <WorthALookSection slug={slug} items={health.worthALook} />
          <CodebaseSignalsSection scanHealth={health.scanHealth} />
          <HousekeepingSection items={health.housekeeping} />
          <AppliedSection hygiene={health.hygiene} />
        </div>
        <HealthRail slug={slug} health={health} />
      </div>
    </TicketDialogHost>
  );
}
