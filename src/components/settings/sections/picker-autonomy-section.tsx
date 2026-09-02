"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { PICKER_AUTONOMY_LEVELS, type PickerAutonomy } from "@/lib/policy/types";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/settings/settings-fields";

/**
 * What the picker's own record has earned (anton-vkp9), as the form receives it — plain counts and a
 * reason, computed on the server (`gardener/autonomy.ts` `earnedPickerAutonomy`) off the same
 * verdicts the pass reads.
 *
 * The counts travel WITH the verdict, exactly as the proposal rows' do. A control that is merely
 * disabled is the failure this floor exists to stop repeating: an operator who finds `apply`
 * unavailable has to be told what it is locked ON and what would unlock it, in the row, at the
 * moment they are deciding.
 */
export interface EarnedPicker {
  /** Picks released, out of picks answered — the record, in the operator's own acts. */
  accepted: number;
  settled: number;
  eligible: boolean;
  /** Why apply is unavailable, with the counts and the bar. Absent exactly when eligible. */
  reason?: string;
}

/** A project with no answered picks — what every project starts on, and what an unreadable store yields. */
export const NO_PICKER_RECORD: EarnedPicker = { accepted: 0, settled: 0, eligible: false };

const PICKER_LEVEL_HINT: Record<PickerAutonomy, string> = {
  propose: "ranks what could run next and records the plan · nothing is offered",
  shadow: "offers each pick in Up Next · you release it or veto it, and that is the record",
  apply: "approves, claims and starts its top pick unattended · nobody is asked",
};

/**
 * Why `apply` is locked, always sayable — the same reasoning `lockedReason` uses for a detection
 * kind: `eligible` is the gate and `reason` only ever its label, so a verdict that arrives
 * ineligible with no reason still reads as locked instead of silently offering the level.
 */
export function lockedPickerReason(earned: EarnedPicker): string {
  return earned.reason ?? "no record could be read for this project — apply stays locked";
}

/**
 * How far the picker may go with the plan it decides (anton-vkp9), and what this project's own
 * record has earned.
 *
 * Sits under the work policy because the two answer halves of one question — the policy is what
 * anton MAY start, this is whether it starts it — and because `apply` is unreachable without an
 * armed policy at all.
 *
 * Self-patching, like the policy panel above it rather than like the shared Save bar: moving the
 * picker to `apply` is an act, not a field, and it should land when it is chosen rather than when
 * some unrelated edit elsewhere on the page is saved.
 */
