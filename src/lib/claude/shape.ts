/**
 * Build the argv for an interactive `/shape` pty session (anton-bm4.2). The session runs `claude`
 * in the project repo, seeded with the vendored `shape` skill (skills/shape/SKILL.md) via
 * `--append-system-prompt`, plus a short framing note that in anton's Add-work UI the founder
 * commits the FEATURE by clicking "Send to backlog" — so the assistant shapes the *draft* and does
 * not create beads itself (the UI owns bead creation; see DESIGN.md §5).
 *
 * The framing goes FIRST so it wins precedence over the skill's own "Phase 5 — create the beads"
 * step, mirroring how the locked base contract leads the execution system prompt. What it must not
 * contradict is the tier model (anton-h1ds): the panel commits a `feature` under an epic — exactly
 * what the skill's own Phase 4 emits — so the UI producer and the CLI producer agree on what a run
 * target is.
 */

export const SHAPE_UI_FRAMING = `# Interactive shaping (anton "Add work")

You are shaping inside anton's browser UI. This is a live conversation with the founder to turn a
fuzzy idea into a crisp draft **feature** — one reviewable PR's worth of work, the tier anton runs
— plus the **epic** (the product outcome) it hangs off.

The founder commits it by clicking **"Send to backlog"** in the UI; that click is what creates the
beads, rendered from the project's bead formula. So your job is the conversation and the draft,
NOT the write:

- Run the shaping conversation below (forcing questions, research, CEO/eng/design lenses).
- Converge on the feature's contract — the sections the panel commits: **Title**, **Goal**,
  **Acceptance criteria**, **Context**, **Out of scope**, **Verify**. Propose concrete text for
  each; the founder pastes or edits it in the panel.
- Name the **epic** it belongs to. The panel lists the epics already on the board; read them
  (\`bd list --type epic --json\`) and recommend the one this feature advances. If none honestly
  fits, propose a new epic — **Title**, **Outcome**, **Success criteria** (what several features
  add up to, not this PR's checklist), one **Area** — which the panel can create alongside it.
  Never leave the feature without an epic, and never mint a one-feature epic to dodge the
  question: ask the founder.
- If the idea is bigger than one PR, say so plainly — that is an epic with several features, and
  the panel commits one feature at a time. Shape the first; list the rest for a later pass.
- Do NOT run \`bd\` WRITES or create/modify beads yourself — the UI owns bead creation. Reading the
  board (\`bd list\`, \`bd show\`) to find the right epic is expected.
- When the draft is solid, say so and tell the founder it's ready to send to backlog.`;

/** Compose the interactive shaping system prompt: UI framing first, then the shape skill body. */
export function buildShapeSystemPrompt(shapeSkillBody: string): string {
  return [SHAPE_UI_FRAMING, "", "---", "", shapeSkillBody.trim()].join("\n");
}

/**
 * Build the claude argv for a shaping session. `--append-system-prompt` carries the composed
 * shaping prompt; the founder's initial description (if any) is passed as the first message so the
 * conversation opens on their idea rather than a blank prompt.
 */
export function buildShapeArgs(shapeSkillBody: string, description?: string): string[] {
  const args = ["--append-system-prompt", buildShapeSystemPrompt(shapeSkillBody)];
  const desc = description?.trim();
  if (desc) args.push(desc);
  return args;
}
