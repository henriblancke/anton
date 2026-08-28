/**
 * The child environment a bd spawn actually gets (anton-ffmw.1).
 *
 * Every case here is written as TWO projects, because one project can never expose the bug: the
 * failure is that project A's connection settings — sitting in anton's own environment — decide
 * where project B's bd writes. The assertions therefore build B's env with A's values ambient and
 * check what survived.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_SCOPED_BD_ENV,
  buildBdEnv,
  passwordVarHint,
  scopedPasswordVar,
  serverScopedPasswordVar,
} from "./bd-env";
import { resetBoardModeCache } from "./board-mode";

const dirs: string[] = [];

function repo(metadata: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "bd-env-"));
  dirs.push(dir);
  if (metadata) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify(metadata));
  }
  resetBoardModeCache();
  return dir;
}

/** A server-mode board, named the way a real `.beads/metadata.json` names one. */
function serverRepo(
  database: string,
  user?: string,
  extra: Record<string, unknown> = {},
): string {
  return repo({
    dolt_mode: "server",
    dolt_server_host: "dolt.example.dev",
    dolt_server_port: 3306,
    dolt_database: database,
    ...(user ? { dolt_server_user: user } : {}),
    ...extra,
  });
}

/** anton's own environment when it was launched from project A's directory (an `.envrc` export). */
const PROJECT_A_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PATH: "/usr/bin",
  BEADS_DOLT_SERVER_MODE: "true",
  BEADS_DOLT_SERVER_HOST: "dolt.example.dev",
  BEADS_DOLT_SERVER_PORT: "3306",
  BEADS_DOLT_SERVER_USER: "anton",
  BEADS_DOLT_SERVER_DATABASE: "anton",
  BEADS_DOLT_SERVER_SOCKET: "/tmp/a.sock",
  BEADS_DOLT_DATA_DIR: "/srv/a/.beads",
  BEADS_DOLT_PASSWORD: "shared-secret",
  BEADS_DOLT_SERVER_TLS: "true",
};

afterEach(() => {
  resetBoardModeCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildBdEnv — project identity never leaks", () => {
  // THE regression: with anton launched under project A's `.envrc`, a bd run for project B used to
  // dial A's database. Asserted over the whole list rather than a sample, so a var added to
  // PROJECT_SCOPED_BD_ENV without a matching strip cannot slip through.
  it("strips every project-scoped var inherited from another project", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), {}, PROJECT_A_ENV);
    for (const key of PROJECT_SCOPED_BD_ENV) expect(env[key]).toBeUndefined();
  });

  it("leaves the rest of the parent environment alone", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), {}, PROJECT_A_ENV);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BEADS_DOLT_SERVER_TLS).toBe("true");
  });

  // The strip is a default, not a prohibition: a caller that names a connection var means it.
  it("keeps an explicitly overridden connection var", () => {
    const env = buildBdEnv(
      serverRepo("planar", "trammel"),
      { BEADS_DOLT_SERVER_DATABASE: "planar" },
      PROJECT_A_ENV,
    );
    expect(env.BEADS_DOLT_SERVER_DATABASE).toBe("planar");
  });

  it("applies overrides, and an undefined override removes the variable (the GH_REPO contract)", () => {
    const env = buildBdEnv(
      serverRepo("planar", "trammel"),
      { BEADS_ACTOR: "anton", GH_REPO: undefined },
      { ...PROJECT_A_ENV, GH_REPO: "acme/home" },
    );
    expect(env.BEADS_ACTOR).toBe("anton");
    expect("GH_REPO" in env).toBe(false);
  });
});

