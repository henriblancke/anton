/**
 * Pure helpers for the tickets page: URL <-> filter serialization and option lists derived
 * from the current result set. Kept dependency-free so they're trivially testable (see
 * tickets-utils.test.ts) and reusable from both the filters toolbar and the tickets view.
 */
import type { TicketFilters, TicketRow } from "@/lib/types";

export const TICKET_FILTER_KEYS: (keyof TicketFilters)[] = [
  "agent",
  "risk",
  "size",
  "domain",
  "status",
  "type",
  "epic",
  "q",
];

export interface TicketFilterField {
  key: keyof TicketFilters;
  label: string;
}

/** Select-driven filter fields, in display order. `q` (free text) is handled separately. */
export const TICKET_FILTER_FIELDS: TicketFilterField[] = [
  { key: "agent", label: "Agent" },
  { key: "risk", label: "Risk" },
  { key: "size", label: "Size" },
  { key: "domain", label: "Domain" },
  { key: "status", label: "Status" },
  { key: "type", label: "Type" },
  { key: "epic", label: "Epic" },
];

/** Reads ticket filters out of a URLSearchParams instance (e.g. from useSearchParams). */
export function filtersFromSearchParams(searchParams: URLSearchParams): TicketFilters {
  const filters: TicketFilters = {};
  for (const key of TICKET_FILTER_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

/** Serializes ticket filters into a URLSearchParams instance, dropping empty values. */
export function searchParamsFromFilters(filters: TicketFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of TICKET_FILTER_KEYS) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  return params;
}

/** `?agent=x&risk=y` (or `""` when there are no active filters), for URLs and fetch calls. */
export function ticketsQueryString(filters: TicketFilters): string {
  const query = searchParamsFromFilters(filters).toString();
  return query ? `?${query}` : "";
}

/** Whether any filter (including free text) is currently active. */
export function hasActiveFilters(filters: TicketFilters): boolean {
  return TICKET_FILTER_KEYS.some((key) => Boolean(filters[key]?.trim()));
}

/** How many filters are currently active (for the "N filters" footer count). */
export function countActiveFilters(filters: TicketFilters): number {
  return TICKET_FILTER_KEYS.filter((key) => Boolean(filters[key]?.trim())).length;
}

export interface EpicOption {
  id: string;
  title: string;
}

/** Unique, sorted values for a select-driven filter field, derived from the current rows. */
export function uniqueFieldOptions(
  tickets: TicketRow[],
  field: "agent" | "risk" | "size" | "domain" | "status" | "type",
): string[] {
  const values = new Set<string>();
  for (const ticket of tickets) {
    const value = ticket[field];
    if (value) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Unique epics referenced by the current rows, sorted by title. */
export function uniqueEpicOptions(tickets: TicketRow[]): EpicOption[] {
  const byId = new Map<string, string>();
  for (const ticket of tickets) {
    if (ticket.epicId) byId.set(ticket.epicId, ticket.epicTitle ?? ticket.epicId);
  }
  return [...byId.entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
