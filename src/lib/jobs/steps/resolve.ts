/**
 * Resolution: turning a formula step's LABELS into the thing that will actually run — the handler a
 * `step:<name>` names, and the reasoning contract a `step:claude` names on top of it.
 *
 * The rule the whole module exists for: a label that maps to nothing PARKS the run, naming the step
 * id, the label, and the formula file. A silent skip would let a project formula quietly define a
 * run that never opens a PR, which is the failure this seam exists to make impossible.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { labelValueOf, type CookedStep } from "../../beads/bd";
import { loadAgentPrompt, stripFrontmatter } from "../../claude/agent-prompt";
import { loadSkill } from "../../claude/prompt";
import { PoisonEpic } from "../errors";
import type { StepContext } from "./context";
import type { StepDefinition } from "./result";

/** The registry a step is resolved against: `step:<name>` suffix → its definition. */
export type StepRegistry = Readonly<Record<string, StepDefinition>>;

/** The label prefix that names a step's handler: `step:<name>`. */
export const STEP_LABEL_PREFIX = "step";

/** The `step:<name>` suffix a cooked step names its handler with, if any. */
export function stepName(step: CookedStep): string | undefined {
  return labelValueOf(step.labels, STEP_LABEL_PREFIX);
}

/**
 * Why a `step:claude` that names neither a prompt nor a skill cannot run — one sentence, shared by
 * the run-start rejection ({@link resolveStepIn}) and the dispatch-time backstop
 * ({@link loadStepReasoning}), so an operator meets the same instruction wherever it surfaces.
 */
const NAMES_NO_REASONING =
  `is a \`${STEP_LABEL_PREFIX}:claude\` step but names no prompt — add a \`prompt:<id>\` label (a ` +
  `\`.claude/agents/<id>.md\`) or a \`skill:<id>\` label (a \`.claude/skills/<id>/SKILL.md\`) so anton ` +
  `knows what to dispatch`;

/** The label prefixes a `step:claude` names its instruction with. */
const REASONING_PREFIXES = ["prompt", "skill"] as const;

/**
 * The instruction labels a step carries. A valueless `prompt:` names nothing, so it doesn't count —
 * it falls through to the "names no prompt" rejection rather than reading as an ambiguity.
 */
function reasoningLabels(labels: string[] | undefined): string[] {
  return (labels ?? []).filter((l) =>
    REASONING_PREFIXES.some((p) => l.startsWith(`${p}:`) && l.length > p.length + 1),
  );
}

/**
 * A `step:claude` dispatches EXACTLY ONE instruction. {@link loadStepReasoning} reads `prompt:`
 * first and `skill:` only if there is none, and `labelValueOf` takes the first label of a prefix by
 * array order — so `prompt:security` next to `skill:release`, or two `prompt:` labels, would run one
 * and silently drop the other, with which one it is decided by label ordering. Reject the ambiguity
 * instead: the operator wrote two instructions and anton cannot know which they meant.
 *
 * `subject` names the step (and, at run start, the file), so the same rejection reads correctly from
 * both the validator and the dispatch-time backstop.
 */
function assertOneReasoningLabel(labels: string[] | undefined, subject: string): void {
  const named = reasoningLabels(labels);
  if (named.length === 0) throw new PoisonEpic(`${subject} ${NAMES_NO_REASONING}`);
  if (named.length === 1) return;
  throw new PoisonEpic(
    `${subject} carries ${named.length} instruction labels (${named.join(", ")}), but a ` +
      `\`${STEP_LABEL_PREFIX}:claude\` step dispatches exactly one — anton will not pick one by label ` +
      `order and silently drop the rest. Keep the one you meant, and give the other its own ` +
      `\`[[steps]]\` entry.`,
  );
}

/**
 * The reasoning contract a `step:claude` runs with, named by the formula step's own labels:
 * `prompt:<id>` resolves like an agent tag (project `.claude/agents` first, then the operator's
 * global copy, anton's bundled prompts, and installed plugins), `skill:<id>` reads the project's
 * `.claude/skills/<id>/SKILL.md` and falls back to anton's own vendored skill of that name.
 *
 * An unresolvable name PARKS: an agent dispatched with no instruction would burn a session and
 * report whatever it invented. The "names neither" and "names two" cases are already rejected at run
 * start by {@link resolveStepIn}; the assertion stays here as the backstop for a caller invoking the
 * handler directly.
 */
