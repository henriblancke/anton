"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { TriangleAlertIcon } from "lucide-react";

import { PICKER_AUTONOMY_LEVELS, type PickerAutonomy } from "@/lib/policy/types";
import { formatExactTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionHeading } from "@/components/settings/settings-fields";

/**
 * The bar the picker's record has to clear, mirrored from `EARNED_AUTONOMY_BARS` — both halves,
 * because they are different gates: `minSettled` is "have you seen enough picks to have an opinion",
 * `minAppliedPct` is "and was the opinion yes".
 */
export interface PickerBar {
  minSettled: number;
  minAppliedPct: number;
}

/** An operator's signature on a bypass of the earned floor, mirrored from `DeliberateArming`. */
export interface PickerSignature {
  by: string;
  at: string;
}

/** What allows `apply`: this project's own record, or an operator's explicit override of it. */
export type PickerArming = "earned" | "deliberate";

/**
 * What the picker's own record has earned (anton-vkp9) and what — if anything — allows `apply`
 * today, as the form receives it. Computed on the server (`gardener/autonomy.ts`
 * `pickerApplyVerdict`) off the same verdicts and the same stored signature the pass reads, because
 * this module never imports server code and the verdict is a fact about the project.
 *
 * The counts and the BAR travel WITH the verdict. A control that is merely disabled is the failure
 * this floor exists to stop repeating: an operator who finds `apply` unavailable has to be told what
 * it is locked ON and what would unlock it, in the row, at the moment they are deciding — and an
 * operator standing on a signature has to be told what they are standing in for.
 */
export interface EarnedPicker {
  /** Picks released, out of picks answered — the record, in the operator's own acts. */
  accepted: number;
  settled: number;
  /** The two thresholds the counts above are read against. */
  bar: PickerBar;
  /**
   * What allows `apply` — "earned" while the record clears the bar on its own, "deliberate" while
   * only an operator's signature does, absent when nothing does. Never "earned" because of a
   * signature: that is what keeps this surface from laundering an override into an achievement.
   */
  arming?: PickerArming;
  /** The stored signature, whenever there is one — including after the record has caught up. */
  deliberate?: PickerSignature;
  /**
   * Why the RECORD does not support `apply`, with the counts and the bar. Absent exactly when it
   * does — so it is still present, and still shown, while a deliberate arming stands in for it.
   */
  reason?: string;
}

/**
 * The picker's bar, mirrored from `EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER]` and guarded against
 * drift by this module's test. Only ever a fallback — every real render is handed the server's copy.
 */
export const PICKER_BAR: PickerBar = { minSettled: 20, minAppliedPct: 90 };

/** A project with no answered picks — what every project starts on, and what an unreadable store yields. */
export const NO_PICKER_RECORD: EarnedPicker = { accepted: 0, settled: 0, bar: PICKER_BAR };

const PICKER_LEVEL_HINT: Record<PickerAutonomy, string> = {
  propose: "ranks what could run next and records the plan · nothing is offered",
  shadow: "offers each pick in Up Next · you release it or veto it, and that is the record",
  apply: "approves, claims and starts its top pick unattended · nobody is asked",
};

/**
 * Why `apply` is locked, always sayable — the same reasoning `lockedReason` uses for a detection
 * kind: `arming` is the gate and `reason` only ever its label, so a verdict that arrives with
 * neither still reads as locked instead of silently offering the level.
 */
export function lockedPickerReason(earned: EarnedPicker): string {
  return earned.reason ?? "no record could be read for this project — apply stays locked";
}

/**
 * The released share of what was answered, or undefined when nothing has been answered at all.
 *
 * Floored on integer math, never rounded, so the number the rung PRINTS agrees with the test that
 * colours it (PR #245 review): 26/29 rounds up to 90 and would read `90%/90%` on a rung the floor
 * leaves short, sending the operator back to the raw counts to find out why it is still red.
 */
function releasedPct(earned: EarnedPicker): number | undefined {
  return earned.settled > 0 ? Math.floor((earned.accepted * 100) / earned.settled) : undefined;
}

