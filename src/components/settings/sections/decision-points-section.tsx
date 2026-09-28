"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { TriangleAlertIcon } from "lucide-react";

import { DECISION_MODES, type DecisionMode } from "@/lib/decide/points";
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

/** What each mode means, in the operator's terms — decide()'s own header, restated for the row. */
const MODE_HINT: Record<DecisionMode, string> = {
  off: "never asked · every call falls back to a human",
  shadow: "computes the answer auto would have acted on and writes nothing — the record below is built here",
  assist: "surfaces its answer as a suggestion · the operator still decides",
  auto: "acts on its own answer once confidence clears the point's threshold · nobody is asked",
};

/**
 * One registered decision point, as the Settings page renders it (anton-xky9e): its question shape
 * and consequence from the registry, the mode this project runs it at, and its measured agreement
 * with the operator. Computed on the server — `listPoints()` only sees points a job step has actually
 * registered by importing it, which a client bundle never does, and the agreement figure is a fold
 * over the decisions table this module cannot reach.
 */
export interface DecisionPointRow {
  id: string;
  questionKind: "choice" | "score" | "yes-no";
  consequence: "low" | "med" | "high";
  defaultMode: DecisionMode;
  /** The resolved mode this project runs the point at — the stored override, or `defaultMode`. */
  mode: DecisionMode;
  /** Settled decisions in the agreement window, and how many the operator's own answer matched. */
  settled: number;
  agreed: number;
}

/**
 * Every decide() point this project can be asked, its mode, and its track record (anton-528bw,
 * anton-xky9e) — the operator's one lever over a layer that otherwise only ever runs in shadow.
 *
 * Self-patching, like the picker autonomy panel: choosing a mode is an act on ONE point, not a field
 * queued behind the shared Save bar. `auto` alone asks for confirmation first — every other mode
 * takes effect the moment it is chosen, because only `auto` lets anton act on its own answer
 * unattended.
 */
export function DecisionPointsSection({
  slug,
  points,
}: {
  slug: string;
  points: DecisionPointRow[];
}) {
  return (
    <section className="flex max-w-2xl flex-col gap-3.5">
      <SectionHeading
        title="Decision points"
        hint="what decide() may be asked, its mode on this project, and its measured agreement with you"
      />

      <ModeLegend />

      {points.length === 0 ? (
        <p className="rounded-[10px] border border-border bg-card px-3 py-2.5 text-[11px] text-subtle">
          No decision points are registered yet — decide()&apos;s registry ships empty until a job
          step declares one.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60 rounded-[10px] border border-border bg-card px-3 py-1">
          {points.map((point) => (
            <DecisionPointRowView key={point.id} slug={slug} point={point} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModeLegend() {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      {DECISION_MODES.map((mode) => (
        <div key={mode} className="flex items-baseline gap-2.5">
          <span className="w-14 shrink-0 font-mono text-[10.5px] text-primary">{mode}</span>
          <span className="text-[11px] text-subtle">{MODE_HINT[mode]}</span>
        </div>
      ))}
      <span className="text-[11px] text-subtle">
        <span className="font-mono text-primary">auto</span> is never reached by a setting alone —
        promoting a point to it asks you to confirm first, every time.
      </span>
      <span className="text-[11px] text-subtle">
        Every call is recorded in the decision log, whatever the mode — that record is what{" "}
        <span className="font-mono">agreed</span> below is measured over.
      </span>
    </div>
  );
}

/** How the agreement figure reads when nothing has settled yet — never a bare "0/0". */
function agreementLabel(point: DecisionPointRow): string {
  return point.settled > 0 ? `agreed ${point.agreed}/${point.settled}` : "no settled decisions yet";
}

function DecisionPointRowView({ slug, point }: { slug: string; point: DecisionPointRow }) {
  const router = useRouter();
  // The pending choice, laid OVER the server's answer and dropped the moment the server's answer
  // moves — the same reconciliation PickerAutonomySection uses, so a stale overlay never outlives a
  // `router.refresh()` that already settled the real mode.
  const [chosen, setChosen] = useState<DecisionMode>();
  const [reconciled, setReconciled] = useState(point.mode);
  if (reconciled !== point.mode) {
    setReconciled(point.mode);
    setChosen(undefined);
  }
  const mode = chosen ?? point.mode;
  const [saving, setSaving] = useState(false);
  const inFlight = useRef<DecisionMode | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function choose(next: DecisionMode) {
    if (inFlight.current === next) return;
    inFlight.current = next;
    setChosen(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${slug}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionModes: { [point.id]: next } }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      toast.success(`${point.id} set to ${next}`);
      router.refresh();
    } catch (err) {
      // Back to what the server says: a control left showing a mode the PATCH did not store would be
      // the one lie this panel cannot tell.
      setChosen(undefined);
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      inFlight.current = undefined;
      setSaving(false);
    }
  }

  function select(next: DecisionMode) {
    if (mode === next) return;
    // The one mode a click never applies directly — promoting to `auto` opens the confirm dialog
    // instead, and only its own confirm button calls `choose`.
    if (next === "auto") {
      setConfirmOpen(true);
      return;
    }
    void choose(next);
  }

  return (
    <div className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[11.5px]">{point.id}</span>
        <span className="text-[11px] text-subtle">
          {point.questionKind} · {point.consequence} consequence
        </span>
        <span className="text-[11px] text-subtle">{agreementLabel(point)}</span>
      </div>
      <span className="ml-auto shrink-0">
        <fieldset
          className="flex gap-0.5 rounded-[9px] border border-border bg-background/40 p-0.5"
          disabled={saving}
        >
          <legend className="sr-only">{point.id} mode</legend>
          {DECISION_MODES.map((level) => (
            <label key={level} title={MODE_HINT[level]} className="block cursor-pointer">
              <input
                type="radio"
                name={`decide-mode-${point.id}`}
                className="peer sr-only"
                value={level}
                checked={mode === level}
                onChange={() => select(level)}
                aria-label={`${point.id} · ${level}`}
              />
              <span className="block rounded-[7px] px-2 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors peer-checked:bg-primary/15 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50 peer-disabled:text-subtle peer-disabled:opacity-50">
                {level}
              </span>
            </label>
          ))}
        </fieldset>
      </span>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-risk-med">
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
              Promote {point.id} to auto
            </DialogTitle>
            <DialogDescription>
              anton will act on this point&apos;s own answer unattended, once confidence clears its
              threshold — nobody is asked first. Its measured record so far: {agreementLabel(point)}.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                void choose("auto");
              }}
            >
              Promote to auto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
