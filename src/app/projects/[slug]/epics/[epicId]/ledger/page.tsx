import Link from "next/link";
import { notFound } from "next/navigation";

import { hasLedgerScope } from "@/lib/feature-scope";
import { projectFeatureLedger } from "@/lib/feature-ledger-read";
import { getProjectBySlug } from "@/lib/projects";
import { listAllBeads } from "@/lib/tickets";
import { issueTypeOf } from "@/lib/ticket-view";
import { typeWord } from "@/components/board/board-utils";
import { LedgerPanel } from "@/components/ledger/ledger-panel";

export const dynamic = "force-dynamic";

/**
 * Feature → Ledger (anton-pu91i): what one run target cost, split by phase, with its three
 * durations and its friction counts.
 *
 * A Server Component end to end, exactly as `spend/page.tsx` is and for the same reasons — the fold
 * is a local sqlite read plus a board snapshot, and nothing on the page is interactive, so there is
 * no client boundary and nothing to fetch after render.
 *
 * ## One board read, shared between the 404 and the fold
 *
 * The page has two questions for the board — "is this a feature at all" and "which beads does its
 * ledger cover" — and they are answered from ONE snapshot, handed to the read (`board`) rather than
 * re-fetched inside it. Two reads would cost a second bd spawn on every page view, and a bd write
 * landing between them would let the page 404-check one board while summing money over another.
 *
 * ## Only a run target has a ledger
 *
 * `hasLedgerScope` is the gate, not mere presence on the board: every bead resolves to SOME scope,
 * so a ticket id in the URL would otherwise render its own lone spend under a page that calls it a
 * feature's total. A container epic is refused for the opposite reason — its features each own a
 * ledger, and rolling them up here would double-count every dollar against both pages.
 */
export default async function FeatureLedgerPage({
  params,
}: {
  params: Promise<{ slug: string; epicId: string }>;
}) {
  const { slug, epicId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const board = await listAllBeads(project);
  if (!hasLedgerScope(board, epicId)) notFound();

  const ledger = await projectFeatureLedger(project.id, epicId, { board });
  // Only an unresolvable project id gets here, and `getProjectBySlug` just resolved one — so this is
  // a project deleted mid-render rather than a bad URL. Same 404 either way.
  if (!ledger) notFound();

  const { scope, totals, timing, friction } = ledger;
  const target = scope.target;
  // `issueTypeOf` rather than the raw bead field: `issue_type` is free-form on a Bead, and the
  // word map has no entry for a type the UI has no language for.
  const word = target ? typeWord(issueTypeOf(target)) : "feature";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
          <Link
            href={`/projects/${slug}`}
            className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {project.name}
          </Link>
          <span className="text-subtle">/</span>
          <Link
            href={`/projects/${slug}/epics/${epicId}`}
            className="min-w-0 truncate text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            title={target?.title ?? epicId}
          >
            {target?.title ?? epicId}
          </Link>
          <span className="text-subtle">/</span>
          <span className="shrink-0 font-medium text-foreground">Ledger</span>
        </nav>
        {/* The scope is stated in the header, not buried: every figure below is summed over these
            beads, and a reader who cannot see which ones cannot check the total against anything. */}
        <span className="ml-1 hidden font-mono text-[11px] whitespace-nowrap text-subtle sm:inline">
          {epicId} · {word}
          {scope.childIds.length > 0 && ` + ${scope.childIds.length} tickets`}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        <LedgerPanel totals={totals} timing={timing} friction={friction} />
      </div>
    </div>
  );
}
