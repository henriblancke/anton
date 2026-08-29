"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";

import type { Project } from "@/lib/types";
import {
  POLICY_BOUND_MAX,
  POLICY_CONTROL_NAMESPACES,
  POLICY_CRITERION_VALUES_MAX,
  POLICY_LABEL_CRITERIA_MAX,
  POLICY_TYPES_MAX,
  namespaceOf,
  valueOf,
  type Policy,
  type PolicyLabelCriterion,
  type PolicyRankComparison,
} from "@/lib/policy/types";
import { admittedValues, partitionByPolicy, type PolicyCandidate } from "@/lib/policy/match";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/atoms";

// The policy value shapes are the server's, imported from the dependency-free leaf they live in
// rather than mirrored: the editor and the predicate must agree on the ORDER of a ranked namespace,
// and two hand-kept copies of that contract is exactly how they would stop agreeing.
export type { Policy, PolicyLabelCriterion, PolicyCandidate };

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
 * How many beads either list renders before it stops. A board can hold hundreds of open beads, and
 * a disclosure that paints all of them costs more than it explains — the count above it is the
 * answer, the list is the evidence, and a few dozen rows is enough evidence.
 */
const MAX_LISTED = 40;

/**
 * The work policy panel (anton-c7iv, anton-qsr1) — and, before anything is armed, the FIRST-ARM
 * PROPOSAL.
 *
 * Two promises, and both are about legibility rather than power.
 *
 * An operator opening this on a project that has never been armed is handed a policy calibrated from
 * that project's own approval history, in that project's own words, with the approvals behind each
 * criterion named beside it. That is the answer to the blank form: the draft is a starting point to
 * argue with, not a questionnaire. The draft is inert — nothing is stored until accept, so an
 * operator who disagrees and closes the tab has armed nothing.
 *
 * And every edit answers itself. Criteria fail closed (R2.5), so a policy naming a label this board
 * does not use admits NOTHING — on screen indistinguishable from a broken pass unless the panel says
 * otherwise. So the count of matching startable targets moves with the control being edited, "see them"
 * proves it, and every bead the policy refused can name the criterion that refused it (R2.6).
 *
 * The criteria themselves are GENERATED (R2.2): the bd-native fields, plus one group per `ns:`
 * namespace read off this board. Nothing here names a label — a payments repo labelling `severity:`
 * and `team:` gets those, because those are what its board has.
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
  rankingCandidates = [],
  candidates = [],
  notStartable = 0,
  boardUnavailable = false,
}: {
  project: Project;
  /** What calibration proposes for a project that has never been armed. */
  draft: PolicyDraft;
  /** The accepted policy, when there is one. Absent = first arm, and the draft is shown. */
  stored?: Policy;
  /** The issue types this board actually uses — anton ships no vocabulary, so it reads one. */
  issueTypes: string[];
  /**
   * The board's `ns:value` labels — the namespaces this editor's criteria are generated from, less
   * anton's own bookkeeping ones ({@link POLICY_CONTROL_NAMESPACES}), which describe anton's runs
   * rather than the repo's judgement.
   */
  labelVocabulary: LabelNamespace[];
  /**
   * The namespaces whose values read as a SCALE (discovery's `rankingCandidate` hint). A HINT beside
   * the ranking control, never the gate on it: the scales discovery recognises are anton's own words,
   * and a repo whose `severity:` runs showstopper → nice-to-have must still be rankable by hand.
   */
  rankingCandidates?: string[];
  /**
   * Every STARTABLE run target on the board, projected server-side, so the match count moves without
   * a fetch. Startable rather than merely open: the picker refuses a claimed, blocked or unshaped
   * target before any policy is consulted, so counting one here would claim work anton cannot start.
   */
  candidates?: PolicyCandidate[];
  /** Open run targets the structural gate refused — the rest of the board, explained, not hidden. */
  notStartable?: number;
  /**
   * The board read FAILED — the vocabulary, the draft and the candidates below are all empty because
   * bd could not be read, not because the project is empty. Arming off that would store a policy
   * fitted to a read failure, so acceptance is refused until the board answers again.
   */
  boardUnavailable?: boolean;
}) {
  const router = useRouter();
  const armed = stored !== undefined;
  const [policy, setPolicy] = useState<Policy>(stored ?? draft.policy);
  const [saving, setSaving] = useState(false);

  // Whether what the controls currently hold was seeded off a FAILED board read — either the first
  // render, or a later disarm that fell back to the draft while the board was still unreadable.
  // React keeps client state across the `router.refresh()` that eventually delivers a real read, so
  // without this the panel would arm the failure-derived policy while the banner and rationale
  // beside it describe the recovered one. Nothing is lost by re-seeding: saving is disabled while
  // the board is unreadable, and every criterion is authored against a vocabulary that read
  // returned none of.
  const [seededBlind, setSeededBlind] = useState(boardUnavailable);
  if (seededBlind && !boardUnavailable) {
    setSeededBlind(false);
    setPolicy(stored ?? draft.policy);
  }

  // Pointer for the mouse, keyboard for everyone else: a ranking that can only be expressed by
  // dragging is a ranking some operators cannot express at all.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // Rationale is evidence for the PROPOSAL. Once a policy is the operator's own, quoting the
  // approvals anton once read would be explaining a decision nobody asked it to make.
  const why = (criterion: string): PolicyRationale | undefined =>
    armed ? undefined : draft.rationale.find((r) => r.criterion === criterion);

  const types = policy.types ?? [];
  // A board can expose more issue types than the store will hold, and a 17th chip previews a policy
  // the accept can only come back from as a 400 — the same ceiling the namespace controls keep.
  const typesAtCeiling = types.length >= POLICY_TYPES_MAX;
  const toggleType = (type: string) => {
    const on = types.includes(type);
    if (!on && typesAtCeiling) return;
    setPolicy((p) => {
      const next = on ? types.filter((t) => t !== type) : [...types, type].sort();
      // Empty means "not asserted", never "match nothing" — an operator clearing every chip is
      // removing the constraint, not asking anton to consider no work at all.
      return { ...p, types: next.length ? next : undefined };
    });
  };

  const criterionFor = (namespace: string): PolicyLabelCriterion | undefined =>
    (policy.labels ?? []).find((c) => c.namespace === namespace);

  const putCriterion = (namespace: string, next: PolicyLabelCriterion | undefined) =>
    setPolicy((p) => {
      const rest = (p.labels ?? []).filter((c) => c.namespace !== namespace);
      const labels = next ? [...rest, next] : rest;
      labels.sort((a, b) => a.namespace.localeCompare(b.namespace));
      return { ...p, labels: labels.length ? labels : undefined };
    });

  /**
   * The policy already constrains as many namespaces as the store will hold, so the next one is a
   * criterion the accept can only come back from as a 400. Boards that expose more `ns:` groups than
   * this are why the chips of an unconstrained namespace go dead rather than staying clickable.
   */
  const criteriaAtCeiling = (policy.labels ?? []).length >= POLICY_LABEL_CRITERIA_MAX;

  const toggleValue = (namespace: string, value: string) => {
    const current = criterionFor(namespace);
    const on = current?.values.includes(value) ?? false;
    // Same reasoning one level up: the value that would OPEN a criterion past the namespace ceiling
    // is refused, while every namespace the policy already names stays fully editable — including
    // clearing one, which is how the operator makes room for another.
    if (!on && !current && criteriaAtCeiling) return;
    // A namespace with more observed values than the store will hold is still authorable — the
    // operator selects the ones that matter — but the chip past the ceiling is refused here rather
    // than previewed as a valid policy the accept can only come back from as a 400.
    if (!on && (current?.values.length ?? 0) >= POLICY_CRITERION_VALUES_MAX) return;
    const values = on
      ? (current?.values ?? []).filter((v) => v !== value)
      : // A ranked namespace appends: sorting it would silently discard the order the operator
        // dragged into place. An unranked one stays alphabetical, where order carries no meaning.
        current?.ranked
        ? [...current.values, value]
        : [...(current?.values ?? []), value].sort();
    // A criterion with no values fails closed against everything, so dropping the last value drops
    // the whole namespace — which is what "stop constraining this" means.
    if (!values.length) return putCriterion(namespace, undefined);
    // A stored comparison survives a chip edit: rebuilding the criterion without it would silently
    // widen `severity ≤ major` into membership over the whole ranking, admitting work the operator
    // had excluded. It goes only when its own bound leaves the ranking — the one state nothing can
    // evaluate (R2.5), and one the store rejects outright.
    const compare = current?.compare;
    const keepsCompare = !!compare && !!current?.ranked && values.includes(compare.value);
    putCriterion(namespace, {
      namespace,
      values,
      ...(current?.ranked ? { ranked: true } : {}),
      ...(keepsCompare ? { compare } : {}),
    });
  };

  /**
   * The bound over a hand-ranking (R2.3) — `severity ≤ major`. Refused without a ranking to compare
   * against: a comparison with no scale behind it refuses every bead (R2.5) and the store rejects
   * it, so it is never a state this editor can reach.
   */
  const setCompare = (namespace: string, compare: PolicyRankComparison | undefined) => {
    const current = criterionFor(namespace);
    if (!current?.ranked) return;
    if (compare && !current.values.includes(compare.value)) return;
    putCriterion(
      namespace,
      compare
        ? { ...current, compare }
        : { namespace: current.namespace, values: current.values, ranked: true },
    );
  };

  const setRanked = (namespace: string, ranked: boolean) => {
    const current = criterionFor(namespace);
    if (!current) return;
    // Un-ranking takes any comparison with it: a bound against a ranking that no longer exists
    // refuses every bead (R2.5), so it must not survive the toggle it depended on.
    putCriterion(
      namespace,
      ranked
        ? { ...current, ranked: true }
        : { namespace: current.namespace, values: current.values },
    );
  };

  /**
   * A dragged value lands at its new rank. Sortable ids are `namespace:value`, so a drop is rejected
   * unless both ends belong to the same namespace — ranking is per-namespace, and a value that
   * jumped groups would silently change what the policy admits.
   */
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const namespace = namespaceOf(String(active.id));
    if (namespaceOf(String(over.id)) !== namespace) return;
    const current = criterionFor(namespace);
    if (!current) return;
    const from = current.values.indexOf(valueOf(String(active.id)) ?? "");
    const to = current.values.indexOf(valueOf(String(over.id)) ?? "");
    if (from < 0 || to < 0) return;
    putCriterion(namespace, {
      ...current,
      values: arrayMove(current.values, from, to),
      ranked: true,
    });
  };

  // What the policy on screen admits RIGHT NOW. Recomputed per edit rather than fetched: the whole
  // point is that the number answers the control the operator is still touching.
  const { matched, excluded } = useMemo(
    () => partitionByPolicy(candidates, policy),
    [candidates, policy],
  );

  const unconstrained = useMemo(() => isUnconstrained(policy), [policy]);

  // The board's types, plus any the policy names that the board no longer uses — a type left over
  // from a renamed convention has to stay visible to be removable.
  const typeVocabulary = useMemo(
    () => [...new Set([...issueTypes, ...(policy.types ?? [])])].sort(),
    [issueTypes, policy.types],
  );

  // Which namespaces discovery read as a SCALE. A HINT only: ranking is offered wherever the
  // operator selected values to order, because the scales anton recognises are anton's vocabulary
  // and a repo's own ordinal words (`showstopper` > `nice-to-have`) are not in it. Gating on this
  // set would make an operator's declaration depend on anton knowing their words (R2.2, R2.3).
  const scaleLike = useMemo(() => new Set(rankingCandidates), [rankingCandidates]);

  // Every namespace this board uses, plus any the policy names that the board no longer does — a
  // criterion left over from a renamed convention matches nothing, and hiding it would hide why.
  //
  // anton's own bookkeeping namespaces are not offered: `stage:` and `review-score:` say where anton
  // has already put a bead, so a criterion over them is the machine quoting itself — and one anton
  // rewrites mid-run admits a set that moves underneath the policy. A policy that already names one
  // stays on screen, because a criterion nothing can un-set is a criterion nothing can remove.
  const namespaces = useMemo(() => {
    const constrained = new Set((policy.labels ?? []).map((c) => c.namespace));
    const onBoard = labelVocabulary.filter(
      (g) =>
        g.namespace &&
        (!POLICY_CONTROL_NAMESPACES.has(g.namespace) || constrained.has(g.namespace)),
    );
    const known = new Set(onBoard.map((g) => g.namespace));
    const orphans = (policy.labels ?? [])
      .filter((c) => !known.has(c.namespace))
      .map((c) => ({ namespace: c.namespace, labels: [] as LabelNamespace["labels"] }));
    return [...onBoard, ...orphans];
  }, [labelVocabulary, policy.labels]);

  async function patchPolicy(next: Policy | null, done: string): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pickerPolicy: next }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      toast.success(done);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = () => patchPolicy(normalize(policy), armed ? "Policy saved" : "Policy accepted");

  /**
   * Back to UNARMED — the only way out of a policy accepted by mistake, since an armed project
   * starts work on its own and every other control here only edits which work. Storing `null`
   * removes the setting rather than storing an empty policy, which would admit everything.
   */
  const remove = async () => {
    if (!(await patchPolicy(null, "Policy removed"))) return;
    // Back to the proposal, so a disarmed project reads as one that has never been armed rather than
    // as a form still holding the policy it just removed. Disarming stays available while the board
    // is unreadable — it removes rather than stores — but the proposal it falls back to is then the
    // failure-derived one, so the re-seed above must know to replace it when the board answers.
    setPolicy(draft.policy);
    setSeededBlind(boardUnavailable);
  };

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[15px] font-semibold">Work policy</h2>
        <span className="text-xs text-subtle">what anton may start on its own</span>
      </div>

      {/* R2.1, stated where it changes what an operator expects: a policy is not shared state, so
          the machine beside you can hold a different one and neither is wrong. */}
      <p className="max-w-2xl text-[11.5px] leading-relaxed text-subtle">
        This policy is <span className="font-medium text-foreground">machine-local</span> — it is
        stored on this machine and never shared with another machine running this repo. Two machines
        may hold different policies; bd&apos;s claim protocol, not this setting, decides who runs
        what.
      </p>

      {boardUnavailable && (
        <div
          className="max-w-2xl rounded-[10px] border border-risk-high/30 bg-risk-high/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-foreground"
          role="alert"
        >
          <p className="font-medium">This board could not be read.</p>
          <p className="mt-1 text-subtle">
            The criteria and counts below are empty because bd did not answer, not because this
            project has no work. A policy accepted from that would be fitted to a read failure, so
            saving is disabled until the board answers again.
          </p>
        </div>
      )}

      {!armed && !boardUnavailable && (
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <div className="flex max-w-2xl flex-col gap-3">
          <Criterion label="Issue type" why={why("types")}>
            <div className="flex flex-wrap gap-1.5">
              {typeVocabulary.map((type) => (
                <Chip
                  key={type}
                  name={type}
                  on={types.includes(type)}
                  disabled={typesAtCeiling && !types.includes(type)}
                  onClick={() => toggleType(type)}
                >
                  {type}
                </Chip>
              ))}
            </div>
            {types.length === 0 && (
              <p className="text-[11px] text-subtle">
                No type constraint — anton will consider every kind of work on this board.
              </p>
            )}
            {typesAtCeiling && typeVocabulary.length > types.length && (
              <p className="text-[11px] text-subtle">
                A policy admits at most {POLICY_TYPES_MAX} issue types — the store accepts no more.
                Remove one to admit another.
              </p>
            )}
          </Criterion>

          <Criterion label="Priority" why={why("priority")}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-subtle">
              <label className="flex items-center gap-2">
                at least
                <PrioritySelect
                  name="Minimum priority"
                  value={policy.maxPriority}
                  onChange={(next) => setPolicy((p) => ({ ...p, maxPriority: next }))}
                />
              </label>
              <label className="flex items-center gap-2">
                and no more urgent than
                <PrioritySelect
                  name="Maximum priority"
                  value={policy.minPriority}
                  onChange={(next) => setPolicy((p) => ({ ...p, minPriority: next }))}
                />
              </label>
            </div>
            {typeof policy.minPriority === "number" && policy.minPriority > 0 && (
              <p className="text-[11px] text-subtle">
                Anything more urgent than P{policy.minPriority} is left for a human to start.
              </p>
            )}
          </Criterion>

          <Criterion label="Parentage" why={why("parentage")}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-subtle">
              <label className="flex items-center gap-2">
                at least
                <Bound
                  name="Minimum parent depth"
                  max={POLICY_BOUND_MAX.parentDepth}
                  value={policy.minParentDepth}
                  onChange={(next) => setPolicy((p) => ({ ...p, minParentDepth: next }))}
                />
              </label>
              <label className="flex items-center gap-2">
                and at most
                <Bound
                  name="Maximum parent depth"
                  max={POLICY_BOUND_MAX.parentDepth}
                  value={policy.maxParentDepth}
                  onChange={(next) => setPolicy((p) => ({ ...p, maxParentDepth: next }))}
                />
                parent levels
              </label>
            </div>
            <p className="text-[11px] text-subtle">
              Depth 0 is top-level, so &ldquo;at most 0&rdquo; admits only parentless work.
            </p>
          </Criterion>

          <Criterion label="Age" why={why("age")}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-subtle">
              <label className="flex items-center gap-2">
                filed at least
                <Bound
                  name="Minimum age in days"
                  max={POLICY_BOUND_MAX.minAgeDays}
                  value={policy.minAgeDays}
                  onChange={(next) => setPolicy((p) => ({ ...p, minAgeDays: next }))}
                />
              </label>
              <label className="flex items-center gap-2">
                and at most
                <Bound
                  name="Maximum age in days"
                  max={POLICY_BOUND_MAX.maxAgeDays}
                  value={policy.maxAgeDays}
                  onChange={(next) => setPolicy((p) => ({ ...p, maxAgeDays: next }))}
                />
                days ago
              </label>
            </div>
            <p className="text-[11px] text-subtle">
              The soak is the guard against starting work a human filed minutes ago and is still
              editing; the far end keeps a widened policy from reaching back into work the board has
              ignored for a year.
            </p>
          </Criterion>

          {namespaces.map((group) => (
            <NamespaceCriterion
              key={group.namespace}
              group={group}
              criterion={criterionFor(group.namespace)}
              locked={criteriaAtCeiling && !criterionFor(group.namespace)}
              scaleLike={scaleLike.has(group.namespace)}
              why={why(`labels:${group.namespace}`)}
              onToggleValue={(value) => toggleValue(group.namespace, value)}
              onRanked={(ranked) => setRanked(group.namespace, ranked)}
              onCompare={(compare) => setCompare(group.namespace, compare)}
              onClear={() => putCriterion(group.namespace, undefined)}
            />
          ))}

          <Criterion label="Blockers" why={why("blockers")}>
            <div className="flex items-center gap-2">
              <Toggle
                checked={policy.requireUnblocked ?? false}
                onChange={(next) => setPolicy((p) => ({ ...p, requireUnblocked: next || undefined }))}
                label="Skip targets with an unmet blocker"
              />
              <span className="text-[11.5px] text-subtle">skip targets with an unmet blocker</span>
            </div>
            <p className="text-[11px] text-subtle">
              A target held by an open blocker is already refused before the policy is applied, so
              this states a rule anton keeps either way — the count below will not move with it.
            </p>
          </Criterion>
        </div>
      </DndContext>

      {!boardUnavailable && (
        <MatchPanel
          matched={matched}
          excluded={excluded}
          total={candidates.length}
          notStartable={notStartable}
        />
      )}

      {unconstrained && !boardUnavailable && (
        <p className="max-w-2xl rounded-[10px] border border-risk-med/28 bg-risk-med/10 px-3 py-2 text-[11.5px] leading-relaxed text-foreground">
          This policy asserts no criteria — it admits every startable run target on this board. Arming
          it places no constraint on what anton starts.
        </p>
      )}

      <div className="flex max-w-2xl flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || boardUnavailable}>
          {saving ? "Saving…" : armed ? "Save policy" : "Use this policy"}
        </Button>
        {armed && (
          <Button size="sm" variant="ghost" onClick={remove} disabled={saving}>
            Remove policy
          </Button>
        )}
        <span className="text-[11px] text-subtle">
          {boardUnavailable
            ? "Nothing can be saved while the board is unreadable."
            : armed
              ? "Applies on this machine only. Removing it returns the project to starting nothing on its own."
              : "Until you accept, this project has no policy and anton starts nothing on its own."}
        </span>
      </div>
    </section>
  );
}

