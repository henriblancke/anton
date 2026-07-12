"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { agentDotClass } from "@/components/board/board-utils";
import { RunTerminal } from "@/components/runs/run-terminal";
import {
  fmtDuration,
  isActiveRun,
  pickAttachSession,
  timelineOrder,
  type RunStatus,
  type SessionStatus,
  type SessionSummary,
} from "@/components/runs/run-view-utils";

/**
 * Local mirror of the run-detail API's run shape. Defined here (not imported from `@/lib/runs`) so
 * this client module never pulls better-sqlite3 into the browser bundle — same guard settings-view
 * uses. Session/status types + the pure helpers live in run-view-utils (unit-tested).
 */
interface RunDetail {
  id: string;
  epicBeadId: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  status: RunStatus;
  attempts: number;
  leaseExpiresAt?: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

const RUN_STATUS_STYLE: Record<RunStatus, { dot: string; text: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", text: "text-stage-implementing", pulse: true },
  queued: { dot: "bg-stage-backlog", text: "text-muted-foreground" },
  parked: { dot: "bg-risk-med", text: "text-risk-med" },
  failed: { dot: "bg-risk-high", text: "text-risk-high" },
  done: { dot: "bg-stage-done", text: "text-stage-done" },
};

function fmtTime(epoch?: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RunDetailView({ slug, runId }: { slug: string; runId: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/projects/${slug}/runs/${runId}`);
      if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
      const data = (await res.json()) as { run: RunDetail; sessions: SessionSummary[] };
      setRun(data.run);
      setSessions(data.sessions);
      setError(null);
      return isActiveRun(data.run.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run");
      return false;
    }
  }, [slug, runId]);

  // Initial load + light polling while the run is active (status/sessions only; the terminal
  // streams on its own SSE channel and is not re-mounted by these refreshes).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const active = await load();
      if (cancelled) return;
      if (active) timer = setTimeout(tick, 2500);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, attempt]);

  // Default the terminal to the running session, else the most recent one; an explicit user pick
  // wins while it still exists. (See pickAttachSession — unit-tested in run-view-utils.test.ts.)
  const attachSessionId = useMemo(
    () => pickAttachSession(sessions, selectedSession),
    [sessions, selectedSession],
  );

  const attachSession = sessions.find((s) => s.id === attachSessionId) ?? null;

  if (error && !run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
          <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
        </span>
        <p className="text-sm text-risk-high">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!run) return <RunDetailSkeleton />;

  const style = RUN_STATUS_STYLE[run.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Link
            href={`/projects/${slug}/runs`}
            className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Runs
          </Link>
          <span className="text-subtle">/</span>
          <span className="truncate font-mono text-foreground" title={run.id}>
            {run.id}
          </span>
        </div>
        <span
          className={cn(
            "ml-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            style.text,
          )}
        >
          <span
            className={cn("size-1.5 rounded-full", style.dot, style.pulse && "anton-pulse")}
            aria-hidden="true"
          />
          {run.status}
        </span>
        <Link
          href={`/projects/${slug}/epics/${run.epicBeadId}`}
          className="ml-auto font-mono text-xs text-primary hover:underline"
        >
          → {run.epicBeadId}
        </Link>
      </header>

      {/* body: meta + timeline | terminal */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,360px)_1fr]">
        {/* LEFT — meta grid + timeline */}
        <div className="flex flex-col gap-6 overflow-y-auto border-border p-5 sm:p-6 lg:border-r">
          {run.error && (
            <div className="flex items-start gap-2 rounded-lg border border-risk-high/30 bg-risk-high/10 p-3">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-risk-high" aria-hidden="true" />
              <span className="font-mono text-[11px] leading-relaxed text-risk-high break-words">
                {run.error}
              </span>
            </div>
          )}

          <section className="flex flex-col gap-2.5">
            <SectionLabel>Run</SectionLabel>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <MetaRow label="epic" value={run.epicBeadId} mono copy />
              <MetaRow label="ticket" value={run.ticketBeadId ?? "—"} mono copy />
              <MetaRow label="agent" value={run.agentTag} mono dotClass={run.agentTag ? agentDotClass(run.agentTag) : undefined} />
              <MetaRow label="model" value={run.model ?? "default"} mono />
              <MetaRow label="branch" value={run.branch ?? "—"} mono copy />
              <MetaRow label="worktree" value={run.worktreePath ?? "—"} mono title={run.worktreePath} copy />
              <MetaRow label="attempts" value={String(run.attempts)} mono />
              <MetaRow label="lease" value={fmtTime(run.leaseExpiresAt)} mono />
              <MetaRow label="started" value={fmtTime(run.startedAt)} mono />
              <MetaRow
                label="duration"
                value={fmtDuration(run.startedAt, run.endedAt)}
                mono
              />
            </dl>
          </section>

          <section className="flex flex-col gap-2.5">
            <SectionLabel>Timeline · {sessions.length}</SectionLabel>
            {sessions.length === 0 ? (
              <p className="py-1 text-xs text-subtle">No sessions recorded yet.</p>
            ) : (
              <ol className="flex flex-col">
                {timelineOrder(sessions).map((s) => (
                  <TimelineItem
                    key={s.id}
                    session={s}
                    active={s.id === attachSessionId}
                    onSelect={() => setSelectedSession(s.id)}
                  />
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* RIGHT — live terminal */}
        <div className="flex min-h-[360px] min-w-0 flex-col">
          <RunTerminal
            slug={slug}
            sessionId={attachSessionId}
            live={attachSession?.status === "running"}
          />
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

function MetaRow({
  label,
  value,
  mono,
  dotClass,
  title,
  copy = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  dotClass?: string;
  title?: string;
  copy?: boolean;
}) {
  const canCopy = copy && value != null && value !== "—";
  return (
    <>
      <dt className="font-mono text-[11px] text-subtle">{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 items-center gap-1.5 truncate text-[12px] text-foreground/90",
          mono && "font-mono text-[11px]",
        )}
        title={title ?? value}
      >
        {dotClass && <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />}
        {canCopy ? (
          <CopyButton value={value} label={label} className="min-w-0 text-foreground/90">
            <span className="truncate">{value}</span>
          </CopyButton>
        ) : (
          <span className="truncate">{value ?? "—"}</span>
        )}
      </dd>
    </>
  );
}

const SESSION_STATUS_DOT: Record<SessionStatus, { dot: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", pulse: true },
  done: { dot: "bg-stage-done" },
  failed: { dot: "bg-risk-high" },
};

function TimelineItem({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const s = SESSION_STATUS_DOT[session.status];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active && "bg-card",
        )}
      >
        <span className="mt-0.5 flex flex-col items-center gap-1">
          <span
            className={cn("size-2 shrink-0 rounded-full", s.dot, s.pulse && "anton-pulse")}
            aria-hidden="true"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-foreground">{session.kind}</span>
            {session.beadId && (
              <span className="truncate font-mono text-[10px] text-subtle">{session.beadId}</span>
            )}
            <span className="ml-auto font-mono text-[10px] text-subtle">
              {fmtDuration(session.startedAt, session.endedAt)}
            </span>
          </span>
          <span className="font-mono text-[10px] text-subtle">
            {fmtTime(session.startedAt)} · {session.status}
          </span>
        </span>
      </button>
    </li>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading run">
      <div className="flex h-14 items-center gap-3 border-b border-border px-6">
        <span className="anton-shimmer h-3 w-48 rounded" />
        <span className="anton-shimmer h-6 w-20 rounded-full" />
      </div>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,360px)_1fr]">
        <div className="flex flex-col gap-4 border-border p-6 lg:border-r">
          <span className="anton-shimmer h-3 w-16 rounded" />
          <span className="anton-shimmer h-40 w-full rounded" />
          <span className="anton-shimmer h-3 w-20 rounded" />
          <span className="anton-shimmer h-24 w-full rounded" />
        </div>
        <div className="anton-shimmer m-6 rounded-xl" />
      </div>
    </div>
  );
}
