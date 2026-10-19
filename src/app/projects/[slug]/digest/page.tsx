import { notFound } from "next/navigation";

import { getDb } from "@/lib/db";
import { projectDigest } from "@/lib/digest/digest-read";
import { getProjectBySlug } from "@/lib/projects";
import { PageHeader } from "@/components/atoms";
import { DigestEmptyWindow } from "@/components/digest/empty-window";
import { DigestFeatureGroups } from "@/components/digest/feature-groups";
import { MarkSeenFooter } from "@/components/digest/mark-seen-footer";
import { DigestNeedsYouHost } from "@/components/digest/needs-you-host";

export const dynamic = "force-dynamic";

/**
 * Project → Digest (anton-rokar): the since-you-looked page the rest of the feature (anton-8ubg3,
 * anton-16s0t, anton-y1uxp, anton-qitea) built the parts for — needs-you first, then the feature
 * cards grouped by outcome, with the explicit mark-seen this ticket wires up.
 *
 * `projectDigest` (digest/digest-read.ts) does the one shared board read and composes everything
 * else; this page is just layout over its result.
 */
export default async function ProjectDigestPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const digest = await projectDigest(getDb(), project);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader project={project.name} section="Digest">
        <span className="ml-1 truncate font-mono text-[11px] text-subtle">{digest.headline}</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {/* Rendered ahead of the isEmpty branch below, and unconditionally: `digest.needsYou`
              is folded WITHOUT the breaker check (PR #350 review — see `ProjectDigest.breaker`),
              so a window with no events and no other needs-you item can still owe the operator a
              disarmed-autopilot row once that streamed read resolves. */}
          <DigestNeedsYouHost slug={slug} summary={digest.needsYou} breaker={digest.breaker} />
          {digest.isEmpty ? (
            <DigestEmptyWindow since={digest.since} />
          ) : (
            <DigestFeatureGroups slug={slug} groups={digest.groups} />
          )}
          {/* Opening this page never marks it seen — only this button, or scrolling to it, does. */}
          <MarkSeenFooter slug={slug} until={digest.until} />
        </div>
      </div>
    </div>
  );
}