/**
 * How far the picker may go with the plan it decides (anton-vkp9), what this project's own record
 * has earned, and — when an operator has signed for `apply` without it (anton-d1lk) — that they did.
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
    : earned.arming
      ? undefined
      : lockedPickerReason(earned);
  // What the pass will ACTUALLY do, not what is stored. A floored `apply` shown as selected would
  // promise unattended starts this project is not getting — the setting is still on the row below,
  // said in words, because it is the thing the operator has to be able to account for.
  const floored = stored === "apply" && blocked !== undefined;
  // What the server says this picker will do, once both floors are applied.
  const resolved = floored ? "shadow" : (stored ?? (armed ? "shadow" : "propose"));
  // The pending choice, laid OVER the server's answer and dropped the moment the server's answer
  // moves — `router.refresh()` keeps this component's state, so an overlay that outlived the
  // refresh would go on reporting a level the picker is no longer running at (PR #218 review).
  // Accepting or removing a policy in the panel above changes the structural floor here, and the
  // demotion it causes has to reach the control, not just the sentence beside it.
  const [chosen, setChosen] = useState<PickerAutonomy>();
  const [reconciled, setReconciled] = useState(resolved);
  if (reconciled !== resolved) {
    setReconciled(resolved);
    setChosen(undefined);
  }
  const level = chosen ?? resolved;
  const [saving, setSaving] = useState(false);
  // The save in flight, held in a ref rather than read off `saving`: the redundant-click path on the
  // radios fires in the SAME native event as the change that started the save, so the state behind
  // it has not been re-rendered yet and only a ref can tell the duplicate apart.
  const inFlight = useRef<PickerAutonomy | undefined>(undefined);

  async function choose(next: PickerAutonomy) {
    if (inFlight.current === next) return;
    inFlight.current = next;
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
      inFlight.current = undefined;
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
        {/* The bypass, named at the top too (anton-z1lp): an operator who is going to reach for it
            should meet it as a signed, revocable exception rather than discover it as a shortcut. */}
        <span className="text-[11px] text-subtle">
          You can also arm it <span className="text-risk-med">deliberately</span> — an explicit
          bypass of that bar, signed with your name, revocable at any time, and labelled as an
          override everywhere the level is shown. It is never reported as earned.
        </span>
      </div>

      <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12.5px] font-medium">This project&apos;s record</span>
            {/* The level, and WHAT is holding it up, said in the same breath (anton-z1lp). */}
            <span className="text-[11px] text-subtle">
              running at <span className="font-mono text-primary">{resolved}</span>
              {resolved === "apply" &&
                (earned.arming === "deliberate" ? (
                  <span className="text-risk-med"> · armed deliberately — not earned</span>
                ) : (
                  <span> · earned by the record below</span>
                ))}
            </span>
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
                      // Selecting the option already rendered as checked emits no change event, and
                      // a floored `apply` renders `shadow` checked while `apply` is still what is
                      // STORED — so without this the operator could never drop the pending return to
                      // apply (PR #218 review). `choose` discards the duplicate a normal selection
                      // produces.
                      onClick={() => {
                        if (stored !== each) choose(each);
                      }}
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

        <PickerLadder earned={earned} />

        <div className="flex flex-col gap-0.5">
          {earned.arming === "earned" ? (
            // Said out loud on the way UP too: the counts are what an operator is arming ON, and a
            // bar that only ever speaks when it refuses gives them no way to know it was consulted.
            <span className="text-[11px] text-subtle">
              this record clears the bar — <span className="font-mono">apply</span> is earned
            </span>
          ) : (
            <span className="text-[11px] text-risk-med">
              {earned.arming === "deliberate" ? "record does not support apply" : "apply locked"} ·{" "}
              {lockedPickerReason(earned)}
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
              un-chosen — it takes effect on its own once the counts clear the bar. Select{" "}
              <span className="font-mono">shadow</span> to drop that choice for good.
            </span>
          )}
        </div>

        <DeliberateArming slug={slug} armed={armed} earned={earned} />

        <span className="text-[11px] text-subtle">
          Every unattended start is recorded in the decision log on this project&apos;s Health page,
          beside the picks you vetoed.
        </span>
      </div>
    </section>
  );
}

