"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;

function noopSubscribe() {
  return () => {};
}

/** True only after client hydration. Avoids rendering the theme-dependent state on the
 * server, where the resolved theme isn't known yet — without a setState-in-effect footgun. */
function useHasMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHasMounted();

  if (!mounted) {
    return <div className="h-8 w-full animate-pulse rounded-[10px] bg-muted" aria-hidden="true" />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-[10px] border border-border bg-card p-0.5"
    >
      {OPTIONS.map(({ value, label }) => {
        const active = resolvedTheme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            onClick={() => setTheme(value)}
            className={cn(
              "flex-1 rounded-md px-2 py-1.5 text-center text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-subtle hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
