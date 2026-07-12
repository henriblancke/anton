# Feature-walkthrough screenshot capture guide

The README feature walkthrough (ticket `anton-gue.3`) needs **four screenshots of the real
running app**, populated with realistic data. These are a **manual, human-in-the-browser step**:
two of the four shots are live streaming terminal surfaces that only exist while a real `claude`
process is running, so they can't be produced by a headless agent. Capture them once, drop the
PNGs in this directory using the filenames below, then wire them into `README.md`.

## Before you start

1. Stand up a real instance with realistic data:
   - `bun install && anton setup && anton start` (see the README "Install & run" section).
   - Add a project pointing at a repo whose `.beads/` has **at least one epic in each stage**
     (`backlog`, `implementing`, `in-review`, `done`). The board derives stage live from beads
     (`src/lib/board.ts`), so populate real beads — don't fake the UI.
   - The in-review epic needs an `external_ref` (PR) **and** a reachable GitHub remote so the PR
     chip resolves to a real URL.
2. **Pick one theme and keep it across all four shots** (dark is the app's first-class default —
   see `docs/ui-brief.md`). Don't mix light and dark.
3. Keep images reasonably sized: target a ~1440px-wide viewport, export as PNG, and run each
   through a compressor (e.g. `pngquant`/`oxipng`) so none is multi-MB.

## The four shots

| File | Surface | URL | What must be visible |
|------|---------|-----|----------------------|
| `board.png` | Epics board | `/projects/<slug>/epics` | All four stage columns (`backlog → implementing → in-review → done`) with count pills and at least one epic card per column. |
| `shape.png` | Interactive `/shape` session | `/projects/<slug>/shape` | The live xterm terminal mid-conversation — `claude` shaping an epic (Goal/Acceptance/tickets visible in the stream). |
| `run.png` | Live run / terminal | `/projects/<slug>/runs` (an active run) | The streaming session terminal for a ticket run — claude implementing, or the run detail with live output. |
| `review.png` | In-review epic w/ PR | `/projects/<slug>/epics/<epic-id>` | An epic in **in-review** showing the clickable PR link and, ideally, review-fix activity. |

## After capturing

Wire them into the README feature walkthrough, each with 1–3 sentences explaining the capability
and where it sits in the loop, using **relative paths** and confirming every one resolves in a
markdown preview, e.g.:

```markdown
![The epics board](docs/images/board.png)
```
