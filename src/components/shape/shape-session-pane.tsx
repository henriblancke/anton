"use client";

import { Button } from "@/components/ui/button";
import { PtyTerminal } from "@/components/pty/pty-terminal";

import type { ShapeSession } from "./use-shape-session";

/** The left pane: the description composer until shaping starts, the live terminal after. */
export function SessionPane({ slug, session }: { slug: string; session: ShapeSession }) {
  return (
    <div className="flex min-w-0 flex-col border-border bg-card lg:border-r">
      {session.sessionId ? (
        <PtyTerminal slug={slug} sessionId={session.sessionId} />
      ) : (
        <Composer
          description={session.description}
          onChange={session.setDescription}
          onStart={session.start}
          starting={session.starting}
        />
      )}
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
  const canStart = description.trim() !== "" && !starting;
  return (
    <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
      <div className="font-mono text-[12.5px] leading-relaxed">
        <div className="text-stage-done">
          ● claude · describe the work — I&apos;ll shape it into a feature
        </div>
        <div className="mt-2 text-muted-foreground">
          Tell me what you want built. I&apos;ll ask a few forcing questions, then help you draft a
          feature — one PR&apos;s worth — and pick the epic it belongs to. Accept it and it lands in
          backlog.
        </div>
      </div>
      <textarea
        value={description}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe the work to shape…"
        aria-label="Describe the work"
        rows={5}
        className="mt-5 min-h-0 flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-[12.5px] text-foreground placeholder:text-subtle focus:border-primary/50 focus:outline-none"
        onKeyDown={(e) => handleStartChord(e, canStart, onStart)}
      />
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={!canStart} onClick={onStart}>
          {starting ? "Starting…" : "Start shaping"}
        </Button>
        <span className="font-mono text-[11px] text-subtle">pty · claude · ⌘↵ to start</span>
      </div>
    </div>
  );
}

/** ⌘↵ starts shaping — gated on exactly what the button is, so the shortcut can't outrun it. */
function handleStartChord(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  enabled: boolean,
  onStart: () => void,
): void {
  if (!enabled || e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  onStart();
}
