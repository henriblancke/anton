import type { ProjectHealth } from "@/lib/health";
import { AppliedSection } from "./applied-section";
import { AutopilotBreakerHeader } from "./autopilot-breaker-band";
import { CodebaseSignalsSection } from "./codebase-signals-section";
import { DismissedSection } from "./dismissed-section";
import { HealthRail } from "./health-rail";
import { HousekeepingSection } from "./housekeeping-section";
import { NeedsYouSection } from "./needs-you-section";
import { StaleServerBanner } from "./stale-server-banner";
import { TicketDialogHost } from "./ticket-dialog-host";
import { UnwatchedParksBand } from "./unwatched-parks-band";
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
 * "Read-only" stopped being true at anton-7gxs, and the ordering below is what that change costs.
 * The alerts that used to live above the board — the breaker, the stopped runs, the unwatched-park
 * warning — now lead this page, because they are the only things here that need a DECISION rather
 * than a look, and a decision buried under three trend charts is one nobody makes. Everything after
 * them is the report this page has always been.
 *
 * `TicketDialogHost` is the page's one client boundary for the report half (mirrors `epic-board.tsx`'s
 * `TicketDialog` + `onOpenBead` pair); the alert sections are client components of their own, because
 * every one of them carries a button.
 */
export function HealthReport({ slug, health }: { slug: string; health: ProjectHealth }) {
  const neverChecked = !health.hygiene && !health.scanHealth && !health.trajectory;

  return (
    <TicketDialogHost slug={slug}>
      <div className="flex flex-col gap-4 min-[900px]:flex-row min-[900px]:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Above everything: a stale process is the reason to distrust the sections below it. */}
          <StaleServerBanner servers={health.staleServers} />
          {/* Then the breaker, because it outranks every row under it: an escalation is one stalled
              card, a disarm is every card that would have started. */}
          <AutopilotBreakerHeader slug={slug} breaker={health.breaker} />
          <NeedsYouSection slug={slug} escalations={health.escalations} />
          {/* Directly under the list it explains: with the watcher off, that list has no producer at
              all, so an empty one means "nothing detected", not "nothing wrong". */}
          <UnwatchedParksBand slug={slug} parks={health.parks} />
          <DismissedSection
            slug={slug}
            dismissed={health.dismissed}
            total={health.dismissedTotal}
          />
          {neverChecked ? <NeverCheckedBanner /> : null}
          <WorthALookSection slug={slug} items={health.worthALook} />
          <CodebaseSignalsSection scanHealth={health.scanHealth} />
          <HousekeepingSection items={health.housekeeping} />
          <AppliedSection slug={slug} hygiene={health.hygiene} pickerLog={health.pickerLog} />
        </div>
        <HealthRail slug={slug} health={health} />
      </div>
    </TicketDialogHost>
  );
}
