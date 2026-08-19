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
import {
  BD_PASSWORD_VAR as PASSWORD_VAR,
  PROJECT_SCOPED_BD_ENV,
  passwordVarHint as passwordVarFor,
  scopedPasswordVar,
} from "./config.mjs";

/**
 * The identity strip and the per-user password variable both live in `config.mjs`, so the pure-node
 * CLI scopes a bd spawn exactly as the server does (`anton server-mode` verifies a project's
 * connection with the same environment anton will later run bd with). Re-exported here because this
 * module is where the rule is explained and where the app reads it from.
 */
export { PROJECT_SCOPED_BD_ENV, scopedPasswordVar };

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
  return passwordVarFor(readBoardMode(repoPath).user);
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
