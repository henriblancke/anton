"use client";

import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { JOB_TYPE_LABELS } from "@/lib/jobs-filters";
import { MODEL_ROUTABLE_STEP_IDS, PIPELINE_JOB_TYPE } from "@/lib/jobs/step-ids";
import {
  MODEL_ROUTABLE_JOB_TYPES,
  isModelRoutableJobTypeWithLabelContext,
  subsumes,
  type ModelRouteMatch,
} from "@/lib/jobs/model-routing";
import { RowControls, SectionHeading } from "@/components/settings/settings-fields";
import type { ModelRouteRow } from "@/components/settings/settings-types";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** The matcher selects' "this rule does not ask" option — an omitted matcher, not a wildcard. */
const ANY = "";

/**
 * Which model each kind of work runs on (anton-uu7r) — authored beside the pipeline variants it is
 * shaped after, because it answers the same question in the same way: let the work pick, rather than
 * making one setting expensive enough for the hardest job.
 *
 * The panel's whole job is making the evaluation ORDER legible, since that is what decides which
 * rule applies: rows are numbered, reorderable, and a row an earlier row already shadows is called
 * out where it sits rather than only at the server's 400.
 */
export function ModelRoutingSection({ form, projectSlug }: { form: SettingsForm; projectSlug: string }) {
  const rows = form.draft.modelRouteRows;
  const fallback = form.draft.model.trim();
  const shadows = shadowMap(rows);
  const { models, loading, error, refresh } = useGatewayModels(projectSlug, form.saved);

  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Model routing"
        hint="which model each kind of work runs on · first match wins"
      />

      <div className="flex max-w-3xl flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[11.5px] text-subtle">
            No routing rules — every job runs on the default model{" "}
            {fallback ? (
              <code className="font-mono text-[11px]">{fallback}</code>
            ) : (
              <span>set in General</span>
            )}
            . That is the norm; add a rule only where one kind of work needs a different model.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <RouteRow
                key={row.id}
                row={row}
                index={i}
                total={rows.length}
                shadowedBy={shadows[i]}
                form={form}
                models={models}
              />
            ))}
          </ol>
        )}
        <Button size="sm" variant="outline" className="self-start" onClick={form.modelRoutes.add}>
          <PlusIcon aria-hidden="true" />
          Add rule
        </Button>
        {form.saved.claudeBaseUrl && form.saved.claudeAuthTokenEnv && (
          <div className="flex items-center gap-2 text-[11px] text-subtle">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
              {loading ? "Loading models…" : models.length > 0 ? "Refresh gateway models" : "Load gateway models"}
            </Button>
            {models.length > 0 && <span>{models.length} gateway models available</span>}
            {error && <span className="text-risk-high">{error}</span>}
          </div>
        )}
      </div>

      {models.length > 0 && (
        <datalist id="gateway-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}

      <span className="max-w-3xl text-[11px] text-subtle">
        Rules are evaluated top down and the <strong className="font-medium">first match wins</strong>
        ; work matching no rule runs on the default model from General
        {fallback ? (
          <>
            {" "}
            (<code className="font-mono text-[11px]">{fallback}</code>)
          </>
        ) : (
          " (or the driver's own default)"
        )}
        . A rule matches when every field it names matches — leave one on{" "}
        <em className="not-italic text-foreground">Any</em> to stop asking about it. Model takes any
        name your driver accepts, including a gateway combo like{" "}
        <code className="font-mono text-[11px]">cc/claude-opus-5[1m]</code>. Put the narrowest rules
        first: a broader rule above a narrower one makes the narrower one unreachable, and saving is
        refused rather than leaving you a rule that quietly never fires.
      </span>
    </section>
  );
}

/**
 * One rule. Only `execute-epic` walks a pipeline, so the step select is disabled for any other job
 * type — the constraint is shown where it applies rather than sprung as a save error.
 */
