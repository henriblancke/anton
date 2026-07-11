"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
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

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, setTheme } = useTheme();
  const mounted = useHasMounted();

  if (!mounted) {
    return (
      <div
        className={cn(
          "h-7 animate-pulse rounded-lg bg-muted",
          collapsed ? "w-7" : "w-full",
        )}
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5",
        collapsed ? "flex-col" : "flex-row",
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active && "bg-background text-foreground shadow-xs",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
