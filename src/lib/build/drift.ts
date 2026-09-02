/**
 * The server-side face of build drift (anton-pzfb): the running process records what it booted from,
 * and every operator-facing surface asks this module whether that still matches the code on disk.
 *
 * The comparison itself lives in `identity.mjs` — pure Node, because `bin/anton.mjs` (`anton doctor`)
 * runs before any build and must reach the same verdict the UI does. This file adds only the two
 * things a TypeScript caller needs: how THIS install resolves its paths, and the discriminated types
 * the UI narrows on.
 *
 * Paths follow anton.db exactly (`ANTON_DB`, else the cwd the server runs from), so a bundle install
 * — whose writable state lives outside the replaceable runtime dir — records beside the database
 * `anton setup` created rather than inside a directory the next update deletes.
 */
import { join } from "node:path";

import {
  buildDrift,
  buildRecordPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  readBuildIdentity,
  readBuildRecord,
  writeBuildRecord,
} from "./identity.mjs";

export type BuildDriftState = "outdated" | "modified" | "unstamped";

export interface BuildIdentity {
  /** The bundle's RELEASE_VERSION, else the checkout's package.json version. */
  version: string | null;
  /** The commit the checkout held; null for an installed bundle (a tarball carries no git). */
  revision: string | null;
}

export interface BuildDrift {
  state: BuildDriftState;
  /** What the running process booted from; null when it recorded nothing ("unstamped"). */
  running: BuildIdentity | null;
  /** What is on disk now — the build a restart would adopt. */
  onDisk: BuildIdentity;
  /** Unix ms the running process booted, when it recorded one. */
  bootedAt: number | null;
}

/** This install's anton.db path — resolved exactly as `getDb` resolves it, so the record lands beside it. */
function dbPath(): string {
  return process.env.ANTON_DB ?? join(process.cwd(), "anton.db");
}

/**
 * What THIS process booted from, held in memory as the backstop for a record anton could not write.
 * Null in anything that never booted a server — a unit test, a script — which is what keeps those
 * silent: no boot identity and no record on disk means there is no running server to call stale.
 */
let bootedFrom: BuildIdentity | null = null;

/**
 * Record what this process is running. Called once from the instrumentation hook, BEFORE the runner
 * starts: a UI-only server (`ANTON_RUNNER=off`) is just as capable of being stale, and a record
 * written only on the runner path would leave that one silently unstamped.
 *
 * The file is what makes the verdict readable from OUTSIDE the process (`anton doctor` is a separate,
 * short-lived one); the in-memory copy is what keeps it readable inside when the file write fails.
 */
export function recordServerBuild(): void {
  bootedFrom = readBuildIdentity(process.cwd()) as BuildIdentity;
  writeBuildRecord(buildRecordPath(dbPath()), bootedFrom);
}

/**
 * The drift verdict for the process serving this install, or null when it matches the code on disk.
 *
 * The record on disk is the primary read even in-process: Next.js bundles the instrumentation hook
 * separately from the request graph, so the module instance that stamped `bootedFrom` at boot is not
 * necessarily this one, and the file is the one thing both can see. `bootedFrom` answers only the
 * case the file cannot — a state dir anton could not write to.
 *
 * Silent when neither exists. In-process that means nothing here ever booted a server (a test, a
 * script), and inventing an "unstamped" verdict there would put a false warning on the health page
 * of every install. Saying so about a server that IS running but left no record is `anton doctor`'s
 * job — it has the pidfile to prove one is up.
 */
export function serverBuildDrift(): BuildDrift | null {
  const recordPath = buildRecordPath(dbPath());
  if (!readBuildRecord(recordPath) && bootedFrom) {
    const verdict = compareBuild(bootedFrom, readBuildIdentity(process.cwd()));
    return verdict.state === "current" ? null : ({ ...verdict, bootedAt: null } as BuildDrift);
  }
  return buildDrift({ appRoot: process.cwd(), recordPath }) as BuildDrift | null;
}

export { describeBuildDrift, describeBuildIdentity };
