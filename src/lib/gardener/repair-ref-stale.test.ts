/**
 * The `ref-stale` repair (anton-fzas / R5.4), against a REAL git fixture repo — because every claim
 * it makes is a claim about what git history says, and a mocked history proves nothing about the
 * commands that read it.
 *
 * Four properties, and three of them are refusals:
 *   • a renamed path resolves and the bead's `## Context` is rewritten to it;
 *   • a DELETED path escalates — there is nowhere for it to have gone;
 *   • an AMBIGUOUS history escalates — the name stood for two files, so history does not answer it;
 *   • a bead anton already repaired for this class escalates (R5.6), it is not repaired twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const updateMock =
  vi.fn<(repo: string, id: string, patch: { description?: string }, labels?: string[]) => Promise<void>>(
    async () => {},
  );
const tagMock = vi.fn<(repo: string, id: string, labels: string[]) => Promise<string>>(async () => "");
const noteMock = vi.fn<(repo: string, id: string, text: string) => Promise<string>>(async () => "");

/** A bead as bd holds it — what the re-read at the write finds. */
interface BoardBead {
  id: string;
  description: string;
  labels: string[];
  notes?: string;
}

/**
 * What `bd show` answers at the write, which is the compare half of the repair's compare-and-set.
 * {@link bead} points it at the bead under test; a case that means to race a founder's edit moves it
 * afterwards.
 */
let onBoard: BoardBead;
const showMock = vi.fn(async () => onBoard as unknown as import("../beads/bd").Bead);

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, show: showMock, update: updateMock, tag: tagMock, note: noteMock },
  };
});

const { repairFingerprint, repairLabel, repairNote } = await import("./repair");
const { citedPaths, contextSpans, refusalNote, repairRefStale, verifyCitedPath } = await import(
  "./repair-ref-stale"
);

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

const BEAD = "anton-a1b2";
const T0 = Date.UTC(2026, 8, 3, 9, 0, 0);

/**
 * A bead as the board hands it back, carrying whatever description and stamps the case needs — and
 * recorded as what the re-read at the write finds, since nothing has edited it in between unless a
 * case says so.
 */
function bead(description: string, labels: string[] = [], notes?: string): BoardBead {
  onBoard = { id: BEAD, description, labels, ...(notes === undefined ? {} : { notes }) };
  return onBoard;
}

/** The contract shape every case's bead is written in — Context is the only section under test. */
function contract(context: string): string {
  return [
    "## Goal",
    "Ship the thing.",
    "",
    "## Acceptance",
    "- [ ] it works",
    "",
    "## Context",
    context,
    "",
    "## Verify",
    "unit tests",
  ].join("\n");
}

