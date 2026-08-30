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
  /**
   * Run one hand cadence edit with the offer's lifecycle around it: it supersedes a pending offer
   * for that same row, and `write` answers whether it LANDED — an edit that did not is rolled back
   * to the cadence the question was about, which puts that question back in play.
   */
  aroundSetCron: (id: string, write: () => Promise<boolean>) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
}

/**
 * Offer to raise product-master from weekly to daily while — and only while — the board-picker is
 * armed and the operator has not answered (anton-3xa9).
 *
 * The arm opens the question, but leaving the page does not answer it: the offer is seeded on mount
 * from the same premise, so a reload does not lose a question the operator never resolved. Only an
 * answer ends it — accept moves the cadence off weekly, decline records the standing opt-out — and
 * both are read back here, so a restored offer cannot become a nag.
 *
 * Every decision here is taken against the LIVE rows rather than a render's snapshot, because the
 * decisions happen after an await: the operator can disarm the picker, disable product-master,
 * retime it, or answer the question while a PATCH is still open.
 */
export function useCadenceOffer({
  rows,
  initialRows,
  keepWeekly: declined,
  patchSettings,
  setCron,
}: {
  /** The live automation rows — the source of truth a decision taken after an await reads. */
  rows: RefObject<Record<string, AutomationScheduleState>>;
  /**
   * The same rows as a plain value, for the two decisions taken at MOUNT — what the picker was
   * already set to, and whether a question is standing. Read from the value rather than the ref
   * because a render may not read a ref, and at mount the two say the same thing anyway.
   */
  initialRows: Record<string, AutomationScheduleState>;
  /** The operator's standing answer from a previous session; absent = never asked. */
  keepWeekly: boolean;
  /** A settings PATCH, queued behind the form's own writes. */
  patchSettings: (body: Record<string, unknown>) => Promise<Response>;
  /** Write one row's cadence, answering whether it landed. */
  setCron: (id: string, cron: string) => Promise<boolean>;
}): CadenceOfferControl {
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
  const armingIntent = useRef(initialRows[AUTOPILOT_ARMING_AUTOMATION]?.enabled === true);
  // Seeded rather than opened by an effect: the premise is entirely in the rows this render was
  // given, so a question left unanswered is on screen in the first paint — no flash of a panel that
  // then grows a row, and the same markup on the server and the client.
  const [offer, setOffer] = useState<CadenceOffer | null>(() =>
    offerFor(initialRows, declined, initialRows[AUTOPILOT_ARMING_AUTOMATION]?.enabled === true),
  );

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
   * Open the offer against the live premise, if there is anything to offer. A premise that no longer
   * holds leaves the screen as it is rather than clearing it — every caller asks to ADD a question,
   * and taking one away is {@link withdraw}'s job, which moves the generation with it.
   */
  function ask() {
    const next = offerFor(rows.current, keepWeekly.current, armingIntent.current);
    if (next) setOffer(next);
  }

  async function aroundToggle(id: string, next: boolean, write: () => Promise<boolean>) {
    // Either half of the coupling: the arm makes product-master's staleness cost something, and
    // enabling product-master gives an already-armed picker priorities to rank off. Both halves
    // decide the premise, so both have to reconsider the question when their write resolves.
    const couples = id === AUTOPILOT_ARMING_AUTOMATION || id === CADENCE_COUPLED_AUTOMATION;
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
      // Read off the row this failure just rolled back, never off the intent this click replaced:
      // that prior intent can be an optimistic value from an earlier click that failed as well —
      // an enable then a disable, queued together and both rejected, would restore `armed` on the
      // strength of an arm that never happened and offer a daily cadence under a picker that is
      // still off. The reverted row is what the server confirmed.
      if (restored) {
        armingIntent.current = rows.current[AUTOPILOT_ARMING_AUTOMATION]?.enabled === true;
      }
      // A rollback can also leave a question standing that the live rows no longer support: the
      // OTHER half of the coupling writes a different row, so it can land and ask inside this
      // write's window, and the offer was never on screen for this click to withdraw. Left there it
      // would retime a job the server says is off, or run it daily under a picker that is off — so
      // it is withdrawn, not merely re-asked, because {@link ask} deliberately leaves an existing
      // offer alone when the premise is false. The generation bump stops an answer still in flight
      // from putting it back (see {@link restorable}, which reads the coupled row alone and can see
      // neither the picker nor a standing opt-out).
      if (couples && !offerFor(rows.current, keepWeekly.current, armingIntent.current)) withdraw();
      if (withdrawn && restorable(withdrawn, at)) setOffer(withdrawn);
      // Nothing to put back, but the toggle can still have SUPPRESSED a question that was therefore
      // never asked at all: a disarm that raced an arm, or a product-master disable clicked while an
      // accept or decline was in flight — the offer was already off screen, so that click withdrew
      // nothing, and the answer's own failure read the optimistic disabled row and declined to
      // restore. Re-open from the live rows; `ask()` stays silent unless the premise still holds.
      else if ((restored && armingIntent.current) || id === CADENCE_COUPLED_AUTOMATION) ask();
    }
    // Whichever half lands second asks — otherwise the question waits for a reload, which is no
    // answer to a premise that is true right now.
    //
    // Only ever an offer, and only once the enable LANDED: the premise is that the picker is now
    // ranking off product-master's priorities, so a failed PATCH must not leave a question standing
    // on a condition that never happened. Turning either one OFF deliberately does nothing to the
    // cadence: an operator who accepted daily keeps daily until they say otherwise, and a schedule
    // that silently sprang back would make this table untrustworthy about the only thing it exists
    // to report.
    if (stored && next && couples) ask();
  }

  /**
   * A cadence chosen by hand in the row's own editor supersedes a pending offer for that same row:
   * the offer's cron was derived from the cadence being replaced, so accepting it afterwards would
   * overwrite the time the operator just picked with one computed from a row that is gone.
   *
   * An edit that did NOT land puts the coupled row back on the cadence the question is asked about,
   * so the question applies again — and it may never have been asked at all: an arm landing while
   * the edit was open decides `ask()` against the optimistic cron and stays silent, which without
   * this would leave the picker armed and product-master weekly with nothing on screen until the
   * picker is cycled. Re-opened from the live rows, so it stays silent unless the premise holds.
   */
  async function aroundSetCron(id: string, write: () => Promise<boolean>) {
    // Keyed on the row the offer is ever ABOUT, not on a question being on screen: an accept or
    // decline already in flight left the screen empty, and the restore it may still perform reads
    // the generation to know its premise died (see {@link restorable}). Without the bump, an edit
    // back to the cadence the offer was derived from reads as restorable, so a failed answer would
    // resurrect a question the operator has since answered by hand — and this edit landing would
    // not take it away, because it withdrew nothing.
    if (id === CADENCE_COUPLED_AUTOMATION) withdraw();
    const stored = await write();
    if (!stored && id === CADENCE_COUPLED_AUTOMATION) ask();
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

  return { offer, aroundToggle, aroundSetCron, accept, decline };
}

