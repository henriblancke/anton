"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Type-to-confirm delete for a project. Destroys anton's state only (registration, settings,
 * runs, worktrees) via DELETE /api/projects/[slug]; the repo and its beads are never touched.
 */
export function DeleteProjectDialog({ project }: { project: Project }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const nameMatches = confirmation === project.name;

  async function handleDelete() {
    if (!nameMatches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to delete project (${res.status})`);
      }
      toast.success(`Deleted "${project.name}"`);
      // Stay in the pending state until the redirect lands — re-enabling here would flash an
      // actionable delete button for a project that no longer exists.
      router.push("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete project";
      setError(message);
      toast.error(message);
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return;
        setOpen(next);
        if (!next) {
          setConfirmation("");
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        <Trash2Icon aria-hidden="true" />
        Delete project
      </DialogTrigger>
      <DialogContent showCloseButton={!deleting}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2Icon className="size-4" aria-hidden="true" />
            Delete {project.name}
          </DialogTitle>
          <DialogDescription>
            This permanently deletes anton&apos;s state for{" "}
            <span className="font-medium text-foreground">{project.name}</span> — its
            registration, settings, run history, and worktrees. The repository at{" "}
            <span className="font-mono text-xs">{project.repoPath}</span> and its beads are
            untouched.
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            Type <span className="font-mono font-medium text-foreground">{project.name}</span> to
            confirm
          </span>
          <Input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={project.name}
            disabled={deleting}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={deleting} />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={!nameMatches || deleting}
          >
            {deleting ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
