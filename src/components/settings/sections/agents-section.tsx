"use client";

import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { agentDotClass } from "@/components/board/board-utils";
import { SectionHeading } from "@/components/settings/settings-fields";
import type { DiscoveredAgent } from "@/components/settings/settings-types";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * The allowlist gates anton's BUNDLED agents only; the project's own `.claude/agents` always run
 * and are listed separately as "always active" (anton-dvo.1 reversal).
 */
export function AgentsSection({
  form,
  bundledAgents,
  userAgents,
}: {
  form: SettingsForm;
  bundledAgents: DiscoveredAgent[];
  userAgents: DiscoveredAgent[];
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Active agents"
        hint="which of anton's bundled agents dispatch may assign"
      />
      {bundledAgents.length === 0 ? (
        <p className="max-w-2xl text-xs text-subtle">No bundled agents available.</p>
      ) : (
        <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
          {bundledAgents.map((agent) => {
            const on = form.draft.activeAgents.has(agent.id);
            return (
              <div
                key={agent.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5",
                  !on && "opacity-70",
                )}
                title={agent.description}
              >
                <AgentDot id={agent.id} />
                <span className="truncate font-mono text-xs">{agent.id}</span>
                <span className="ml-auto shrink-0">
                  <Toggle
                    checked={on}
                    onChange={() => form.toggleAgent(agent.id)}
                    label={`agent ${agent.id}`}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {userAgents.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <span className="text-xs text-subtle">
            always active · your own agents (<span className="font-mono">.claude/agents</span> and
            installed plugins) — never gated by the allowlist
          </span>
          <div className="grid max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
            {userAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5"
                title={agent.description}
              >
                <AgentDot id={agent.id} />
                <span className="truncate font-mono text-xs">{agent.id}</span>
                <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9.5px] text-subtle">
                  {agent.source}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AgentDot({ id }: { id: string }) {
  return (
    <span className={cn("size-2 shrink-0 rounded-full", agentDotClass(id))} aria-hidden="true" />
  );
}
