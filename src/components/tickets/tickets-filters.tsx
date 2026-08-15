"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";

import type { TicketFilters, TicketRow } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FilterSelect, type FilterSelectOption } from "@/components/ui/filter-select";
import {
  TICKET_FILTER_FIELDS,
  filtersFromSearchParams,
  hasActiveFilters,
  ticketsQueryString,
  uniqueEpicOptions,
  uniqueFieldOptions,
  type EpicOption,
  type TicketFilterField,
} from "@/components/tickets/tickets-utils";

function optionsForField(
  field: TicketFilterField,
  tickets: TicketRow[],
  epicOptions: EpicOption[],
): FilterSelectOption[] {
  if (field.options) return field.options;
  const key = field.key;
  if (key === "epic") {
    return epicOptions.map((epic) => ({ value: epic.id, label: epic.title }));
  }
  if (key === "agent" || key === "risk" || key === "size" || key === "domain" || key === "status" || key === "type") {
    return uniqueFieldOptions(tickets, key).map((value) => ({ value, label: value }));
  }
  return [];
}

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
      className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-5 py-3 sm:px-6"
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
          idPrefix="ticket-filter"
          field={field.key}
          label={field.label}
          emptyLabel={field.label}
          wrapperClassName="flex flex-col gap-1"
          value={filters[field.key] ?? ""}
          options={optionsForField(field, tickets, epicOptions)}
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
