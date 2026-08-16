/**
 * Theming shared by every ReactFlow surface in the app. It lives in one place because it is a
 * workaround for upstream behaviour: when `@xyflow/react` changes, this needs revisiting once,
 * not once per graph.
 */

/**
 * Theme the Controls through ReactFlow's own CSS variables. ReactFlow only applies its dark
 * palette under `.react-flow.dark` (a class we never set — the app toggles dark on an ancestor),
 * so its light defaults (white button, grey border) otherwise leak into dark mode. Driving the
 * vars here follows the app theme in both modes; the button glyph is an <svg fill="currentColor">,
 * so the button *color* var (not `fill`) is what makes the icon visible.
 */
export const REACT_FLOW_CONTROLS_THEME_CLASS = [
  "[--xy-controls-button-background-color:var(--color-card)]",
  "[--xy-controls-button-background-color-hover:var(--color-muted)]",
  "[--xy-controls-button-color:var(--color-foreground)]",
  "[--xy-controls-button-color-hover:var(--color-foreground)]",
  "[--xy-controls-button-border-color:var(--color-border)]",
].join(" ");
