"use client";

import { Toggle } from "@/components/atoms";
import { SectionHeading, TextField } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * Point this project at a Claude-compatible gateway (anton-n16m) without touching the shell that
 * launched anton. The token itself is never stored — only the NAME of the env var anton reads it
 * from at spawn time, out of its own environment.
 */
export function GatewaySection({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Claude gateway"
        hint="route this project through a gateway instead of the Claude API"
      />

      <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
        <TextField
          label="Base URL"
          value={draft.claudeBaseUrl}
          onChange={(value) => set("claudeBaseUrl", value)}
          placeholder="e.g. http://localhost:20128"
          hint="an http(s) URL · empty = the Claude API"
          maxLength={2000}
        />
        <TextField
          label="Auth token env var"
          value={draft.claudeAuthTokenEnv}
          onChange={(value) => set("claudeAuthTokenEnv", value)}
          placeholder="e.g. ANTHROPIC_AUTH_TOKEN"
          hint="the NAME of an env var, not the token"
          maxLength={256}
        />
      </div>

      <div className="flex max-w-2xl items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px]">Discover models from the gateway</span>
          <span className="text-[10.5px] text-subtle">
            ask the gateway which models it serves · off by default
          </span>
        </div>
        <span className="ml-auto">
          <Toggle
            checked={draft.claudeGatewayModelDiscovery}
            onChange={(next) => set("claudeGatewayModelDiscovery", next)}
            label="Discover models from the gateway"
          />
        </span>
      </div>

      <span className="max-w-2xl text-[11px] text-subtle">
        The gateway token is <strong className="font-semibold text-foreground">never stored</strong>.
        anton reads it at spawn time from the named environment variable in its own environment — set
        that variable in the shell or service that runs anton. Saving a base URL requires a token env
        var name.
      </span>
    </section>
  );
}