describe("citedPaths", () => {
  it("reads repo-relative paths and leaves prose that merely mentions a file alone", () => {
    const cited = citedPaths(
      "touches: a new repair module beside `src/lib/gardener/apply-steps.ts`, and the block " +
        "handling in execute-epic — see also ./src/lib/git/ops.ts.",
    );
    expect(cited.map((c) => c.path)).toEqual([
      "src/lib/gardener/apply-steps.ts",
      "src/lib/git/ops.ts",
    ]);
  });

  it("never reads a URL's path as a repo path", () => {
    expect(citedPaths("see https://vercel.com/docs/workflow/index.html for the API")).toEqual([]);
  });

  it("reports every occurrence, so a rewrite can correct all of them", () => {
    const cited = citedPaths("`src/a.ts` calls into `src/a.ts` twice");
    expect(cited.map((c) => c.path)).toEqual(["src/a.ts", "src/a.ts"]);
    expect(cited[1]!.index).toBeGreaterThan(cited[0]!.index);
  });

  it("never takes a path as a prefix of a longer one", () => {
    expect(citedPaths("`vendor/src/a.tsx`").map((c) => c.path)).toEqual(["vendor/src/a.tsx"]);
  });

  it("refuses a path that leaves the repository", () => {
    expect(citedPaths("../outside/thing.ts and /etc/hosts.conf")).toEqual([]);
  });

  it("keeps the written form so a rewrite replaces exactly what was written", () => {
    const [cited] = citedPaths("see ./src/a.ts");
    expect(cited).toMatchObject({ path: "src/a.ts", text: "./src/a.ts" });
  });

  // An import in a code sample wears a citation's shape while pointing at nothing in this tree, and
  // reading it as a pointer escalated repairs that were otherwise mechanical (PR #223 review).
  it("reads no citation inside a fenced code block", () => {
    const cited = citedPaths(
      [
        "the shape to follow:",
        "```ts",
        'import { Foo } from "@types/node/globals.d.ts";',
        "```",
      ].join("\n"),
    );
    expect(cited).toEqual([]);
  });

  it("keeps offsets aimed at the source text across a fence", () => {
    const text = ["```ts", "import './src/b.ts';", "```", "touches `src/a.ts`."].join("\n");
    const [cited, ...rest] = citedPaths(text);
    expect(rest).toEqual([]);
    expect(cited).toMatchObject({ path: "src/a.ts", text: "src/a.ts" });
    expect(text.slice(cited!.index, cited!.index + cited!.text.length)).toBe("src/a.ts");
  });

  // A path left in an HTML comment renders nowhere, so following it would rewrite text no reader can
  // see — and refusing to follow it would escalate a bead whose visible pointers are all fine (PR
  // #223 review).
  it("reads no citation inside an HTML comment", () => {
    expect(citedPaths("prose <!-- old reference: src/old.ts --> more")).toEqual([]);
    expect(citedPaths(["<!-- was", "`src/old.ts`", "-->"].join("\n"))).toEqual([]);
    expect(citedPaths("prose <!-- src/old.ts")).toEqual([]);
  });

  it("keeps offsets aimed at the source text across an HTML comment", () => {
    const text = "<!-- was `src/old.ts` --> now `src/a.ts`.";
    const [cited, ...rest] = citedPaths(text);
    expect(rest).toEqual([]);
    expect(cited).toMatchObject({ path: "src/a.ts", text: "src/a.ts" });
    expect(text.slice(cited!.index, cited!.index + cited!.text.length)).toBe("src/a.ts");
  });

  it("measures CRLF separators, so a citation's offset survives them", () => {
    const text = ["prose", "touches `src/a.ts`."].join("\r\n");
    const [cited] = citedPaths(text);
    expect(text.slice(cited!.index, cited!.index + cited!.text.length)).toBe("src/a.ts");
  });
});

describe("contextSpans", () => {
  it("ends the section at the next heading of its own depth", () => {
    const [span, ...rest] = contextSpans(contract("touches `src/a.ts`."));
    expect(rest).toEqual([]);
    expect(span!.body.trim()).toBe("touches `src/a.ts`.");
  });

  it("keeps a deeper heading inside the section", () => {
    const [span] = contextSpans(
      ["## Context", "prose", "### Files", "`src/a.ts`", "", "## Verify", "x"].join("\n"),
    );
    expect(span!.body).toContain("### Files");
    expect(span!.body).not.toContain("## Verify");
  });

  it("stops at a DEEPER heading that names another contract section", () => {
    // The gate reads `### Verify` as Verify's own content however deeply it is nested, so a span
    // running past it would rewrite a citation belonging to a section this repair never touches.
    const [span, ...rest] = contextSpans(
      ["## Context", "prose `src/a.ts`", "### Verify", "`src/b.ts` passes"].join("\n"),
    );
    expect(rest).toEqual([]);
    expect(span!.body).toContain("`src/a.ts`");
    expect(span!.body).not.toContain("`src/b.ts`");
  });

  it("answers nothing for a bead that states no Context", () => {
    expect(contextSpans("## Goal\nShip it.")).toEqual([]);
  });

  it("reads every repeated Context section, not just the first", () => {
    const description = [
      "## Context",
      "first `src/a.ts`",
      "",
      "## Goal",
      "ship `src/g.ts`",
      "",
      "## Context",
      "second `src/b.ts`",
      "",
      "## Verify",
      "x",
    ].join("\n");
    const spans = contextSpans(description);
    expect(spans.map((s) => s.body.trim())).toEqual(["first `src/a.ts`", "second `src/b.ts`"]);
    for (const span of spans) expect(description.slice(span.start, span.end)).toBe(span.body);
  });

  it("splits two adjacent Context headings rather than swallowing the second", () => {
    const spans = contextSpans(["## Context", "first", "## Context", "second"].join("\n"));
    expect(spans.map((s) => s.body.trim())).toEqual(["first", "second"]);
  });

  it("keeps its offsets on a CRLF description, so the tail of Context is not cut off", () => {
    const description = contract(
      ["first `src/a.ts`", "second `src/b.ts`", "last `src/c.ts`"].join("\n"),
    ).replace(/\n/g, "\r\n");
    const [span] = contextSpans(description);
    expect(description.slice(span!.start, span!.end)).toBe(span!.body);
    expect(span!.body).toContain("last `src/c.ts`");
    expect(span!.body).not.toContain("## Verify");
  });
});

