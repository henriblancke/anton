"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

import { STAGES, type Board } from "@/lib/types";
import { EpicCard } from "@/components/board/epic-card";
import { STAGE_LABELS } from "@/components/board/board-utils";

export function EpicBoard({ slug }: { slug: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/board`);
        if (!res.ok) throw new Error(`Failed to load board (${res.status})`);
        const data = (await res.json()) as { board: Board };
        if (!cancelled) setBoard(data.board);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load board");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!board) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Loading board…
      </div>
    );
  }

  return (
    <div className="grid flex-1 grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
      {STAGES.map((stage) => {
        const epics = board.columns[stage] ?? [];
        return (
          <div key={stage} className="flex flex-col gap-3 rounded-xl bg-muted/30 p-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold">{STAGE_LABELS[stage]}</h2>
              <span className="text-xs text-muted-foreground">{epics.length}</span>
            </div>
            <div className="flex flex-col gap-3">
              {epics.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No epics.</p>
              ) : (
                epics.map((epic) => <EpicCard key={epic.id} slug={slug} epic={epic} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
