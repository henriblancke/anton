"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";
import { DeleteProjectDialog } from "@/components/settings/delete-project-dialog";
import { PruneBeadsSection } from "@/components/settings/prune-beads-section";

/** Settings the UI can edit today. Kept local so this client module never imports server code. */
interface EditableSettings {
  model?: string;
  seedPrompt?: string;
  reviewFixPrompt?: string;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  concurrency?: number;
  jobTimeoutMinutes?: number;
  maxRetries?: number;
  agents?: string[];
  autonomy?: boolean;
  conventionalCommits?: boolean;
}

// Defaults mirror the server (src/lib/projects.ts DEFAULT_*); duplicated so this client module
// stays server-import-free. Keep in sync.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2h
const DEFAULT_MAX_RETRIES = 3;

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

// Display copy for the scheduled automations. Ids match the schedule row `type`; crons mirror
// DEFAULT_SCHEDULES in src/lib/schedules.ts — keep in sync. Enabled state comes from `schedules`.
const AUTOMATIONS = [
  { id: "nightly-stringer", label: "nightly-stringer", meta: "scan → triage · 0 3 * * *" },
  { id: "review-fix", label: "review-fix watcher", meta: "poll PRs every 15m" },
  { id: "orphan-grooming", label: "orphan-grooming", meta: "bucket loose tickets · 0 4 * * 1" },
];

/** Per-automation schedule state from the server; a missing row means "not scheduled yet". */
interface AutomationSchedule {
  type: string;
  enabled: boolean;
}

/**
 * One discoverable agent (anton-dvo.1), mirrored from the server's DiscoveredAgent. Kept local so
 * this client module never imports the server-only discovery code.
 */
interface DiscoveredAgent {
  id: string;
  source: "project" | "global" | "bundled";
  description?: string;
}

