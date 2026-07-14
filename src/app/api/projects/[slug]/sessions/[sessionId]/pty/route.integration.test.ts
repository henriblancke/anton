/**
 * End-to-end HTTP proof for the interactive pty transport (anton-bm4.1). Drives the real route
 * handlers — POST `…/sessions/interactive` to spawn, GET `…/pty` to stream (SSE, base64 frames),
 * POST `…/pty` to send input, DELETE `…/pty` to tear down — with `bash` standing in for `claude`
 * (via ANTON_CLAUDE_BIN). Projects/sessions persistence is mocked so the test needs no anton.db;
 * only the pty transport is real. Self-skips when node-pty's native addon can't spawn here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Project } from "@/lib/types";

const require = createRequire(import.meta.url);

/** True when node-pty can actually spawn on this machine (its prebuilt often mismatches CI's ABI). */
function nodePtyWorks(): boolean {
  try {
    const nodePty = require("node-pty") as {
      spawn: (f: string, a: string[], o: Record<string, unknown>) => { kill: () => void };
    };
    const probe = nodePty.spawn("bash", ["-lc", "exit 0"], {
      name: "xterm-256color",
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
    });
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

const project: Project = {
  id: "p1",
  slug: "tmp",
  name: "tmp",
  repoPath: process.cwd(),
  defaultBranch: "main",
  hasBeads: false,
  createdAt: 0,
};

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (slug === project.slug ? project : null),
}));

// Persistence is out of scope here — stub it so the routes never touch anton.db.
vi.mock("@/lib/sessions", () => ({
  createSession: async () => {},
  endSession: async () => {},
  getSessionById: async (id: string) => ({ id, projectId: project.id, kind: "interactive" }),
}));

const { POST: SPAWN } = await import("../../interactive/route");
const { GET, POST, DELETE } = await import("./route");

const spawnCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const ptyCtx = (slug: string, sessionId: string) => ({
  params: Promise.resolve({ slug, sessionId }),
});

/** Read an SSE stream, base64-decoding `data` frames, until `pred(text)` holds or we time out. */
async function readUntil(
  res: Response,
  pred: (accumulated: string) => boolean,
  timeoutMs = 5000,
): Promise<{ text: string; exited: boolean; abort: () => void }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let exited = false;
  const abort = () => void reader.cancel().catch(() => {});
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      const payload = data.join("\n");
      if (event === "data") text += Buffer.from(payload, "base64").toString("utf8");
      else if (event === "exit") exited = true;
    }
    if (pred(text) || exited) break;
  }
  return { text, exited, abort };
}

const suite = nodePtyWorks() ? describe : describe.skip;

suite("interactive pty routes (real node-pty)", () => {
  const prevBin = process.env.ANTON_CLAUDE_BIN;
  const prevNoHandler = process.env.ANTON_PTY_NO_EXIT_HANDLER;
  const created: string[] = [];

  beforeAll(() => {
    process.env.ANTON_CLAUDE_BIN = "bash";
    process.env.ANTON_PTY_NO_EXIT_HANDLER = "1"; // don't stack a process 'exit' handler per test run
  });

  afterAll(async () => {
    // Tear down anything still live so no bash pty is orphaned.
    for (const id of created) await DELETE(new Request("http://t/"), ptyCtx("tmp", id));
    if (prevBin === undefined) delete process.env.ANTON_CLAUDE_BIN;
    else process.env.ANTON_CLAUDE_BIN = prevBin;
    if (prevNoHandler === undefined) delete process.env.ANTON_PTY_NO_EXIT_HANDLER;
    else process.env.ANTON_PTY_NO_EXIT_HANDLER = prevNoHandler;
  });

  async function spawnSession(): Promise<string> {
    const req = new Request("http://t/", {
      method: "POST",
      body: JSON.stringify({ args: ["--noprofile", "--norc", "-i"] }),
    });
    const res = await SPAWN(req, spawnCtx("tmp"));
    expect(res.status).toBe(201);
    const { sessionId } = await res.json();
    created.push(sessionId);
    return sessionId;
  }

  it("spawns, streams pty output, and echoes keystrokes back (bidirectional)", async () => {
    const sessionId = await spawnSession();

    // Send a command over stdin; its output must come back through the SSE stream.
    const input = await POST(
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ type: "input", data: "echo bm4-http-$((6*7))\r" }),
      }),
      ptyCtx("tmp", sessionId),
    );
    expect(input.status).toBe(204);

    const stream = await GET(new Request("http://t/"), ptyCtx("tmp", sessionId));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toContain("text/event-stream");

    const { text, abort } = await readUntil(stream, (t) => t.includes("bm4-http-42"));
    abort();
    expect(text).toContain("bm4-http-42");
  });

  it("accepts a resize for a live session and 409s once it's gone", async () => {
    const sessionId = await spawnSession();
    const ok = await POST(
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      }),
      ptyCtx("tmp", sessionId),
    );
    expect(ok.status).toBe(204);

    // DELETE tears the pty down cleanly; further input is rejected.
    const del = await DELETE(new Request("http://t/"), ptyCtx("tmp", sessionId));
    expect(del.status).toBe(204);

    const afterKill = await POST(
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ type: "input", data: "x" }),
      }),
      ptyCtx("tmp", sessionId),
    );
    expect(afterKill.status).toBe(409);
  });

  it("streams a clean exit when the pty ends on its own", async () => {
    const sessionId = await spawnSession();
    const stream = await GET(new Request("http://t/"), ptyCtx("tmp", sessionId));
    // Tell the shell to exit; the SSE stream should emit `exit` and close.
    await POST(
      new Request("http://t/", { method: "POST", body: JSON.stringify({ type: "input", data: "exit\r" }) }),
      ptyCtx("tmp", sessionId),
    );
    const { exited } = await readUntil(stream, () => false);
    expect(exited).toBe(true);
  });

  it("404s a session that does not belong to the project", async () => {
    const res = await GET(new Request("http://t/"), ptyCtx("nope", "whatever"));
    expect(res.status).toBe(404);
  });
});