suite("ref-stale, against a real git history", () => {
  let sandbox: string;
  let repo: string;

  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const write = (path: string, body: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  };

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-refstale-"));
    repo = join(sandbox, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);

    // moved.ts → renamed once. hop.ts → renamed twice. gone.ts → deleted. twice.ts → the name has
    // stood for two different files, which is the ambiguity nothing can resolve. mixed.ts → deleted,
    // recreated by something unrelated, then renamed. rerun.ts → renamed to the SAME destination
    // twice, which is that ambiguity wearing one name. here.ts → stays put. ousted.ts → renamed to a
    // destination an unrelated file took over afterwards. replacer.ts → renamed onto a name whose
    // older occupant was already gone, which is a clean rename and must stay one. reborn.ts →
    // renamed away, then an unrelated file committed back at the old name, so the CITATION is in
    // the worktree while the file it named is not.
    write("src/moved.ts", "export const moved = 'a file long enough to pair on similarity';\n");
    write("src/hop.ts", "export const hop = 'another file long enough to pair on similarity';\n");
    write("src/gone.ts", "export const gone = 'a third file long enough to pair on similarity';\n");
    write("src/twice.ts", "export const twice = 'a fourth file long enough to pair on it';\n");
    write("src/mixed.ts", "export const mixed = 'a fifth file long enough to pair on similarity';\n");
    write("src/rerun.ts", "export const rerun = 'a sixth file long enough to pair on similarity';\n");
    write("src/here.ts", "export const here = 'still right where the bead says it is';\n");
    write("src/ousted.ts", "export const ousted = 'a seventh file long enough to pair on it';\n");
    write("src/replacer.ts", "export const replacer = 'an eighth file long enough to pair on it';\n");
    write("src/legacy.ts", "export const legacy = 'the older file that used to wear that name';\n");
    write("src/reborn.ts", "export const reborn = 'a ninth file long enough to pair on similarity';\n");
    write("src/usurped.ts", "export const usurped = 'a tenth file long enough to pair on it';\n");
    write("src/intruder.ts", "export const intruder = 'the file that takes an old name over';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c1"]);

    mkdirSync(join(repo, "src/lib"), { recursive: true });
    g(["mv", "src/moved.ts", "src/lib/renamed.ts"]);
    g(["commit", "-qm", "c2"]);

    g(["mv", "src/hop.ts", "src/mid.ts"]);
    g(["commit", "-qm", "c3"]);
    g(["mv", "src/mid.ts", "src/lib/landed.ts"]);
    g(["commit", "-qm", "c4"]);

    g(["rm", "-q", "src/gone.ts"]);
    g(["commit", "-qm", "c5"]);

    g(["mv", "src/twice.ts", "src/first.ts"]);
    g(["commit", "-qm", "c6"]);
    write("src/twice.ts", "export const reborn = 'an entirely different file under an old name';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c7"]);
    g(["mv", "src/twice.ts", "src/second.ts"]);
    g(["commit", "-qm", "c8"]);

    g(["rm", "-q", "src/mixed.ts"]);
    g(["commit", "-qm", "c9"]);
    write("src/mixed.ts", "export const unrelated = 'a different file that took over the name';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c10"]);
    g(["mv", "src/mixed.ts", "src/took-over.ts"]);
    g(["commit", "-qm", "c11"]);

    g(["mv", "src/rerun.ts", "src/lib/rerun.ts"]);
    g(["commit", "-qm", "c12"]);
    g(["rm", "-q", "src/lib/rerun.ts"]);
    write("src/rerun.ts", "export const different = 'nothing to do with what used to live here';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c13"]);
    g(["mv", "src/rerun.ts", "src/lib/rerun.ts"]);
    g(["commit", "-qm", "c14"]);

    // The ambiguity the SOURCE's history cannot see: one clean rename, then the destination is
    // removed and an unrelated file takes the name. Read from `src/ousted.ts` this is a rename to a
    // path that is right there in the worktree.
    g(["mv", "src/ousted.ts", "src/taken.ts"]);
    g(["commit", "-qm", "c15"]);
    g(["rm", "-q", "src/taken.ts"]);
    g(["commit", "-qm", "c16"]);
    write("src/taken.ts", "export const stranger = 'an unrelated file that took the name later';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c17"]);

    // The same shape read backwards: the older `src/legacy.ts` is gone BEFORE the rename replaces
    // it, so the destination has stood for one file ever since and the rename is followable.
    g(["rm", "-q", "src/legacy.ts"]);
    g(["commit", "-qm", "c18"]);
    g(["mv", "src/replacer.ts", "src/legacy.ts"]);
    g(["commit", "-qm", "c19"]);

    // The reincarnation read from the SOURCE side: the name the bead cites is occupied again, by
    // something with no relation to what the bead pointed at.
    g(["mv", "src/reborn.ts", "src/relocated.ts"]);
    g(["commit", "-qm", "c20"]);
    write("src/reborn.ts", "export const impostor = 'a later file that took an old name over';\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "c21"]);

    // The same reincarnation arriving as a RENAME rather than a re-add, which is the one `--follow`
    // cannot see (PR #223 review): followed from the file living at `src/usurped.ts` now, the walk
    // switches to `src/intruder.ts` at c23 and never reaches the deletion at c22.
    g(["rm", "-q", "src/usurped.ts"]);
    g(["commit", "-qm", "c22"]);
    g(["mv", "src/intruder.ts", "src/usurped.ts"]);
    g(["commit", "-qm", "c23"]);
  });

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  beforeEach(() => {
    updateMock.mockClear();
    tagMock.mockClear();
    noteMock.mockClear();
    showMock.mockClear();
  });

  describe("verifyCitedPath", () => {
    it("reports a path that is right where the bead says it is", async () => {
      expect(await verifyCitedPath(repo, "src/here.ts")).toEqual({
        path: "src/here.ts",
        state: "present",
      });
    });

    it("follows a rename to its current location", async () => {
      expect(await verifyCitedPath(repo, "src/moved.ts")).toMatchObject({
        state: "moved",
        to: "src/lib/renamed.ts",
      });
    });

    it("follows a chain of renames, not just the first hop", async () => {
      expect(await verifyCitedPath(repo, "src/hop.ts")).toMatchObject({
        state: "moved",
        to: "src/lib/landed.ts",
        trail: ["src/hop.ts", "src/mid.ts", "src/lib/landed.ts"],
      });
    });

    it("refuses a deleted path rather than guessing a replacement", async () => {
      const verdict = await verifyCitedPath(repo, "src/gone.ts");
      expect(verdict.state).toBe("unresolved");
      expect(verdict).toMatchObject({ why: expect.stringContaining("deleted") });
    });

    it("refuses a name that has stood for more than one file", async () => {
      const verdict = await verifyCitedPath(repo, "src/twice.ts");
      expect(verdict.state).toBe("unresolved");
      expect(verdict).toMatchObject({ why: expect.stringContaining("more than one file") });
    });

    it("refuses a path that was deleted AND renamed, rather than following the later file", async () => {
      const verdict = await verifyCitedPath(repo, "src/mixed.ts");
      expect(verdict.state).toBe("unresolved");
      expect(verdict).toMatchObject({ why: expect.stringContaining("both deleted and renamed") });
    });

    it("refuses a name renamed to the same destination twice, however it deduplicates", async () => {
      const verdict = await verifyCitedPath(repo, "src/rerun.ts");
      expect(verdict.state).toBe("unresolved");
      expect(verdict).toMatchObject({ why: expect.stringContaining("more than one file") });
    });

    it("refuses a rename whose destination an unrelated file took over afterwards", async () => {
      const verdict = await verifyCitedPath(repo, "src/ousted.ts");
      expect(verdict.state).toBe("unresolved");
      expect(verdict).toMatchObject({ why: expect.stringContaining("committed afterwards") });
    });

    it("follows a rename that legitimately replaced an already-deleted name", async () => {
      expect(await verifyCitedPath(repo, "src/replacer.ts")).toMatchObject({
        state: "moved",
        to: "src/legacy.ts",
      });
    });

    // Presence is a claim about the TREE, deliberately — vetting every present citation's history
    // here would escalate blocks that have nothing to do with paths. `repairRefStale` asks the
    // reincarnation question, and only once a repair is in play (PR #223 review).
    it("reports a recreated citation as present — the reincarnation check is the repair's", async () => {
      expect(await verifyCitedPath(repo, "src/reborn.ts")).toEqual({
        path: "src/reborn.ts",
        state: "present",
      });
    });

    it("refuses a path git has never heard of", async () => {
      const verdict = await verifyCitedPath(repo, "src/never-existed.ts");
      expect(verdict).toMatchObject({ state: "unresolved" });
    });
  });

  describe("repairRefStale", () => {
    it("rewrites the Context to the resolved path and records the repair", async () => {
      const description = contract("touches: `src/moved.ts` and `src/here.ts`.");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({
        action: "repaired",
        label: repairLabel(BEAD, "ref-stale", T0),
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      expect(outcome.action === "repaired" && outcome.description).toContain(
        "`src/lib/renamed.ts`",
      );
      // Only the pointer moved: every other section comes back byte-identical.
      expect(outcome.action === "repaired" && outcome.description).toBe(
        description.replace("src/moved.ts", "src/lib/renamed.ts"),
      );
      expect(updateMock).toHaveBeenCalledWith(
        repo,
        BEAD,
        { description: outcome.action === "repaired" ? outcome.description : "" },
        [],
      );
      // The stamp lands before the prose — the label is the suppression (repair.ts).
      expect(tagMock).toHaveBeenCalledWith(repo, BEAD, [repairLabel(BEAD, "ref-stale", T0)]);
      expect(noteMock.mock.calls[0]![2]).toContain(repairFingerprint(BEAD, "ref-stale"));
    });

    // The repair moves the pointer and nothing else — including the `./` an author wrote, which
    // `citedPaths` normalises away and git never reports back (PR #223 review).
    it("keeps a `./` prefix the bead was written with", async () => {
      const description = contract("touches: `./src/moved.ts` and `src/moved.ts`.");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({ action: "repaired" });
      expect(outcome.action === "repaired" && outcome.description).toBe(
        contract("touches: `./src/lib/renamed.ts` and `src/lib/renamed.ts`."),
      );
    });

    // A code sample is not a set of pointers at this repo: an import path that resolves nowhere here
    // used to join the unresolved set and escalate an otherwise mechanical repair (PR #223 review).
    it("follows the real pointer past a code sample citing a path this repo never had", async () => {
      const description = contract(
        [
          "touches `src/moved.ts`. Written like:",
          "",
          "```ts",
          'import { Foo } from "@types/node/globals.d.ts";',
          'import { gone } from "./src/gone.ts";',
          "```",
        ].join("\n"),
      );
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({
        action: "repaired",
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      // The sample comes back byte-identical — the repair moves the pointer and nothing else.
      expect(outcome.action === "repaired" && outcome.description).toBe(
        description.replace("src/moved.ts", "src/lib/renamed.ts"),
      );
    });

    // A commented-out pointer renders nowhere, so reading it escalated a mechanical repair on the
    // strength of a line no one can see — and following it would have rewritten one (PR #223 review).
    it("follows the real pointer past a path hidden in an HTML comment", async () => {
      const description = contract(
        [
          "touches `src/moved.ts`.",
          "<!-- old reference: `src/gone.ts` — kept for the archaeology -->",
        ].join("\n"),
      );
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({
        action: "repaired",
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      // The comment comes back byte-identical — the repair rewrites what the bead RENDERS.
      expect(outcome.action === "repaired" && outcome.description).toBe(
        description.replace("touches `src/moved.ts`", "touches `src/lib/renamed.ts`"),
      );
    });

    it("answers `none` when the only stale path is one an HTML comment hides", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/here.ts`. <!-- was `src/moved.ts` -->")),
        block: { reason: "something else is wrong" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({ action: "none" });
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("rewrites a stale pointer in EVERY Context section, not just the first", async () => {
      const description = [
        "## Goal",
        "Ship the thing.",
        "",
        "## Context",
        "touches `src/here.ts`.",
        "",
        "## Acceptance",
        "- [ ] it works",
        "",
        "## Context",
        "also touches `src/moved.ts` and `src/moved.ts` again.",
        "",
        "## Verify",
        "unit tests",
      ].join("\n");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome).toMatchObject({
        action: "repaired",
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      // A citation only the LATER section carries is still spec: every occurrence is corrected and
      // nothing else in the description moves.
      expect(outcome.action === "repaired" && outcome.description).toBe(
        description.replaceAll("src/moved.ts", "src/lib/renamed.ts"),
      );
    });

    it("keeps a rewrite whose stamp failed, unstamped — the pointer is already correct", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      tagMock.mockRejectedValueOnce(new Error("bd tag exploded"));
      const description = contract("touches: `src/moved.ts` and `src/here.ts`.");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });
      errors.mockRestore();

      // The fix landed, so the outcome is `repaired` and the ticket is re-queued. Rejecting instead
      // would block a bead anton had already corrected, and no later pass would find it again —
      // every path resolves now, so the next `ref-stale` check answers `none`.
      expect(outcome).toMatchObject({
        action: "repaired",
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      expect(outcome.action === "repaired" && outcome.label).toBeUndefined();
      expect(updateMock).toHaveBeenCalledWith(
        repo,
        BEAD,
        { description: description.replace("src/moved.ts", "src/lib/renamed.ts") },
        [],
      );
      // The bead says it is unstamped rather than carrying a silently rewritten description — and
      // carries no fingerprint, because nothing suppresses a later repair of this class.
      const note = noteMock.mock.calls.at(-1)![2];
      expect(note).toContain("could not stamp it");
      expect(note).not.toContain(repairFingerprint(BEAD, "ref-stale"));
    });

    // The rewrite replaces the WHOLE description and is computed from a read taken before a string
    // of git history reads. A founder saving an edit in that window would be silently overwritten,
    // so the write compares before it sets (PR #223 review).
    it("refuses to write a rewrite the bead moved out from under", async () => {
      const stale = bead(contract("touches: `src/moved.ts` and `src/here.ts`."));
      const edited = contract("touches: `src/moved.ts`. Rewritten by hand mid-repair.");
      onBoard = { id: BEAD, description: edited, labels: [] };

      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: stale,
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });

      expect(outcome.action).toBe("escalate");
      expect(outcome.action === "escalate" && outcome.why).toContain("rewritten while");
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    // Labels are read at the write for the same reason the description is: `beads.update` diffs the
    // patch against the labels it is handed, so a stale set would take back an edit made meanwhile.
    it("writes against the labels the bead carries at the write, not the ones it was read with", async () => {
      const stale = bead(contract("touches `src/moved.ts`."), []);
      onBoard = { id: BEAD, description: stale.description, labels: ["domain:eng"] };

      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: stale,
        block: {},
        now: T0,
        autonomy: "apply",
      });

      expect(outcome.action).toBe("repaired");
      expect(updateMock).toHaveBeenCalledWith(repo, BEAD, expect.anything(), ["domain:eng"]);
    });

    it("armed at `shadow`: works the rewrite out and writes NOTHING (R5.3)", async () => {
      const description = contract("touches: `src/moved.ts` and `src/here.ts`.");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "shadow",
      });

      // The armed answer, minus the writes: the same description, so a week of shadow says what
      // arming would actually have done rather than what a second implementation thinks it would.
      expect(outcome).toMatchObject({
        action: "shadow",
        rewrites: [{ from: "src/moved.ts", to: "src/lib/renamed.ts" }],
      });
      expect(outcome.action === "shadow" && outcome.description).toBe(
        description.replace("src/moved.ts", "src/lib/renamed.ts"),
      );
      expect(updateMock).not.toHaveBeenCalled();
      // No stamp either: nothing happened to the bead, so the one repair the guard allows is still
      // available when the operator arms the class.
      expect(tagMock).not.toHaveBeenCalled();
      expect(noteMock).not.toHaveBeenCalled();
    });

    it("armed at `propose`: establishes the class, then escalates without touching the bead", async () => {
      const description = contract("touches: `src/moved.ts` and `src/here.ts`.");
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(description),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "propose",
      });

      // Staleness is still established first — an unarmed class must not turn every OTHER block on
      // a healthy bead into a "ref-stale is not armed" escalation.
      expect(outcome.action).toBe("escalate");
      if (outcome.action !== "escalate") return;
      expect(outcome.why).toContain("not armed to repair");
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("rewrites every occurrence of a moved path, not only the first", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("`src/moved.ts` is read by the gate, and `src/moved.ts` alone.")),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("repaired");
      expect(outcome.action === "repaired" && outcome.description).not.toContain("src/moved.ts`");
    });

    it("escalates a deleted path and writes NOTHING to the bead", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/gone.ts`.")),
        block: { reason: "the file is not there" },
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      expect(outcome.action === "escalate" && outcome.evidence.join(" ")).toContain("deleted");
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("escalates an ambiguous history rather than picking a destination", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/twice.ts`.")),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      expect(outcome.action === "escalate" && outcome.evidence.join(" ")).toContain(
        "more than one file",
      );
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("rewrites nothing when even one cited path is unresolvable", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/moved.ts` and `src/gone.ts`.")),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      expect(updateMock).not.toHaveBeenCalled();
    });

    // The half-repair the worktree check alone would allow (PR #223 review): `src/reborn.ts` is
    // right there, so it passes as resolved, `src/moved.ts` is rewritten, the bead is stamped
    // repaired — and the retry it earns still points at whatever took the old name over.
    it("escalates a present citation whose own file moved away, instead of half-repairing", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/moved.ts` and `src/reborn.ts`.")),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      const evidence = outcome.action === "escalate" ? outcome.evidence.join(" ") : "";
      expect(evidence).toContain("src/reborn.ts");
      expect(evidence).toContain("committed afterwards");
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    // The replacement does not have to arrive as a re-add: an unrelated file renamed INTO the cited
    // name is the same wrong pointer, and `--follow` reports that name as clean because the walk
    // switches to the incoming file at the rename (PR #223 review).
    it("escalates a present citation an unrelated file was RENAMED into", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/moved.ts` and `src/usurped.ts`.")),
        block: { reason: "src/moved.ts is not in the worktree" },
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      const evidence = outcome.action === "escalate" ? outcome.evidence.join(" ") : "";
      expect(evidence).toContain("src/usurped.ts");
      expect(evidence).toContain("committed afterwards");
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    // The other half of that decision: a reincarnated citation on its own is not a `ref-stale`
    // block, so an unrelated block on the bead settles exactly as it did before.
    it("answers `none` for a reincarnated citation when nothing else is stale", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/reborn.ts`.")),
        block: { reason: "the test runner is not installed" },
        now: T0,
        autonomy: "apply",
      });
      expect(outcome).toMatchObject({ action: "none" });
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("does nothing at all when every cited path is in the worktree", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/here.ts`.")),
        block: { reason: "the test runner is not installed" },
        now: T0,
        autonomy: "apply",
      });
      expect(outcome).toMatchObject({ action: "none" });
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("does nothing for a bead that states no Context to check", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead("## Goal\nShip it."),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      expect(outcome).toMatchObject({ action: "none" });
    });

    it("escalates the SECOND ref-stale block on a bead it already repaired (R5.6)", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(
          contract("touches `src/moved.ts`."),
          [repairLabel(BEAD, "ref-stale", T0)],
          repairNote(repairFingerprint(BEAD, "ref-stale"), "rewrote it once already"),
        ),
        block: { reason: "still cannot find it" },
        now: T0 + 60_000,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("escalate");
      expect(outcome.action === "escalate" && outcome.evidence.join(" ")).toContain(
        "rewrote it once already",
      );
      expect(updateMock).not.toHaveBeenCalled();
      expect(tagMock).not.toHaveBeenCalled();
    });

    it("leaves a bead the guard escalated on a DIFFERENT class free to be repaired", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/moved.ts`."), [
          repairLabel(BEAD, "dep-missing", T0),
        ]),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      expect(outcome.action).toBe("repaired");
    });
  });

  describe("refusalNote", () => {
    it("is exactly one line, so the notes blob reads it back as one note", async () => {
      const outcome = await repairRefStale({
        repoPath: repo,
        worktreePath: repo,
        bead: bead(contract("touches `src/gone.ts`.")),
        block: {},
        now: T0,
        autonomy: "apply",
      });
      const note = refusalNote(outcome as Extract<typeof outcome, { action: "escalate" }>);
      expect(note.split("\n")).toHaveLength(1);
      expect(note).toContain("ref-stale");
    });
  });
});
