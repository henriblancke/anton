"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";

/**
 * One discovered-namespace criterion, mirrored from the server's PolicyLabelCriterion. Local for the
 * same reason as EditableSettings in settings-view: this client module never imports server code.
 */
export interface PolicyLabelCriterion {
  namespace: string;
  values: string[];
}

/** The standing work policy, mirrored from the server's Policy. */
export interface Policy {
  types?: string[];
  /** bd's priority NUMBER: P0 is 0 and larger is less urgent, so this is a floor, not a ceiling. */
  maxPriority?: number;
  labels?: PolicyLabelCriterion[];
  requireUnblocked?: boolean;
}

/** One criterion's evidence, mirrored from the server's PolicyRationale. */
export interface PolicyRationale {
  criterion: string;
  summary: string;
  citedBeadIds: string[];
}

/** A calibrated proposal, mirrored from the server's PolicyDraft. */
export interface PolicyDraft {
  policy: Policy;
  basis: "history" | "fallback";
  approvals: number;
  rationale: PolicyRationale[];
}

/** A `ns:` group of the board's labels, mirrored from the server's LabelNamespace. */
export interface LabelNamespace {
  namespace: string;
  labels: { label: string; count: number }[];
}

/** bd's priority scale, printed the way an operator says it. */
const PRIORITIES = [0, 1, 2, 3, 4];

/**
 * The work policy panel (anton-c7iv) — and, before anything is armed, the FIRST-ARM PROPOSAL.
 *
 * An operator opening this on a project that has never been armed is handed a policy calibrated from
 * that project's own approval history, in that project's own words, with the approvals behind each
 * criterion named beside it. That is the answer to the blank form: the draft is a starting point to
 * argue with, not a questionnaire.
 *
 * The draft is inert. Nothing here is stored until the operator presses accept, and until they do
 * the project stays unarmed — so an operator who disagrees with the proposal and closes the tab has
 * armed nothing, which is the safe direction.
 *
 * Once a policy IS stored the panel edits that instead: calibration runs at first arm only, so a
 * policy an operator has tuned is never quietly re-derived out from under them.
 */
