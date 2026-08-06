"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage, killShapeSession, startShapeSession } from "./shape-api";

export interface ShapeSession {
  /** The pre-session composer's text — the seed both the pty and the draft start from. */
  description: string;
  setDescription: (value: string) => void;
  /** Non-null once the pty is live; the left pane swaps composer for terminal on it. */
  sessionId: string | null;
  starting: boolean;
  start: () => void;
}

/**
 * The live `claude` pty half of the Add-work surface. It owns the session and nothing else — the
 * draft composed beside it lives in `useShapeDraft` — with `onStarted` as the single seam between
 * them: the seed the founder typed is handed to the draft the moment shaping begins.
 */
export function useShapeSession(slug: string, onStarted: (seed: string) => void): ShapeSession {
  const [description, setDescription] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    const seed = description.trim();
    setStarting(true);
    try {
      const id = await startShapeSession(slug, seed);
      // Navigating away mid-start would otherwise orphan the pty: the POST has already landed and
      // the `claude` process is live, but nothing left on the page ever learns its id to kill it.
      // Aborting the fetch wouldn't help — it loses the id without stopping the process.
      if (!mounted.current) {
        killShapeSession(slug, id);
        return;
      }
      onStarted(seed);
      setSessionId(id);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't start the shaping session."));
    } finally {
      setStarting(false);
    }
  }, [description, onStarted, slug]);

  return { description, setDescription, sessionId, starting, start };
}
