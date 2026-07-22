"use client";

import { usePathname } from "next/navigation";

import { Topbar } from "@/components/shell/topbar";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { extractProjectSlug } from "@/components/shell/shell-utils";

/**
 * Instant fallback while the project RSC resolves getBoard() — a cold `bd list` spawn can
 * take seconds, and without this boundary the previous screen stays frozen. Mirrors the
 * board page's exact frame (Topbar + p-[18px] board grid) so the real board swaps in with
 * no layout shift. Client component: loading.tsx gets no params, so the slug for the
 * breadcrumb comes from the already-committed pathname.
 */
export default function ProjectLoading() {
  const pathname = usePathname();
  const projectSlug = extractProjectSlug(pathname);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar projectSlug={projectSlug} />
      <div className="flex min-h-0 flex-1 flex-col p-[18px]">
        <BoardSkeleton />
      </div>
    </div>
  );
}
