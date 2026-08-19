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
import { PROJECT_SCOPED_BD_ENV, buildBdEnv, passwordVarHint, scopedPasswordVar } from "./bd-env";
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
function serverRepo(database: string, user?: string): string {
  return repo({
    dolt_mode: "server",
    dolt_server_host: "dolt.example.dev",
    dolt_server_port: 3306,
    dolt_database: database,
    ...(user ? { dolt_server_user: user } : {}),
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
