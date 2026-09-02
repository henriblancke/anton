/**
 * Which processes of this install are RUNNING (anton-pzfb) — the half of build drift that no record
 * can answer.
 *
 * A build record proves what ONE process booted from and says nothing about a second, older one, so
 * every surface reporting on "the anton server" has to look beside the records too: the upgrade this
 * whole check exists for leaves a pre-stamp server up — running the nightly jobs from code that
 * shipped days ago — while the operator, having pulled, starts a current one on the next free port.
 * Gated on the records alone that process is invisible.
 *
 * It lives here rather than in the CLI because `anton doctor` and the Health page must not answer
 * differently about the same machine (PR #217 review): doctor found the unstamped neighbour and the
 * page, reading records only, called the install clean. Both now stand on this module.
 *
 * Pure Node, no dependencies — `bin/anton.mjs` runs it before any build exists, and the server
 * imports it from a request path.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

import { processStartedAt, sameDirectory } from "./identity.mjs";

/**
 * Every TCP socket LISTENING on this machine, as `{ pid, port }` — `[]` when nothing is, null when
 * this machine cannot say. A socket anton can see but cannot attribute carries a null `pid`: that
 * is "found, owned by someone else", not "not listening".
 *
 * Enumerated whole rather than one port at a time (PR #217): the server anton most needs to find
 * is the one nothing recorded, and nothing on disk names the port it took — Next moves to the next
 * free port when 3000 is held, which is exactly how a stale server and a current one end up running
 * side by side.
 *
 * Each platform is answered by something it always has, because anton installs no enumerator and
 * declares none as a prereq: Linux reads procfs directly (most distros ship no lsof, and one that
 * is merely absent would answer "nothing is listening" on every such box), macOS — which has no
 * procfs — uses the lsof in its base system.
 */
function listeningEndpoints() {
  return osPlatform() === "linux" ? procfsListeningEndpoints() : lsofListeningEndpoints();
}

/** `/proc/net/tcp` connection state for LISTEN. */
const TCP_LISTEN = "0A";

/**
 * listeningEndpoints via procfs: the LISTEN sockets in /proc/net/tcp{,6}, resolved to their owning
 * pids through /proc/<pid>/fd. `procRoot` is injectable so the parse is testable.
 */
export function procfsListeningEndpoints(procRoot = "/proc") {
  const ports = new Map(); // socket inode -> the port it listens on
  let tables = 0;
  for (const table of ["net/tcp", "net/tcp6"]) {
    let text;
    try {
      text = readFileSync(join(procRoot, table), "utf8");
    } catch {
      continue;
    }
    tables++;
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== TCP_LISTEN) continue;
      const port = parseInt(f[1].slice(f[1].lastIndexOf(":") + 1), 16);
      if (Number.isInteger(port) && port > 0) ports.set(f[9], port);
    }
  }
  if (!tables) return null; // no procfs (a container without it) — no evidence, not "nothing".
  if (!ports.size) return [];
  const owners = socketOwners(new Set(ports.keys()), procRoot);
  return [...ports].map(([inode, port]) => ({ pid: owners.get(inode) ?? null, port }));
}

/** Which pid holds each of `inodes` as an open socket. Processes anton can't read are skipped. */
function socketOwners(inodes, procRoot) {
  const targets = new Map([...inodes].map((inode) => [`socket:[${inode}]`, inode]));
  const owners = new Map();
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return owners;
  }
  for (const entry of entries) {
    const pid = parseInt(entry, 10);
    if (!Number.isInteger(pid) || String(pid) !== entry) continue;
    let fds;
    try {
      fds = readdirSync(join(procRoot, entry, "fd"));
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      let link;
      try {
        link = readlinkSync(join(procRoot, entry, "fd", fd));
      } catch {
        continue;
      }
      // Every match is kept, not just the first: one server holds a socket per address family and
      // may hold several ports, and stopping at one would leave the rest unattributed.
      const inode = targets.get(link);
      if (inode !== undefined) owners.set(inode, pid);
    }
  }
  return owners;
}

/**
 * listeningEndpoints via lsof. Its exit status separates the two answers that must not be confused —
 * 1 with no output is "nothing is listening", while a missing binary or an error is "no evidence".
 */
