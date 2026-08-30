"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import {
  AUTONOMY_GROUPS,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_HINT,
  NO_RECORD,
  lockedReason,
  type AutonomyKindSpec,
  type EarnedKind,
  type ProposalAutonomy,
} from "@/components/settings/settings-autonomy";
import { SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * How far a pass may go with what it files, per kind (anton-nbyy). Grouped by REVERSIBILITY rather
 * than by producer: the gardener's shipped-orphan close and its implied-order link come out of the
 * same pass and are nothing alike to get wrong, and a flat list of eleven kinds hides exactly that.
 */
export function ProposalsSection({
  form,
  earned,
  projectSlug,
}: {
  form: SettingsForm;
  earned: Record<string, EarnedKind>;
  projectSlug: string;
}) {
  return (
    <section className="flex max-w-2xl flex-col gap-3.5">
      <SectionHeading
        title="Proposal autonomy"
        hint="how far a pass may go with what it finds, per kind"
      />

      <AutonomyLegend projectSlug={projectSlug} />

      {AUTONOMY_GROUPS.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-labelledby={`autonomy-group-${group.id}`}
          className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3"
        >
          <div className="flex flex-col gap-1">
            <span id={`autonomy-group-${group.id}`} className="text-[12.5px] font-medium">
              {group.title}
            </span>
            <span className="text-[11px] text-subtle">{group.does}</span>
            <span className="text-[11px] text-subtle">
              <span className="text-muted-foreground">Undone by</span> {group.undo}
            </span>
            {group.armed && (
              <span className="text-[11px] text-risk-med">
                <span className="font-mono">apply</span> {group.armed}
              </span>
            )}
          </div>

          <div className="flex flex-col divide-y divide-border/60">
            {group.kinds.map((kind) => (
              <AutonomyRow
                key={kind.id}
                kind={kind}
                earned={earned[kind.id] ?? NO_RECORD}
                value={form.draft.proposalAutonomy[kind.id]}
                onChange={(level) => form.armKind(kind.id, level)}
              />
            ))}
          </div>

          {group.floor && <span className="text-[11px] text-subtle">{group.floor}</span>}
        </div>
      ))}
    </section>
  );
}

/** What each level means, the second gate arming needs, and where the writes show up. */
function AutonomyLegend({ projectSlug }: { projectSlug: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      {AUTONOMY_LEVELS.map((level) => (
        <div key={level} className="flex items-baseline gap-2.5">
          <span className="w-14 shrink-0 font-mono text-[10.5px] text-primary">{level}</span>
          <span className="text-[11px] text-subtle">{AUTONOMY_LEVEL_HINT[level]}</span>
        </div>
      ))}
      {/* The second gate arming needs (anton-m29g), said once at the top rather than only in the row
          it locks: a founder who finds `apply` unavailable has to know it is a rule and not a bug,
          and what would lift it. */}
      <span className="text-[11px] text-subtle">
        <span className="font-mono text-primary">apply</span> also has to be EARNED. A kind is
        armable only once your own accept/decline verdicts on its proposals support it — a clean
        shadow week says the move would run, never that it was right. Each row shows where that kind
        stands.
      </span>
      {/* Where the writes show up (anton-hzce). An applied proposal closes the moment it is filed,
          so it never stands on the board as an ask — an operator arming a kind here has to be told,
          at the moment they arm it, where the evidence will be. */}
      <span className="text-[11px] text-subtle">
        Every unattended write is recorded on its pass&apos;s row on the{" "}
        <Link
          href={`/projects/${projectSlug}/jobs`}
          className="text-primary underline-offset-2 hover:underline"
        >
          Jobs page
        </Link>
        , with the reason for anything it refused.
      </span>
    </div>
  );
}

/**
 * One detection kind's autonomy row (anton-nbyy): what approving it writes, how far this project lets
 * a pass go with it, and what its own proposals have earned (anton-m29g). A kind either floor pins at
 * `propose` says so in the row rather than being left out — an operator has to be able to see that
 * anton knows about `oversized`, or that `parentless-cluster` is locked on 3/12, which a silently
 * absent row and a bare disabled control both fail to tell them.
 */
function AutonomyRow({
  kind,
  earned,
  value,
  onChange,
}: {
  kind: AutonomyKindSpec;
  earned: EarnedKind;
  value: ProposalAutonomy;
  onChange: (level: ProposalAutonomy) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[11.5px]">{kind.id}</span>
        <span className="text-[11px] text-subtle">{kind.does}</span>
        {kind.blocked ? (
          <span className="text-[11px] text-risk-med">not armable · {kind.blocked}</span>
        ) : earned.eligible ? (
          // Said out loud on the way UP too: the counts are what an operator is arming ON, and a bar
          // that only ever speaks when it refuses gives them no way to know it was consulted.
          <span className="text-[11px] text-subtle">
            record · {earned.applied}/{earned.settled} applied — clears the bar
          </span>
        ) : (
          <span className="text-[11px] text-risk-med">apply locked · {lockedReason(earned)}</span>
        )}
      </div>
      <span className="ml-auto shrink-0">
        <AutonomyChoice kind={kind} earned={earned} value={value} onChange={onChange} />
      </span>
    </div>
  );
}

/**
 * The three levels as a segmented radio group, least autonomous first.
 *
 * Real radios rather than a `<select>`: three options whose whole point is that one is further along
 * a scale than the next read better side by side, and this is the shape that can show a kind the
 * floor pins DISABLED with its reason instead of hiding it — an operator offered a level the pass
 * silently ignores is worse off than one who can see why it isn't on offer.
 */
function AutonomyChoice({
  kind,
  earned,
  value,
  onChange,
}: {
  kind: AutonomyKindSpec;
  earned: EarnedKind;
  value: ProposalAutonomy;
  onChange: (level: ProposalAutonomy) => void;
}) {
  // TWO floors take a level off the table, and they take different amounts. `oversized` has no
  // mechanical move at all, so EVERY level is pinned for it — offering it `shadow` would be a
  // setting the pass silently ignores. A kind whose record has not earned `apply` (anton-m29g) loses
  // only that one: `shadow` is how the record becomes readable in the first place and writes
  // nothing, so gating it would lock the door and pocket the key.
  const pinned = kind.blocked;
  const unearned = kind.blocked || earned.eligible ? undefined : lockedReason(earned);
  return (
    <fieldset className="flex gap-0.5 rounded-[9px] border border-border bg-background/40 p-0.5">
      <legend className="sr-only">{kind.id} autonomy</legend>
      {AUTONOMY_LEVELS.map((level) => {
        const unavailable = pinned ?? (level === "apply" ? unearned : undefined);
        return (
          <label
            key={level}
            title={unavailable ?? AUTONOMY_LEVEL_HINT[level]}
            className={cn("block", unavailable ? "cursor-not-allowed" : "cursor-pointer")}
          >
            <input
              type="radio"
              name={`autonomy-${kind.id}`}
              className="peer sr-only"
              value={level}
              checked={value === level}
              disabled={Boolean(unavailable)}
              onChange={() => onChange(level)}
              aria-label={`${kind.id} · ${level}`}
            />
            <span className="block rounded-[7px] px-2 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors peer-checked:bg-primary/15 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50 peer-disabled:text-subtle peer-disabled:opacity-50">
              {level}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
