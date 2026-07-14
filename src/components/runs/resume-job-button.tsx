"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Resume control for a parked/failed job (anton-ner.4). POSTs to the resume route, which un-parks
 * the job back to `queued`; the runner re-leases it next tick and resumes idempotently. Refreshes
 * the server component so the row's status reflects queued → running.
 */
export function ResumeJobButton({ slug, jobId }: { slug: string; jobId: string }) {
  const router = useRouter();
  const [resuming, setResuming] = useState(false);

  async function handleResume() {
    setResuming(true);
    try {
      const res = await fetch(`/api/projects/${slug}/jobs/${jobId}/resume`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Resume failed (${res.status})`);
      }
      toast.success("Job resumed — the runner will pick it up shortly");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resume job");
    } finally {
      setResuming(false);
    }
  }

  return (
    <Button size="xs" variant="outline" onClick={handleResume} disabled={resuming}>
      <RotateCcwIcon aria-hidden="true" />
      {resuming ? "Resuming…" : "Resume"}
    </Button>
  );
}