function lsofListeningEndpoints() {
  const r = spawnSync("lsof", ["-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-Fpn"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.error) return null;
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0) return out ? null : [];
  return lsofRows(out).flatMap(({ pid, name }) => {
    // `*:3000`, `127.0.0.1:3000`, `[::1]:3000` — the port is what follows the last colon.
    const port = parseInt(name.slice(name.lastIndexOf(":") + 1), 10);
    return Number.isInteger(port) && port > 0 ? [{ pid, port }] : [];
  });
}

/**
 * `lsof -Fpn` output as `{ pid, name }` rows: a `p<pid>` line opens a process set, and every `n`
 * line under it names a file of that process.
 */
function lsofRows(out) {
  const rows = [];
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      rows.push({ pid, name: line.slice(1) });
    }
  }
  return rows;
}

/**
 * Each pid's working directory as `Map<pid, path>` — absent for one anton cannot read.
 *
 * Read in one pass because the caller asks about every listener on the machine at once and the
 * fallback is a spawn: `lsof -p 1,2,3` costs what `lsof -p 1` does, while one spawn per listener
 * would put dozens of them on the caller's path.
 */
function processCwds(pids) {
  const found = new Map();
  const missing = [];
  for (const pid of pids) {
    try {
      found.set(pid, realpathSync(`/proc/${pid}/cwd`)); // Linux publishes it; macOS has no /proc.
    } catch {
      missing.push(pid);
    }
  }
  if (!missing.length) return found;
  const r = spawnSync("lsof", ["-a", "-w", "-p", missing.join(","), "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.error || r.status !== 0) return found;
  for (const { pid, name } of lsofRows((r.stdout ?? "").trim())) found.set(pid, name);
  return found;
}

/**
 * The servers listening from THIS checkout: `{ pid, port }` per socket, `[]` when none can be shown
 * to be.
 *
 * The port is shared by every anton on the box, so a response alone attributes a neighbouring
 * install's server to this one — a bundle, or a second worktree, serving anton's page would be
 * reported as this checkout's, with restart instructions for the wrong install. `dev` and `start`
 * both spawn the server with `cwd: APP_ROOT` (`runLocal`), so the listener's working directory is
 * the install-specific evidence that closes it.
 *
 * Evidence anton cannot gather is not evidence against: a machine that can enumerate nothing yields
 * no servers and claims nothing — the same trade the pidfile scoping makes, since a liveness claim
 * about the wrong install is worse than a missing one.
 *
 * @param {string|null} appRoot
 * @returns {{pid: number, port: number}[]}
 */
export function checkoutServers(appRoot) {
  const endpoints = (listeningEndpoints() ?? []).filter(({ pid }) => pid !== null);
  if (!endpoints.length) return [];
  const cwds = processCwds([...new Set(endpoints.map(({ pid }) => pid))]);
  return endpoints.filter(({ pid }) => {
    const cwd = cwds.get(pid);
    return !!cwd && sameDirectory(cwd, appRoot);
  });
}

/**
 * Is anton's own page answering on `port`? The other half of naming a server, beside where it runs
 * from: the title is what tells anton's page from any other dev server holding a port.
 *
 * @param {number} port
 */
export async function answersAsAnton(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return /<title>[^<]*anton/i.test(await r.text());
  } catch {
    return false;
  }
}

/**
 * The servers of THIS install that no live build record accounts for — the unstamped ones.
 *
 * `pid`, `servers` and `answering` are the evidence seams: every caller passes its own install's
 * mode and pidfile reader, and the tests pass fixtures. A caller that names no `pid` reader gets no
 * pidfile evidence rather than a default one — the file is the daemon's, and guessing whose it is
 * is the mistake the paragraph below exists to prevent.
 *
 * A record proves what ONE process is running and says nothing about a second, older one, so the
 * search runs BESIDE the records rather than behind them (PR #217). The case that needs it is the
 * upgrade this whole check exists for: a pre-stamp server still up while the operator, having
 * pulled, starts a current one — Next takes the next free port when 3000 is held — and the old
 * process goes on running the nightly jobs from code that shipped days ago. Gated on "some record
 * is live", that process is invisible; here it is one more line. Only the pids the records already
 * speak for are dropped.
 *
 * Each mode reads only its OWN evidence, because both signals are shared across installs and
 * crossing them names the wrong process. The pidfile lives under the global state dir and is
 * written by exactly one thing — the bundle's daemonized `anton start` — so a source checkout that
 * consulted it would report the installed bundle's daemon as its own unstamped server and hand the
 * operator source-mode restart instructions for a process `anton stop` owns. A bundle reading the
 * listeners is the mirror image: its own daemon is already the pidfile's answer, and anything else
 * holding a port is someone else's server.
 *
 * The pidfile is evidence only for the process that wrote it, which is why `livePid` proves the
 * pid's birth stamp before answering: a crashed daemon's leftover pid, reused by the OS, would
 * otherwise be reported here as an unstamped anton and send the operator to `anton stop` a stranger.
 *
 * The cost is bundle `--foreground`, which writes no pidfile: an unstamped one reads as stopped.
 * A liveness claim about the wrong install is worse than a missing one — restarting the wrong
 * server kills a run and leaves the stale one up.
 *
 * The probes run TOGETHER because they are independent, and the case this whole check exists for is
 * exactly the one with several listeners up (PR #217 review): probed in turn, each unanswered port
 * spends its full timeout before the next begins, and the health page — a cache miss away from the
 * operator — waits the sum of them. In parallel it waits the longest single probe however many
 * ports are held.
 *
 * @param {{
 *   isBundle?: boolean,
 *   appRoot?: string|null,
 *   livePids?: Set<number>,
 *   pid?: () => number|null,
 *   servers?: (appRoot: string|null) => {pid: number, port: number}[],
 *   answering?: (port: number) => Promise<boolean>,
 * }} [options]
 * @returns {Promise<number[]>}
 */
export async function unstampedServers({
  isBundle = false,
  appRoot = null,
  livePids = new Set(),
  pid = () => null,
  servers = checkoutServers,
  answering = answersAsAnton,
} = {}) {
  if (isBundle) {
    const daemon = pid();
    return daemon && !livePids.has(daemon) ? [daemon] : [];
  }
  const candidates = servers(appRoot).filter(({ pid: listener }) => !livePids.has(listener));
  const answers = await Promise.all(candidates.map(({ port }) => answering(port)));
  const found = [];
  // One process can hold several ports, so a pid is reported once — by whichever of its ports answers.
  candidates.forEach(({ pid: listener }, i) => {
    if (answers[i] && !found.includes(listener)) found.push(listener);
  });
  return found;
}

/**
 * Where the bundle's daemon publishes its pid. Under the state dir rather than the runtime dir, for
 * the reason anton.db is: `anton update` replaces the runtime wholesale.
 *
 * The default is spelled once, here, because two surfaces resolve it — the CLI, which stops and
 * starts that daemon, and the server, which asks the same file who else of this install is up.
 */
export function antonPidFile(stateDir = process.env.ANTON_STATE_DIR ?? join(homedir(), ".local", "state", "anton")) {
  return join(stateDir, "anton.pid");
}

/**
 * The pid a pidfile names WHILE that process is still the one it recorded — null otherwise, and
 * null for a file that is missing or says nothing.
 *
 * Alive means the recorded process, not the recorded NUMBER: a daemon that crashed without clearing
 * its pidfile leaves a pid the OS reuses, and signal 0 alone then reports an unrelated process as
 * anton's server (PR #217). Doctor would name it an unstamped anton and send the operator to
 * `anton stop`, which signals a stranger. So the birth stamp on line two has to match too.
 *
 * A pidfile carrying no stamp — one written by an older anton, or on a machine that cannot read a
 * birth time — still answers on the pid alone: an absence is not evidence, and that is exactly the
 * check this always was.
 *
 * Read-only, so a request path can ask: clearing a file this rejects is the CLI's call, not a
 * reader's (see `runningPid` in bin/anton.mjs).
 *
 * @param {string} pidFile
 * @returns {number|null}
 */
export function livePid(pidFile) {
  let pid, startedAt;
  try {
    [pid, startedAt] = readFileSync(pidFile, "utf8").split("\n", 2);
    pid = parseInt(String(pid).trim(), 10);
    startedAt = (startedAt ?? "").trim();
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check
  } catch {
    return null;
  }
  if (!startedAt) return pid;
  const now = processStartedAt(pid);
  return now === null || now === startedAt ? pid : null;
}
