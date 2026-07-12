"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";

/** Settings the UI can edit today. Kept local so this client module never imports server code. */
interface EditableSettings {
  model?: string;
  seedPrompt?: string;
  reviewFixPrompt?: string;
}

/** Default model options for the headless claude driver. Empty value = the CLI's own default. */
const MODELS: { value: string; label: string; hint?: string }[] = [
  { value: "", label: "Default", hint: "use claude's configured model" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "most capable" },
  { value: "claude-sonnet-5", label: "Sonnet 5", hint: "balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest" },
  { value: "claude-fable-5", label: "Fable 5", hint: "frontier" },
];

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "prompt", label: "Prompt" },
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

export function SettingsView({
  project,
  settings,
  basePrompt,
}: {
  project: Project;
  settings: EditableSettings;
  /** The locked base system prompt, shown read-only so operators see what always applies. */
  basePrompt: string;
}) {
  const [active, setActive] = useState<(typeof SECTIONS)[number]["id"]>("general");
  const [agents, setAgents] = useState<Set<string>>(new Set(DEFAULT_ACTIVE));
  const [concurrency, setConcurrency] = useState(3);
  const [autonomy, setAutonomy] = useState(true);
  const [automations, setAutomations] = useState<Record<string, boolean>>(
    Object.fromEntries(AUTOMATIONS.map((a) => [a.id, a.on])),
  );
  const [model, setModel] = useState(settings.model ?? "");
  const [seedPrompt, setSeedPrompt] = useState(settings.seedPrompt ?? "");
  const [reviewFixPrompt, setReviewFixPrompt] = useState(settings.reviewFixPrompt ?? "");
  const [saving, setSaving] = useState(false);

  function toggleAgent(agent: string) {
    setAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // "" clears the override → driver runs with no --model / no seed / the default review-fix prompt.
        body: JSON.stringify({
          model: model || null,
          seedPrompt: seedPrompt.trim() || null,
          reviewFixPrompt: reviewFixPrompt.trim() || null,
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(error ?? "Save failed");
      }
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Settings</span>
        </div>
        <Button size="sm" className="ml-auto" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
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
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-semibold">General</h2>
              {/* beads connection is status, not an editable field */}
              <BeadsStatus connected={project.hasBeads} />
            </div>
            <div className="grid max-w-xl grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field label="Name" value={project.name} />
              <Field label="Default branch" value={project.defaultBranch} mono />
              <Field label="Repository path" value={project.repoPath} mono className="sm:col-span-2" />
              <ModelField value={model} onChange={setModel} className="sm:col-span-2" />
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

          {/* Prompt — locked base contract (read-only) + editable operator seed */}
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Execution prompt</h2>
              <span className="text-xs text-subtle">what anton tells claude on every autonomous run</span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Seed prompt</span>
                <span className="text-[11px] text-subtle">editable · project-specific guidance</span>
                {seedPrompt.trim() !== (settings.seedPrompt ?? "").trim() && (
                  <span className="font-mono text-[10px] text-primary">unsaved</span>
                )}
              </div>
              <textarea
                value={seedPrompt}
                onChange={(e) => setSeedPrompt(e.target.value)}
                rows={6}
                maxLength={8000}
                placeholder="e.g. Prefer server components. Our design tokens live in src/styles/tokens.css. Never touch the legacy /v1 API."
                aria-label="Seed prompt"
                className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
              />
              <span className="text-[11px] text-subtle">
                Layered on top of the base contract below. It refines behavior — it can’t override
                the contract. Empty = base + agent prompt only. {seedPrompt.length}/8000
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Review-fix prompt</span>
                <span className="text-[11px] text-subtle">editable · how claude resolves PR feedback</span>
                {reviewFixPrompt.trim() !== (settings.reviewFixPrompt ?? "").trim() && (
                  <span className="font-mono text-[10px] text-primary">unsaved</span>
                )}
              </div>
              <textarea
                value={reviewFixPrompt}
                onChange={(e) => setReviewFixPrompt(e.target.value)}
                rows={6}
                maxLength={8000}
                placeholder="Override the default review-fix reasoning prompt. Empty = anton's shipped default (skills/review-fix/SKILL.md)."
                aria-label="Review-fix prompt"
                className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
              />
              <span className="text-[11px] text-subtle">
                The reasoning contract for the review-fix job. anton appends the concrete PR context
                (comments, failing checks) beneath it. Empty = shipped default. {reviewFixPrompt.length}/8000
              </span>
            </div>

            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">Base contract</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  locked · always applied
                </span>
              </div>
              <pre className="max-h-64 max-w-2xl overflow-auto rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {basePrompt || "(base prompt unavailable)"}
              </pre>
              <span className="text-[11px] text-subtle">
                Core operating rules — git &amp; beads ownership, learnings capture, scope,
                fail-loud. Defined in code; not editable here.
              </span>
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

/** Default-model selector. Persists to settingsJson.model; "" runs claude with no --model. */
function ModelField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const hint = MODELS.find((m) => m.value === value)?.hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">Default model</span>
      <div className="relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Default model"
          className="w-full appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none"
        >
          {MODELS.map((m) => (
            <option key={m.value || "default"} value={m.value}>
              {m.label}
              {m.value ? ` · ${m.value}` : ""}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </div>
  );
}

/** beads connection shown as a status pill, not an editable field. */
function BeadsStatus({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        connected
          ? "border-stage-done/30 bg-stage-done/10 text-stage-done"
          : "border-risk-high/30 bg-risk-high/10 text-risk-high",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", connected ? "bg-stage-done" : "bg-risk-high")}
        aria-hidden="true"
      />
      beads {connected ? "connected" : "missing"}
    </span>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}
