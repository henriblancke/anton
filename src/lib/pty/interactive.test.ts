/**
 * anton-gjhu: startInteractiveSession's cwd contract. The pty must run in the project's repoPath
 * by default and in the caller-supplied cwd when one is passed (the investigate flow roots the
 * terminal at a running job's worktree). Persistence + the pty manager are mocked — only the
 * session-wiring logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/types";

const { spawn, createSession, endSession } = vi.hoisted(() => ({
  spawn: vi.fn(),
  createSession: vi.fn(async () => {}),
  endSession: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sessions", () => ({ createSession, endSession }));
vi.mock("@/lib/jobs/queue", () => ({ systemClock: { now: () => 0 } }));
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
});
