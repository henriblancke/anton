"use client";

import { useEffect, useState } from "react";

/**
 * The current human operator identity (from /api/operator), shared across every board surface so
 * the claim controls can tell "mine" from "someone else's". Machine-scoped and effectively
 * constant per session, so it's fetched once and memoized at module scope — every hook consumer
 * reuses the same in-flight promise/result instead of refetching.
 *
 * Returns `undefined` while the identity is still resolving, then `string | null` (null = no
 * operator could be resolved). A null operator still allows Claim (the POST assigns to whoever the
 * server resolves), it just can't distinguish an existing claim as "mine".
 */
let cached: string | null | undefined; // undefined = not fetched yet
let inflight: Promise<string | null> | null = null;

function fetchOperator(): Promise<string | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/operator")
      .then((res) => (res.ok ? (res.json() as Promise<{ operator: string | null }>) : { operator: null }))
      .then((data) => {
        cached = data.operator ?? null;
        return cached;
      })
      .catch(() => {
        cached = null;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useOperator(): string | null | undefined {
  const [operator, setOperator] = useState<string | null | undefined>(cached);

  useEffect(() => {
    // fetchOperator resolves synchronously-cached values on a microtask, so setOperator runs
    // outside the effect body (and no-ops when the seeded state already matches).
    let active = true;
    void fetchOperator().then((value) => {
      if (active) setOperator(value);
    });
    return () => {
      active = false;
    };
  }, []);

  return operator;
}