/**
 * The question this premise justifies, or `null` when there is none to ask.
 *
 * Silent in four cases, each of which would make the offer a lie or a nag: the operator already
 * answered `keep weekly`; the picker is (or has just been asked to be) off, so nothing consumes what
 * product-master judges; product-master is off, so its output feeds nothing and its cadence is moot;
 * or its cadence is not weekly — already daily-or-faster, or hand-written, and neither is ours to
 * rewrite (see {@link dailyEquivalentOf}).
 *
 * Pure, because it answers the same question at two moments that share no state: the mount that
 * restores an unanswered offer, and every later {@link useCadenceOffer.ask} against the live rows.
 */
function offerFor(
  rows: Record<string, AutomationScheduleState>,
  keepWeekly: boolean,
  armed: boolean,
): CadenceOffer | null {
  if (keepWeekly || !armed) return null;
  const coupled = rows[CADENCE_COUPLED_AUTOMATION];
  if (coupled?.enabled !== true) return null;
  const daily = dailyEquivalentOf(coupled.cron);
  if (!daily) return null;
  return {
    automationId: CADENCE_COUPLED_AUTOMATION,
    cron: daily,
    reason: CADENCE_OFFER_REASON,
    acceptLabel: "Raise to daily",
    declineLabel: "Keep weekly",
  };
}
