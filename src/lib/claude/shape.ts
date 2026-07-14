/**
 * Build the argv for an interactive `/shape` pty session (anton-bm4.2). The session runs `claude`
 * in the project repo, seeded with the vendored `shape` skill (skills/shape/SKILL.md) via
 * `--append-system-prompt`, plus a short framing note that in anton's Add-work UI the founder
 * commits the epic by clicking "Send to backlog" — so the assistant shapes the *draft* and does
 * not create beads itself (the UI owns bead creation; see DESIGN.md §5).
 *
 * The framing goes FIRST so it wins precedence over the skill's own "Phase 5 — create the beads"
 * step, mirroring how the locked base contract leads the execution system prompt.
 */

export const SHAPE_UI_FRAMING = `# Interactive shaping (anton "Add work")

You are shaping inside anton's browser UI. This is a live conversation with the founder to turn a
fuzzy idea into a crisp draft epic — title, goal, and the tickets it would decompose into.

The founder commits the epic to the backlog by clicking **"Send to backlog"** in the UI; that
click is what creates the bead. So your job is the conversation and the draft, NOT the write:

- Run the shaping conversation below (forcing questions, research, CEO/eng/design lenses).
- Help the founder converge on a single-PR-scoped epic with a clear title and goal.
- Do NOT run \`bd\` or create/modify beads yourself — the UI owns bead creation.
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
