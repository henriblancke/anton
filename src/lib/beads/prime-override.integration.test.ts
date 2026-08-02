/**
 * Real `bd prime` round-trip for the `.beads/PRIME.md` override (anton-z45e).
 *
 * bd's help *claims* PRIME.md "overrides the default output entirely" — and help is not an oracle
 * (`.product/decisions/2026-07-28-bd-workflow-primitives.md`). This pins what a real binary actually
 * does with the file anton ships, because two behaviours the repo now depends on are invisible from
 * the docs:
 *
 *   1. the override IS served (so a primed session in a fresh clone learns the pickup protocol), and
 *   2. it suppresses the persistent-memory block in EVERY mode, `--memories-only` included — which
 *      is why `.claude/settings.json` calls `bd prime --export --memories-only` as a second hook
 *      command. If a future bd started merging memories into the override instead, that second call
 *      would double them; if PRIME.md stopped being served, the protocol would silently vanish.
 *
 * Runs against whichever `bd` is on PATH; the floor (1.1.0) and 1.1.2 were both verified by hand
 * when the override landed.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";

/** The override anton ships, read from the repo it is served in. */
const PRIME_MD = join(process.cwd(), ".beads", "PRIME.md");

/** A memory only this fixture has, so "memories are absent" can't pass on an empty board. */
const SENTINEL = "PRIME-OVERRIDE-SENTINEL: this memory must survive the override";

describeBd("bd prime + .beads/PRIME.md override", () => {
  let sandbox: BdRepo;
  const prime = (args: string[] = []): string =>
    execFileSync("bd", ["prime", ...args], { cwd: sandbox.repo, encoding: "utf8" });

  beforeAll(() => {
    sandbox = makeBdRepo();
    execFileSync("bd", ["remember", SENTINEL], { cwd: sandbox.repo, stdio: "ignore" });
  });

  afterAll(() => sandbox?.cleanup());

  it("serves the default workflow context, memories included, with no PRIME.md", () => {
    const out = prime();
    expect(out).toMatch(/# Beads Workflow Context/);
    expect(out).toContain(SENTINEL);
  });

  it("serves anton's PRIME.md verbatim once it exists", () => {
    copyFileSync(PRIME_MD, join(sandbox.repo, ".beads", "PRIME.md"));
    expect(prime().trim()).toBe(readFileSync(PRIME_MD, "utf8").trim());
  });

  it("carries the pickup protocol into a primed session", () => {
    const out = prime();
    expect(out).toMatch(/bd ready --label approved --unassigned --json --limit 0/);
    expect(out).toMatch(/No worker runs bare `bd ready`/);
    expect(out).toMatch(/bd update <id> --claim/);
    expect(out).toMatch(/assert assignee/);
  });

  it("suppresses persistent memories in every mode — the reason the hook calls --export", () => {
    // Not a preference: `--memories-only` is what a compact hook context uses, and the override
    // wins there too, so memory injection has to be recovered explicitly.
    expect(prime()).not.toContain(SENTINEL);
    expect(prime(["--memories-only"])).not.toContain(SENTINEL);
    expect(prime(["--export", "--memories-only"])).toContain(SENTINEL);
  });

  it("still wraps the override for the hook envelope", () => {
    const envelope = JSON.parse(prime(["--hook-json"]));
    expect(envelope.hookSpecificOutput.additionalContext).toMatch(/No worker runs bare `bd ready`/);
  });
});
