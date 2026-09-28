import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/projects";
import { projectCohortFeatures } from "@/lib/cohort-read";
import { normalizeCohortDimension, promptSeries } from "@/lib/prompt-series";
import { normalizeWindow, windowSince } from "@/lib/spend-breakdown";
import { PageHeader } from "@/components/atoms";
import { CohortControls } from "@/components/cohorts/cohort-controls";
import { CohortView } from "@/components/cohorts/cohort-view";

export const dynamic = "force-dynamic";

/**
 * Project → Cohorts (anton-lplyz): did the prompt, agent or skill change make anton better?
 *
 * A Server Component end to end, exactly as `spend/page.tsx` is and for the same reasons — the
 * window and dimension are URL query bounds rather than view state, and `promptSeries` is a pure
 * fold over what `cohortFeatures` already resolved, so there is nothing here to hydrate.
 */
export default async function ProjectCohortsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string; dimension?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const window = normalizeWindow(query.window);
  const dimension = normalizeCohortDimension(query.dimension);
  const features = await projectCohortFeatures(project.id, { since: windowSince(window) });
  // Only an unresolvable project id gets here, and `getProjectBySlug` just resolved one — a project
  // deleted mid-render rather than a bad URL. Same 404 either way.
  if (!features) notFound();

  const series = promptSeries(features, dimension);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader project={project.name} section="Cohorts">
        <span className="ml-1 font-mono text-[11px] text-subtle">
          delivered features · grouped by stamp · compared against the cohort before
        </span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        <div className="flex flex-col gap-4">
          <CohortControls slug={slug} dimension={dimension} window={window} />
          <CohortView window={window} series={series} />
        </div>
      </div>
    </div>
  );
}
