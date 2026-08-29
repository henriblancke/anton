import { TriangleAlertIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * The app's single failed-load affordance (anton-iquy) — every view that can fail a fetch renders
 * this, so wording, icon, retry and a11y change in one place instead of five.
 *
 * `page` fills the view it replaces; `dialog` sits inside an already-padded dialog body, so it
 * neither claims page padding nor flexes to fill a column it does not own.
 */
const errorStateVariants = cva(
  "flex flex-col items-center justify-center gap-3 text-center",
  {
    variants: {
      layout: {
        page: "flex-1 p-8",
        dialog: "py-10",
      },
    },
    defaultVariants: {
      layout: "page",
    },
  },
);

export function ErrorState({
  message,
  onRetry,
  layout,
  className,
}: {
  /** What failed, in the view's own words (usually the caught error's message). */
  message: string;
  /** Re-runs the failed fetch — typically bumping the effect's `attempt` counter. */
  onRetry: () => void;
  className?: string;
} & VariantProps<typeof errorStateVariants>) {
  return (
    <div className={cn(errorStateVariants({ layout }), className)}>
      <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
        <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
      </span>
      <p className="text-sm text-risk-high">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