/**
 * Where this project stands on the ladder — both rungs, as counts against the bar they are read
 * against (anton-z1lp).
 *
 * Two rungs rather than one number, because the bar is two gates and a project can be short of
 * either: twelve answers at 100% released has not been seen enough to have an opinion, and forty at
 * 60% has been. The meters are decorative — every number they draw is in the text beside them, so a
 * screen reader loses nothing by skipping them.
 */
function PickerLadder({ earned }: { earned: EarnedPicker }) {
  const { accepted, settled, bar } = earned;
  const pct = releasedPct(earned);
  return (
    <div className="flex flex-col gap-1">
      <dl className="flex flex-col gap-1">
        <LadderRung
          label="answered"
          value={`${settled}/${bar.minSettled}`}
          note="picks you released or refused with Never"
          filled={settled / bar.minSettled}
          cleared={settled >= bar.minSettled}
        />
        <LadderRung
          label="released"
          value={pct === undefined ? `—/${bar.minAppliedPct}%` : `${pct}%/${bar.minAppliedPct}%`}
          note={pct === undefined ? "nothing answered yet" : `${accepted} of ${settled} answered`}
          filled={(pct ?? 0) / 100}
          // Compared by cross multiplication like the floor itself, never on the rounded percentage:
          // 26/29 is 89.66% and reads as 90, and a rung that called that cleared would disagree with
          // the pass about the one thing this panel exists to explain.
          cleared={settled > 0 && accepted * 100 >= bar.minAppliedPct * settled}
        />
      </dl>
      {/* Said where the counts are read, not only in the pass that computes them (PR #245 review):
          an operator who paced through a dozen picks with `✕ not now` and sees 0 answered would
          otherwise read the ladder as having lost their clicks, rather than as never having asked
          for them. */}
      <span className="text-[11px] text-subtle">
        a <span className="font-mono">✕ not now</span> is pacing, not a verdict on the ranking — it
        is not counted either way.
      </span>
    </div>
  );
}

function LadderRung({
  label,
  value,
  note,
  filled,
  cleared,
}: {
  label: string;
  value: string;
  note: string;
  /** How far along the rung this project is, 0–1. Clamped — a record past the bar is still full. */
  filled: number;
  cleared: boolean;
}) {
  const width = `${Math.min(100, Math.max(0, Math.round(filled * 100)))}%`;
  return (
    <div className="flex items-center gap-2.5">
      <dt className="w-14 shrink-0 font-mono text-[10.5px] text-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-border"
        >
          <span
            className={cn("block h-full rounded-full", cleared ? "bg-primary" : "bg-risk-med")}
            style={{ width }}
          />
        </span>
        <span
          className={cn("shrink-0 font-mono text-[10.5px]", cleared ? "text-primary" : "text-risk-med")}
        >
          {value}
        </span>
        <span className="truncate text-[11px] text-subtle">{note}</span>
      </dd>
    </div>
  );
}

/**
 * The signed bypass of the earned floor (anton-d1lk), and the one control that creates it.
 *
 * Shown only where it can mean something. A project with no work policy cannot reach `apply` however
 * deliberately it is armed, so it is offered no button — the structural floor is stated above
 * instead. A project whose record already clears the bar is offered none either: there is nothing to
 * stand in for. What is always shown, once a signature exists, is WHO signed and WHEN — including
 * after the record catches up, because the fact that this project once ran unattended on somebody's
 * word rather than on evidence does not stop being true.
 */
