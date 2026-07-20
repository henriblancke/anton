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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Slugify a folder name into a bd-safe ticket-ID prefix (lowercase, alnum, dash-separated). */
function toPrefix(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

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
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  // The folder the editable fields were last seeded from — re-seed when the browsed folder changes.
  const [seededPath, setSeededPath] = useState<string | null>(null);

  // Prefill name + prefix from the selected folder, but keep them user-editable. Adjusting state
  // during render (React's recommended reset-on-change pattern) converges: once seededPath matches
  // the browsed path, the branch stops firing.
  if (dir && dir.path !== seededPath) {
    const base = baseName(dir.path);
    setSeededPath(dir.path);
    setName(base);
    setPrefix(toPrefix(base));
  }

  const needsInit = Boolean(dir) && !dir?.hasBeads;
  const canAdd = Boolean(dir) && !submitting && (!needsInit || prefix.trim().length > 0);

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
    if (!dir || !canAdd) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoPath: dir.path,
          name: name.trim() || undefined,
          // Only a fresh repo needs a prefix; an existing board ignores it server-side.
          prefix: needsInit ? prefix.trim() || undefined : undefined,
        }),
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
          setSeededPath(null);
          setName("");
          setPrefix("");
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
            Browse to a local repo. A folder with a{" "}
            <span className="font-mono text-muted-foreground">.beads/</span> board is added as-is;
            one without gets a fresh board initialized under the prefix you choose.
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
        ) : dir ? (
          <p className="text-xs text-subtle">
            No <span className="font-mono text-muted-foreground">.beads/</span> board here yet — anton
            will initialize one with <span className="font-mono">bd init</span>.
          </p>
        ) : (
          <p className="text-xs text-subtle">Open a folder to add it.</p>
        )}

        {/* project name + (fresh-repo only) board prefix */}
        {dir && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="add-project-name">Name</Label>
              <Input
                id="add-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={baseName(dir.path)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {needsInit && (
              <div className="grid gap-1.5">
                <Label htmlFor="add-project-prefix">Board prefix</Label>
                <Input
                  id="add-project-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(toPrefix(e.target.value))}
                  placeholder="e.g. anton"
                  aria-invalid={prefix.trim().length === 0}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" onClick={handleAdd} disabled={!canAdd}>
            {submitting ? "Adding…" : needsInit ? "Initialize & add" : "Add this project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
