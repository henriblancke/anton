import { cn } from "@/lib/utils";

/**
 * The anton mark — an iris-gradient rounded tile with a small dark square notch, matching the
 * Atelier design system. Sizes are driven by the `size` prop (tile edge in px).
 */
export function AntonMark({ size = 26, className }: { size?: number; className?: string }) {
  const notch = Math.round(size * 0.35);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[28%] bg-[linear-gradient(150deg,#8f82ff,#6355e0)] shadow-[0_0_0_1px_color-mix(in_oklch,#8f82ff_35%,transparent),0_8px_24px_-8px_color-mix(in_oklch,#8f82ff_60%,transparent)]",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="rounded-[22%] bg-[#0b0a09]"
        style={{ width: notch, height: notch }}
      />
    </span>
  );
}

/** The full lockup: mark + `anton` wordmark set in the display face. */
export function AntonWordmark({
  size = 26,
  textClassName,
  className,
}: {
  size?: number;
  textClassName?: string;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <AntonMark size={size} />
      <span
        className={cn(
          "font-display text-[17px] font-bold tracking-[-0.02em] text-foreground",
          textClassName,
        )}
      >
        anton
      </span>
    </span>
  );
}
