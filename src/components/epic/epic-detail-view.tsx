"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckIcon, CircleSlashIcon, RotateCcwIcon } from "lucide-react";

import type { EpicCrumb, EpicDetail, ReviewReport, Ticket } from "@/lib/types";
// The predicate itself, not a page-local copy: approve, the runner, and the board card ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { CopyButton } from "@/components/ui/copy-button";
import { TYPE_LABELS, agentDotClass, ticketProgress } from "@/components/board/board-utils";
import { AbandonedChip, MetaChip, RelativeTime, RiskChip, StagePill } from "@/components/atoms";
import { ClaimControl } from "@/components/board/claim-control";
import { toastApprovalOutcome } from "@/components/board/contract-advisory";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { EpicBadge } from "@/components/board/epic-badge";
import { PrLinkControl } from "@/components/board/pr-link-control";
import { DependencyGraph } from "@/components/epic/dependency-graph";
import { EpicPriorityControl } from "@/components/epic/epic-priority-control";
import { ReviewScorePanel } from "@/components/epic/review-score-panel";
import { ReworkDialog } from "@/components/epic/rework-dialog";
import { AbandonButton } from "@/components/ticket/abandon-button";
import { TicketDialog } from "@/components/ticket/ticket-dialog";

type AcceptanceItem = { text: string; checked: boolean };

/** Split an acceptance blob into checklist items, honoring `- [x]` / `- [ ]` markers. */
function parseAcceptance(acceptance: string): AcceptanceItem[] {
  return acceptance
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(line);
      if (m) return { text: m[2].trim(), checked: m[1].toLowerCase() === "x" };
      return { text: line.replace(/^[-*]\s*/, ""), checked: false };
    });
}

function StatusCircle({ ticket }: { ticket: Ticket }) {
  // Checked BEFORE done: an abandoned ticket is closed, so its stage says done — the slash is what
  // keeps a dropped ticket from wearing the shipped tick.
  if (ticket.abandoned) {
    return (
      <CircleSlashIcon className="size-3.5 shrink-0 text-subtle" aria-label="abandoned" />
    );
  }
  if (ticket.stage === "done") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-stage-done">
        <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (ticket.stage === "implementing") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-stage-implementing">
        <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" />
      </span>
    );
  }
  if (ticket.stage === "in-review") {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-stage-in-review">
        <span className="size-1.5 rounded-full bg-stage-in-review" />
      </span>
    );
  }
  return <span className="size-3.5 shrink-0 rounded-full border-[1.5px] border-subtle" />;
}

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

