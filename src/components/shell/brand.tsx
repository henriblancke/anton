import { cn } from "@/lib/utils";

/**
 * The anton mark — the anton avatar (backwards cap + glasses) in white, set on the iris-gradient
 * rounded tile of the Atelier design system. Sizes are driven by the `size` prop (tile edge in px).
 * The avatar is painted via a CSS mask over `/anton-avatar.svg` so it inherits the white fill and
 * stays crisp at any size; the same lockup is baked into `app/icon.png` / `app/apple-icon.png`.
 */
export function AntonMark({ size = 26, className }: { size?: number; className?: string }) {
  const face = Math.round(size * 0.8);
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
        className="bg-white"
        style={{
          width: face,
          height: face,
          WebkitMaskImage: "url(/anton-avatar.svg)",
          maskImage: "url(/anton-avatar.svg)",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
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
