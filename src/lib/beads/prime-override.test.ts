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

/** Line wraps and blockquote markers are prose formatting, not protocol — drop them before matching
 *  a sentence, so rewrapping a paragraph never breaks a rule assertion. */
const flat = (doc: string): string => doc.replace(/\n>\s*/g, "\n").replace(/\s+/g, " ");

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

      // anton-mv70: `agent:human` is the one agent value that resolves to no specialist prompt, so
      // a set that still carried it would dispatch human work to the DEFAULT agent.
      it("excludes agent:human from the claimable set, and says why", () => {
        expect(flat(doc)).toMatch(/not labelled `agent:human`/);
        expect(flat(doc)).toMatch(
          /credential, an account, a purchase, a signature, or a taste call/,
        );
        expect(flat(doc)).toMatch(/`human` resolves to none/);
      });

      it("keeps that exclusion out of the pool query's flags", () => {
        // isClaimable narrows; the argv stays byte-identical to buildClaimableReadyArgs. A doc that
        // taught `bd ready --exclude-label` here would teach a pool no anton caller ever asks for.
        expect(doc).not.toMatch(/bd ready[^\n]*--exclude-label/);
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

      // The sync legs are embedded-only (anton-0tul): on a shared server they reconcile nothing and
      // fail outright — `bd dolt pull/push` runs ON the server, which cannot reach the git remote.
      // A doc that teaches them unconditionally hands every server-mode worker a failing publish.
      it("scopes the sync legs to an embedded board", () => {
        expect(doc).toMatch(/\*\*On a shared-server board, run steps 2, 6 and 7 only\.\*\*/);
        expect(doc).toMatch(/`dolt_mode`[\s\S]{0,80}`\.beads\/metadata\.json`/);
        expect(doc).toMatch(/absent or unreadable means embedded/);
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

  // Shaping applies the label, so its test lives with the label table — the worker docs only need
  // to know the set drops it.
  it("SKILL.md's label table carries agent:human and the question that applies it", () => {
    expect(SKILL).toMatch(/\|\s*`agent:`[^\n]*`human`/);
    expect(flat(SKILL)).toMatch(
      /Can an agent complete this end to end, or does it need a credential, an account, a purchase, a signature, or a taste call\?/,
    );
  });

  // AGENTS.md is the third home of the same rule: a session that reads only it must not be taught a
  // claimable set that still contains human work.
  it("AGENTS.md's pickup section agrees on the exclusion", () => {
    const agents = read("AGENTS.md");
    expect(flat(agents)).toMatch(/drops anything labelled `agent:human`/);
    expect(flat(agents)).toMatch(
      /credential, an account, a purchase, a signature, or a taste call/,
    );
    expect(agents).not.toMatch(/bd ready[^\n]*--exclude-label/);
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
