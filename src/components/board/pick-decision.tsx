"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * One answer per pick (PR #212 review).
 *
 * A ranked card carries both ways to respond — `[Release]` inside the card and the two vetoes above
 * it — and they are the SAME decision seen from two sides. Each control tracking only its own
 * pending flag lets the operator click both while one request is out: a release can start work the
 * veto just deferred, or a veto can record a decline against a plan the release already accepted,
 * leaving two contradictory verdicts on one pick.
 *
 * So the decision, not the button, holds the state. `claim` is synchronous and ref-backed — two
 * clicks in one tick cannot both take it, which no `disabled` prop can promise — and it is the whole
 * gate: a control that fails to claim does nothing at all.
 *
 * `settle` is TERMINAL: an answer that landed is the card's answer, and the other control stays shut
 * until the surface re-reads. `abandon` is for a write that did not land (or one whose own copy asks
 * the operator to try again), which must leave the pick open to answer.
 *
 * Outside a provider the lock is a no-op — a Backlog card renders exactly one of these controls, so
 * there is nothing to serialize.
 */
export type PickDecision = {
  /** `open` — answerable. `deciding` — a write is out. `settled` — this pick has its answer. */
  state: "open" | "deciding" | "settled";
  /** Take the pick synchronously; `false` means another control already holds or settled it. */
  claim: () => boolean;
  /** The write landed — the pick is answered. */
  settle: () => void;
  /** The write did not land — hand the pick back. */
  abandon: () => void;
};

const OPEN: PickDecision = {
  state: "open",
  claim: () => true,
  settle: () => {},
  abandon: () => {},
};

const PickDecisionContext = createContext<PickDecision>(OPEN);

export function PickDecisionProvider({ children }: { children: React.ReactNode }) {
  const held = useRef<PickDecision["state"]>("open");
  const [state, setState] = useState<PickDecision["state"]>("open");

  const claim = useCallback(() => {
    if (held.current !== "open") return false;
    held.current = "deciding";
    setState("deciding");
    return true;
  }, []);
  const move = useCallback((next: PickDecision["state"]) => {
    held.current = next;
    setState(next);
  }, []);
  const settle = useCallback(() => move("settled"), [move]);
  const abandon = useCallback(() => move("open"), [move]);

  const value = useMemo<PickDecision>(
    () => ({ state, claim, settle, abandon }),
    [state, claim, settle, abandon],
  );
  return <PickDecisionContext.Provider value={value}>{children}</PickDecisionContext.Provider>;
}

export function usePickDecision(): PickDecision {
  return useContext(PickDecisionContext);
}