/**
 * A policy that asserts NOTHING — every criterion cleared, so it admits every open run target. It is
 * a legible state to pass through while editing and a dangerous one to arm, which is why it is named
 * on screen rather than silently stored. Read off the normalized value, since that is what is sent.
 *
 * Field-agnostic on purpose: unset is `undefined`, an emptied list is dropped, and `requireUnblocked:
 * false` is a toggle that constrains nothing — so a criterion added later is covered without an edit
 * here.
 */
function isUnconstrained(policy: Policy): boolean {
  return Object.values(normalize(policy)).every(
    (value) => value === undefined || value === false || (Array.isArray(value) && !value.length),
  );
}

/**
 * The open run targets the structural gate refused, said in the operator's terms. Named rather than
 * silently dropped: a denominator smaller than the board reads as a board with less work on it.
 */
function withheld(count: number): string {
  return `${count} more open run target${count === 1 ? " is" : "s are"} not startable right now — already claimed, held by a blocker, or short of the approve contract — so the policy is never asked about ${count === 1 ? "it" : "them"}.`;
}

/**
 * What the policy admits right now, and — the load-bearing half — what it refused and why (R2.6).
 *
 * A zero here is the expected first answer on a repo whose conventions anton has never seen, so it
 * is stated as the policy talking rather than left as a bare 0 an operator reads as a broken pass.
 */
