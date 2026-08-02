/**
 * The gate seam's spawn contract (anton-uk95). Every gate call is driven through a REAL fake-`bd`
 * script (pointed at via ANTON_BD_BIN) rather than a mocked child_process, because the property
 * under test IS a process property: which directory bd is spawned in.
 *
 * `bd -C <dir>` changes only which DATABASE bd reads. The `gh` subprocess bd spawns to evaluate a
 * `gh:run` / `gh:pr` gate still resolves its repository from the PROCESS cwd — so a gate call made
 * from the wrong directory returns another repository's CI verdict. The fake bd records its own
 * `pwd`, `GH_REPO` and argv, so a wrapper that ever forgets cwd (or reaches for `-C`) reddens here.
 * The end-to-end proof that the hazard is real, in both directions, lives in
 * gate-cwd.integration.test.ts; this suite pins the seam that prevents it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  beads,
  buildGateCheckArgs,
  buildGateCreateArgs,
  buildGateDiscoverArgs,
  parseGateCheck,
} from "./bd";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

/** The origin this suite's repo points at — the slug GH_REPO must carry on every gate call. */
const SLUG = "acme/widgets";

let dir: string;
let repo: string;
let log: string;
const prevBin = process.env[BD_BIN_ENV];

/** One recorded fake-bd invocation. */
interface Call {
  cwd: string;
  ghRepo: string;
  argv: string[];
}

function recorded(): Call[] {
  let raw = "";
  try {
    raw = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [cwd, ghRepo, args] = line.split("\t");
      // The fake bd joins argv with US (\u001f) so an arg containing spaces survives the round-trip.
      return { cwd, ghRepo, argv: args.split("\u001f").filter(Boolean) };
    });
}

/** A repo whose origin isn't github.com, so the seam derives no slug. Built once, reused. */
function nonGithubRepo(): string {
  const local = join(dir, "local");
  if (!existsSync(local)) {
    execFileSync("git", ["init", "-q", "-b", "main", local], { stdio: "ignore" });
    execFileSync("git", ["-C", local, "remote", "add", "origin", join(dir, "bare.git")], {
      stdio: "ignore",
    });
  }
  return local;
}

