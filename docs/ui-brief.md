# anton — UI design brief

The single source of visual coherence. Every UI agent follows this so the app reads as one
product. Target aesthetic: a calm, dense, dark-first **productivity tool** (think Linear /
Vercel dashboard) — confident, legible, quietly polished. Not flashy, not generic-shadcn-default.

## Foundations

- **Dark mode is first-class.** Everything must look intentional in BOTH themes. Use the
  shadcn CSS variables (`bg-background`, `text-foreground`, `border`, `muted`, `card`,
  `primary`, `accent`, `ring`) — never hard-coded hex that breaks a theme. Dark is the default
  we design for; light is the equal sibling. Wire `next-themes` (`attribute="class"`,
  `defaultTheme="system"`, `disableTransitionOnChange`) and a theme toggle in the shell.
- **Palette:** neutral zinc/stone base + ONE restrained accent (the shadcn `primary`). Color
  carries *meaning*, not decoration: risk `high` = destructive/red tint, `low` = muted;
  agent/domain badges = subtle neutral chips with a small colored dot. Stages get quiet color
  accents on the column header, not loud fills.
- **Type:** a clear scale — page title `text-lg font-semibold`, section `text-sm font-medium`,
  body `text-sm`, meta `text-xs text-muted-foreground`. Tight but breathable line-height.
  Numerals for counts. Truncate long titles with `title=` tooltips.
- **Spacing/density:** comfortable-dense. Generous outer padding, tight internal rhythm
  (`gap-2`/`gap-3`). Cards are compact but not cramped. Consistent `rounded-lg`/`rounded-xl`,
  hairline `border` (not heavy shadows). Subtle `hover:bg-muted/50` affordances.
- **Motion:** fast, subtle (`transition-colors`, 120–160ms). Drag has a slight lift/shadow +
  a clear drop indicator. No bouncy/gratuitous animation.
- **Accessibility:** visible `focus-visible` rings, labeled controls, keyboard paths for every
  interaction (including drag, via dnd-kit keyboard sensor), stable list keys, sufficient
  contrast in both themes.
- **States:** design the empty state, the loading state (skeletons, not spinners where a shape
  is known), and the error state for every data surface. They should feel considered.

## App shell

A persistent shell wraps every page:
- **Left sidebar** (collapsible on small screens): app mark "anton", primary nav —
  **Projects**, and when a project is selected: **Board**, **Tickets**. Theme toggle pinned at
  the bottom.
- **Topbar**: current project name + a lightweight breadcrumb/context; room for a future
  "Add work" action.
- Content area: a max-width container with consistent page padding.

## Surfaces

- **Board**: four stage columns (`backlog / implementing / in-review / done`) with a header
  showing the stage name + a count pill. Cards are **epics** (and orphan single-ticket cards).
  An epic card shows: title, a one-line Goal, a compact ticket summary (count + a few
  agent/risk dots), an Approve affordance when applicable, a PR chip when present. The whole
  card is a click target to the epic detail; drag moves it between columns.
- **Epic card badges**: small, meaningful — `agent:` (neutral chip), `risk:high` (red-tinted),
  `size:`. Keep it scannable, not a badge soup.
- **Tickets page**: a dense, filterable table/list of individual tickets with metadata columns
  (agent, risk, size, status, epic). Filters are quiet controls in a toolbar; the active set is
  reflected in the URL.
- **Epic detail**: full contract (Goal / Acceptance / description), the ticket list, and a
  dependency graph. The graph (React Flow) should feel native to the app — themed nodes, quiet
  edges, auto-laid-out (dagre), not a default-React-Flow look.

## Anti-goals

No default-shadcn-blandness, no rainbow badges, no heavy drop shadows, no layout that only
works in light mode, no spinners where a skeleton fits.
