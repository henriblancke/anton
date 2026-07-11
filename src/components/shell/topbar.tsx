import Link from "next/link";
import { ChevronRightIcon, MenuIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function Topbar({
  projectName,
  projectSlug,
  onOpenMobile,
}: {
  projectName?: string;
  projectSlug?: string;
  onOpenMobile: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur-sm sm:px-4">
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onOpenMobile}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
      >
        <MenuIcon className="size-4" aria-hidden="true" />
      </button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <Link
          href="/"
          className="shrink-0 rounded-md px-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Projects
        </Link>
        {projectSlug && (
          <>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
            <span className="truncate font-medium text-foreground" title={projectName ?? projectSlug}>
              {projectName ?? projectSlug}
            </span>
          </>
        )}
      </nav>

      <div className="ml-auto">
        <Button size="sm" variant="ghost" disabled title="Coming soon">
          <PlusIcon aria-hidden="true" />
          Add work
        </Button>
      </div>
    </header>
  );
}
