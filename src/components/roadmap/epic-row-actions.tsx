"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";

import type { RoadmapRow } from "@/lib/types";
import { EpicDialog } from "@/components/roadmap/epic-dialog";

/**
 * The roadmap's only interactive island. The table stays a Server Component — this is the single
 * "use client" boundary, so opening the dialog costs one small bundle rather than shipping the
 * whole rollup to the browser.
 *
 * On save it calls `router.refresh()`: the roadmap page is `force-dynamic` and derives its rows
 * server-side from the bead snapshot, so re-running the RSC is what re-sorts the table after a
 * priority change. Patching a local copy would leave the row's position stale.
 */
export function EpicRowActions({ slug, row }: { slug: string; row: RoadmapRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Edit ${row.title}`}
        title="Edit epic"
        className="inline-flex size-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </button>
      <EpicDialog
        slug={slug}
        row={row}
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => router.refresh()}
      />
    </>
  );
}