export function PickerAutonomySection({
  slug,
  armed,
  stored,
  earned,
}: {
  slug: string;
  /** This project has an accepted work policy. Without one, `apply` is structurally unreachable. */
  armed: boolean;
  /** The stored level; absent means never chosen, which an armed project reads back as `shadow`. */
  stored?: PickerAutonomy;
  earned: EarnedPicker;
}) {
  const router = useRouter();
  // The two floors, in the order the pass applies them (`resolvePickerAutonomy`). Kept apart rather
  // than merged into one disabled control: "you have no policy" and "your record does not support
  // this yet" are different problems with different next steps.
  const blocked = !armed
    ? "accept a work policy first — anton will not start work off a policy that admits everything"
    : earned.eligible
      ? undefined
      : lockedPickerReason(earned);
  // What the pass will ACTUALLY do, not what is stored. A floored `apply` shown as selected would
  // promise unattended starts this project is not getting — the setting is still on the row below,
  // said in words, because it is the thing the operator has to be able to account for.
  const floored = stored === "apply" && blocked !== undefined;
  // Derived from the server's answer, with the pending choice laid over it — not a copy of `stored`
  // seeded once. Accepting a policy in the panel above re-renders this one with a different
  // structural floor, and a mirrored state would keep showing the level from before that.
  const [chosen, setChosen] = useState<PickerAutonomy>();
  const level = chosen ?? (floored ? "shadow" : (stored ?? (armed ? "shadow" : "propose")));
  const [saving, setSaving] = useState(false);

  async function choose(next: PickerAutonomy) {
    setChosen(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pickerAutonomy: next }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      toast.success(`Picker set to ${next}`);
      router.refresh();
    } catch (err) {
      // Back to what the server says: a control left showing a level the PATCH did not store would
      // be the one lie this panel cannot tell.
      setChosen(undefined);
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex max-w-2xl flex-col gap-3.5">
      <SectionHeading
        title="Picker autonomy"
        hint="how far anton may go with the plan it decides"
      />

      <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
        {PICKER_AUTONOMY_LEVELS.map((each) => (
          <div key={each} className="flex items-baseline gap-2.5">
            <span className="w-14 shrink-0 font-mono text-[10.5px] text-primary">{each}</span>
            <span className="text-[11px] text-subtle">{PICKER_LEVEL_HINT[each]}</span>
          </div>
        ))}
        {/* Said at the top and not only in the locked control: a founder who finds `apply` on offer
            nowhere has to know it is a rule, what it is counted over, and that it keeps counting. */}
        <span className="text-[11px] text-subtle">
          <span className="font-mono text-primary">apply</span> has to be EARNED. It unlocks once
          your own releases and vetoes on anton&apos;s picks support it — a plan that ranks a target
          says anton could start it, never that starting it was right. The count rolls over your most
          recent answers, so a record that stops supporting{" "}
          <span className="font-mono">apply</span> returns the picker to{" "}
          <span className="font-mono">shadow</span> on its own.
        </span>
      </div>

      <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12.5px] font-medium">This project&apos;s record</span>
            {earned.eligible ? (
              // Said out loud on the way UP too: the counts are what an operator is arming ON, and a
              // bar that only ever speaks when it refuses gives them no way to know it was consulted.
              <span className="text-[11px] text-subtle">
                {earned.accepted}/{earned.settled} released — clears the bar
              </span>
            ) : (
              <span className="text-[11px] text-risk-med">
                apply locked · {lockedPickerReason(earned)}
              </span>
            )}
            {/* The structural floor is stated separately from the record, and never instead of it:
                an unarmed project still has a record, and hiding its counts behind "accept a policy
                first" would leave the operator unable to see the second gate coming. */}
            {!armed && (
              <span className="text-[11px] text-risk-med">
                apply also needs a work policy — anton will not start work off one that admits
                everything.
              </span>
            )}
            {floored && (
              // The demotion, said where the setting is. An operator who chose `apply` and is
              // getting `shadow` must not have to read the pass's logs to find that out.
              <span className="text-[11px] text-risk-med">
                You chose <span className="font-mono">apply</span>; anton is running this picker at{" "}
                <span className="font-mono">shadow</span> until the record supports it. Nothing was
                un-chosen — it takes effect on its own once the counts clear the bar.
              </span>
            )}
          </div>
          <span className="ml-auto shrink-0">
            <fieldset
              className="flex gap-0.5 rounded-[9px] border border-border bg-background/40 p-0.5"
              disabled={saving}
            >
              <legend className="sr-only">Picker autonomy</legend>
              {PICKER_AUTONOMY_LEVELS.map((each) => {
                // Only `apply` is ever taken off the table. `shadow` is how the record becomes
                // readable in the first place and starts nothing, so gating it would lock the door
                // and pocket the key.
                const unavailable = each === "apply" ? blocked : undefined;
                return (
                  <label
                    key={each}
                    title={unavailable ?? PICKER_LEVEL_HINT[each]}
                    className={cn("block", unavailable ? "cursor-not-allowed" : "cursor-pointer")}
                  >
                    <input
                      type="radio"
                      name="picker-autonomy"
                      className="peer sr-only"
                      value={each}
                      checked={level === each}
                      disabled={Boolean(unavailable)}
                      onChange={() => choose(each)}
                      aria-label={`picker · ${each}`}
                    />
                    <span className="block rounded-[7px] px-2 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors peer-checked:bg-primary/15 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50 peer-disabled:text-subtle peer-disabled:opacity-50">
                      {each}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </span>
        </div>

        <span className="text-[11px] text-subtle">
          Every unattended start is recorded in the decision log on this project&apos;s Health page,
          beside the picks you vetoed.
        </span>
      </div>
    </section>
  );
}
