"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Toggle } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { SectionHeading, TextField } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";
import type { JevHealth } from "@/lib/decide/backends/jev-fallback";

/** A registered decide() point and the state fields it would disclose to a model backend — the same
 * `stateFields` {@link import("@/lib/decide/points").narrowState} enforces, read for display only. */
export interface JevDisclosureRow {
  id: string;
  stateFields: string[];
}

const HEALTH_HINT: Record<JevHealth["status"], string> = {
  healthy: "answering normally — every call still tries jev first",
  unhealthy: "repeated failures — calls are falling back to claude-local",
};

/**
 * Opt a project into Jev as decide()'s backend (anton-l70sq, anton-p32iy): explicit (a toggle, not
 * an inferred default), disclosed (exactly which fields each point would send, in the clear below),
 * and safe to fail (a failed call answers via claude-local instead of going answer-less — see
 * jev-fallback.ts). Per-project only — there is no global switch (out of scope, anton-p32iy).
 */
export function JevSection({
  form,
  apiKeyConfigured,
  disclosure,
  health,
}: {
  form: SettingsForm;
  /** Whether a key is already stored — the server never sends the key itself back (anton-p32iy). */
  apiKeyConfigured: boolean;
  /** Every registered decide() point and the state it would disclose, if this project turns Jev on. */
  disclosure: JevDisclosureRow[];
  /** Undefined until something has actually called the jev backend — see jev-fallback.ts's own
   *  doc comment for why health is tracked in-memory rather than read back from the decisions log. */
  health?: JevHealth;
}) {
  const { draft, set } = form;
  const [clearing, setClearing] = useState(false);

  async function clearKey() {
    setClearing(true);
    try {
      const res = await form.patchSettings({ jevApiKey: null });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Clear failed (${res.status})`);
      }
      toast.success("Jev API key cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Jev backend"
        hint="opt this project into TypeSafe's Jev for decide() — off by default, per project only"
      />

      <div className="flex max-w-2xl items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px]">Use Jev for decide()</span>
          <span className="text-[10.5px] text-subtle">
            a hosted API, answering in milliseconds — off keeps every point on claude-local
          </span>
        </div>
        <span className="ml-auto">
          <Toggle checked={draft.jevEnabled} onChange={(next) => set("jevEnabled", next)} label="Use Jev for decide()" />
        </span>
      </div>

      <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-subtle">API key</span>
            <input
              type="password"
              value={draft.jevApiKey}
              onChange={(e) => set("jevApiKey", e.target.value)}
              placeholder={apiKeyConfigured ? "stored — leave blank to keep it" : "paste your Jev API key"}
              maxLength={500}
              aria-label="API key"
              className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
            />
          </label>
          <span className="text-[11px] text-subtle">
            {apiKeyConfigured
              ? "a key is already stored — it is never shown here again; type a new one to replace it"
              : "held directly in this project's local settings · never sent anywhere but api.typesafe.ai"}
          </span>
          {apiKeyConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              disabled={clearing}
              onClick={() => void clearKey()}
            >
              Clear stored key
            </Button>
          )}
        </div>
        <TextField
          label="Pinned model"
          value={draft.jevModel}
          onChange={(value) => set("jevModel", value)}
          placeholder="e.g. jev-1.13.0"
          hint='an exact jev-X.Y.Z version — "jev-latest" is refused'
          maxLength={64}
        />
      </div>

      <HealthRow health={health} />

      <Disclosure rows={disclosure} />
    </section>
  );
}

function HealthRow({ health }: { health?: JevHealth }) {
  if (!health) {
    return (
      <div className="flex max-w-2xl items-center gap-2 rounded-[10px] border border-border bg-card px-3 py-2.5 text-[11px] text-subtle">
        <span className="size-1.5 rounded-full bg-subtle" aria-hidden="true" />
        No calls yet — health appears once a decide() point has actually called Jev.
      </div>
    );
  }
  const healthy = health.status === "healthy";
  return (
    <div className="flex max-w-2xl flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={healthy ? "size-1.5 rounded-full bg-stage-done" : "size-1.5 rounded-full bg-risk-high"}
          aria-hidden="true"
        />
        <span className={healthy ? "text-[12.5px] text-stage-done" : "text-[12.5px] text-risk-high"}>
          {healthy ? "Healthy" : "Unhealthy"}
        </span>
        <span className="text-[11px] text-subtle">{HEALTH_HINT[health.status]}</span>
      </div>
      <span className="text-[11px] text-subtle">
        {health.consecutiveFailures > 0
          ? `${health.consecutiveFailures} failure(s) in a row`
          : "no failures in a row"}
        {health.lastError ? ` · last error: ${health.lastError}` : ""}
      </span>
    </div>
  );
}

/** The per-point field disclosure (anton-p32iy): exactly which state fields a point would send to
 * Jev, read straight off `DecisionPoint.stateFields` — the same list `narrowState` enforces, so
 * this can never promise less than what actually reaches the backend. */
function Disclosure({ rows }: { rows: JevDisclosureRow[] }) {
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <span className="text-[12.5px] font-medium">What each point would send</span>
      <span className="text-[11px] text-subtle">
        Every registered decide() point, and the exact state fields it would disclose to Jev if this
        project turns it on — the same fields any other backend sees, nothing more.
      </span>
      {rows.length === 0 ? (
        <p className="rounded-[10px] border border-border bg-card px-3 py-2.5 text-[11px] text-subtle">
          No decision points are registered yet.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60 rounded-[10px] border border-border bg-card px-3 py-1">
          {rows.map((row) => (
            <div key={row.id} className="flex items-baseline gap-2.5 py-2 first:pt-1.5 last:pb-1.5">
              <span className="w-40 shrink-0 truncate font-mono text-[11.5px]" title={row.id}>
                {row.id}
              </span>
              <span className="font-mono text-[11px] text-subtle">
                {row.stateFields.length > 0 ? row.stateFields.join(", ") : "(no state fields)"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
