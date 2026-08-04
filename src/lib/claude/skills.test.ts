/**
 * Asset test for anton's vendored REQUIRED skills (anton-d8f.1). Proves the skills anton ships
 * (`skills/<name>/SKILL.md`) exist and are well-formed, so a `/shape` run — and anton's own jobs —
 * have full operating context from anton's assets alone, with no loom/plugin dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLED_SKILLS, REQUIRED_SKILLS, loadSkill, skillPath } from "./prompt";
import { stripFrontmatter } from "./agent-prompt";

/** Pull `name:` and `description:` out of a SKILL.md frontmatter block. */
function frontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = raw.slice(4, end);
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  // description may be a folded scalar (>-); just assert the key is present + non-empty.
  const description = block.match(/^description:\s*([\s\S]+?)(?:\n\S|$)/m)?.[1]?.trim();
  return { name, description };
}

describe("required skill assets", () => {
  it("ships exactly the expected required set", () => {
    expect([...REQUIRED_SKILLS].sort()).toEqual(
      ["bd", "review", "review-fix", "scan-triage", "shape"].sort(),
    );
  });

  for (const name of REQUIRED_SKILLS) {
    describe(`skills/${name}`, () => {
      const raw = readFileSync(skillPath(name), "utf8");

      it("has frontmatter whose name matches its directory", () => {
        const fm = frontmatter(raw);
        expect(fm.name).toBe(name);
        expect(fm.description && fm.description.length).toBeGreaterThan(0);
      });

      it("has a non-empty body once frontmatter is stripped", () => {
        expect(stripFrontmatter(raw).trim().length).toBeGreaterThan(0);
      });

      it("carries no dangling loom / external-plugin references", () => {
        const body = stripFrontmatter(raw);
        expect(body).not.toMatch(/loom/i);
        expect(body).not.toMatch(/foolery/i);
        expect(body).not.toMatch(/skills\/bd\b/); // stale cross-skill path
        expect(body).not.toMatch(/SessionStart/i);
        expect(body).not.toMatch(/loom-scan/i);
      });

      it("loadSkill returns the frontmatter-stripped body", async () => {
        expect(await loadSkill(name)).toBe(stripFrontmatter(raw).trim());
      });
    });
  }

  it("shape and scan-triage point at the bd skill for conventions", () => {
    for (const name of ["shape", "scan-triage"] as const) {
      expect(readFileSync(skillPath(name), "utf8")).toMatch(/`bd` skill/);
    }
  });

  it("shape and scan-triage warn about missing .product/ and point at /setup", () => {
    // If .product/ is absent, these skills must not shape/triage against a vacuum — they warn
    // explicitly and direct the user at the now-bundled /setup (anton-olh).
    for (const name of ["shape", "scan-triage"] as const) {
      const raw = readFileSync(skillPath(name), "utf8");
      expect(raw).toMatch(/`.product\/` is missing/);
      expect(raw).toMatch(/`\/setup`/);
    }
  });

  // The producer must emit the taxonomy the runtime executes (anton-9pkk.7). These assert on the
  // load-bearing copy only — the tier names, the nesting rule, the run-target rule, and the
  // never-orphan-a-feature escalation — not on prose that is free to be rewritten.
  describe("three-tier taxonomy", () => {
    const bd = readFileSync(skillPath("bd"), "utf8");
    const shape = readFileSync(skillPath("shape"), "utf8");
    const scanTriage = readFileSync(skillPath("scan-triage"), "utf8");

    it("bd documents all three tiers and the nesting rule", () => {
      expect(bd).toMatch(/`epic`/);
      expect(bd).toMatch(/`feature`/);
      expect(bd).toMatch(/`task` \/ `bug` \/ `chore`/);
      expect(bd).toMatch(/epic → feature → task \| bug \| chore/);
    });

    it("bd records that `epic` was redefined, and that no bead is re-typed to migrate", () => {
      expect(bd).toMatch(/`epic` has been redefined/);
      expect(bd).toMatch(/never re-type an existing bead/i);
    });

    it("bd states the run-target rule the executor implements", () => {
      // Must stay in step with beads.isRunTarget / isContainer (src/lib/beads/bd.ts).
      expect(bd).toMatch(
        /run target if it is a `feature`, \*\*or\*\* a parentless `task`\/`bug`, \*\*or\*\* an `epic`[\s>]+with no `feature` children/,
      );
    });

    it("bd scopes `area:` to the epic tier", () => {
      expect(bd).toMatch(/`area:`/);
      expect(bd).toMatch(/epic tier only/i);
    });

    it("shape emits a feature scoped to one PR, not an epic", () => {
      expect(shape).toMatch(/anton runs \*\*features\*\*, not epics/);
      expect(shape).toMatch(/\*\*`feature`\*\* scoped to \*\*one reviewable PR\*\*/);
    });

    it("shape looks for an existing epic before creating one", () => {
      expect(shape).toMatch(/bd list --type epic --json/);
      expect(shape).toMatch(/Match on `area:` first/);
      expect(shape).toMatch(/Nothing fits → create the epic/);
    });

    it("warns that a ticket parented to a container epic never runs", () => {
      // A live /shape run hung a task straight off the epic — neither a run target (it has a
      // parent) nor covered by any feature's run. Both producers must name that trap.
      expect(bd).toMatch(/No ticket under a container epic/);
      expect(shape).toMatch(/parented straight\s+to that epic never runs/);
    });

    // anton-tier-invariants: stating the taxonomy in prose was not enough — a /shape run read all
    // of it and still shipped fifteen zero-ticket features. These pin the parts that made the rule
    // CHECKABLE, so a future edit can't quietly soften them back into vibes.
    it("bd numbers the five invariants and splits them by whether the bead can run", () => {
      expect(bd).toMatch(/five invariants/i);
      expect(bd).toMatch(/\*\*Blocking — a dead bead/);
      expect(bd).toMatch(/\*\*Advisory — it runs, but the shape costs later/);
      for (const rule of [
        /No ticket under a container epic/,
        /A feature hangs off an epic and nothing else/,
        /No parentless `chore`/,
        /Every feature has an epic/,
        /A feature carries 2–6 tickets/,
      ]) {
        expect(bd).toMatch(rule);
      }
    });

    it("bd settles feature size: one PR AND 2–6 tickets, which are steps not PRs", () => {
      // The one contradiction the taxonomy left open — "a feature is one PR" vs "a feature holds
      // many tickets" — resolved rather than restated, since either reading alone mis-shapes a board.
      expect(bd).toMatch(/one worktree, one PR\*\* — and it carries \*\*2–6 tickets\*\*/);
      expect(bd).toMatch(/steps executed inside its single run\*, not separate PRs/);
    });

    it("bd keeps the zero-ticket feature legal, matching beads.groupsChildren", () => {
      // Hardening this into an error would refuse runs the runtime executes happily: a childless
      // feature IS its own single ticket.
      expect(bd).toMatch(/Zero is legal/);
      expect(bd).toMatch(/groupsChildren/);
    });

    it("both producers deny that `bd children` verifies the tiers", () => {
      expect(bd).toMatch(/`bd children <epic-id>` prints \*\*titles\*\*/);
      expect(bd).toMatch(/Never treat it as a structural check/);
      expect(shape).toMatch(/`bd children` does not/);
    });

    it("shape's Phase 5 requires the type audit and the mechanical check", () => {
      expect(shape).toMatch(/Audit the tiers\. This step is not optional/);
      expect(shape).toMatch(/npm run board:check/);
      expect(shape).toMatch(/If the audit and your intent disagree, the audit is right/);
    });

    it("shape maps a mid-shape structural instruction onto the tiers instead of obeying it", () => {
      // "make everything a feature", applied literally, is exactly what produced the bad board.
      expect(shape).toMatch(/structural instruction mid-shape is a reading, not a command/i);
      expect(shape).toMatch(/do \*\*not\*\* apply it literally/);
    });

    it("shape reads the board's own shape before adding to it", () => {
      expect(shape).toMatch(/Read the board's shape before you add to it/);
      expect(shape).toMatch(/surface the difference to the user/);
    });

    it("bd creates a tree atomically and names the graph plan's traps", () => {
      expect(bd).toMatch(/bd create --graph/);
      expect(bd).toMatch(/parent_key/);
      expect(bd).toMatch(/--dry-run/);
      // Verified on bd 1.1.2: the graph plan has no acceptance field, and `## Acceptance` alone
      // fails `bd lint` — one heading satisfies both readers.
      expect(bd).toMatch(/There is no acceptance field/);
      expect(bd).toMatch(/`## Acceptance Criteria`\*\* — the one spelling/);
      expect(bd).toMatch(/Never put a heredoc inside command substitution/);
    });

    it("shape escalates an unattachable feature instead of orphaning it", () => {
      expect(shape).toMatch(/ask the user/i);
      expect(shape).toMatch(/Never leave a feature parentless/);
      expect(shape).toMatch(/never mint a one-feature epic/);
    });

    // The second producer (anton-hd9i). Nightly triage must emit the same taxonomy /shape does,
    // or the board gets one-PR "epics" it can only treat as legacy run targets.
    it("scan-triage clusters into a feature scoped to one PR, not an epic", () => {
      expect(scanTriage).toMatch(/anton runs \*\*features\*\*, not epics/);
      expect(scanTriage).toMatch(/\*\*`feature` scoped to one reviewable PR\*\*/);
      expect(scanTriage).toMatch(/one `feature` per theme/);
      expect(scanTriage).not.toMatch(/one epic per theme/);
    });

    it("scan-triage maps a security signal to a feature or a parentless bug, never a bare ticket", () => {
      // The one executor-level exception to clustering — it regresses silently if the wording drifts.
      expect(scanTriage).toMatch(/a `feature` when an epic owns that surface/);
      expect(scanTriage).toMatch(/otherwise a\s+parentless `bug`/);
    });

    it("scan-triage looks for an existing epic before creating one", () => {
      // `--limit 0` on both board reads: bd list defaults to 50, and a truncated board hides the
      // matching epic (duplicate epic) or an already-tracked signal (duplicate bead). `--all` is
      // unconditional on the epic read — triage runs unattended, so a closed epic it never sees is
      // one it can only conclude doesn't exist, and it mints a duplicate.
      expect(scanTriage).toMatch(/bd list --type epic --all --json --limit 0/);
      expect(scanTriage).toMatch(/bd list --json --limit 0/);
      expect(scanTriage).toMatch(/Match on `area:` first/);
    });

    it("scan-triage screens a reused epic for legacy tickets and a closed status", () => {
      // Attaching a feature to a pre-tier epic flips it to a container (beads.isContainer), so its
      // direct tickets land under no card (boardCards.cardOf → undefined) and any run on it is
      // 422'd; and linking a feature never reopens its parent, so buildRoadmap keeps reporting a
      // closed epic as a delivered outcome.
      expect(scanTriage).toMatch(/safe to attach to\*\* — `bd children <epic-id>`/);
      expect(scanTriage).toMatch(/turns it into a container/);
      expect(scanTriage).toMatch(/bd reopen <epic-id>/);
    });

    it("scan-triage hangs child tickets off the feature, never off the epic", () => {
      expect(scanTriage).toMatch(/hang off the feature, never off the epic/);
    });

    it("scan-triage files one-small-change work as a childless feature, not a bare ticket", () => {
      // A bare ticket under an epic is a dead bead; a parentless one leaves the roadmap without the
      // §4.3 ask. Neither is what "this theme is a single bump" should produce.
      expect(scanTriage).toMatch(/A bare ticket is never how you file small work/);
      expect(scanTriage).toMatch(/childless\s+`feature`/);
      expect(scanTriage).not.toMatch(/or a\s+single ticket if the whole theme/);
      expect(scanTriage).not.toMatch(/one ticket if it's a single bump/);
    });

    it("scan-triage refuses to attach cleanup to an already-started run", () => {
      // runTickets is recomputed at merge time, so a ticket added to an in-flight feature is never
      // implemented and still gets closed as delivered by finalizeMergedEpic.
      expect(scanTriage).toMatch(/Never grow a run that has started/);
      expect(scanTriage).toMatch(/a feature \*this triage just created\*/);
      expect(scanTriage).toMatch(/no `approved` \/ `stage:\*` label and no PR ref/);
      // A human claim only sets an assignee (the claim route never enqueues a run), so the prose
      // must not name it as a disqualifier the actionable check doesn't test.
      expect(scanTriage).not.toMatch(/already claimed, approved/);
      expect(scanTriage).toMatch(/An assignee alone is not a disqualifier/);
      // The guard is narrowing-only: read as a licence it would let a cleanup ticket join any open
      // unstarted feature, crossing epic boundaries past what the per-class rule allows.
      expect(scanTriage).toMatch(/only rules candidates \*out\*; it never widens a per-class rule/);
      expect(scanTriage).toMatch(/never some unrelated open feature under another epic/);
    });

    it("scan-triage refuses to hand a childless feature its first child", () => {
      // beads.groupsChildren is `feature && children.length > 0`: the first child flips the feature
      // from running its own Acceptance to running only its children, so the feature's spec never
      // reaches the agent and merge closes it on a PR containing just the cleanup.
      expect(scanTriage).toMatch(/Never give a childless feature its first child/);
      expect(scanTriage).toMatch(/already\*\* has\s+working-layer children/);
      expect(scanTriage).toMatch(/this triage just created\* that\s+already carries child tickets/);
    });

    it("scan-triage surfaces an unattachable cluster instead of orphaning it", () => {
      // No user to ask on the 03:00 cron — the report is how the run asks (§4.3 → §6).
      expect(scanTriage).toMatch(/never mint a one-feature epic/i);
      expect(scanTriage).toMatch(/never leave a `feature` parentless/);
      expect(scanTriage).toMatch(/needs-an-epic:/);
      expect(scanTriage).toMatch(/Surfaced, never orphaned/);
    });

    it("scan-triage's summary line counts features, not epics", () => {
      expect(scanTriage).toMatch(/created: N \(F features, T tickets\)/);
      expect(scanTriage).not.toMatch(/created: N \(E epics/);
    });
  });

  // The pre-PR self-review contract (anton-6ues). These assert only on the load-bearing guarantees —
  // fresh-context framing, the anchored mandatory score, and the deferral of the wire format to the
  // context anton appends — not on prose an operator override is free to restyle.
  describe("self-review contract", () => {
    const body = stripFrontmatter(readFileSync(skillPath("review"), "utf8"));

    it("frames the reviewer as a fresh-context second opinion on code it did not write", () => {
      expect(body).toMatch(/second opinion/i);
      expect(body).toMatch(/fresh context/i);
      expect(body).toMatch(/did not write/i);
    });

    it("grades against the beads' Acceptance criteria and the project's own principles", () => {
      expect(body).toMatch(/## Acceptance/);
      expect(body).toMatch(/\.product\/principles\.md/);
      expect(body).toMatch(/met \/ not met \/\s+unverifiable/);
    });

    it("splits findings into blocking vs advisory (the severities the gate acts on)", () => {
      expect(body).toMatch(/\*\*Blocking\*\*/);
      expect(body).toMatch(/\*\*Advisory\*\*/);
    });

    it("demands a mandatory 0-10 score with a rationale grounded in the criteria", () => {
      expect(body).toMatch(/integer overall quality score from 0 to 10/);
      expect(body).toMatch(/mandatory/i);
      expect(body).toMatch(/rationale must be grounded in the Acceptance verification/);
    });

    it("anchors the scale so scores are comparable across runs", () => {
      for (const anchor of [/\*\*10\*\*/, /\*\*7\*\*/, /\*\*4\*\*/, /\*\*0\*\*/]) {
        expect(body).toMatch(anchor);
      }
    });

    it("defers the machine-readable format to the appended context, not the skill", () => {
      // The wire format lives in code (mirroring review-fix-context.ts) so a reviewPrompt /
      // reviewAgent override can restyle the review but never break the protocol anton parses.
      expect(body).toMatch(/machine-readable report format is specified in the context anton appends/);
      expect(body).toMatch(/Do not invent your own schema/);
      // …and the skill must not smuggle a competing schema in.
      expect(body).not.toMatch(/```json/);
    });

    it("does not orchestrate — anton owns the diff, the fixes, and the PR", () => {
      expect(body).toMatch(/Do not edit code, do not\nrun git, do not open or comment on a PR/);
    });
  });

  // `setup` is founder-run, not loaded by anton's runtime for a background job — so it lives outside
  // REQUIRED_SKILLS. But it IS in INSTALLED_SKILLS: the installer must ship it (skill + its bundled
  // templates) into a target repo, or `/setup` can't resolve where `/shape` sends the founder (anton-olh).
  describe("bundled setup skill", () => {
    const raw = readFileSync(skillPath("setup"), "utf8");

    it("is not in the runtime-required set", () => {
      expect([...REQUIRED_SKILLS]).not.toContain("setup");
    });

    it("is in the always-installed set (so `/setup` resolves in a target repo)", () => {
      expect([...INSTALLED_SKILLS]).toContain("setup");
    });

    it("has frontmatter whose name matches its directory + a non-empty body", () => {
      const fm = frontmatter(raw);
      expect(fm.name).toBe("setup");
      expect(fm.description && fm.description.length).toBeGreaterThan(0);
      expect(stripFrontmatter(raw).trim().length).toBeGreaterThan(0);
    });

    it("is de-loomed and scaffolds from templates bundled alongside the skill", () => {
      const body = stripFrontmatter(raw);
      expect(body).not.toMatch(/loom/i);
      expect(body).not.toMatch(/foolery/i);
      expect(body).toMatch(/templates\/\.product\//);
      expect(body).toMatch(/bd init/);
    });

    it("ships its `.product/` templates inside the skill directory (they travel with the skill)", () => {
      // The templates must live under skills/setup/ so installing the skill dir copies them into a
      // target repo — the fix for a source tree where /setup had no templates to copy (anton-olh).
      const templates = join(dirname(skillPath("setup")), "templates", ".product");
      for (const rel of [
        "PRODUCT.md",
        "config.yaml",
        "principles.md",
        "learnings.md",
        "decisions/README.md",
        "entities/README.md",
      ]) {
        expect(existsSync(join(templates, rel))).toBe(true);
      }
    });
  });
});
