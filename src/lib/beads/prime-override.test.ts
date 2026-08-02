/**
 * Asset test for the primed pickup protocol (anton-z45e): `.beads/PRIME.md` is what a worker with no
 * anton runtime is taught, so its load-bearing lines are gated here rather than left to prose drift.
 *
 * The override replaces `bd prime`'s output ENTIRELY — memories included, in every mode — so the two
 * halves are asserted together: the protocol the file must carry, and the second hook command that
 * puts persistent memories back. Real-binary behaviour is pinned in
 * `prime-override.integration.test.ts`; this file is the fast gate on the content itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

const PRIME = read(".beads", "PRIME.md");
const SKILL = read("skills", "bd", "SKILL.md");

/** Both docs teach the same protocol; a rule that lands in only one of them is a drift bug. */
const PROTOCOL_HOMES: Array<[string, string]> = [
  [".beads/PRIME.md", PRIME],
  ["skills/bd/SKILL.md", SKILL],
];

describe("the pickup protocol is teachable without the anton runtime", () => {
  for (const [where, doc] of PROTOCOL_HOMES) {
    describe(where, () => {
      it("forbids bare `bd ready`", () => {
        expect(doc).toMatch(/\*\*No worker runs bare `bd ready`\.\*\*/);
      });

      it("gives the canonical claimable-set query", () => {
        // Must stay in step with buildClaimableReadyArgs (bd.ts): every flag is load-bearing.
        expect(doc).toMatch(/bd ready --label approved --unassigned --json --limit 0/);
        expect(doc).toMatch(/bd list --status all --json --limit 0/);
      });

      it("gives the rank order every consumer sorts by", () => {
        // rankClaimableTargets: priority → unblocking value → age → id.
        expect(doc).toMatch(/\*\*priority\*\*, P0 first/);
        expect(doc).toMatch(/transitively unblocks via `blocks` edges/);
        expect(doc).toMatch(/oldest `created_at` first/);
        expect(doc).toMatch(/\*\*id\*\*, which is what makes the order total/);
      });

      it("gives the full claim-verify sequence, in order", () => {
        // The seven legs of beads.claimVerified. A doc that drops the settle, the re-read or the
        // re-validation teaches a claim that looks held — or still runnable — and isn't.
        const legs = [
          /bd dolt pull/,
          /BEADS_ACTOR="\$ACTOR" bd update <id> --claim/,
          /bd dolt commit && bd dolt push/,
          /sleep 2/,
          /bd show <id> --json/,
          /re-apply §1 to the target you now hold/,
        ];
        let cursor = 0;
        for (const leg of legs) {
          const at = doc.slice(cursor).search(leg);
          expect(at, `${leg} out of order`).toBeGreaterThanOrEqual(0);
          cursor += at + 1;
        }
        expect(doc).toMatch(/assert assignee == "\$ACTOR"/);
      });

      it("names all four claim outcomes, and licenses a run only on the first", () => {
        expect(doc).toMatch(/assignee is you, and §1 still holds\*\* → you hold it/);
        expect(doc).toMatch(/Back off \*without writing anything\*/);
        // The target left the claimable set while we settled: ours on paper, not runnable.
        expect(doc).toMatch(/but the target left the claimable set\*\*/);
        expect(doc).toMatch(/Hand the claim back \(`bd assign <id> ""`\)/);
        expect(doc).toMatch(/fail closed: do not run the target/);
      });

      it("reserves a claimed feature's children with assign, never claim", () => {
        expect(doc).toMatch(/bd assign <child-id> "\$ACTOR"/);
        expect(doc).toMatch(/bd assign <child-id> ""/);
        expect(doc).toMatch(/never `bd update --claim`/);
      });
    });
  }

  it("PRIME.md is self-sufficient: it carries the run-target rule it filters on", () => {
    // The override replaces bd's whole reference, so a rule it only cites is a rule a primed
    // session doesn't have.
    expect(PRIME).toMatch(
      /run target if it is a `feature`, \*\*or\*\* a parentless `task`\/`bug`, \*\*or\*\* an `epic`[\s>]+with no `feature` children/,
    );
  });

  it("PRIME.md says how to recover what the override hides", () => {
    expect(PRIME).toMatch(/bd prime --export --memories-only/);
    expect(PRIME).toMatch(/bd prime --export/);
  });
});

describe("prime hooks", () => {
  const hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> = JSON.parse(
    read(".claude", "settings.json"),
  ).hooks;

  // The override wins in --memories-only too (proved against a real bd in the integration suite),
  // so `bd prime` alone would drop every `bd remember` insight out of a primed session.
  it("re-inject persistent memories the override suppresses", () => {
    const commands = Object.values(hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command))
      .filter((c) => c.includes("bd prime"));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/bd prime --export --memories-only/);
    }
  });
});
