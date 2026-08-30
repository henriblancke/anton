"use client";

import { useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { dailyEquivalentOf } from "@/lib/jobs/cadence";
import type {
  AutomationScheduleState,
  CadenceOffer,
} from "@/components/settings/automation-table";

/**
 * The cadence coupling arming the picker creates (anton-3xa9, design R7.1).
 *
 * The board-picker is the only automation that CONSUMES product-master's output: with it off, a
 * stale priority is a stale opinion someone reads whenever; with it on, it is the input to a
 * ranking recomputed every few minutes. That is the only reason the offer exists — and the only
 * automation it is offered for, because no other pair of schedules has that relationship.
 *
 * The offer states the picker's effect TODAY — it records a plan, it starts nothing (see
 * `src/lib/jobs/board-picker.ts`). Overstating that would buy a daily claude session on a promise
 * the build does not keep; when the arming feature lands and the plan is executed, the reason gets
 * stronger, not different.
 */
const AUTOPILOT_ARMING_AUTOMATION = "board-picker";
const CADENCE_COUPLED_AUTOMATION = "product-master";
const CADENCE_OFFER_REASON =
  "board-picker now ranks what could run next off these priorities and records that plan — it " +
  "starts nothing yet. A week-old priority makes a week-old ranking. Run it daily?";

/** The offer as the automation panel drives it: the pending question, and every way it is answered. */
export interface CadenceOfferControl {
  /** The pending question, rendered under the row it would change. `null` = nothing to ask. */
  offer: CadenceOffer | null;
  /**
   * Run one automation toggle with the offer's lifecycle around it: `write` performs the PATCH and
   * answers whether it LANDED, which is what decides whether a question is opened or put back.
   */
  aroundToggle: (id: string, next: boolean, write: () => Promise<boolean>) => Promise<void>;
  /** A cadence set by hand supersedes a pending offer for that same row. */
  supersede: (id: string) => void;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
}

/**
 * Offer to raise product-master from weekly to daily when — and only when — the operator arms the
 * board-picker (anton-3xa9).
 *
 * Every decision here is taken against the LIVE rows rather than a render's snapshot, because the
 * decisions happen after an await: the operator can disarm the picker, disable product-master,
 * retime it, or answer the question while a PATCH is still open.
 */
export function useCadenceOffer({
  rows,
  keepWeekly: declined,
  patchSettings,
  setCron,
}: {
  /** The live automation rows — the source of truth a decision taken after an await reads. */
  rows: RefObject<Record<string, AutomationScheduleState>>;
  /** The operator's standing answer from a previous session; absent = never asked. */
  keepWeekly: boolean;
  /** A settings PATCH, queued behind the form's own writes. */
  patchSettings: (body: Record<string, unknown>) => Promise<Response>;
  /** Write one row's cadence, answering whether it landed. */
  setCron: (id: string, cron: string) => Promise<boolean>;
}): CadenceOfferControl {
  const [offer, setOffer] = useState<CadenceOffer | null>(null);
  // The standing answer is persisted the moment it is given — this panel saves immediately, and an
  // opt-out that waited for the Save button would be re-asked on the next arm by anyone who
  // navigated away. A ref rather than state because nothing renders it and the reads that matter
  // happen after an await: a decline landing while an arm's PATCH is open must not be re-asked by
  // the offer that arm opens.
  const keepWeekly = useRef(declined);
  // Counts the withdrawals — offers killed by a change rather than by an answer. An accept restores
  // its offer on a failed write, and only this tells that restore apart from one that would put back
  // a question the operator already invalidated while the PATCH was open.
  const generation = useRef(0);
  // The picker state the operator last ASKED for, recorded before its PATCH goes out. The rows alone
  // cannot answer that after an await: a disable clicked while the arm is still open withdraws an
  // offer that does not exist yet, and the arm's response — which reports the row as armed — can
  // still land first. Only the last click says whether an offer's premise is still standing.
  const armingIntent = useRef(rows.current[AUTOPILOT_ARMING_AUTOMATION]?.enabled === true);

  /**
   * Withdraw the pending question because something invalidated it, rather than because it was
   * answered. Every such path goes through here so the generation moves with it — that is what lets
   * an answer still in flight tell a failed write from a question that stopped applying underneath
   * it (see {@link restorable}).
   */
  function withdraw() {
    generation.current += 1;
    setOffer(null);
  }

  /**
   * Whether an offer taken off screen may be put back on it: nothing withdrew it while the write was
   * open, and its premise still reads the same off the live rows — the job still enabled, still on
   * the cadence the offered cron was derived from.
   *
   * The generation catches what this panel withdrew; the row check catches what it did not, because
   * a withdrawal cannot fire for an offer that is already off screen while an answer is in flight.
   */
  function restorable(pending: CadenceOffer, at: number): boolean {
    if (generation.current !== at) return false;
    const coupled = rows.current[pending.automationId];
    return coupled?.enabled === true && dailyEquivalentOf(coupled.cron) === pending.cron;
  }

  /**
   * Open the offer, if there is anything to offer.
   *
   * Silent in four cases, each of which would make it a lie or a nag: the operator already answered
   * `keep weekly`; they have since asked for the picker to be off, so nothing consumes what
   * product-master judges; product-master is off, so its output feeds nothing and its cadence is
   * moot; or its cadence is not weekly — already daily-or-faster, or hand-written, and neither is
   * ours to rewrite (see {@link dailyEquivalentOf}).
   */
  function ask() {
    if (keepWeekly.current) return;
    if (!armingIntent.current) return;
    const coupled = rows.current[CADENCE_COUPLED_AUTOMATION];
    if (coupled?.enabled !== true) return;
    const daily = dailyEquivalentOf(coupled.cron);
    if (!daily) return;
    setOffer({
      automationId: CADENCE_COUPLED_AUTOMATION,
      cron: daily,
      reason: CADENCE_OFFER_REASON,
      acceptLabel: "Raise to daily",
      declineLabel: "Keep weekly",
    });
  }

  async function aroundToggle(id: string, next: boolean, write: () => Promise<boolean>) {
    // Disarming withdraws the QUESTION, never the answer: with the picker off, nothing executes what
    // product-master judges, so an unanswered offer has lost its reason to be on screen. Toggling the
    // offered automation itself withdraws it too — a cadence offer for a job the operator just turned
    // off is asking about a schedule that no longer fires. Done ahead of the write because it takes
    // something OFF screen — nothing can be accepted in the meantime.
    const invalidates = (id === AUTOPILOT_ARMING_AUTOMATION && !next) || id === offer?.automationId;
    // The withdrawal fires on the invalidating CLICK, never on there being a question on screen: an
    // answer already in flight reads the generation to know its premise died (see {@link restorable}),
    // so skipping the bump for an empty screen would let a failed accept put back an offer this
    // toggle just killed.
    const withdrawn = invalidates ? offer : null;
    if (invalidates) withdraw();
    // Captured AFTER our own withdrawal moved it, so restorability below asks only whether something
    // ELSE withdrew the question while this write was open.
    const at = generation.current;
    // Recorded with the withdrawal, not after the write: a disable can only take the arm's offer off
    // screen if it is on record before that arm's response gets to open one.
    const priorIntent = armingIntent.current;
    if (id === AUTOPILOT_ARMING_AUTOMATION) armingIntent.current = next;

    const stored = await write();

    // A toggle that did not land invalidated nothing. The row went back, so the premise the
    // withdrawal was taken on — picker armed, product-master running weekly — is the live one again,
    // and an operator left with the question gone could only get it back by cycling the toggle until
    // a write succeeds. The intent goes back with it, or a later arm refuses to re-ask on the
    // strength of a disarm that never happened. Both are skipped when a later toggle has since asked
    // for something else: that click is the current premise, not this failure.
    if (!stored) {
      const restored = id === AUTOPILOT_ARMING_AUTOMATION && armingIntent.current === next;
      if (restored) armingIntent.current = priorIntent;
      if (withdrawn && restorable(withdrawn, at)) setOffer(withdrawn);
      // A disarm that never landed leaves the picker armed with nothing to put back — and if it
      // raced an arm, it also suppressed that arm's own question, which was therefore never asked
      // at all. Re-open it from the live rows; `ask()` stays silent unless the premise still holds.
      else if (restored && armingIntent.current) ask();
    }
    // Arming the picker is the one toggle that changes what ANOTHER automation's staleness costs, so
    // it is the one toggle that opens an offer — and only an offer. Asked only once the arm LANDED:
    // the offer's entire premise is that the picker is now ranking off product-master's priorities,
    // so a failed PATCH must not leave a question standing on a condition that never happened.
    // Disarming deliberately does nothing to the cadence: an operator who accepted daily keeps daily
    // until they say otherwise, and a schedule that silently sprang back would make this table
    // untrustworthy about the only thing it exists to report.
    if (stored && id === AUTOPILOT_ARMING_AUTOMATION && next) ask();
  }

  /**
   * A cadence chosen by hand in the row's own editor supersedes a pending offer for that same row:
   * the offer's cron was derived from the cadence being replaced, so accepting it afterwards would
   * overwrite the time the operator just picked with one computed from a row that is gone.
   */
  function supersede(id: string) {
    if (id === offer?.automationId) withdraw();
  }

  /**
   * Accept — the ONLY path that changes the cadence, through the same PATCH as a hand edit.
   *
   * The question comes back if the write does not land: the cadence rolls back to weekly, so an offer
   * that stayed dismissed would leave an operator who chose daily sitting on weekly with nothing left
   * to retry. It stays gone if the question stopped applying while the PATCH was open — the picker
   * disarmed, the row edited by hand, product-master switched off — because that question is dead on
   * its own terms and a failed write is no reason to resurrect it (see {@link restorable}).
   */
  async function accept() {
    const pending = offer;
    if (!pending) return;
    const at = generation.current;
    setOffer(null);
    const stored = await setCron(pending.automationId, pending.cron);
    if (!stored && restorable(pending, at)) setOffer(pending);
  }

  /**
   * Decline, permanently. Persisted immediately and optimistically: a failed write is reverted so the
   * offer returns rather than being silently swallowed — an opt-out this panel only thinks it stored
   * is how an operator gets asked the same question forever.
   *
   * The revert puts the QUESTION back too, not just the standing answer. An operator who declined,
   * got an error toast, and then watched the question vanish anyway has been told the write failed
   * and shown the outcome of it succeeding; the offer has to be back where they can answer it again.
   * Only while it is still a live question, though — the picker can be disarmed and product-master
   * disabled or retimed while this write is open, and none of those leave anything to re-ask (see
   * {@link restorable}).
   */
  async function decline() {
    const pending = offer;
    const at = generation.current;
    setOffer(null);
    keepWeekly.current = true;
    try {
      const res = await patchSettings({ keepProductMasterWeekly: true });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(error ?? "Update failed");
      }
      toast.success(`${CADENCE_COUPLED_AUTOMATION} stays weekly`);
    } catch (err) {
      keepWeekly.current = false;
      if (pending && restorable(pending, at)) setOffer(pending);
      toast.error(err instanceof Error ? err.message : "Failed to save your answer");
    }
  }

  return { offer, aroundToggle, supersede, accept, decline };
}
