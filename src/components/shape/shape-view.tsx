"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MetaChip } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";

/**
 * The Add-work / shaping surface. A real `/shape` session runs a `claude` pty streamed to an
 * xterm on the left, forming a draft epic on the right. That pty/SSE backend is Phase-2 work
 * (tracked separately); this renders the full shaping layout and lets you send a description to
 * kick it off.
 */
export function ShapeView({ slug, projectName }: { slug: string; projectName: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function sendToBacklog() {
    setSubmitting(true);
    toast.success("Draft queued for shaping — it'll land in backlog once shaped.");
    setSubmitting(false);
    router.push(`/projects/${slug}`);
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{projectName}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Add work</span>
        </div>
        <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary">
          <span className="size-1.5 rounded-full bg-primary anton-pulse" aria-hidden="true" />
          interactive · /shape
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_380px]">
        {/* terminal */}
        <div className="flex min-w-0 flex-col border-border bg-[#0c0b0a] lg:border-r">
          <div className="flex-1 overflow-y-auto p-5 font-mono text-[12.5px] leading-relaxed sm:p-6">
            <Line tone="dim">$ anton shape --project {slug}</Line>
            <Line tone="ok">● claude · describe the work — I&apos;ll shape it into an epic</Line>
            <div className="h-3" />
            <Line tone="subtle">
              Tell me what you want built. I&apos;ll ask a few forcing questions, then draft an epic
              with tickets, an agent, and a risk estimate. Accept it and it lands in backlog.
            </Line>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) sendToBacklog();
            }}
            className="flex items-center gap-2.5 border-t border-border bg-[#100f0e] px-5 py-3 sm:px-6"
          >
            <span className="font-mono text-primary" aria-hidden="true">
              ▍
            </span>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe an epic to shape…"
              aria-label="Describe an epic"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-foreground placeholder:text-subtle focus:outline-none"
            />
            <span className="font-mono text-[11px] text-subtle">pty · claude-sonnet</span>
          </form>
        </div>

        {/* draft panel */}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <span className="text-[13px] font-semibold">Draft epic</span>
            <span className="ml-auto font-mono text-[10px] text-subtle">
              {prompt.trim() ? "forming…" : "waiting"}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            {prompt.trim() ? (
              <>
                <DraftField label="Title" value={firstLine(prompt)} strong />
                <DraftField label="Goal" value={prompt.trim()} />
                <div className="flex flex-col gap-2">
                  <FieldLabel>Proposed tickets</FieldLabel>
                  <p className="text-xs text-subtle">
                    Tickets are proposed during the live shaping session.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <MetaChip dotClass={agentDotClass("fastapi")}>agent — TBD</MetaChip>
                  <MetaChip tone="risk-med">risk:?</MetaChip>
                </div>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-subtle">
                As you describe the work, the epic forms here — title, goal, proposed tickets, and
                labels — before it&apos;s sent to backlog.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-border bg-card/40 px-5 py-4">
            <Button className="w-full" disabled={!prompt.trim() || submitting} onClick={sendToBacklog}>
              Send to backlog
            </Button>
            <span className="text-center text-[11px] text-subtle">
              Lands as an open bead · unapproved
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function Line({ tone, children }: { tone: "dim" | "ok" | "subtle" | "iris"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        tone === "dim" && "text-subtle",
        tone === "ok" && "text-stage-done",
        tone === "subtle" && "text-muted-foreground",
        tone === "iris" && "text-primary",
      )}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

function DraftField({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <span
        className={cn(
          strong ? "text-[15px] font-semibold leading-snug" : "text-[12.5px] leading-relaxed text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
