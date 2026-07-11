"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "execution", label: "Execution" },
  { id: "automation", label: "Automation" },
] as const;

const AGENTS = [
  "fastapi",
  "supabase",
  "pydantic",
  "nextjs",
  "alembic",
  "terraform",
  "docker",
  "kubernetes",
] as const;

const DEFAULT_ACTIVE = new Set(["fastapi", "supabase", "pydantic", "nextjs"]);

const AUTOMATIONS = [
  { id: "nightly-stringer", label: "nightly-stringer", meta: "scan → triage · 0 2 * * *", on: true },
  { id: "review-fix", label: "review-fix watcher", meta: "poll PRs every 5m", on: true },
  { id: "orphan-grooming", label: "orphan-grooming", meta: "bucket loose tickets", on: false },
];

export function SettingsView({ project }: { project: Project }) {
  const [active, setActive] = useState<(typeof SECTIONS)[number]["id"]>("general");
  const [agents, setAgents] = useState<Set<string>>(new Set(DEFAULT_ACTIVE));
  const [concurrency, setConcurrency] = useState(3);
  const [autonomy, setAutonomy] = useState(true);
  const [automations, setAutomations] = useState<Record<string, boolean>>(
    Object.fromEntries(AUTOMATIONS.map((a) => [a.id, a.on])),
  );

  function toggleAgent(agent: string) {
    setAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Settings</span>
        </div>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => toast.success("Settings saved locally")}
        >
          Save changes
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[168px_1fr]">
        {/* subnav */}
        <nav className="flex flex-row gap-1 border-border p-3 md:flex-col md:border-r md:p-4">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                active === s.id
                  ? "bg-card font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="mt-auto hidden px-2.5 py-1.5 text-left text-[12.5px] text-risk-high md:block">
            Danger zone
          </span>
        </nav>

        {/* panels */}
        <div className="flex flex-col gap-7 overflow-y-auto p-6 md:p-7">
          {/* General */}
          <section className="flex flex-col gap-3.5">
            <h2 className="text-[15px] font-semibold">General</h2>
            <div className="grid max-w-xl grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field label="Name" value={project.name} />
              <Field label="Default branch" value={project.defaultBranch} mono />
              <Field label="Repository path" value={project.repoPath} mono className="sm:col-span-2" />
              <Field label="Default model" value="claude-sonnet" mono chevron />
              <Field label="Beads" value={project.hasBeads ? "connected" : "missing"} />
            </div>
          </section>

          <Divider />

          {/* Agents */}
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Active agents</h2>
              <span className="text-xs text-subtle">which agent prompts anton may assign</span>
            </div>
            <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
              {AGENTS.map((agent) => {
                const on = agents.has(agent);
                return (
                  <div
                    key={agent}
                    className={cn(
                      "flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5",
                      !on && "opacity-70",
                    )}
                  >
                    <span className={cn("size-2 rounded-full", agentDotClass(agent))} aria-hidden="true" />
                    <span className="font-mono text-xs">{agent}</span>
                    <span className="ml-auto">
                      <Toggle checked={on} onChange={() => toggleAgent(agent)} label={`agent ${agent}`} />
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <Divider />

          {/* Execution + Automation */}
          <div className="grid max-w-3xl grid-cols-1 gap-7 md:grid-cols-2">
            <section className="flex flex-col gap-3.5">
              <h2 className="text-[15px] font-semibold">Execution</h2>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between">
                  <span className="text-[12.5px] text-muted-foreground">Max concurrent runs</span>
                  <span className="font-mono text-[12.5px] text-primary">{concurrency}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={6}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  aria-label="Max concurrent runs"
                  className="accent-primary"
                />
                <span className="text-[11px] text-subtle">1 — 6 · worktrees run in parallel</span>
              </div>
              <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px]">Autonomous execution</span>
                  <span className="text-[10.5px] text-subtle">run approved epics without asking</span>
                </div>
                <span className="ml-auto">
                  <Toggle checked={autonomy} onChange={setAutonomy} label="Autonomous execution" />
                </span>
              </div>
            </section>

            <section className="flex flex-col gap-3.5">
              <h2 className="text-[15px] font-semibold">Automation</h2>
              <div className="flex flex-col gap-2.5">
                {AUTOMATIONS.map((a) => {
                  const on = automations[a.id];
                  return (
                    <div
                      key={a.id}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5",
                        !on && "opacity-70",
                      )}
                    >
                      <span
                        className={cn("size-1.5 rounded-full", on ? "bg-stage-done" : "bg-stage-backlog")}
                        aria-hidden="true"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12.5px]">{a.label}</span>
                        <span className="font-mono text-[10.5px] text-subtle">{a.meta}</span>
                      </div>
                      <span className="ml-auto">
                        <Toggle
                          checked={on}
                          onChange={(next) => setAutomations((p) => ({ ...p, [a.id]: next }))}
                          label={a.label}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <Divider />

          {/* Danger zone */}
          <section className="flex max-w-2xl items-center gap-3.5 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-risk-high">Remove project</span>
              <span className="text-xs text-muted-foreground">
                Detaches anton from this repo. Beads &amp; git are untouched.
              </span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              onClick={() => toast("Removing a project isn't wired up yet.")}
            >
              Remove
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  chevron = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  chevron?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <div
        className={cn(
          "flex items-center rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]",
          mono && "font-mono",
        )}
      >
        <span className="truncate" title={value}>
          {value}
        </span>
        {chevron && <span className="ml-auto text-subtle">▾</span>}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}