function RouteRow({
  row,
  index,
  total,
  shadowedBy,
  form,
  models,
}: {
  row: ModelRouteRow;
  index: number;
  total: number;
  /** The 1-based rule that already matches everything this one does, if any. */
  shadowedBy?: number;
  form: SettingsForm;
  models: string[];
}) {
  const n = index + 1;
  const stepsApply = row.jobType === ANY || row.jobType === PIPELINE_JOB_TYPE;
  const labelsApply = row.jobType === ANY || isModelRoutableJobTypeWithLabelContext(row.jobType);
  const dead = shadowedBy !== undefined;

  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-2.5 py-2",
        dead && "border-risk-high/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-4 shrink-0 text-center font-mono text-[10px] text-subtle">{n}</span>

        <Matcher
          label={`Rule ${n} job type`}
          value={row.jobType}
          onChange={(jobType) =>
            form.modelRoutes.patch(row.id, {
              jobType,
              // A step is only a fact about the pipeline job, so switching away drops it rather
              // than leaving an invisible matcher the save would then be refused for.
              ...(jobType !== ANY && jobType !== PIPELINE_JOB_TYPE ? { step: ANY } : {}),
              // Scheduled jobs have no bead to supply labels, so avoid an invisible matcher the
              // settings boundary would reject as unreachable.
              ...(jobType !== ANY && !isModelRoutableJobTypeWithLabelContext(jobType) ? { label: ANY } : {}),
            })
          }
          options={MODEL_ROUTABLE_JOB_TYPES.map((t) => ({ value: t, label: JOB_TYPE_LABELS[t] }))}
          anyLabel="Any job"
        />

        <Matcher
          label={`Rule ${n} step`}
          value={row.step}
          onChange={(step) => form.modelRoutes.patch(row.id, { step })}
          options={MODEL_ROUTABLE_STEP_IDS.map((s) => ({ value: s, label: s }))}
          anyLabel="Any step"
          disabled={!stepsApply}
          title={stepsApply ? undefined : "only an epic run walks a pipeline"}
        />

        <input
          type="text"
          value={row.label}
          onChange={(e) => form.modelRoutes.patch(row.id, { label: e.target.value })}
          placeholder="any label"
          maxLength={120}
          aria-label={`Rule ${n} bead label`}
          disabled={!labelsApply}
          title={labelsApply ? undefined : "this job has no bead labels"}
          className={cn(
            "min-w-0 flex-1 basis-32 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60",
            !labelsApply && "cursor-not-allowed opacity-50",
          )}
        />

        <span aria-hidden="true" className="shrink-0 text-[11px] text-subtle">
          →
        </span>

        <input
          type="text"
          value={row.model}
          onChange={(e) => form.modelRoutes.patch(row.id, { model: e.target.value })}
          placeholder="claude-opus-5"
          list={models.length > 0 ? "gateway-models" : undefined}
          maxLength={200}
          aria-label={`Rule ${n} model`}
          className="min-w-0 flex-1 basis-40 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
        />

        <RowControls
          onMoveUp={() => form.modelRoutes.move(row.id, -1)}
          onMoveDown={() => form.modelRoutes.move(row.id, 1)}
          onRemove={() => form.modelRoutes.remove(row.id)}
          atTop={index === 0}
          atBottom={index === total - 1}
          labels={{
            up: `Move rule ${n} up`,
            down: `Move rule ${n} down`,
            remove: `Remove rule ${n}`,
          }}
        />
      </div>

      {dead && (
        <p role="status" className="pl-6 text-[11px] text-risk-high">
          Rule {shadowedBy} above already matches everything this rule does, so it can never fire —
          move it above rule {shadowedBy}, or narrow it.
        </p>
      )}
    </li>
  );
}

function useGatewayModels(
  projectSlug: string,
  settings: Pick<SettingsForm["saved"], "claudeBaseUrl" | "claudeAuthTokenEnv">,
) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const baseUrl = settings.claudeBaseUrl?.trim();
  const tokenEnv = settings.claudeAuthTokenEnv?.trim();

  const refresh = useCallback(async () => {
    if (!baseUrl || !tokenEnv) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/projects/${projectSlug}/settings/models`);
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
        throw new Error("Could not retrieve models from the configured gateway");
      }
      setModels(body.models.filter((model): model is string => typeof model === "string"));
    } catch (cause) {
      setModels([]);
      setError(cause instanceof Error ? cause.message : "Could not retrieve gateway models");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, projectSlug, tokenEnv]);

  return { models, loading, error, refresh };
}

/** One matcher select. `Any` is the first option because an unasked question is the common case. */
function Matcher({
  label,
  value,
  onChange,
  options,
  anyLabel,
  disabled,
  title,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  anyLabel: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="relative flex shrink-0 items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        disabled={disabled}
        title={title}
        className={cn(
          "appearance-none rounded-lg border border-border bg-background py-1.5 pr-7 pl-2.5 text-[12px] text-foreground outline-none focus:border-primary/60",
          disabled && "cursor-not-allowed opacity-50",
          value === ANY && "text-subtle",
        )}
      >
        <option value={ANY}>{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 text-[10px] text-subtle">▾</span>
    </div>
  );
}

/**
 * For each row, the 1-based number of the row that already matches everything it does — the panel's
 * half of the save-time rejection, shown while the operator is still authoring rather than only
 * when Save comes back 400.
 *
 * Computed over the rules a save would SEND, but reported in ROW numbers, which are what the
 * operator sees: a scaffolding row naming no model is neither a shadow nor shadowed, because the
 * save drops it before the server ever evaluates the table.
 */
function shadowMap(rows: ModelRouteRow[]): (number | undefined)[] {
  const rules = rows.map((row) => (row.model.trim() === "" ? undefined : matchersOf(row)));
  return rules.map((rule, i) => {
    if (!rule) return undefined;
    const at = rules.findIndex((earlier, j) => j < i && earlier !== undefined && subsumes(earlier, rule));
    return at < 0 ? undefined : at + 1;
  });
}

/** A row's matchers as the save sends them: a blank one is an absent question, never `""`. */
function matchersOf(row: ModelRouteRow): ModelRouteMatch {
  return {
    ...(row.jobType.trim() ? { jobType: row.jobType.trim() } : {}),
    ...(row.step.trim() ? { step: row.step.trim() } : {}),
    ...(row.label.trim() ? { label: row.label.trim() } : {}),
  };
}
