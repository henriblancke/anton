import { Suspense } from "react";

import { TicketsView } from "@/components/tickets/tickets-view";

export default async function ProjectTicketsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={<div className="flex flex-1 flex-col gap-4" aria-busy="true" />}>
        <TicketsView slug={slug} />
      </Suspense>
    </div>
  );
}
