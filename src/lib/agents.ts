/**
 * Known specialist agent ids anton may assign (the `agent:<id>` bead labels). Client-safe
 * constants only — shared by the settings UI (toggle list) and the settings API (allowlist
 * validation) so both work from the same source (anton-46w).
 */
export const KNOWN_AGENTS = [
  "fastapi",
  "supabase",
  "pydantic",
  "nextjs",
  "alembic",
  "terraform",
  "docker",
  "kubernetes",
] as const;

export type KnownAgent = (typeof KNOWN_AGENTS)[number];

/** Agents active when settings_json carries no `agents` allowlist. */
export const DEFAULT_ACTIVE_AGENTS: readonly KnownAgent[] = [
  "fastapi",
  "supabase",
  "pydantic",
  "nextjs",
];
