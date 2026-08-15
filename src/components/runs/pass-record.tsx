import Link from "next/link";

import type {
  PassRecord,
  PassRecordGroup,
  PassRecordSummary,
} from "@/lib/gardener/record";
import { isCleanPass, passRecordCounts, passRecordGroup } from "@/lib/gardener/record";
import { cn } from "@/lib/utils";

/**
 * What a gardener or product-master pass did with the proposals it filed (anton-hzce).
 *
 * An applied proposal closes the moment it is filed, so it is never a card anybody browses past: the
 * only place a founder can see an unattended write BEFORE finding a bead already moved is here. Two
 * shapes, and each answers a different question at a different glance — the chips on the collapsed
 * row answer "did anything move", the panel under it answers "what, and why not the rest".
 *
 * Read-only and derived: every value comes from the session log the pass wrote, and the proposal id
 * is a link, so the evidence is one click from the record.
 */

/**
 * Group order, worst-consequence first — an unattended WRITE is what a reader came for.
 *
 * A failed APPLY and a failed SHADOW are separate rows on purpose: only the first attempted a board
 * write, so a shadow that could not be evaluated must never be described as one that may have been
 * rolled back (see `passRecordGroup`). An apply whose OUTCOME never reached the log is a third row
 * for the same reason — "nothing landed" is the one thing nobody can say about it.
 */
const GROUPS: {
  key: PassRecordGroup;
  label: string;
  text: string;
  chip: string;
  blurb: string;
}[] = [
  {
    key: "applied",
    label: "applied",
    text: "text-stage-done",
    chip: "border-stage-done/30 bg-stage-done/10 text-stage-done",
    blurb: "written to the board unattended, under this project's proposal autonomy",
  },
  {
    key: "unrecorded",
    label: "outcome not recorded",
    text: "text-risk-high",
    chip: "border-risk-high/30 bg-risk-high/10 text-risk-high",
    blurb: "the write was attempted and its result never reached the log — check the subject itself",
  },
  {
    key: "refused",
    label: "refused",
    text: "text-risk-med",
    chip: "border-risk-med/30 bg-risk-med/10 text-risk-med",
    blurb: "the board declined the move — the ask is still open, with the reason on it",
  },
  {
    key: "apply-failed",
    label: "could not apply",
    text: "text-risk-high",
    chip: "border-risk-high/30 bg-risk-high/10 text-risk-high",
    blurb: "anton failed to decide or the write was rolled back — nothing landed",
  },
  {
    key: "shadow-failed",
    label: "could not shadow",
    text: "text-risk-med",
    chip: "border-risk-med/30 bg-risk-med/10 text-risk-med",
    blurb: "anton could not work out what it would do — no write was attempted",
  },
  {
    key: "shadowed",
    label: "shadowed",
    text: "text-muted-foreground",
    chip: "border-border bg-card text-muted-foreground",
    blurb: "recorded only — nothing was written",
  },
];

/**
 * Counts for the collapsed row. Silent on a clean pass: a chip reading "0 applied" on every nightly
 * patrol is noise the eye learns to skip, which is exactly the habit this record cannot afford.
 */
export function PassRecordChips({ summary }: { summary: PassRecordSummary }) {
  if (isCleanPass(summary)) return null;
  const counts = passRecordCounts(summary);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {GROUPS.filter((group) => counts[group.key] > 0).map((group) => (
        <span
          key={group.key}
          className={cn("rounded-full border px-1.5 py-0.5 font-mono text-[10px]", group.chip)}
        >
          {counts[group.key]} {group.label}
        </span>
      ))}
      {summary.notes.length > 0 && summary.records.length === 0 && (
        <span className="rounded-full border border-risk-med/30 bg-risk-med/10 px-1.5 py-0.5 font-mono text-[10px] text-risk-med">
          {summary.notes.length} note{summary.notes.length === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

/** The pass's whole record, grouped by outcome, under the expanded job row. */
export function PassRecordPanel({
  summary,
  slug,
}: {
  summary: PassRecordSummary;
  slug: string;
}) {
  const counts = passRecordCounts(summary);
  const groups = GROUPS.filter((group) => counts[group.key] > 0);

  return (
    <section className="flex flex-col gap-2" aria-label="Proposals">
      <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">
        Proposals
      </span>

      {isCleanPass(summary) ? (
        // A result, not an empty state: this pass ran and wrote nothing, which is what a project
        // that has armed nothing looks like every night. Saying so beats a blank panel that reads
        // as output the page failed to load.
        <p className="text-[11px] text-muted-foreground">
          Clean pass — nothing applied, shadowed or refused.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className={cn("font-mono text-[11px]", group.text)}>
                  {counts[group.key]} {group.label}
                </span>
                <span className="text-[10.5px] text-subtle">{group.blurb}</span>
              </div>
              <ul className="flex flex-col gap-1">
                {summary.records
                  .filter((record) => passRecordGroup(record) === group.key)
                  .map((record, i) => (
                    <PassRecordEntry
                      key={`${record.proposal}-${record.mode}-${i}`}
                      record={record}
                      slug={slug}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {summary.notes.length > 0 && (
        // The write cap holding proposals back, or a board that would not read. Never folded into
        // the counts: an operator who armed a kind and finds three beads moved has to be able to
        // tell "that was all of it" from "we stopped at three".
        <ul className="flex flex-col gap-1">
          {summary.notes.map((note, i) => (
            <li key={i} className="text-[11px] text-risk-med">
              {note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One proposal: the whole ask on one line, and the pass's own words for what happened to it. */
function PassRecordEntry({ record, slug }: { record: PassRecord; slug: string }) {
  return (
    <li className="flex flex-col gap-0.5 border-l border-border pl-2.5">
      <span className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-[11px]">
        <Link
          href={`/projects/${slug}/epics/${record.proposal}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {record.proposal}
        </Link>
        <span className="text-subtle">{record.kind}</span>
        <span className="text-muted-foreground">
          {record.verb} {record.subjects.join(", ")}
          {record.target ? ` → ${record.target}` : ""}
        </span>
      </span>
      {/* planApply's own words, never a paraphrase: "the board moved under it" and "the evidence
          went stale" are different problems with the same shape, and only the reason tells them
          apart. */}
      <span className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-mono text-[10px] text-subtle">{record.verdict}</span>{" "}
        {record.detail}
      </span>
    </li>
  );
}