function DeliberateArming({
  slug,
  armed,
  earned,
}: {
  slug: string;
  armed: boolean;
  earned: EarnedPicker;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);

  const signature = earned.deliberate;
  // Nothing signed, and nothing a signature would buy: an unarmed project cannot reach `apply` at
  // all, and an earned one is already there.
  if (!signature && (!armed || earned.arming === "earned")) return null;

  async function send(method: "POST" | "DELETE") {
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/projects/${slug}/picker/arming`, { method });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; armedBy?: string; autonomy?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      if (method === "POST") {
        toast.success("apply armed deliberately", {
          description: body?.armedBy ? `Recorded as ${body.armedBy}.` : undefined,
        });
        setOpen(false);
        setAcknowledged(false);
      } else {
        toast.success("Deliberate arming revoked", {
          description: body?.autonomy ? `Picker is running at ${body.autonomy}.` : undefined,
        });
      }
      // The level and the signature are both the server's answer — a refresh is what settles which
      // of the two floors this project now stands on.
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      // The acknowledgement was for THAT click. A retry after a refusal is a fresh decision — the
      // state it is refused over has usually moved — so it has to be signed for again.
      setAcknowledged(false);
      toast.error(message);
      // A refusal usually means the state moved under this tab (someone armed it, or the policy was
      // removed) — re-read rather than leave a control that errors on every click.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const signedAt = signature ? formatExactTime(signature.at) : null;
  return (
    <div className="flex items-center gap-3 rounded-[9px] border border-risk-med/30 bg-risk-med/5 px-2.5 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        {signature ? (
          <>
            <span className="text-[11px] text-risk-med">
              <span className="font-mono">apply</span> armed deliberately by{" "}
              <span className="font-medium">{signature.by}</span>
              {signedAt ? ` on ${signedAt}` : null}
            </span>
            <span className="text-[11px] text-subtle">
              {earned.arming === "deliberate"
                ? "It stands in for the record above. Revoking returns this picker to shadow until the record clears the bar on its own."
                : "The record above now clears the bar on its own, so apply no longer rests on this signature. Revoking changes nothing while that holds."}
            </span>
          </>
        ) : (
          <>
            <span className="text-[11px] font-medium">Arm apply deliberately</span>
            <span className="text-[11px] text-subtle">
              Sign for unattended starts before the record supports them. Your name is recorded on
              it, and you can revoke it at any time.
            </span>
          </>
        )}
        {/* The dialog reports its own refusals; repeating one behind it would say it twice. */}
        {error && !open && (
          <span role="alert" className="text-[11px] text-risk-high">
            {error}
          </span>
        )}
      </div>
      <span className="ml-auto shrink-0">
        {signature ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => void send("DELETE")}
          >
            {pending ? "Revoking…" : "Revoke arming"}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={pending}
            onClick={() => setOpen(true)}
          >
            <TriangleAlertIcon aria-hidden="true" />
            Arm deliberately
          </Button>
        )}
      </span>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) {
            setAcknowledged(false);
            setError(undefined);
          }
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-risk-med">
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
              Arm apply without the record
            </DialogTitle>
            <DialogDescription>
              anton will approve, claim and start its top pick unattended, with nobody asked first.
              Your name is recorded on that decision, and every surface that shows the level will say
              it was armed deliberately rather than earned.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">What this bypasses</span>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
              <li>
                The earned floor, and only that — the bar this project has not cleared:{" "}
                <span className="text-foreground">{lockedPickerReason(earned)}</span>.
              </li>
              <li>
                Until you revoke it, every unattended start rests on your judgement rather than on
                evidence that anton&apos;s picks were worth starting.
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">What still protects this project</span>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
              <li>
                Your <span className="text-foreground">work policy</span> — anton can only start the
                targets it admits, and it is re-checked at the moment of the start.
              </li>
              <li>
                The <span className="text-foreground">brakes</span> — a disarm, the failure and
                score-regression breakers, and your review-queue limit all still hold starts back.
              </li>
              <li>
                The <span className="text-foreground">budget</span> still caps what a day of
                unattended work spends.
              </li>
              <li>
                Every unattended start is recorded in the decision log on this project&apos;s Health
                page.
              </li>
              <li>
                It stays <span className="text-foreground">revocable</span>: revoking drops the
                picker back to <span className="font-mono">shadow</span> on the next pass unless the
                record has caught up by then.
              </li>
            </ul>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-risk-med/30 bg-risk-med/5 px-2.5 py-2 text-xs leading-snug">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              disabled={pending}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I am arming <span className="font-mono">apply</span> without the record, and it is
              recorded against my operator identity.
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!acknowledged || pending}
              onClick={() => void send("POST")}
            >
              {pending ? "Arming…" : "Arm apply deliberately"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
