import { RelativeTime } from "@/components/atoms";

/**
 * The digest's empty-window state (anton-rokar): nothing happened and nothing needs the operator
 * since whichever instant `since` names.
 *
 * `since: null` is "has never looked" (viewer-marks.ts) — there is no prior look to name, so this
 * reads as a fresh project rather than printing a timestamp nobody set.
 */
export function DigestEmptyWindow({ since }: { since: number | null }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      <p className="text-sm font-medium text-foreground">Nothing new since you looked</p>
      <p className="text-xs text-muted-foreground">
        {since !== null ? (
          <>
            Caught up as of <RelativeTime iso={new Date(since * 1000).toISOString()} />.
          </>
        ) : (
          "Nothing has happened on this project yet."
        )}
      </p>
    </div>
  );
}