export function EpicDetailView({
  slug,
  epicId,
  budgetAware = false,
}: {
  slug: string;
  epicId: string;
  /**
   * Whether this project's budget governor paces autonomous work (anton-d8i4). On → the run action
   * splits into "Approve" (immediate execution) and "Queue" (paced for optimal usage). Off → a single
   * run button (the governor never runs, so there's nothing to queue for).
   */
  budgetAware?: boolean;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The self-review history (anton-tprv), loaded beside the detail rather than inside it: it costs a
  // hydrated `bd show --include-comments`, and the detail open is deliberately spawn-free
  // (anton-8s1t). Two concurrent fetches, never a waterfall — the page paints off the snapshot while
  // the score series fills in.
  const [review, setReview] = useState<ReviewReport | undefined>(undefined);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [reworkOpen, setReworkOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${epicId}`);
        if (!res.ok) throw new Error(`Failed to load epic (${res.status})`);
        const data = (await res.json()) as { detail: EpicDetail };
        if (!cancelled) {
          setDetail(data.detail);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load epic");
      }
    }
    async function loadReview() {
      try {
        const res = await fetch(`/api/projects/${slug}/epics/${epicId}/review`);
        if (!res.ok) throw new Error(`Couldn't load the self-review history (${res.status})`);
        const data = (await res.json()) as { report: ReviewReport };
        if (!cancelled) {
          setReview(data.report);
          setReviewError(null);
        }
      } catch (err) {
        // A history that can't be read never blocks the page: the score is a record of past runs,
        // and every action here operates on the beads, not on it.
        if (!cancelled) {
          setReviewError(err instanceof Error ? err.message : "Couldn't load the self-review history");
        }
      }
    }
    void load();
    void loadReview();
    return () => {
      cancelled = true;
    };
  }, [slug, epicId, attempt]);

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  async function handleRun(
    title: string,
    opts: { force?: boolean; immediate?: boolean } = {},
  ) {
    // `immediate` carries the run-directly choice (anton-d8i4): true → execute now (bypass pacing),
    // false → queue for optimal usage. Defaults to immediate so the single run/force-run button (and
    // any non-budget-aware project) behaves as it always has — run now.
    const immediate = opts.immediate ?? true;
    setRunning(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epicId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ immediate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Run failed (${res.status})`);
      }
      // The response decides whether a run actually starts, and the run starts with whatever thin
      // sections it has; both are said once, here.
      await toastApprovalOutcome(res, {
        started: opts.force
          ? `Re-running "${title}"`
          : immediate
            ? `Run started for "${title}"`
            : `Queued "${title}" for optimal usage`,
        title,
      });
      setAttempt((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(title: string) {
    const res = await fetch(`/api/projects/${slug}/epics/${epicId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Delete failed (${res.status})`);
      return;
    }
    toast.success(`Deleted "${title}"`);
    router.push(`/projects/${slug}`);
  }

  async function handleOpenWorktree(worktreePath: string) {
    try {
      await navigator.clipboard.writeText(worktreePath);
      toast.success("Worktree path copied", { description: worktreePath });
    } catch {
      toast.error("Couldn't copy worktree path");
    }
  }

  if (!detail) return <EpicDetailSkeleton />;

  const { epic, tickets, edges, run, parentEpic } = detail;
  const { done, total, pct } = ticketProgress({ tickets });
  const inProgress = tickets.filter((t) => t.stage === "implementing").length;
  const inProgressPct = total === 0 ? 0 : Math.round((inProgress / total) * 100);
  const todo = Math.max(0, total - done - inProgress);
  const abandoned = tickets.filter((t) => t.abandoned).length;
  const acceptance = epic.acceptance ? parseAcceptance(epic.acceptance) : [];
  // The page serves every run target, and a feature is the tier anton runs — so the id line and the
  // actions name the bead's real type instead of calling everything an epic.
  const word = TYPE_LABELS[epic.type].toLowerCase();
  // Every run action here posts to the approve route, which refuses a blocking contract gap on the
  // target or any open ticket under it (anton-j9zs). Gate the buttons on the same judgement the
  // board card uses, so the action reads as inert-and-explained rather than 422ing on click.
  const contractBlocked = contractBlocks(epic.contract);
  const blocking = epic.contract?.blocking ?? [];
  // Rework acts on work a run has already produced and reviewed, so it is offered exactly once the
  // target has left backlog — that covers the run that parked on its own self-review (the case this
  // exists for) as well as one waiting at the merge gate. An abandoned target has no work to redo.
  const canRework = !epic.abandoned && epic.stage !== "backlog" && tickets.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
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
              onChanged={() => setAttempt((n) => n + 1)}
            />
          )}
          {epic.abandoned ? null : epic.stage === "implementing" ? (
            <>
              {run && (
                <Link
                  href={`/projects/${slug}/runs/${run.id}`}
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
                  onClick={() => handleRun(epic.title, { force: true })}
                  disabled={running}
                  title="Re-trigger the execute-epic job (resumes from where it stopped)"
                >
                  {running ? "Starting…" : "Force run"}
                </Button>
              )}
            </>
          ) : contractBlocked ? (
            // One inert action for both the budget-aware and plain layouts: the run is withheld by a
            // missing section, and neither pacing choice changes that.
            <ApproveBlocked
              violations={blocking}
              label={budgetAware ? "Approve" : `Run ${word}`}
              size="sm"
            />
          ) : budgetAware ? (
            // Budget-aware project: let the operator choose immediate execution vs pacing for optimal
            // usage (anton-d8i4). "Approve" runs now (bypasses weekly/daytime pacing, keeps the
            // session floor); "Queue" hands the run to the governor's pace-line.
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRun(epic.title, { immediate: false })}
                disabled={running}
                title="Queue this run for the budget governor to pace against the weekly plan"
              >
                {running ? "…" : "Queue"}
              </Button>
              <Button
                size="sm"
                onClick={() => handleRun(epic.title, { immediate: true })}
                disabled={running}
                title="Approve and run now, bypassing budget pacing (the session limit still applies)"
              >
                {running ? "Starting…" : "Approve"}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRun(epic.title)}
              disabled={running}
            >
              {running ? "Starting…" : `Run ${word}`}
            </Button>
          )}
          {canRework && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReworkOpen(true)}
              title="Attach fix instructions to one of this run's tickets and put it back in the pipeline"
            >
              <RotateCcwIcon aria-hidden="true" />
              Send back
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => run?.worktreePath && handleOpenWorktree(run.worktreePath)}
            disabled={!run?.worktreePath}
            title={run?.worktreePath ?? "No active worktree"}
          >
            Open worktree
          </Button>
          {/* Abandon settles the epic and cascades to its open children; the route 409s an
              already-closed epic, so the action only shows while there is something to settle. */}
          {epic.stage !== "done" && !epic.abandoned && (
            <AbandonButton
              slug={slug}
              targetId={epicId}
              kind="epic"
              onAbandoned={() => setAttempt((n) => n + 1)}
            />
          )}
          <ConfirmDeleteButton
            onConfirm={() => handleDelete(epic.title)}
            iconOnly
            title={`Delete ${word} and all its tickets`}
          />
        </div>
      </header>

      {/* body: contract | graph */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[400px_1fr]">
        {/* LEFT — contract */}
        <div className="flex flex-col gap-5 overflow-y-auto border-border p-5 sm:p-6 lg:border-r">
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-subtle">
              <CopyButton value={epic.id} label={`${word} id`}>
                {epic.id}
              </CopyButton>
              · {word}
            </span>
            <h1 className="font-display text-[22px] leading-tight font-bold tracking-[-0.01em]" title={epic.title}>
              {epic.title}
            </h1>
            {(epic.agent || epic.risk || epic.size) && (
              <div className="flex flex-wrap gap-1.5">
                {epic.agent && <MetaChip dotClass={agentDotClass(epic.agent)}>{epic.agent}</MetaChip>}
                {epic.risk && <RiskChip risk={epic.risk} />}
                {epic.size && <MetaChip>size:{epic.size}</MetaChip>}
              </div>
            )}
            <PrLinkControl
              slug={slug}
              itemId={epic.id}
              prRef={epic.prRef}
              prUrl={epic.prUrl}
              onLinked={() => setAttempt((n) => n + 1)}
            />
          </div>

          {/* completion module */}
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-end gap-2.5">
              <span className="font-display text-[30px] leading-none font-bold tracking-[-0.02em]">
                {done}
                <span className="text-[20px] text-subtle"> / {total}</span>
              </span>
              <span className="mb-0.5 text-xs text-muted-foreground">tickets complete</span>
              <span className="mb-0.5 ml-auto font-mono text-xs text-stage-done">{pct}%</span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
              <span className="bg-stage-done" style={{ width: `${pct}%` }} />
              <span className="bg-stage-implementing" style={{ width: `${inProgressPct}%` }} />
            </div>
            <div className="flex flex-wrap gap-3.5">
              <LegendItem className="bg-stage-done" label={`${done} done`} />
              <LegendItem className="bg-stage-implementing" label={`${inProgress} in progress`} />
              <LegendItem className="bg-subtle" label={`${todo} to do`} />
              {/* Abandoned tickets are out of the progress count — say so rather than let them
                  silently vanish from the epic's arithmetic. */}
              {abandoned > 0 && (
                <LegendItem className="bg-border" label={`${abandoned} abandoned`} />
              )}
            </div>
          </div>

          {/* Beside completion on purpose: how much of the run landed, then how well it scored. */}
          <ReviewScorePanel
            report={review}
            stage={epic.stage}
            loading={review === undefined && reviewError === null}
            error={reviewError}
          />

          {/* claimed-by + created — mirrors the ticket surfaces */}
          <dl className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12.5px]">
              <dt className="w-20 shrink-0">
                <SectionLabel>Claimed by</SectionLabel>
              </dt>
              <dd>
                <ClaimControl
                  slug={slug}
                  itemId={epic.id}
                  owner={epic.assignee}
                  variant="row"
                  readOnly={epic.approved}
                  canTakeOver={epic.stage === "backlog"}
                  onChanged={() => setAttempt((n) => n + 1)}
                />
              </dd>
            </div>
            <div className="flex items-baseline gap-2 text-[12.5px]">
              <dt className="w-20 shrink-0">
                <SectionLabel>Created</SectionLabel>
              </dt>
              <dd className="text-foreground/85">
                <RelativeTime iso={epic.createdAt} />
                {epic.createdBy && <span className="text-subtle"> by {epic.createdBy}</span>}
              </dd>
            </div>
          </dl>

          {epic.goal && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Goal</SectionLabel>
              <p className="text-[13px] leading-relaxed text-foreground/85">{epic.goal}</p>
            </div>
          )}

          {acceptance.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <SectionLabel>Acceptance</SectionLabel>
              {acceptance.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  {item.checked ? (
                    <span className="mt-px flex size-[15px] shrink-0 items-center justify-center rounded bg-stage-done">
                      <CheckIcon className="size-2 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="mt-px size-[15px] shrink-0 rounded border-[1.5px] border-border" />
                  )}
                  <span
                    className={cn(
                      "text-[12.5px] leading-snug",
                      item.checked ? "text-muted-foreground" : "text-foreground/85",
                    )}
                  >
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <SectionLabel>Tickets · {tickets.length}</SectionLabel>
            {tickets.length === 0 ? (
              <p className="py-2 text-xs text-subtle">No linked tickets yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/60">
                {tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <button
                      type="button"
                      onClick={() => setOpenTicketId(ticket.id)}
                      title={ticket.title}
                      className="flex w-full items-center gap-2.5 rounded-md py-2 text-left hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <StatusCircle ticket={ticket} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[12.5px]",
                          ticket.abandoned
                            ? "text-subtle line-through decoration-border"
                            : ticket.stage === "done"
                              ? "text-muted-foreground"
                              : "text-foreground",
                        )}
                      >
                        {ticket.title}
                      </span>
                      {ticket.size && (
                        <span className="shrink-0 font-mono text-[10px] text-subtle">{ticket.size}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* RIGHT — dependency graph */}
        <div className="flex min-h-[440px] flex-col">
          <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5 sm:px-6">
            <span className="text-[13px] font-semibold">Dependency graph</span>
            <span className="font-mono text-[11px] text-subtle">dagre · left → right</span>
            <div className="ml-auto hidden gap-3 sm:flex">
              <LegendItem className="bg-stage-done" label="done" small />
              <LegendItem className="bg-stage-implementing" label="active" small />
              <LegendItem className="bg-stage-backlog" label="todo" small />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <DependencyGraph
              epic={epic}
              tickets={tickets}
              edges={edges}
              fill
              onSelectTicket={setOpenTicketId}
            />
          </div>
        </div>
      </div>

      <ReworkDialog
        slug={slug}
        targetId={epic.id}
        tickets={tickets}
        // The page already holds the report its findings are picked from — hand it over rather than
        // spend a second hydrated read when the dialog opens.
        report={review}
        open={reworkOpen}
        onClose={() => setReworkOpen(false)}
        onReworked={() => setAttempt((n) => n + 1)}
      />

      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
        onSaved={() => setAttempt((n) => n + 1)}
        onDeleted={() => setAttempt((n) => n + 1)}
      />
    </div>
  );
}

function LegendItem({
  className,
  label,
  small = false,
}: {
  className: string;
  label: string;
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-muted-foreground",
        small ? "text-[11px] text-subtle" : "text-[11px]",
      )}
    >
      <span className={cn("size-2 rounded-[3px]", className)} aria-hidden="true" />
      {label}
    </span>
  );
}

function EpicDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-label="Loading epic">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-6">
        <span className="anton-shimmer h-3 w-40 rounded" />
        <span className="anton-shimmer h-6 w-24 rounded-full" />
      </div>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[400px_1fr]">
        <div className="flex flex-col gap-5 border-border p-6 lg:border-r">
          <span className="anton-shimmer h-6 w-3/4 rounded" />
          <span className="anton-shimmer h-24 w-full rounded-xl" />
          <span className="anton-shimmer h-3 w-1/3 rounded" />
          <span className="anton-shimmer h-16 w-full rounded" />
        </div>
        <div className="anton-shimmer m-6 rounded-xl" />
      </div>
    </div>
  );
}
