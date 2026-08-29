/**
 * The one text normaliser the pm protocol shares. Both halves need it for the same reason — a
 * newline inside a rendered fact or a parsed claim breaks the line-per-fact shape each side reads —
 * so it lives apart rather than making the parser depend on the renderer to borrow it.
 */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