describe("buildBdEnv — credentials are per project", () => {
  // What lets the shared `beads` account be retired: B's user gets B's password, even though A's
  // password is the one sitting in anton's environment.
  it("uses the target project's user password over the ambient one", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), {}, {
      ...PROJECT_A_ENV,
      BEADS_DOLT_PASSWORD_TRAMMEL: "trammel-secret",
      BEADS_DOLT_PASSWORD_ANTON: "anton-secret",
    });
    expect(env.BEADS_DOLT_PASSWORD).toBe("trammel-secret");
  });

  // A single shared account is still a valid deployment — only an operator who created per-project
  // users should see any change.
  it("falls back to the shared password when the project has no user of its own", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), {}, PROJECT_A_ENV);
    expect(env.BEADS_DOLT_PASSWORD).toBe("shared-secret");
  });

  it("lets an explicit password override win", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), { BEADS_DOLT_PASSWORD: "explicit" }, {
      ...PROJECT_A_ENV,
      BEADS_DOLT_PASSWORD_TRAMMEL: "trammel-secret",
    });
    expect(env.BEADS_DOLT_PASSWORD).toBe("explicit");
  });

  it("names a user's password var legally even when the account has punctuation", () => {
    expect(scopedPasswordVar("anton-bot")).toBe("BEADS_DOLT_PASSWORD_ANTON_BOT");
    expect(scopedPasswordVar("beads")).toBe("BEADS_DOLT_PASSWORD_BEADS");
  });

  // Two servers, one account name, two secrets: scoped by user alone both projects resolve to
  // BEADS_DOLT_PASSWORD_BEADS, so one of them authenticates against the wrong server (PR #174
  // review). The per-server rung is what lets one anton hold both.
  it("prefers this server's password for an account name two servers share", () => {
    const env: NodeJS.ProcessEnv = {
      ...PROJECT_A_ENV,
      BEADS_DOLT_PASSWORD_BEADS: "server-a-secret",
      BEADS_DOLT_PASSWORD_DOLT_EXAMPLE_DEV_3306_BEADS: "server-a-secret",
      BEADS_DOLT_PASSWORD_OTHER_EXAMPLE_DEV_3306_BEADS: "server-b-secret",
    };
    const onB = serverRepo("planar", "beads", { dolt_server_host: "other.example.dev" });
    expect(buildBdEnv(onB, {}, env).BEADS_DOLT_PASSWORD).toBe("server-b-secret");
    expect(buildBdEnv(serverRepo("anton", "beads"), {}, env).BEADS_DOLT_PASSWORD).toBe("server-a-secret");
  });

  it("falls back to the per-user password when this server has no variable of its own", () => {
    const env = { ...PROJECT_A_ENV, BEADS_DOLT_PASSWORD_TRAMMEL: "trammel-secret" };
    expect(buildBdEnv(serverRepo("planar", "trammel"), {}, env).BEADS_DOLT_PASSWORD).toBe("trammel-secret");
  });

  it("names the per-server var from host, port and account — and nothing without a host or user", () => {
    expect(serverScopedPasswordVar({ host: "dolt.example.dev", port: 3306, user: "anton-bot" })).toBe(
      "BEADS_DOLT_PASSWORD_DOLT_EXAMPLE_DEV_3306_ANTON_BOT",
    );
    expect(serverScopedPasswordVar({ host: "dolt.example.dev", user: "beads" })).toBe(
      "BEADS_DOLT_PASSWORD_DOLT_EXAMPLE_DEV_BEADS",
    );
    expect(serverScopedPasswordVar({ user: "beads" })).toBeUndefined();
    expect(serverScopedPasswordVar({ host: "dolt.example.dev" })).toBeUndefined();
  });

  // The name is what an operator types into their shell, and every doc that teaches it says to
  // derive it by hand — so the fold is lossy rather than escaped or hashed, and hosts differing only
  // in WHICH punctuation they use share a variable (PR #174 review). Pinned, not tolerated silently:
  // the docs name the way out (different account names), and a change to the fold has to come here.
  it("folds punctuation lossily — two hosts can share one variable, which the docs make the operator's call", () => {
    expect(serverScopedPasswordVar({ host: "db-a.example.com", port: 3306, user: "beads" })).toBe(
      serverScopedPasswordVar({ host: "db.a-example.com", port: 3306, user: "beads" }),
    );
    // Different accounts on that same pair stay apart — the documented way out of the collision.
    expect(serverScopedPasswordVar({ host: "db-a.example.com", port: 3306, user: "beads-a" })).not.toBe(
      serverScopedPasswordVar({ host: "db.a-example.com", port: 3306, user: "beads-b" }),
    );
  });
});

// Transport is per project for the same reason the database is: `BEADS_DOLT_SERVER_TLS` is one
// process-wide value, and a TLS server and a plaintext one cannot both be described by it (PR #174
// review). bd reads `dolt_server_tls` per directory — the env just has to stop overriding it.
describe("buildBdEnv — transport follows the target project", () => {
  it("strips an inherited TLS flag for a project that declares plaintext", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel", { dolt_server_tls: false }), {}, PROJECT_A_ENV);
    expect("BEADS_DOLT_SERVER_TLS" in env).toBe(false);
  });

  it("sets it for a project that declares TLS, whatever anton was launched with", () => {
    const parent = { ...PROJECT_A_ENV, BEADS_DOLT_SERVER_TLS: undefined };
    const env = buildBdEnv(serverRepo("planar", "trammel", { dolt_server_tls: true }), {}, parent);
    expect(env.BEADS_DOLT_SERVER_TLS).toBe("true");
  });

  // The documented single-server setup: one exported variable, no per-project key, unchanged.
  it("inherits the ambient flag when the project declares no transport", () => {
    const env = buildBdEnv(serverRepo("planar", "trammel"), {}, PROJECT_A_ENV);
    expect(env.BEADS_DOLT_SERVER_TLS).toBe("true");
  });

  it("lets an explicit override win over the project's own declaration", () => {
    const repoPath = serverRepo("planar", "trammel", { dolt_server_tls: false });
    const env = buildBdEnv(repoPath, { BEADS_DOLT_SERVER_TLS: "true" }, PROJECT_A_ENV);
    expect(env.BEADS_DOLT_SERVER_TLS).toBe("true");
  });
});

// The whole change is gated on server mode, and an embedded board reports no user — so an embedded
// project's credentials are whatever the parent holds, exactly as before.
describe("buildBdEnv — embedded boards are unchanged", () => {
  it.each([
    ["an explicitly embedded board", { dolt_mode: "embedded" } as Record<string, unknown>],
    ["no .beads directory at all", null],
  ])("passes the parent password through given %s", (_label, meta) => {
    const env = buildBdEnv(repo(meta), {}, {
      ...PROJECT_A_ENV,
      BEADS_DOLT_PASSWORD_TRAMMEL: "trammel-secret",
    });
    expect(env.BEADS_DOLT_PASSWORD).toBe("shared-secret");
  });
});

describe("passwordVarHint", () => {
  it("names the per-user var for a project with its own account", () => {
    expect(passwordVarHint(serverRepo("planar", "trammel"))).toBe(
      "BEADS_DOLT_PASSWORD_TRAMMEL (or BEADS_DOLT_PASSWORD)",
    );
  });

  it("names the shared var when metadata.json configures no user", () => {
    expect(passwordVarHint(serverRepo("planar"))).toBe("BEADS_DOLT_PASSWORD");
  });
});