export function SettingsView({
  project,
  settings,
  basePrompt,
  schedules,
  agents,
}: {
  project: Project;
  settings: EditableSettings;
  /** The locked base system prompt, shown read-only so operators see what always applies. */
  basePrompt: string;
  /** The project's schedule rows (schedules.enabled) backing the Automation toggles. */
  schedules: AutomationSchedule[];
  /** Every agent this project can assign — bundled + the operator's own .claude/agents. */
  agents: DiscoveredAgent[];
}) {
  const [active, setActive] = useState<(typeof SECTIONS)[number]["id"]>("general");
  // The enabled allowlist. Absent persisted value → seed "all discovered on", matching the runtime
  // rule that an absent allowlist means every agent is active (so a no-op save stays all-active).
  const [activeAgents, setActiveAgents] = useState<Set<string>>(
    () => new Set(settings.agents ?? agents.map((a) => a.id)),
  );
  const [concurrency, setConcurrency] = useState(settings.concurrency ?? DEFAULT_CONCURRENCY);
  const [jobTimeoutMinutes, setJobTimeoutMinutes] = useState(
    settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES,
  );
  const [maxRetries, setMaxRetries] = useState(settings.maxRetries ?? DEFAULT_MAX_RETRIES);
  const [autonomy, setAutonomy] = useState(settings.autonomy ?? true);
  const [conventionalCommits, setConventionalCommits] = useState(
    settings.conventionalCommits ?? false,
  );
  // null = no schedule row for this project yet (shown as "not scheduled"; toggling creates it).
  const [automations, setAutomations] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(
      AUTOMATIONS.map((a) => [a.id, schedules.find((s) => s.type === a.id)?.enabled ?? null]),
    ),
  );
  const [model, setModel] = useState(settings.model ?? "");
  const [seedPrompt, setSeedPrompt] = useState(settings.seedPrompt ?? "");
  const [reviewFixPrompt, setReviewFixPrompt] = useState(settings.reviewFixPrompt ?? "");
  const [testCommand, setTestCommand] = useState(settings.testCommand ?? "");
  const [lintCommand, setLintCommand] = useState(settings.lintCommand ?? "");
  const [typecheckCommand, setTypecheckCommand] = useState(settings.typecheckCommand ?? "");
  const [buildCommand, setBuildCommand] = useState(settings.buildCommand ?? "");
  const [saving, setSaving] = useState(false);

  /**
   * Flip one automation's schedules.enabled row immediately (not via Save) — optimistic flip,
   * reverted with a toast if the PATCH fails. A missing row is created server-side.
   */
  async function toggleAutomation(id: string, next: boolean) {
    const prev = automations[id];
    setAutomations((p) => ({ ...p, [id]: next }));
    try {
      const res = await fetch(`/api/projects/${project.slug}/schedules`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: id, enabled: next }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(error ?? "Update failed");
      }
      toast.success(`${id} ${next ? "enabled" : "disabled"}`);
    } catch (err) {
      setAutomations((p) => ({ ...p, [id]: prev }));
      toast.error(err instanceof Error ? err.message : `Failed to update ${id}`);
    }
  }

  function toggleAgent(agent: string) {
    setActiveAgents((prev) => {
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
          // "" clears a verify gate → it's skipped (no behavior change).
          testCommand: testCommand.trim() || null,
          lintCommand: lintCommand.trim() || null,
          typecheckCommand: typecheckCommand.trim() || null,
          buildCommand: buildCommand.trim() || null,
          concurrency,
          jobTimeoutMinutes,
          maxRetries,
          // The enabled ids, in discovered order. Only ids we actually rendered — a stale id from
          // a since-deleted agent (still in the seeded set) is pruned rather than re-persisted.
          agents: agents.filter((a) => activeAgents.has(a.id)).map((a) => a.id),
          autonomy,
          conventionalCommits,
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
              <span className="text-xs text-subtle">
                which agent prompts anton may assign · bundled + your{" "}
                <span className="font-mono">.claude/agents</span>
              </span>
            </div>
            {agents.length === 0 ? (
              <p className="max-w-2xl text-xs text-subtle">No agents discovered for this project.</p>
            ) : (
              <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
                {agents.map((agent) => {
                  const on = activeAgents.has(agent.id);
                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5",
                        !on && "opacity-70",
                      )}
                      title={agent.description}
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", agentDotClass(agent.id))}
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-xs">{agent.id}</span>
                      {agent.source !== "bundled" && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9.5px] text-subtle">
                          {agent.source}
                        </span>
                      )}
                      <span className="ml-auto shrink-0">
                        <Toggle
                          checked={on}
                          onChange={() => toggleAgent(agent.id)}
                          label={`agent ${agent.id}`}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
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

          {/* Verify gates — operator-pinned hard checks run in the worktree before commit */}
          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">Verify gates</h2>
              <span className="text-xs text-subtle">
                deterministic checks anton runs after the agent, before commit · non-zero exit fails
                the ticket
              </span>
            </div>
            <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
              <GateField
                label="Test command"
                value={testCommand}
                onChange={setTestCommand}
                placeholder="e.g. bun run test"
              />
              <GateField
                label="Lint command"
                value={lintCommand}
                onChange={setLintCommand}
                placeholder="e.g. bun run lint"
              />
              <GateField
                label="Typecheck command"
                value={typecheckCommand}
                onChange={setTypecheckCommand}
                placeholder="e.g. bun run typecheck"
              />
              <GateField
                label="Build command"
                value={buildCommand}
                onChange={setBuildCommand}
                placeholder="e.g. bun run build"
              />
            </div>
            <span className="max-w-2xl text-[11px] text-subtle">
              Each gate runs in the ticket&apos;s worktree in order (test → lint → typecheck →
              build). Empty = skipped. These are the operator-pinned backstop; the agent still
              self-verifies. The same gates run before review-fix pushes.
            </span>
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

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted-foreground">Job timeout</span>
                  <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
                    <input
                      type="number"
                      min={5}
                      max={720}
                      value={jobTimeoutMinutes}
                      onChange={(e) => setJobTimeoutMinutes(Number(e.target.value))}
                      aria-label="Job timeout in minutes"
                      className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-9 font-mono text-[12.5px] text-foreground outline-none"
                    />
                    <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">
                      min
                    </span>
                  </div>
                  <span className="text-[11px] text-subtle">per run · default 120 (2h)</span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted-foreground">Retries</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                    aria-label="Max retries"
                    className="rounded-[10px] border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-primary/60"
                  />
                  <span className="text-[11px] text-subtle">attempts before parking · default 3</span>
                </label>
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

              <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12.5px]">Conventional-commit PR titles</span>
                  <span className="text-[10.5px] text-subtle">
                    prefix epic PR titles with feat/fix(scope)
                  </span>
                </div>
                <span className="ml-auto">
                  <Toggle
                    checked={conventionalCommits}
                    onChange={setConventionalCommits}
                    label="Conventional-commit PR titles"
                  />
                </span>
              </div>
            </section>

            <section className="flex flex-col gap-3.5">
              <h2 className="text-[15px] font-semibold">Automation</h2>
              <div className="flex flex-col gap-2.5">
                {AUTOMATIONS.map((a) => {
                  const state = automations[a.id];
                  const on = state === true;
                  const missing = state === null;
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
                        <span className="font-mono text-[10.5px] text-subtle">
                          {missing ? `${a.meta} · not scheduled` : a.meta}
                        </span>
                      </div>
                      <span className="ml-auto">
                        <Toggle
                          checked={on}
                          onChange={(next) => toggleAutomation(a.id, next)}
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
          <section className="flex max-w-2xl flex-col gap-3.5">
            <h2 className="text-[15px] font-semibold text-risk-high">Danger zone</h2>
            <div className="flex items-center gap-3.5 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold text-risk-high">Delete project</span>
                <span className="text-xs text-muted-foreground">
                  Destroys anton&apos;s state — settings, runs, worktrees. Repo &amp; beads are
                  untouched.
                </span>
              </div>
              <span className="ml-auto">
                <DeleteProjectDialog project={project} />
              </span>
            </div>
            {/* Prune closed beads (anton-uobe): permanent deletion, gated behind preview + confirm */}
            <div className="flex flex-col gap-3 rounded-xl border border-risk-high/25 bg-risk-high/5 p-4">
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold text-risk-high">Prune closed beads</span>
                <span className="text-xs text-muted-foreground">
                  Permanently deletes piled-up closed beads (they bloat the export and slow
                  queries). Open and in-progress beads are never touched.
                </span>
              </div>
              <PruneBeadsSection project={project} />
            </div>
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

/** Editable verify-gate command (anton-3oh8). Persists to settingsJson.*Command; "" clears it. */
function GateField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={1000}
        aria-label={label}
        className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </label>
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
