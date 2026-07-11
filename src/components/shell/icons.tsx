/**
 * Sidebar nav glyphs — reproduced 1:1 from the Anton Redesign design artifact (16×16 viewBox).
 * All use `currentColor` so the active (iris) / inactive (subtle) state is driven by text color.
 */

export function BoardIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="2" width="3.4" height="12" rx="1" />
      <rect x="6.3" y="2" width="3.4" height="8" rx="1" />
      <rect x="11.1" y="2" width="3.4" height="10" rx="1" />
    </svg>
  );
}

export function TicketsIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" />
      <rect x="2" y="7" width="12" height="2" rx="1" />
      <rect x="2" y="11" width="8" height="2" rx="1" />
    </svg>
  );
}

export function DependenciesIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <circle cx="3.5" cy="4" r="2" />
      <circle cx="3.5" cy="12" r="2" />
      <circle cx="12.5" cy="8" r="2" />
      <path d="M5.5 4.6c4 0.6 4 2.8 4 2.8M5.5 11.4c4-0.6 4-2.8 4-2.8" />
    </svg>
  );
}

export function ProjectsIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <rect x="2" y="4" width="8" height="7" rx="1.5" />
      <rect x="6" y="6" width="8" height="7" rx="1.5" />
    </svg>
  );
}

export function RunsIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M4.5 6.5l2 1.6-2 1.6" />
      <line x1="8" y1="10" x2="11" y2="10" />
    </svg>
  );
}

export function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <line x1="2" y1="5" x2="14" y2="5" />
      <line x1="2" y1="11" x2="14" y2="11" />
      <circle cx="10" cy="5" r="2.2" className="fill-sidebar" />
      <circle cx="5" cy="11" r="2.2" className="fill-sidebar" />
    </svg>
  );
}
