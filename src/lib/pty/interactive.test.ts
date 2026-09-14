/**
 * anton-gjhu: startInteractiveSession's cwd contract. The pty must run in the project's repoPath
 * by default and in the caller-supplied cwd when one is passed (the investigate flow roots the
 * terminal at a running job's worktree). Persistence + the pty manager are mocked — only the
 * session-wiring logic under test is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/types";

const { spawn, createSession, endSession, getProjectSettings } = vi.hoisted(() => ({
  spawn: vi.fn(),
  createSession: vi.fn(async () => {}),
  endSession: vi.fn(async () => {}),
  getProjectSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sessions", () => ({ createSession, endSession }));
vi.mock("@/lib/jobs/queue", () => ({ systemClock: { now: () => 0 } }));
vi.mock("@/lib/projects", () => ({ getProjectSettings }));
vi.mock("./manager", () => ({
  CLAUDE_BIN_ENV: "ANTON_CLAUDE_BIN",
  getPtyManager: () => ({ spawn }),
}));

const { startInteractiveSession } = await import("./interactive");

const project: Project = {
  id: "p1",
  slug: "proj",
  name: "proj",
  repoPath: "/repos/proj",
  defaultBranch: "main",
  hasBeads: false,
  createdAt: 0,
};

beforeEach(() => {
  spawn.mockClear();
  createSession.mockClear();
  endSession.mockClear();
  getProjectSettings.mockClear();
  getProjectSettings.mockResolvedValue({});
});

describe("startInteractiveSession cwd", () => {
  it("spawns in the project's repoPath by default", async () => {
    await startInteractiveSession(project, {});
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repos/proj" }));
  });

  it("honors a cwd override (investigate roots the pty at the job's worktree)", async () => {
    await startInteractiveSession(project, { cwd: "/worktrees/proj-anton-x1" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/worktrees/proj-anton-x1" }),
    );
  });

  it("marks the session failed and rethrows when the spawn fails", async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error("claude not on PATH");
    });
    await expect(startInteractiveSession(project, { cwd: "/gone" })).rejects.toThrow(
      "claude not on PATH",
    );
    expect(endSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      "failed",
    );
  });

  it("marks the session failed and rethrows when the routing lookup rejects", async () => {
    getProjectSettings.mockRejectedValueOnce(new Error("db read failed"));
    await expect(startInteractiveSession(project, {})).rejects.toThrow("db read failed");
    expect(spawn).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      "failed",
    );
  });
});

// The pty must talk to the SAME endpoint this project's headless runs do (anton-7poz): resolve the
// project's settings through the shared routing resolver and apply its delta over anton's env.
describe("startInteractiveSession routing", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function spawnedEnv(): NodeJS.ProcessEnv {
    return spawn.mock.calls[0][0].env;
  }

  it("points a routed project's pty at the project's gateway", async () => {
    process.env.MY_GATEWAY_TOKEN = "secret-token";
    getProjectSettings.mockResolvedValue({
      claudeBaseUrl: "https://gateway.example/v1",
      claudeAuthTokenEnv: "MY_GATEWAY_TOKEN",
      claudeGatewayModelDiscovery: true,
    });

    await startInteractiveSession(project, {});

    const env = spawnedEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret-token");
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(env.TERM).toBe("xterm-256color");
  });

  it("clears an ambient ANTHROPIC_BASE_URL for an unrouted project", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example/v1";
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    getProjectSettings.mockResolvedValue({});

    await startInteractiveSession(project, {});

    const env = spawnedEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
  });

  // An investigate terminal carries the live run's captured routing (anton-7poz): it must hit that
  // endpoint even if project settings drifted since the run began, so the pinned routing is used
  // verbatim and the current settings are never consulted.
  it("honors a captured routing override without reading current settings", async () => {
    process.env.RUN_GATEWAY_TOKEN = "run-token";
    // Settings now point elsewhere — the drift the override exists to defeat.
    getProjectSettings.mockResolvedValue({
      claudeBaseUrl: "https://drifted.example/v1",
      claudeAuthTokenEnv: "RUN_GATEWAY_TOKEN",
    });

    await startInteractiveSession(project, {
      routing: {
        routed: true,
        baseUrl: "https://run.example/v1",
        authTokenEnv: "RUN_GATEWAY_TOKEN",
        gatewayModelDiscovery: false,
      },
    });

    expect(getProjectSettings).not.toHaveBeenCalled();
    const env = spawnedEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://run.example/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("run-token");
  });

  // A run captured while UNROUTED must keep its terminal off any gateway — including anton's ambient
  // one — rather than falling through to a routed current-settings read.
  it("honors a captured unrouted routing, clearing ambient gateway env", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example/v1";
    getProjectSettings.mockResolvedValue({
      claudeBaseUrl: "https://drifted.example/v1",
      claudeAuthTokenEnv: "SOME_TOKEN",
    });

    await startInteractiveSession(project, { routing: { routed: false } });

    expect(getProjectSettings).not.toHaveBeenCalled();
    expect(spawnedEnv().ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
