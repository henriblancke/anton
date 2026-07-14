"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PtyTerminal } from "@/components/pty/pty-terminal";
import { cn } from "@/lib/utils";

/**
 * The Add-work / shaping surface (anton-bm4.2). A real `/shape` session runs a `claude` pty
 * streamed to an xterm on the left; on the right the founder shapes a draft epic and commits it to
 * backlog. Before the session starts the left pane is a description composer; "Start shaping"
 * spawns the pty (POST `…/sessions/shape`) and swaps in the live terminal. "Send to backlog" POSTs
 * the accepted draft (POST `…/backlog`), which creates the open, unapproved epic bead.
 */
export function ShapeView({ slug, projectName }: { slug: string; projectName: string }) {
  const router = useRouter();

  const [description, setDescription] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The draft epic committed on accept. Seeded from the description when shaping starts, then
  // freely editable so the founder can refine it as the conversation converges.
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function startShaping() {
    const seed = description.trim();
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/sessions/shape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: seed || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `shape session failed (${res.status})`);
      }
      const { sessionId: id } = (await res.json()) as { sessionId: string };
      if (seed && !title) setTitle(firstLine(seed));
      if (seed && !goal) setGoal(seed);
      setSessionId(id);
    } catch (err) {
      toast.error((err as Error).message || "Couldn't start the shaping session.");
    } finally {
      setStarting(false);
    }
  }

  async function sendToBacklog() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${slug}/backlog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmedTitle, goal: goal.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `create failed (${res.status})`);
      }
      // Navigating away unmounts PtyTerminal, which only aborts the SSE stream — the live pty
      // (and the `claude` process behind it) outlives the page unless we kill it explicitly.
      // `keepalive` lets the DELETE finish even though the push tears this component down.
      if (sessionId) {
        void fetch(`/api/projects/${slug}/sessions/${sessionId}/pty`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => {
          /* best-effort teardown — the pty exits on its own if this never lands */
        });
      }
      toast.success("Draft landed in backlog — approve it when you're ready.");
      router.push(`/projects/${slug}`);
    } catch (err) {
      toast.error((err as Error).message || "Couldn't send the draft to backlog.");
      setSubmitting(false);
    }
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
        {/* terminal / composer */}
        <div className="flex min-w-0 flex-col border-border bg-card lg:border-r">
          {sessionId ? (
            <PtyTerminal slug={slug} sessionId={sessionId} />
          ) : (
            <Composer
              description={description}
              onChange={setDescription}
              onStart={startShaping}
              starting={starting}
            />
          )}
        </div>

        {/* draft panel */}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <span className="text-[13px] font-semibold">Draft epic</span>
            <span className="ml-auto font-mono text-[10px] text-subtle">
              {sessionId ? "shaping…" : "not started"}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            {sessionId ? (
              <>
                <DraftInput label="Title" value={title} onChange={setTitle} placeholder="Epic title" />
                <DraftTextarea
                  label="Goal"
                  value={goal}
                  onChange={setGoal}
                  placeholder="One or two sentences: the outcome and why."
                />
                <p className="text-xs leading-relaxed text-subtle">
                  Shape the epic in the terminal, then refine the title and goal here. Tickets are
                  proposed live — you decompose after it lands in backlog.
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-subtle">
                Describe the work on the left and start shaping. As the conversation converges, the
                epic&apos;s title and goal form here — then send it to backlog.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-border bg-card/40 px-5 py-4">
            <Button
              className="w-full"
              disabled={!sessionId || !title.trim() || submitting}
              onClick={sendToBacklog}
            >
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

function Composer({
  description,
  onChange,
  onStart,
  starting,
}: {
  description: string;
  onChange: (v: string) => void;
  onStart: () => void;
  starting: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
      <div className="font-mono text-[12.5px] leading-relaxed">
        <div className="text-stage-done">
          ● claude · describe the work — I&apos;ll shape it into an epic
        </div>
        <div className="mt-2 text-muted-foreground">
          Tell me what you want built. I&apos;ll ask a few forcing questions, then help you draft an
          epic with a clear goal and proposed tickets. Accept it and it lands in backlog.
        </div>
      </div>
      <textarea
        value={description}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe an epic to shape…"
        aria-label="Describe an epic"
        rows={5}
        className="mt-5 min-h-0 flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-[12.5px] text-foreground placeholder:text-subtle focus:border-primary/50 focus:outline-none"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && description.trim() && !starting) {
            e.preventDefault();
            onStart();
          }
        }}
      />
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={!description.trim() || starting} onClick={onStart}>
          {starting ? "Starting…" : "Start shaping"}
        </Button>
        <span className="font-mono text-[11px] text-subtle">pty · claude · ⌘↵ to start</span>
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

function DraftInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] font-medium leading-snug",
          "placeholder:font-normal placeholder:text-subtle focus:border-primary/50 focus:outline-none",
        )}
      />
    </label>
  );
}

function DraftTextarea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className={cn(
          "resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground",
          "placeholder:text-subtle focus:border-primary/50 focus:outline-none",
        )}
      />
    </label>
  );
}