function MatchPanel({
  matched,
  excluded,
  total,
  notStartable,
}: {
  matched: PolicyCandidate[];
  excluded: { candidate: PolicyCandidate; failed: { label: string; reason: string }[] }[];
  total: number;
  notStartable: number;
}) {
  if (total === 0) {
    return (
      <p className="max-w-2xl text-[11.5px] text-subtle">
        Nothing on this board is startable right now, so there is nothing for the policy to match
        against yet.
        {notStartable > 0 && ` ${withheld(notStartable)}`}
      </p>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-2 rounded-[10px] border border-border bg-card px-3 py-2.5">
      {/* The denominator is the STARTABLE set, not the open board: the picker never asks the policy
          about a target it has already refused, so counting those would claim available work anton
          has none of. */}
      <p className="text-[12.5px] text-foreground" role="status" aria-live="polite">
        <span className="font-semibold">{matched.length}</span> of {total} startable run target
        {total === 1 ? "" : "s"} match this policy
      </p>

      {notStartable > 0 && <p className="text-[11px] text-subtle">{withheld(notStartable)}</p>}

      {matched.length === 0 && (
        <p className="text-[11px] leading-relaxed text-subtle">
          Nothing matches — that is the policy, not a fault. Criteria fail closed: a bead missing a
          label a criterion names does not satisfy it. Open below to see which criterion is doing it.
        </p>
      )}

      {matched.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-subtle hover:text-foreground">
            See them ({matched.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {matched.slice(0, MAX_LISTED).map((c) => (
              <li key={c.id} className="flex gap-2 text-[11.5px]">
                <span className="shrink-0 font-mono text-[10.5px] text-subtle">{c.id}</span>
                <span className="truncate text-foreground">{c.title}</span>
              </li>
            ))}
            {matched.length > MAX_LISTED && (
              <li className="text-[11px] text-subtle">
                …and {matched.length - MAX_LISTED} more
              </li>
            )}
          </ul>
        </details>
      )}

      {excluded.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-subtle hover:text-foreground">
            Why not the rest? ({excluded.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {excluded.slice(0, MAX_LISTED).map(({ candidate, failed }) => (
              <li key={candidate.id}>
                <details>
                  <summary className="flex cursor-pointer gap-2 text-[11.5px] hover:text-foreground">
                    <span className="shrink-0 font-mono text-[10.5px] text-subtle">
                      {candidate.id}
                    </span>
                    <span className="truncate text-subtle">{candidate.title}</span>
                  </summary>
                  <ul className="mt-1 mb-1 ml-4 flex flex-col gap-0.5">
                    {failed.map((f) => (
                      <li key={f.label} className="text-[11px] text-subtle">
                        <span className="font-mono text-foreground">{f.label}</span> — {f.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
            {excluded.length > MAX_LISTED && (
              <li className="text-[11px] text-subtle">
                …and {excluded.length - MAX_LISTED} more
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One discovered namespace, generated from the board's own labels — membership by default, and a
 * hand-ranked order only when the operator asks for one (R2.3). anton never infers the order,
 * because a namespace a repo invented has none to infer.
 */
function NamespaceCriterion({
  group,
  criterion,
  locked,
  scaleLike,
  why,
  onToggleValue,
  onRanked,
  onCompare,
  onClear,
}: {
  group: LabelNamespace;
  criterion?: PolicyLabelCriterion;
  /**
   * The policy already names as many namespaces as the store holds, and this one is not among them —
   * so it is shown (hiding it would hide why the board's other namespaces went quiet) and refused.
   */
  locked: boolean;
  /** Discovery read these values as a scale — a hint beside the control, never a gate on it. */
  scaleLike: boolean;
  why?: PolicyRationale;
  onToggleValue: (value: string) => void;
  onRanked: (ranked: boolean) => void;
  onCompare: (compare: PolicyRankComparison | undefined) => void;
  onClear: () => void;
}) {
  const selected = criterion?.values ?? [];
  const onBoard = group.labels
    .map((l) => l.label.slice(group.namespace.length + 1))
    .filter(Boolean);
  // Board values first (usage order, as the vocabulary read them), then anything the policy names
  // that the board no longer carries — a stale value has to stay visible to be removable.
  const values = [...onBoard, ...selected.filter((v) => !onBoard.includes(v))];
  const ranked = criterion?.ranked ?? false;
  const atCeiling = selected.length >= POLICY_CRITERION_VALUES_MAX;

  return (
    <Criterion
      label={`${group.namespace}:`}
      why={why}
      onRemove={selected.length ? onClear : undefined}
    >
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Chip
            key={value}
            name={`${group.namespace}:${value}`}
            on={selected.includes(value)}
            disabled={(atCeiling || locked) && !selected.includes(value)}
            onClick={() => onToggleValue(value)}
          >
            {value}
          </Chip>
        ))}
      </div>

      {selected.length === 0 && !locked && (
        <p className="text-[11px] text-subtle">Not constrained — any value, or none, matches.</p>
      )}

      {locked && (
        <p className="text-[11px] text-subtle">
          A policy constrains at most {POLICY_LABEL_CRITERIA_MAX} namespaces — the store accepts no
          more. Clear another namespace to constrain this one.
        </p>
      )}

      {atCeiling && values.length > selected.length && (
        <p className="text-[11px] text-subtle">
          A criterion admits at most {POLICY_CRITERION_VALUES_MAX} values — the store accepts no
          more. Remove one to admit another.
        </p>
      )}

      {selected.length > 1 && (
        <div className="flex items-center gap-2">
          <Toggle
            checked={ranked}
            onChange={onRanked}
            label={`Rank ${group.namespace}: values`}
          />
          <span className="text-[11.5px] text-subtle">
            rank these values — drag to order them, most preferred first
            {scaleLike && !ranked && " · these read as a scale"}
          </span>
        </div>
      )}

      {ranked && criterion && selected.length > 1 && (
        <>
          <SortableContext
            items={selected.map((v) => `${group.namespace}:${v}`)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="flex flex-col gap-1">
              {selected.map((value, i) => (
                <RankedValue
                  key={value}
                  id={`${group.namespace}:${value}`}
                  rank={i + 1}
                  value={value}
                />
              ))}
            </ol>
          </SortableContext>
          <RankBound namespace={group.namespace} criterion={criterion} onChange={onCompare} />
        </>
      )}
    </Criterion>
  );
}

/**
 * The bound over a hand-ranking — the ONE way a discovered namespace gains an order (R2.3), and only
 * because the operator declared both the ranking and the bound. Offered only where a ranking exists,
 * because a comparison without one can be evaluated against nothing and refuses every bead (R2.5).
 *
 * Choosing an op never narrows on its own: it lands on the end of the ranking that admits everything
 * already selected, so the policy changes when the operator moves the bound rather than when they
 * reach for the control.
 */
function RankBound({
  namespace,
  criterion,
  onChange,
}: {
  namespace: string;
  criterion: PolicyLabelCriterion;
  onChange: (compare: PolicyRankComparison | undefined) => void;
}) {
  const values = criterion.values;
  const compare = criterion.compare;
  // Never undefined here: the criterion is ranked and its bound is one of its own values.
  const admitted = admittedValues(criterion) ?? values;

  const setOp = (op: string) => {
    if (!op) return onChange(undefined);
    const widest = op === "lte" ? values[values.length - 1] : values[0];
    onChange({ op: op as PolicyRankComparison["op"], value: compare?.value ?? widest });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-subtle">
        admit
        <select
          aria-label={`Bound ${namespace}: by rank`}
          value={compare?.op ?? ""}
          onChange={(e) => setOp(e.target.value)}
          className={BOUND_CLASS}
        >
          <option value="">every selected value</option>
          <option value="lte">at or before</option>
          <option value="gte">at or after</option>
        </select>
        {compare && (
          <select
            aria-label={`Bound ${namespace}: at`}
            value={compare.value}
            onChange={(e) => onChange({ op: compare.op, value: e.target.value })}
            className={BOUND_CLASS}
          >
            {values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
        in this ranking
      </div>
      <p className="text-[11px] text-subtle">
        {compare
          ? `Admits ${namespace}:${admitted.join(`, ${namespace}:`)} — the rest of the ranking is left for a human.`
          : "The order is stored, but every selected value still matches. Bound it to admit only part of the ranking."}
      </p>
    </div>
  );
}

/** One value at its rank, draggable by the handle — the same grip affordance the board uses. */
function RankedValue({ id, rank, value }: { id: string; rank: number; value: string }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1",
        isDragging && "opacity-40",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${id}`}
        style={{ touchAction: "none" }}
        className="flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" aria-hidden="true" />
      </button>
      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-subtle">{rank}</span>
      <span className="font-mono text-[11px] text-foreground">{value}</span>
    </li>
  );
}

/**
 * The policy as it goes over the wire. A `ranked` flag on a criterion narrowed back to one value
 * describes an ordering of one thing, so it is dropped rather than stored as a fact nothing can use.
 */
function normalize(policy: Policy): Policy {
  const labels = (policy.labels ?? []).map((c) =>
    c.ranked && c.values.length > 1 ? c : { namespace: c.namespace, values: c.values },
  );
  return { ...policy, labels: labels.length ? labels : undefined };
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

/** Shared chrome, so both ends of an ordered bound read as the same kind of control. */
const BOUND_CLASS =
  "rounded-lg border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground outline-none focus:border-primary/60";

/**
 * One end of the priority bound. The scale is printed the way an operator says it — P0 is the most
 * urgent — while the policy holds bd's number, so the two ends read as "at least" and "no more
 * urgent than" even though the comparison underneath them inverts.
 */
function PrioritySelect({
  name,
  value,
  onChange,
}: {
  name: string;
  value?: number;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <select
      aria-label={name}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      className={BOUND_CLASS}
    >
      <option value="">any priority</option>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          P{p}
        </option>
      ))}
    </select>
  );
}

/**
 * One end of a whole-unit native bound — parent hops, or days.
 *
 * Empty is UNSET, never 0: an asserted criterion still fails closed on a bead that cannot answer it,
 * so an operator clearing the box has to stop asserting it rather than assert zero.
 *
 * `max` is the field's own schema ceiling, and typed input is clamped to it rather than passed on:
 * the settings route rejects anything above it, so accepting the value here would show a live match
 * count for a policy that can only ever come back as a 400 the operator cannot resolve.
 */
function Bound({
  name,
  value,
  max,
  onChange,
}: {
  name: string;
  value?: number;
  max: number;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      step={1}
      placeholder="any"
      aria-label={name}
      value={value ?? ""}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        const unset = e.target.value === "" || !Number.isFinite(parsed) || parsed < 0;
        onChange(unset ? undefined : Math.min(Math.floor(parsed), max));
      }}
      className={cn(BOUND_CLASS, "w-16")}
    />
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
  disabled = false,
  onClick,
  children,
}: {
  on: boolean;
  name: string;
  /** The criterion is full — the chip stays announced, so its ceiling is legible rather than silent. */
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border bg-background text-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