export async function loadStepReasoning(ctx: StepContext, stepId: string): Promise<string> {
  assertOneReasoningLabel(ctx.step?.labels, `formula step "${stepId}"`);
  const promptId = labelValueOf(ctx.step?.labels, "prompt");
  if (promptId) {
    const body = await loadAgentPrompt(promptId, { projectDir: ctx.worktreePath });
    if (body?.trim()) return body.trim();
    throw new PoisonEpic(
      `formula step "${stepId}" names \`prompt:${promptId}\`, which resolves to no prompt file — ` +
        `add \`.claude/agents/${promptId}.md\` to the project, or correct the label`,
    );
  }
  const skillId = labelValueOf(ctx.step?.labels, "skill");
  if (skillId) {
    const body = await loadProjectSkill(ctx.worktreePath, skillId);
    if (body) return body;
    throw new PoisonEpic(
      `formula step "${stepId}" names \`skill:${skillId}\`, which resolves to no skill — add ` +
        `\`.claude/skills/${skillId}/SKILL.md\` to the project, or correct the label`,
    );
  }
  throw new PoisonEpic(`formula step "${stepId}" ${NAMES_NO_REASONING}`);
}

/** The project's own skill, else anton's vendored one of the same name. Undefined when neither exists. */
async function loadProjectSkill(worktreePath: string, id: string): Promise<string | undefined> {
  const path = join(worktreePath, ".claude", "skills", id, "SKILL.md");
  const local = await readFile(path, "utf8").then(stripFrontmatter, () => undefined);
  if (local?.trim()) return local.trim();
  const bundled = await loadSkill(id).catch(() => undefined);
  return bundled?.trim() || undefined;
}

/**
 * The handler a cooked step resolves to, against the registry the caller supplies.
 *
 * FAIL LOUD on anything else: a step carrying no `step:` label, one carrying several, one naming a
 * handler that doesn't exist, or a `step:claude` naming no prompt, PARKS the run with the step id,
 * the label, and the formula file — never a silent skip, which would let a formula define a run that
 * quietly never opens a PR. Resolution runs at run START (anton-hrql), so all four park before a
 * worktree exists rather than partway through a run that has already committed work.
 */
export function resolveStepIn(
  registry: StepRegistry,
  step: CookedStep,
  formulaFile: string,
): StepDefinition {
  const subject = `formula step "${step.id}" in ${formulaFile}`;
  assertOneStepLabel(step, subject);
  const name = stepName(step);
  if (!name) {
    throw new PoisonEpic(
      `${subject} carries no \`${STEP_LABEL_PREFIX}:<name>\` label, so anton cannot tell what it ` +
        `should run — label it with one of: ${knownStepNames(registry)}`,
    );
  }
  const definition = registry[name];
  if (!definition) throw unknownStepError(registry, name, subject);
  // The extension point's instruction rides on the step's OWN labels, so whether it can execute is
  // knowable here — both that it names one, and that it names no more than one. Checking it at
  // dispatch alone (loadStepReasoning) would park a run that had already implemented and committed
  // — the exact halfway failure run-start validation exists to prevent.
  if (definition.name === "claude") assertOneReasoningLabel(step.labels, subject);
  return definition;
}

/**
 * A step runs exactly ONE handler. `labelValueOf` would take the first `step:` label by array order,
 * so `["step:implement", "step:verify"]` would implement and silently never verify — and the floor,
 * seeing a resolved implement, would pass it.
 */
function assertOneStepLabel(step: CookedStep, subject: string): void {
  const named = (step.labels ?? []).filter((l) => l.startsWith(`${STEP_LABEL_PREFIX}:`));
  if (named.length <= 1) return;
  throw new PoisonEpic(
    `${subject} carries ${named.length} \`${STEP_LABEL_PREFIX}:\` labels (${named.join(", ")}), but ` +
      `a step runs exactly one handler — anton will not pick one by label order and silently skip ` +
      `the rest. Split them into separate \`[[steps]]\`.`,
  );
}

/**
 * A `step:<name>` no handler answers to. `step:shell` gets its own answer because it is the one
 * absence that is deliberate rather than a typo — see the module header of the registry.
 */
function unknownStepError(registry: StepRegistry, name: string, subject: string): PoisonEpic {
  if (name === "shell") {
    return new PoisonEpic(
      `${subject} names \`${STEP_LABEL_PREFIX}:shell\`, which anton deliberately does not provide: ` +
        `"run a command, fail on non-zero" is what the project's verify gates already do ` +
        `(Settings → Verify gates, covered by \`${STEP_LABEL_PREFIX}:verify\`). Use a verify gate ` +
        `for a command, or \`${STEP_LABEL_PREFIX}:claude\` with a prompt of your own for anything ` +
        `else.`,
    );
  }
  return new PoisonEpic(
    `${subject} names \`${STEP_LABEL_PREFIX}:${name}\`, which maps to no anton handler — the run is ` +
      `parked rather than skipping it. Known steps: ${knownStepNames(registry)}. To add a step of ` +
      `your own, use \`${STEP_LABEL_PREFIX}:claude\` with a \`prompt:<id>\` or \`skill:<id>\` label.`,
  );
}

function knownStepNames(registry: StepRegistry): string {
  return Object.keys(registry)
    .map((n) => `${STEP_LABEL_PREFIX}:${n}`)
    .join(", ");
}
