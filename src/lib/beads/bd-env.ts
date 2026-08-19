/**
 * The environment ONE bd subprocess is spawned with (anton-ffmw.1).
 *
 * anton is one process driving many projects' boards. bd's config precedence is
 * `env > .beads/metadata.json > .beads/config.yaml`, so anything `BEADS_DOLT_*` in anton's own
 * environment — inherited from whatever directory anton was launched in — outranks the *target*
 * project's metadata.json and points that bd at the wrong database. In the field a launch directory
 * whose `.envrc` exported `BEADS_DOLT_SERVER_DATABASE=anton` made every bd call for every other
 * project dial anton's database; only bd's project-identity guard caught it:
 *
 *   PROJECT IDENTITY MISMATCH — refusing to connect
 *
 * Without that guard the other project's writes would have landed in anton's database silently.
 *
 * The fix has two halves, and both live here so "which env does a bd spawn for THIS project get"
 * has exactly one answer:
 *
 *   1. **Identity is stripped** ({@link PROJECT_SCOPED_BD_ENV}) so the target's own metadata.json —
 *      per-directory, and therefore unable to leak — decides which database is opened.
 *   2. **Credentials are resolved per project** ({@link scopedPasswordVar}) so a per-project
 *      database user can authenticate. Stripping the user without this would only move the failure:
 *      every project would resolve its own user from metadata.json and then present the one ambient
 *      password, which is why the shared `beads` account existed at all.
 */
import { readBoardMode } from "./board-mode";

/**
 * Env vars that name WHICH project/database bd talks to. Never inherited by a bd spawned against a
 * different project — an inherited value silently overrides that project's own metadata.json.
 *
 * Credentials and transport (`BEADS_DOLT_PASSWORD`, `BEADS_DOLT_SERVER_TLS`) are deliberately
 * absent: they answer "may I connect", not "connect to what", and a blanket strip would leave every
 * spawn unable to authenticate. The password is scoped by {@link resolvePassword} instead, which
 * narrows it per project without removing the shared-account fallback.
 */
export const PROJECT_SCOPED_BD_ENV = [
  // Whether to reach for a server at all, and which one.
  "BEADS_DOLT_SERVER_MODE",
  "BEADS_DOLT_SHARED_SERVER",
  "BEADS_DOLT_PROXIED_SERVER",
  "BEADS_DOLT_SERVER_HOST",
  "BEADS_DOLT_SERVER_PORT",
  "BEADS_DOLT_SERVER_USER",
  "BEADS_DOLT_SERVER_DATABASE",
  "BEADS_DOLT_SERVER_SOCKET",
  // Embedded-mode routing: the data directory, and the ports of the per-project server bd starts
  // over it. An inherited port dials another project's server exactly as a host/database would.
  "BEADS_DOLT_DATA_DIR",
  "BEADS_DOLT_PORT",
  "BEADS_DOLT_REMOTESAPI_PORT",
] as const;

/** The one credential var bd reads. Scoped per project rather than stripped — see the module note. */
const PASSWORD_VAR = "BEADS_DOLT_PASSWORD";

/**
 * The env var holding `user`'s password: `BEADS_DOLT_PASSWORD_<USER>`, uppercased with every
 * non-alphanumeric run folded to `_` so a user like `anton-bot` maps to a legal var name.
 *
 * Keyed by USER, not by database or project: the password belongs to the account, so two projects
 * that legitimately share one account need one var, not two copies that can drift apart.
 */
export function scopedPasswordVar(user: string): string {
  return `${PASSWORD_VAR}_${user.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The password for `repoPath`'s configured database user, or `undefined` to leave whatever the
 * parent holds.
 *
 * Falls back to the ambient `BEADS_DOLT_PASSWORD` deliberately: a single shared account is still a
 * valid deployment, and only an operator who has actually created per-project users should see
 * their behaviour change. Embedded boards report no user, so they never reach the lookup — their
 * environment is untouched.
 */
function resolvePassword(repoPath: string, parentEnv: NodeJS.ProcessEnv): string | undefined {
  const user = readBoardMode(repoPath).user;
  return user ? parentEnv[scopedPasswordVar(user)] : undefined;
}

/**
 * Which env var an operator must set to give `repoPath`'s bd a password — the per-user form when
 * metadata.json names a user, the shared one otherwise. Used by the server preflight's failure
 * message: naming the wrong variable is the difference between a one-line fix and an hour lost.
 */
export function passwordVarHint(repoPath: string): string {
  const user = readBoardMode(repoPath).user;
  return user ? `${scopedPasswordVar(user)} (or ${PASSWORD_VAR})` : PASSWORD_VAR;
}

/**
 * The environment for a bd invocation against `repoPath`: the parent's, with `overrides` applied,
 * project identity stripped, and the password narrowed to the target project's database user.
 *
 * `overrides` wins outright in both directions. An explicit value survives the strip (a caller that
 * deliberately sets a connection var means it), and an explicit `undefined` REMOVES the variable
 * rather than leaving whatever anton was launched with — which is what keeps a gate call that
 * cannot derive a repo slug from inheriting an ambient `GH_REPO` and answering this project's gates
 * with another repository's CI verdict.
 */
export function buildBdEnv(
  repoPath: string,
  overrides: Record<string, string | undefined>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  for (const key of PROJECT_SCOPED_BD_ENV) if (!(key in overrides)) delete env[key];

  if (!(PASSWORD_VAR in overrides)) {
    const password = resolvePassword(repoPath, parentEnv);
    if (password !== undefined) env[PASSWORD_VAR] = password;
  }
  return env;
}
