import { notFound } from "next/navigation";

import { getProjectBySlug, getProjectSettingsBySlug } from "@/lib/projects";
import { projectSpendBreakdowns } from "@/lib/claude-invocations";
import { fetch9RouterPricing } from "@/lib/model-pricing";
import { normalizeWindow, windowSince } from "@/lib/spend-breakdown";
import { PageHeader } from "@/components/atoms";
import { SpendView } from "@/components/spend/spend-view";

export const dynamic = "force-dynamic";

/**
 * Project → Spend (anton-1kdm): what each task and each model cost, over a chosen window.
 *
 * A Server Component end to end — the ledger read is a local sqlite query and the window is a URL
 * param, so nothing on this page needs to be a client boundary. The window links in
 * `SpendWindowTabs` are plain `Link`s for the same reason.
 */
export default async function ProjectSpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const settings = await getProjectSettingsBySlug(slug);
  const gatewayPricing = settings
    ? await fetch9RouterPricing({
        baseUrl: settings.claudeBaseUrl,
        authTokenEnv: settings.claudeAuthTokenEnv,
      })
    : undefined;
  const window = normalizeWindow(query.window);
  const { model, task, divergence } = await projectSpendBreakdowns(project.id, {
    since: windowSince(window),
    gatewayPricing,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader project={project.name} section="Spend">
        <span className="ml-1 font-mono text-[11px] text-subtle">
          measured per invocation · by model · by task
        </span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        <SpendView
          slug={slug}
          window={window}
          model={model}
          task={task}
          divergence={divergence}
          hasGatewayPricing={gatewayPricing !== undefined}
        />
      </div>
    </div>
  );
}
