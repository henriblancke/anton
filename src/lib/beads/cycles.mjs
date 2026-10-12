/** Parse `bd dep cycles --json` while retaining raw records when bd evolves its output shape. */
export function parseDepCycles(raw) {
  let parsed;
  try {
    parsed = JSON.parse((raw ?? "").trim() || "null");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const idsOf = (node) => {
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.flatMap(idsOf);
    if (!node || typeof node !== "object") return [];
    const named =
      node.cycle ?? node.path ?? node.ids ?? node.issue_ids ?? node.issues ?? node.nodes ?? node.members;
    if (named !== undefined) return idsOf(named);
    const id = typeof node.id === "string" ? node.id : typeof node.issue_id === "string" ? node.issue_id : undefined;
    return id ? [id] : [];
  };
  return parsed.map((raw) => ({ ids: idsOf(raw), raw }));
}