/** The single call a case made — asserts exactly one bd spawn, which is what each wrapper owes. */
function onlyCall(): Call {
  const calls = recorded();
  expect(calls).toHaveLength(1);
  return calls[0];
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-gate-"));
  repo = join(dir, "repo");
  log = join(dir, "bd-calls.log");

  // A real git repo: the seam derives GH_REPO from `origin`, so faking that would fake the test.
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:${SLUG}.git`], {
    stdio: "ignore",
  });

  // Records pwd + GH_REPO + argv, then answers each gate subcommand with bd 1.1.2's real output
  // shape — including `gate check`'s progress lines BEFORE its --json summary, on stdout.
  const bin = join(dir, "fake-bd");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `{ printf '%s\\t%s\\t' "$(pwd)" "\${GH_REPO-}"; for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> "${log}"`,
      'case "$*" in',
      "  'gate create'*) echo '{\"id\":\"acme-g1\",\"issue_type\":\"gate\",\"status\":\"open\"}' ;;",
      "  *'gate check'*--dry-run*)",
      "    echo '✓ acme-g1: would resolve - workflow ci succeeded'",
      "    echo 'Checked 1 gates: 1 resolved, 0 escalated, 0 errors'",
      "    echo '{\"checked\":1,\"dry_run\":true,\"errors\":0,\"escalated\":0,\"resolved\":1}' ;;",
      "  'gate check'*)",
      "    echo 'Checked 2 gates: 1 resolved, 0 escalated, 1 errors'",
      "    echo '{\"checked\":2,\"dry_run\":false,\"errors\":1,\"escalated\":0,\"resolved\":1}' ;;",
      "  'gate list'*) echo '[{\"id\":\"acme-g1\",\"title\":\"Gate: gh:run 7\",\"status\":\"open\",\"issue_type\":\"gate\",\"await_type\":\"gh:run\",\"await_id\":\"7\"}]' ;;",
      "  'gate resolve'*) echo '✓ Gate resolved: acme-g1' ;;",
      "  'gate discover'*) echo \"Found 3 recent workflow run(s) on branch 'main'\" ;;",
      "  'ready --gated'*) echo '{\"count\":1,\"molecules\":[{\"molecule_id\":\"acme-mol-1\",\"molecule_title\":\"probe\"}]}' ;;",
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(bin, 0o755);
  process.env[BD_BIN_ENV] = bin;
  resetBdBinCache();
});

afterAll(() => {
  if (prevBin === undefined) delete process.env[BD_BIN_ENV];
  else process.env[BD_BIN_ENV] = prevBin;
  resetBdBinCache();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => rmSync(log, { force: true }));

/**
 * Every gate call the seam exposes, with the argv it owes bd. Kept exhaustive on purpose: the
 * coverage case below fails if a new `gate*` wrapper lands without an entry here, so no gate call
 * can be added that skips the cwd assertions.
 */
const CALLS: Array<{ name: string; run: (r: string) => Promise<unknown>; argv: string[] }> = [
  {
    name: "gateCreate",
    run: (r) => beads.gateCreate(r, { blocks: "acme-1", type: "gh:run", awaitId: "7" }),
    argv: ["gate", "create", "--blocks", "acme-1", "--type", "gh:run", "--await-id", "7", "--json"],
  },
  {
    name: "gateCheck",
    run: (r) => beads.gateCheck(r, { scope: "gh:run" }),
    argv: ["gate", "check", "--type", "gh:run", "--json"],
  },
  {
    name: "gateResolve",
    run: (r) => beads.gateResolve(r, "acme-g1", "CI is green"),
    argv: ["gate", "resolve", "acme-g1", "--reason", "CI is green"],
  },
  {
    name: "gateList",
    run: (r) => beads.gateList(r, { all: true }),
    argv: ["gate", "list", "--json", "--limit", "0", "--all"],
  },
  {
    name: "gateDiscover",
    run: (r) => beads.gateDiscover(r, { dryRun: true, branch: "main", limit: 10 }),
    argv: ["gate", "discover", "--dry-run", "--branch", "main", "--limit", "10"],
  },
  {
    name: "readyGated",
    // NOT `bd mol ready --gated`: that errors "unknown flag: --gated" on 1.1.0 and 1.1.2.
    run: (r) => beads.readyGated(r),
    argv: ["ready", "--gated", "--json", "--limit", "0"],
  },
];

describe("gate seam · spawn contract", () => {
  it.each(CALLS)("$name spawns bd with cwd = the project repo, never -C", async ({ run, argv }) => {
    await run(repo);
    const call = onlyCall();
    // realpath both sides: macOS resolves /var/folders/… to /private/var/… inside the child.
    expect(realpathSync(call.cwd)).toBe(realpathSync(repo));
    expect(call.argv).toEqual(argv);
    // -C would point bd's DATABASE at the repo while leaving `gh` resolving the caller's — the
    // exact split that fabricates a verdict from the wrong repository.
    expect(call.argv).not.toContain("-C");
    expect(call.argv).not.toContain("--directory");
  });

  it.each(CALLS)("$name sets GH_REPO alongside cwd (belt and braces)", async ({ run }) => {
    await run(repo);
    expect(onlyCall().ghRepo).toBe(SLUG);
  });

  it.each(CALLS)("$name refuses to run without a repo rather than inheriting the server's cwd", async ({ run }) => {
    await expect(run("")).rejects.toThrow(/requires the project repo as cwd/);
    expect(recorded()).toEqual([]);
  });

  it("covers every gate call the seam exposes", () => {
    const exposed = Object.keys(beads).filter((k) => k.startsWith("gate") || k === "readyGated");
    expect(exposed.sort()).toEqual(CALLS.map((c) => c.name).sort());
  });

  it("leaves GH_REPO unset when origin isn't a github.com remote — cwd still governs", async () => {
    await beads.gateList(nonGithubRepo());
    const call = onlyCall();
    expect(call.ghRepo).toBe("");
    expect(realpathSync(call.cwd)).toBe(realpathSync(nonGithubRepo()));
  });

  it("clears an inherited GH_REPO when there's no slug — never gh's verdict for another repo", async () => {
    const prev = process.env.GH_REPO;
    process.env.GH_REPO = "intruder/elsewhere";
    try {
      await beads.gateList(nonGithubRepo());
      // Inheriting here would point gh at intruder/elsewhere and close this repo's gates on its CI.
      expect(onlyCall().ghRepo).toBe("");
    } finally {
      if (prev === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prev;
    }
  });
});

describe("gate seam · results", () => {
  it("gateCreate returns the new gate's id", async () => {
    await expect(beads.gateCreate(repo, { blocks: "acme-1" })).resolves.toBe("acme-g1");
  });

  it("gateCheck reads bd's summary out of a stdout that also carries progress lines", async () => {
    // errors: 1 is the unknown state — a gate bd could not evaluate is neither resolved nor waiting.
    await expect(beads.gateCheck(repo)).resolves.toEqual({
      checked: 2,
      resolved: 1,
      escalated: 0,
      errors: 1,
      dryRun: false,
    });
  });

  it("gateList parses gates with their await fields", async () => {
    const [gate] = await beads.gateList(repo);
    expect(gate).toMatchObject({ id: "acme-g1", await_type: "gh:run", await_id: "7" });
  });

  it("readyGated unwraps the { count, molecules } envelope", async () => {
    await expect(beads.readyGated(repo)).resolves.toEqual([
      { molecule_id: "acme-mol-1", molecule_title: "probe" },
    ]);
  });
});

describe("gate argv builders", () => {
  it("creates a human gate by default and omits every unset flag", () => {
    expect(buildGateCreateArgs({ blocks: "acme-1" })).toEqual([
      "gate",
      "create",
      "--blocks",
      "acme-1",
      "--json",
    ]);
  });

  it("carries type, await-id, timeout and reason", () => {
    expect(
      buildGateCreateArgs({
        blocks: "acme-1",
        type: "timer",
        awaitId: "42",
        timeout: "2h",
        reason: "waiting on review",
      }),
    ).toEqual([
      "gate", "create", "--blocks", "acme-1",
      "--type", "timer", "--await-id", "42", "--timeout", "2h",
      "--reason", "waiting on review", "--json",
    ]);
  });

  it("refuses a gate that blocks nothing — bd requires --blocks", () => {
    expect(() => buildGateCreateArgs({ blocks: "" })).toThrow(/blocks/);
  });

  it("scopes and flags a check", () => {
    expect(buildGateCheckArgs()).toEqual(["gate", "check", "--json"]);
    expect(buildGateCheckArgs({ scope: "gh", dryRun: true, escalate: true })).toEqual([
      "gate", "check", "--type", "gh", "--dry-run", "--escalate", "--json",
    ]);
  });

  it("builds discover without --json (bd 1.1.2 emits none for it)", () => {
    expect(buildGateDiscoverArgs()).toEqual(["gate", "discover"]);
    expect(buildGateDiscoverArgs({ dryRun: true, branch: "main", limit: 5, maxAge: "30m" })).toEqual(
      ["gate", "discover", "--dry-run", "--branch", "main", "--limit", "5", "--max-age", "30m"],
    );
  });
});

describe("parseGateCheck", () => {
  it("reads the summary that trails bd's progress lines", () => {
    const raw = [
      "✓ acme-g1: would resolve - workflow 'ci' succeeded",
      "",
      "Checked 3 gates: 1 resolved, 1 escalated, 1 errors",
      '{"checked":3,"dry_run":true,"errors":1,"escalated":1,"resolved":1,"schema_version":1}',
    ].join("\n");
    expect(parseGateCheck(raw)).toEqual({
      checked: 3,
      resolved: 1,
      escalated: 1,
      errors: 1,
      dryRun: true,
    });
  });

  it("throws rather than reporting an unreadable check as 'nothing resolved'", () => {
    // A silent {resolved: 0} here would read as "still waiting" forever on a bd whose output moved.
    expect(() => parseGateCheck("Checked 1 gates: 1 resolved, 0 escalated, 0 errors")).toThrow(
      /could not read its --json summary/,
    );
    expect(() => parseGateCheck("")).toThrow(/could not read its --json summary/);
  });
});