export function PolicyDraftSection({
  project,
  draft,
  stored,
  issueTypes,
  labelVocabulary,
}: {
  project: Project;
  /** What calibration proposes for a project that has never been armed. */
  draft: PolicyDraft;
  /** The accepted policy, when there is one. Absent = first arm, and the draft is shown. */
  stored?: Policy;
  /** The issue types this board actually uses — anton ships no vocabulary, so it reads one. */
  issueTypes: string[];
  /** The board's `ns:value` labels, so a criterion's values can be widened, not only narrowed. */
  labelVocabulary: LabelNamespace[];
}) {
  const router = useRouter();
  const armed = stored !== undefined;
  const [policy, setPolicy] = useState<Policy>(stored ?? draft.policy);
  const [saving, setSaving] = useState(false);

  // Rationale is evidence for the PROPOSAL. Once a policy is the operator's own, quoting the
  // approvals anton once read would be explaining a decision nobody asked it to make.
  const why = (criterion: string): PolicyRationale | undefined =>
    armed ? undefined : draft.rationale.find((r) => r.criterion === criterion);

  const types = policy.types ?? [];
  const toggleType = (type: string) =>
    setPolicy((p) => {
      const next = types.includes(type) ? types.filter((t) => t !== type) : [...types, type].sort();
      // Empty means "not asserted", never "match nothing" — an operator clearing every chip is
      // removing the constraint, not asking anton to consider no work at all.
      return { ...p, types: next.length ? next : undefined };
    });

  const setLabelValues = (namespace: string, values: string[]) =>
    setPolicy((p) => {
      const rest = (p.labels ?? []).filter((c) => c.namespace !== namespace);
      // A criterion with no values fails closed against everything, so dropping the last value drops
      // the whole namespace — which is what "stop constraining this" means.
      const next = values.length ? [...rest, { namespace, values }] : rest;
      next.sort((a, b) => a.namespace.localeCompare(b.namespace));
      return { ...p, labels: next.length ? next : undefined };
    });

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pickerPolicy: policy }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      toast.success(armed ? "Policy saved" : "Policy accepted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[15px] font-semibold">Work policy</h2>
        <span className="text-xs text-subtle">
          what anton may start on its own · machine-local, never shared with another machine
        </span>
      </div>

      {!armed && (
        <div
          className="max-w-2xl rounded-[10px] border border-dashed border-primary/50 bg-primary/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-foreground"
          role="note"
        >
          <p className="font-medium">
            {draft.basis === "history"
              ? `Proposed from this project's own history — the policy that would have admitted all ${draft.approvals} of its approvals.`
              : "Proposed from anton's conservative default."}
          </p>
          <p className="mt-1 text-subtle">
            {draft.basis === "history"
              ? "Written in this board's own words, because it was read off this board. Edit anything below."
              : `Only ${draft.approvals} prior approval${draft.approvals === 1 ? "" : "s"} here — too few to read a pattern from, so anton proposes bd-native fields only.`}{" "}
            Nothing is armed until you accept it.
          </p>
        </div>
      )}

      <div className="flex max-w-2xl flex-col gap-3">
        <Criterion label="Issue type" why={why("types")}>
          <div className="flex flex-wrap gap-1.5">
            {[...new Set([...issueTypes, ...types])].sort().map((type) => (
              <Chip key={type} name={type} on={types.includes(type)} onClick={() => toggleType(type)}>
                {type}
              </Chip>
            ))}
          </div>
          {types.length === 0 && (
            <p className="text-[11px] text-subtle">
              No type constraint — anton will consider every kind of work on this board.
            </p>
          )}
        </Criterion>

        <Criterion label="Priority" why={why("priority")}>
          <label className="flex items-center gap-2 text-[11.5px] text-subtle">
            at least
            <select
              value={policy.maxPriority ?? ""}
              aria-label="Minimum priority"
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  maxPriority: e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
              className="rounded-lg border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:border-primary/60"
            >
              <option value="">any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </label>
        </Criterion>

        {(policy.labels ?? []).map((criterion) => {
          const onBoard = (labelVocabulary.find((g) => g.namespace === criterion.namespace)?.labels ?? [])
            .map((l) => l.label.slice(criterion.namespace.length + 1))
            .filter(Boolean);
          return (
            <Criterion
              key={criterion.namespace}
              label={`${criterion.namespace}:`}
              why={why(`labels:${criterion.namespace}`)}
              onRemove={() => setLabelValues(criterion.namespace, [])}
            >
              <div className="flex flex-wrap gap-1.5">
                {[...new Set([...onBoard, ...criterion.values])].sort().map((value) => {
                  const on = criterion.values.includes(value);
                  return (
                    <Chip
                      key={value}
                      name={`${criterion.namespace}:${value}`}
                      on={on}
                      onClick={() =>
                        setLabelValues(
                          criterion.namespace,
                          on
                            ? criterion.values.filter((v) => v !== value)
                            : [...criterion.values, value].sort(),
                        )
                      }
                    >
                      {value}
                    </Chip>
                  );
                })}
              </div>
            </Criterion>
          );
        })}

        <Criterion label="Blockers" why={why("blockers")}>
          <div className="flex items-center gap-2">
            <Toggle
              checked={policy.requireUnblocked ?? false}
              onChange={(next) => setPolicy((p) => ({ ...p, requireUnblocked: next || undefined }))}
              label="Skip targets with an unmet blocker"
            />
            <span className="text-[11.5px] text-subtle">skip targets with an unmet blocker</span>
          </div>
        </Criterion>
      </div>

      <div className="flex max-w-2xl items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : armed ? "Save policy" : "Use this policy"}
        </Button>
        <span className="text-[11px] text-subtle">
          {armed
            ? "Applies on this machine only."
            : "Until you accept, this project has no policy and anton starts nothing on its own."}
        </span>
      </div>
    </section>
  );
}

/** One criterion: its name, the evidence behind it, and whatever control edits it. */
function Criterion({
  label,
  why,
  onRemove,
  children,
}: {
  label: string;
  why?: PolicyRationale;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-foreground">{label}</span>
        {onRemove && (
          <Button size="xs" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      {children}
      {why && (
        <p className="text-[11px] leading-relaxed text-subtle">
          {why.summary}
          {why.citedBeadIds.length > 0 && (
            <>
              {" "}
              <span className="font-mono">{why.citedBeadIds.join(", ")}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * A membership chip — on means the value is admitted by the criterion. The accessible name is the
 * FULL label, not the chip's text: two namespaces can both carry an `eng` value, and two switches
 * announced as "eng" are two controls a screen-reader user cannot tell apart.
 */
function Chip({
  on,
  name,
  onClick,
  children,
}: {
  on: boolean;
  name: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        on
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border bg-background text-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
