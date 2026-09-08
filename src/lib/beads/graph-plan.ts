/**
 * The `bd create --graph` plan (anton-lsad): the node schema anton writes and the reader for the
 * refusal bd prints when a plan is rejected. `beads.createGraph` in ./bd is the spawn.
 */
/**
 * One node of a `bd create --graph` plan, in bd 1.1.2's schema (skills/bd/SKILL.md). Deliberately
 * narrower than bd's — anton only ever plans a tree of typed, contract-carrying beads — because bd
 * DROPS an unknown field with a warning rather than failing, so a typo'd key would land a bead
 * silently missing what the caller meant to set. There is no acceptance field and none is needed:
 * the rubric rides the description, the home `bd lint` and contract.ts's `acceptanceBody` both read.
 */
export interface GraphPlanNode {
  /** Plan-local handle — how `parent_key` refers to this node, and the key its id comes back under. */
  key: string;
  title: string;
  type: "epic" | "feature" | "task" | "bug" | "chore";
  /** The whole contract markdown, exactly as `create`'s `description` takes it. */
  description?: string;
  labels?: string[];
  /** Parent within this same plan — the form that makes a tree atomic (no `bd link` step). */
  parent_key?: string;
  /** Parent already on the board, for a plan that grafts onto an existing tree. */
  parent_id?: string;
}

/** A whole tree, written in one bd call — see {@link beads.createGraph}. */
export interface GraphPlan {
  nodes: GraphPlanNode[];
}

/**
 * The reason a graph plan was refused. bd prints a plan failure as `{"error": …}` on STDOUT while
 * exiting non-zero (measured on 1.1.2 — stderr carries only the unknown-field warnings), so the
 * generic "Command failed" message {@link bd} builds from stderr would name no cause at all.
 */
export function graphPlanError(err: unknown): string | undefined {
  const stdout = (err as { stdout?: unknown }).stdout;
  if (typeof stdout !== "string") return undefined;
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
