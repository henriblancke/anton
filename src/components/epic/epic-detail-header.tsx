"use client";

import Link from "next/link";
import { RotateCcwIcon } from "lucide-react";

import type { Epic, EpicCrumb, EpicDetail } from "@/lib/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { AbandonedChip, StagePill } from "@/components/atoms";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { EpicBadge } from "@/components/board/epic-badge";
import { AbandonButton } from "@/components/ticket/abandon-button";
import { EpicPriorityControl } from "@/components/epic/epic-priority-control";
import type { EpicDetailSummary } from "@/components/epic/epic-detail-summary";
import type { RunOptions } from "@/components/epic/use-epic-detail";

/**
 * Where this run target sits: Board / [product epic] / this bead. The epic hop is what a `feature`
 * gains over the old two-tier board (docs/design/2026-07-26-tier-and-linear-ux.md); a run target
 * with no parent epic — a legacy epic, a standalone task — simply drops that hop.
 */
export function DetailBreadcrumb({
  slug,
  id,
  title,
  parentEpic,
}: {
  slug: string;
  id: string;
  title: string;
  parentEpic?: EpicCrumb;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
      <Link
        href={`/projects/${slug}`}
        className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Board
      </Link>
      <span className="text-subtle">/</span>
      {parentEpic && (
        <>
          <EpicBadge slug={slug} epic={parentEpic} />
          <span className="text-subtle">/</span>
        </>
      )}
      <span className="truncate font-medium text-foreground" title={title}>
        {title}
      </span>
      <span className="shrink-0 text-subtle">·</span>
      <span className="shrink-0 font-mono text-[11px] text-subtle">{id}</span>
    </nav>
  );
}

/**
 * The run affordance in every shape this page offers it: nothing at all once the target is
 * abandoned, View run + Force run while it is implementing, the inert contract-blocked button when
 * the approve route would refuse, the Queue/Approve split on a budget-aware project (anton-d8i4),
 * and a single run button otherwise.
 */
function EpicRunActions({
  slug,
  epic,
  runId,
  summary,
  budgetAware,
  running,
  onRun,
}: {
  slug: string;
  epic: Epic;
  runId?: string;
  summary: EpicDetailSummary;
  budgetAware: boolean;
  running: boolean;
  onRun: (opts?: RunOptions) => void;
}) {
  const { contractBlocked, blocking, word } = summary;

  if (epic.abandoned) return null;

  if (epic.stage === "implementing") {
    return (
      <>
        {runId && (
          <Link
            href={`/projects/${slug}/runs/${runId}`}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            View run
          </Link>
        )}
        {contractBlocked ? (
          <ApproveBlocked violations={blocking} label="Force run" size="sm" />
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRun({ force: true })}
            disabled={running}
            title="Re-trigger the execute-epic job (resumes from where it stopped)"
          >
            {running ? "Starting…" : "Force run"}
          </Button>
        )}
      </>
    );
  }

  if (contractBlocked) {
    // One inert action for both the budget-aware and plain layouts: the run is withheld by a
    // missing section, and neither pacing choice changes that.
    return (
      <ApproveBlocked
        violations={blocking}
        label={budgetAware ? "Approve" : `Run ${word}`}
        size="sm"
      />
    );
  }

  if (budgetAware) {
    // Budget-aware project: let the operator choose immediate execution vs pacing for optimal usage
    // (anton-d8i4). "Approve" runs now (bypasses weekly/daytime pacing, keeps the session floor);
    // "Queue" hands the run to the governor's pace-line.
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRun({ immediate: false })}
          disabled={running}
          title="Queue this run for the budget governor to pace against the weekly plan"
        >
          {running ? "…" : "Queue"}
        </Button>
        <Button
          size="sm"
          onClick={() => onRun({ immediate: true })}
          disabled={running}
          title="Approve and run now, bypassing budget pacing (the session limit still applies)"
        >
          {running ? "Starting…" : "Approve"}
        </Button>
      </>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={() => onRun()} disabled={running}>
      {running ? "Starting…" : `Run ${word}`}
    </Button>
  );
}

/** The detail page's action bar: where the target sits, what stage it is in, and what may be done to it. */
export function EpicDetailHeader({
  slug,
  detail,
  summary,
  budgetAware,
  running,
  onRun,
  onRework,
  onDelete,
  onCopyWorktree,
  onChanged,
}: {
  slug: string;
  detail: EpicDetail;
  summary: EpicDetailSummary;
  budgetAware: boolean;
  running: boolean;
  onRun: (opts?: RunOptions) => void;
  onRework: () => void;
  onDelete: () => void;
  onCopyWorktree: (worktreePath: string) => void;
  onChanged: () => void;
}) {
  const { epic, run, parentEpic } = detail;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5 sm:px-6">
      <DetailBreadcrumb slug={slug} id={epic.id} title={epic.title} parentEpic={parentEpic} />
      {/* An abandoned epic is closed, so its derived stage is `done` — the chip replaces the Done
          pill outright rather than sitting beside it. */}
      {epic.abandoned ? (
        <AbandonedChip className="ml-1" />
      ) : (
        <StagePill stage={epic.stage} className="ml-1" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Priority drives the board/backlog ordering; let it be set here (P0–P4) unless the epic
            is abandoned, which strips the rest of the action set too. */}
        {!epic.abandoned && (
          <EpicPriorityControl
            slug={slug}
            epicId={epic.id}
            priority={epic.priority}
            onChanged={onChanged}
          />
        )}
        <EpicRunActions
          slug={slug}
          epic={epic}
          runId={run?.id}
          summary={summary}
          budgetAware={budgetAware}
          running={running}
          onRun={onRun}
        />
        {summary.canRework && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRework}
            title="Attach fix instructions to one of this run's tickets and put it back in the pipeline"
          >
            <RotateCcwIcon aria-hidden="true" />
            Send back
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => run?.worktreePath && onCopyWorktree(run.worktreePath)}
          disabled={!run?.worktreePath}
          title={run?.worktreePath ?? "No active worktree"}
        >
          Open worktree
        </Button>
        {/* Abandon settles the epic and cascades to its open children; the route 409s an
            already-closed epic, so the action only shows while there is something to settle. */}
        {epic.stage !== "done" && !epic.abandoned && (
          <AbandonButton slug={slug} targetId={epic.id} kind="epic" onAbandoned={onChanged} />
        )}
        <ConfirmDeleteButton
          onConfirm={onDelete}
          iconOnly
          title={`Delete ${summary.word} and all its tickets`}
        />
      </div>
    </header>
  );
}
