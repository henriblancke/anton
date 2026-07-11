"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpIcon,
  CheckIcon,
  FolderGitIcon,
  FolderIcon,
  HouseIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface DirEntry {
  name: string;
  path: string;
  hasBeads: boolean;
}
interface BrowseResult {
  path: string;
  parent: string | null;
  home: string;
  hasBeads: boolean;
  entries: DirEntry[];
}

export function AddProjectDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<BrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const browse = useCallback(async (path?: string) => {
    setBrowsing(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
      const data = (await res.json()) as BrowseResult | { error: string };
      if (!res.ok || "error" in data) {
        throw new Error("error" in data ? data.error : `Failed to browse (${res.status})`);
      }
      setDir(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse");
    } finally {
      setBrowsing(false);
    }
  }, []);

  async function handleAdd() {
    if (!dir?.hasBeads) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: dir.path }),
      });
      const data = (await res.json()) as { project: Project } | { error: string };
      if (!res.ok || !("project" in data)) {
        throw new Error("error" in data ? data.error : `Failed to add project (${res.status})`);
      }
      toast.success(`Added "${data.project.name}"`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          if (!dir) void browse();
        } else {
          setError(null);
          setDir(null);
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon />
        Add project
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGitIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Add project
          </DialogTitle>
          <DialogDescription>
            Browse to a local repo. Only folders that contain a{" "}
            <span className="font-mono text-muted-foreground">.beads/</span> directory can be added.
          </DialogDescription>
        </DialogHeader>

        {/* current path + up/home */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => dir?.parent && browse(dir.parent)}
            disabled={!dir?.parent || browsing}
            aria-label="Up one level"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <ArrowUpIcon className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => dir && browse(dir.home)}
            aria-label="Home"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <HouseIcon className="size-4" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1 truncate rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground" title={dir?.path}>
            {dir?.path ?? "…"}
          </div>
        </div>

        {/* folder list */}
        <div className="h-64 overflow-y-auto rounded-lg border border-border bg-card">
          {browsing && !dir ? (
            <div className="flex h-full items-center justify-center text-xs text-subtle">Loading…</div>
          ) : dir && dir.entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-subtle">
              No sub-folders here
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {dir?.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => browse(entry.path)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                  >
                    {entry.hasBeads ? (
                      <FolderGitIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-subtle" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                    {entry.hasBeads && (
                      <span className="shrink-0 rounded-full border border-stage-done/30 bg-stage-done/10 px-2 py-0.5 font-mono text-[10px] text-stage-done">
                        .beads
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* selection status */}
        {dir?.hasBeads ? (
          <div className="flex items-center gap-2 rounded-lg border border-stage-done/25 bg-stage-done/10 px-3 py-2.5">
            <CheckIcon className="size-4 shrink-0 text-stage-done" aria-hidden="true" />
            <span className="text-xs text-stage-done">
              <span className="font-mono">.beads/</span> found in this folder · ready to add
            </span>
          </div>
        ) : (
          <p className="text-xs text-subtle">
            Open a folder that contains a{" "}
            <span className="font-mono text-muted-foreground">.beads/</span> directory to add it.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={!dir?.hasBeads || submitting}
          >
            {submitting ? "Adding…" : "Add this project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
