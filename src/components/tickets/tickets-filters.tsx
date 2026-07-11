"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";

import type { TicketFilters, TicketRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  TICKET_FILTER_FIELDS,
  filtersFromSearchParams,
  hasActiveFilters,
  ticketsQueryString,
  uniqueEpicOptions,
  uniqueFieldOptions,
  type EpicOption,
} from "@/components/tickets/tickets-utils";

type SelectOption = { value: string; label: string };

function optionsForField(
  key: keyof TicketFilters,
  tickets: TicketRow[],
  epicOptions: EpicOption[],
): SelectOption[] {
  if (key === "epic") {
    return epicOptions.map((epic) => ({ value: epic.id, label: epic.title }));
  }
  if (key === "agent" || key === "risk" || key === "size" || key === "domain" || key === "status" || key === "type") {
    return uniqueFieldOptions(tickets, key).map((value) => ({ value, label: value }));
  }
  return [];
}

const selectClassName = cn(
  "h-8 min-w-24 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

export function TicketsFilters({ tickets }: { tickets: TicketRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = filtersFromSearchParams(searchParams);
  const urlQ = filters.q ?? "";
  const [q, setQ] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);

  // Keep the local search box in sync when the URL changes from elsewhere (back/forward) —
  // adjusted during render, not in an effect, per React's set-state-in-effect guidance.
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    setQ(urlQ);
  }

  const applyFilters = useCallback(
    (next: TicketFilters) => {
      router.push(`${pathname}${ticketsQueryString(next)}`, { scroll: false });
    },
    [pathname, router],
  );

  function handleFieldChange(key: keyof TicketFilters, value: string) {
    applyFilters({ ...filters, [key]: value || undefined });
  }

  useEffect(() => {
    const trimmed = q.trim();
    if ((filters.q ?? "") === trimmed) return;
    const timeout = setTimeout(() => {
      applyFilters({ ...filters, q: trimmed || undefined });
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function handleReset() {
    setQ("");
    router.push(pathname, { scroll: false });
  }

  const epicOptions = uniqueEpicOptions(tickets);

  return (
    <div
      role="search"
      aria-label="Filter tickets"
      className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3 sm:px-6"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="ticket-search" className="sr-only">
          Search titles
        </Label>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle"
            aria-hidden="true"
          />
          <Input
            id="ticket-search"
            type="search"
            placeholder="Filter by title…"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className="h-8 w-52 rounded-lg pl-8 text-xs"
          />
        </div>
      </div>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      {TICKET_FILTER_FIELDS.map((field) => (
        <FilterSelect
          key={field.key}
          field={field.key}
          label={field.label}
          value={filters[field.key] ?? ""}
          options={optionsForField(field.key, tickets, epicOptions)}
          onChange={(value) => handleFieldChange(field.key, value)}
        />
      ))}

      {hasActiveFilters(filters) && (
        <Button type="button" size="sm" variant="ghost" onClick={handleReset} className="ml-auto text-subtle">
          Clear all
        </Button>
      )}
    </div>
  );
}

function FilterSelect({
  field,
  label,
  value,
  options,
  onChange,
}: {
  field: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = `ticket-filter-${field}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={selectClassName}
      >
        <option value="">{label}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
