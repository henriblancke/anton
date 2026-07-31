/**
 * The bead contract, in one place (anton-crj5).
 *
 * "Is this bead runnable" is judged at three sites — the approve route, execute-epic, and the
 * board — so the judgement lives here as one pure function rather than three copies that drift.
 * This module only REPORTS — it judges, names, and formats the gaps; the refusal itself belongs to
 * the caller (the approve route and execute-epic gate on {@link contractGaps}, anton-j9zs).
 *
 * Severity is the whole point of the split. Only Acceptance BLOCKS: it is the run's definition of
 * done and the rubric self-review scores the diff against, so without it the work is unrunnable.
 * Goal / Context / Out of scope / Verify degrade quality without making it unrunnable — they warn.
 *
 * Three facts this encodes (the first two measured against bd 1.1.0, 2026-07-28):
 *
 * 1. The contract lives in the DESCRIPTION markdown. `bd create --context` is sugar that appends a
 *    `## Context` section to it (`bd update` has no such flag — repairing Context means rewriting
 *    the description, see docs/runbooks/bead-contract-conformance.md); there is no `context` field
 *    in `--json`. `acceptance_criteria`
 *    (bd's own field, rendered "Success Criteria" for an epic) is the one genuinely separate home —
 *    and beads edited through the ticket dialog also keep it as `## Acceptance` in the description,
 *    so either home satisfies it.
 * 2. bd OMITS empty fields from `--json` rather than emitting `""` — a bead created with no
 *    description comes back with no `description` key at all. So an absent field cannot be read as
 *    "the section is there, we just didn't fetch it"; on a bead that came from a bd read it is a
 *    genuine gap. What must never be faulted is a bead that never came from one — see
 *    {@link isContractReadable}.
 * 3. A section holding the bead formula's `TODO —` prompt is UNWRITTEN, not present. The formula
 *    (anton-8mnr) ships prompts rather than content precisely so an author fills them; counting the
 *    prompt as content would let a bead cooked-and-never-authored approve and run against a
 *    placeholder rubric — see {@link PROMPT_LINE}.
 *
 * Contract text: skills/bd/SKILL.md. Kept dependency-free (a type-only import) so the API route,
 * the job runner, and the board can all import it.
 */
import type { Bead } from "./types";

export type ContractSeverity = "blocking" | "advisory";

/** The piece of the contract a violation points at. Which apply depends on the bead's tier. */
export type ContractSection =
  | "Acceptance"
  | "Goal"
  | "Context"
  | "Out of scope"
  | "Verify"
  | "Outcome"
  | "Success Criteria"
  | "area:";

export interface ContractViolation {
  section: ContractSection;
  severity: ContractSeverity;
  /** One line naming the gap and its fix — ready for a 422 body, a park note, or a board tooltip. */
  message: string;
}

/**
 * Which requirements a bead answers to. `epic` is read, not executed, so it carries less; `exempt`
 * covers every non-work type (`learning`, `molecule`, …) — plus a bead whose type the read didn't
 * carry, which cannot be classified and is therefore never faulted.
 *
 * `chore` is a TICKET, not an exemption: it is the working layer alongside `task`/`bug`
 * (skills/bd/SKILL.md), so `runTickets` classifies a chore under a feature as one of that run's
 * tickets and execute-epic dispatches it. Exempting it would hand an agent a chore with no
 * definition of done and self-review no rubric — the exact hole this contract exists to close.
 */
type ContractTier = "ticket" | "epic" | "exempt";

function tierOf(bead: Bead): ContractTier {
  switch (bead.issue_type) {
    case "task":
    case "bug":
    case "chore":
    case "feature":
      return "ticket";
    case "epic":
      return "epic";
    default:
      return "exempt";
  }
}

/**
 * Is this bead's type the working layer's own — one the ticket contract judges? The dispatch
 * predicate (`isRunTicket`, src/lib/ticket-view.ts) asks THIS, so the set of beads a run hands an
 * agent and the set the contract gates are one taxonomy that cannot drift: an exempt type
 * (`learning`, `molecule`, a custom type, or one the read didn't carry) that still dispatched would
 * run an agent against a spec no gate ever judged — the exact hole the run gate exists to close.
 */
export function isTicketTier(bead: Bead): boolean {
  return tierOf(bead) === "ticket";
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** An opening or closing code fence: up to 3 leading spaces, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Heading text → comparison key, case- and punctuation-insensitive: `## Out-of-Scope:` → `outofscope`.
 * Inline HTML comments are stripped first: `## Acceptance <!-- markdownlint-disable-line -->` still
 * renders an Acceptance heading, and slugging the raw annotation missed the section — the hard gate
 * rejected otherwise shaped work. An unclosed comment runs to the end of the line, as it renders. */
const slug = (heading: string) =>
  heading
    .replace(/<!--.*?(?:-->|$)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** The HTML-comment state after `text`, given the state it began in — `<!--`/`-->` toggled in order. */
function commentStateAfter(text: string, inComment: boolean): boolean {
  let rest = text;
  let state = inComment;
  for (;;) {
    const at = rest.indexOf(state ? "-->" : "<!--");
    if (at === -1) return state;
    rest = rest.slice(at + (state ? 3 : 4));
    state = !state;
  }
}

/**
 * The description's lines, each flagged with whether it sits inside a fenced code block or begins
 * inside a multiline HTML comment.
 *
 * Both matter because the contract is judged on HEADINGS: a bead whose description quotes the
 * formula (or any markdown sample) in a ``` block carries the literal line `## Acceptance` with
 * example boxes under it, and a scanner blind to fences reads that sample as the real section —
 * passing the blocking gate on a ticket that states no definition of done at all. A `## Acceptance`
 * hidden inside a `<!-- … -->` comment is the same hole from the other side: the render shows no
 * heading and no criteria, so a scanner that recognized it would open a section over text the
 * cleanup pass ({@link renderedLines}) never sees the opening delimiter of — classifying invisible
 * text as the written spec. Comment state is tracked only OUTSIDE fences, matching the cleanup's
 * own rule that comments inside fenced code are literal content.
 *
 * CommonMark rules, kept to what a description can hit: a closing fence matches the opening
 * character, is at least as long, and carries nothing but whitespace after it; a backtick fence's
 * info string may not contain a backtick; an unclosed fence (or comment) runs to the end of the
 * text (so the contract fails closed — the same way the description renders).
 *
 * The delimiter lines themselves are flagged: they are punctuation, not content, so a judge of
 * "does this section say anything" ({@link stateOf}) must skip them — an empty ``` block otherwise
 * reads as two lines of authored text.
 */
function scanLines(
  description: string,
): { text: string; fenced: boolean; delimiter?: boolean; commented?: boolean }[] {
  const out: { text: string; fenced: boolean; delimiter?: boolean; commented?: boolean }[] = [];
  let open: { char: string; len: number } | undefined;
  let inComment = false;
  for (const text of description.split(/\r?\n/)) {
    // A line that BEGINS inside a comment can neither open a section nor a fence — the render hides
    // it. Text after a `-->` on the same line is kept out of the heading judgement on purpose: a
    // heading must start the line, and the closing delimiter already occupies that position.
    if (inComment) {
      inComment = commentStateAfter(text, true);
      out.push({ text, fenced: false, commented: true });
      continue;
    }
    const fence = FENCE.exec(text);
    if (fence) {
      const [char, len] = [fence[1][0], fence[1].length];
      if (!open) {
        if (char !== "`" || !fence[2].includes("`")) {
          open = { char, len };
          out.push({ text, fenced: true, delimiter: true });
          continue;
        }
      } else if (char === open.char && len >= open.len && fence[2].trim() === "") {
        out.push({ text, fenced: true, delimiter: true });
        open = undefined;
        continue;
      }
    }
    if (!open) inComment = commentStateAfter(text, false);
    out.push({ text, fenced: !!open });
  }
  return out;
}

/**
 * Section bodies of a description, keyed by slugged heading. A repeated heading concatenates.
 *
 * A section runs until a heading that starts ANOTHER section: one of `keys` at any depth, or any
 * heading at the current section's level or shallower. A DEEPER heading that names no contract
 * section is the section's own content — criteria grouped under `## Acceptance` by `### API` /
 * `### UI` are still that bead's definition of done, and ending the section there read a fully
 * authored ticket as having none, which blocks approval and execution outright.
 *
 * `keys` is the TIER's heading set ({@link contractKeysOf}), not every tier's merged: `success`
 * satisfies only an epic, so on a ticket a `### Success` grouping criteria inside `## Acceptance`
 * is that section's own content — the merged set ended Acceptance there and rejected the authored
 * ticket outright.
 *
 * Depth alone can't decide it: descriptions that open with a `# Title` put every `## Goal` below it,
 * and folding those in would lose the contract entirely. A contract heading always opens its section.
 */
function sectionsOf(description: string, keys: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | undefined;
  let level = 0;
  let body: string[] = [];
  const flush = () => {
    if (!key) return;
    const text = [out.get(key), body.join("\n").trim()].filter(Boolean).join("\n");
    out.set(key, text);
  };
  for (const { text, fenced, commented } of scanLines(description)) {
    const heading = fenced || commented ? null : HEADING.exec(text);
    if (heading) {
      const depth = heading[1].length;
      const slugged = slug(heading[2]);
      if (!key || depth <= level || keys.has(slugged)) {
        flush();
        key = slugged;
        level = depth;
        body = [];
        continue;
      }
    }
    if (key) body.push(text);
  }
  flush();
  return out;
}

/** The description text ahead of the first heading — an epic whose outcome is written as a bare
 * line rather than under `## Goal` still states one, and must not be faulted for it. */
function preambleOf(description: string): string {
  const lines: string[] = [];
  for (const { text, fenced, commented } of scanLines(description)) {
    if (!fenced && !commented && HEADING.test(text)) break;
    lines.push(text);
  }
  return lines.join("\n").trim();
}

/**
 * Every variable default in `anton-bead.formula.json` is a PROMPT, not content — "- [ ] TODO — a
 * concrete, checkable statement of done". A bead cooked from the formula and never authored
 * therefore carries all five headings and none of the spec, and reading it as conformant would let
 * a run start against a placeholder rubric: exactly the false green the gate exists to prevent.
 *
 * Matched after the list scaffolding (`- `, `* `, `- [ ] `) so the checkbox form reads the same as
 * the bare one, and anchored on the separator that follows `TODO` so an authored line merely
 * mentioning one ("- [ ] the TODO banner clears") is not mistaken for a prompt.
 */
const PROMPT_LINE = /^(?:[-*+]\s+)?(?:\[[ xX]?\][ \t]*)?TODO\s*[—–:-]/;

/** A list or task-list marker with nothing after it — `-`, `1.`, `- [ ]`. Scaffolding, not spec:
 * a section holding only such markers states no definition of done ({@link stateOf}). */
const EMPTY_LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]?\])?[ \t]*$/;

/** A thematic break — 3+ `-`/`*`/`_` of one kind, spaces between allowed (CommonMark). It renders
 * as a rule, not text, so a section holding only `---` says nothing ({@link stateOf}). */
const THEMATIC_BREAK = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** One blockquote marker — up to 3 leading spaces, `>`, then an optional space (CommonMark). */
const BLOCKQUOTE = /^ {0,3}>[ \t]?/;

/**
 * `text` with every blockquote marker stripped, nesting included — the content the callout wraps.
 *
 * The marker is punctuation: `> TODO — fill this in` renders the prompt inside a callout, and it is
 * exactly as unwritten as the bare line. A judge blind to the prefix saw no {@link PROMPT_LINE}
 * match and read the section as authored, so a project-local formula that styles its placeholders
 * as callouts passed the blocking gate with no definition of done at all.
 */
function unquote(text: string): string {
  let out = text;
  while (BLOCKQUOTE.test(out)) out = out.replace(BLOCKQUOTE, "");
  return out;
}

/** What a section holds. `prompt` is a gap like `absent` — they differ only in the message. */
type SectionState = "written" | "prompt" | "absent";

/**
 * A body's lines as the rendered description shows them: fence delimiters dropped, HTML comments
 * (`<!-- … -->`, single- or multi-line) stripped. Both are invisible in the render, so a judge of
 * "does this section say anything" must not count them — a template placeholder like
 * `## Acceptance\n<!-- add criteria here -->` is as empty as the heading alone. Comments inside
 * fenced code are literal content and are kept; an unclosed comment runs to the end of the body, so
 * the judgement fails closed — the same way the description renders.
 *
 * Each line keeps its `fenced` flag: fenced content is LITERAL, so the scaffolding filters
 * {@link stateOf} applies (headings, empty list markers, the TODO prompt) hold only outside fences —
 * a rubric written as a fenced Markdown example whose content is heading-shaped is still authored
 * text, and filtering it read the section as absent.
 */
function renderedLines(raw: string): { text: string; fenced: boolean }[] {
  const out: { text: string; fenced: boolean }[] = [];
  let inComment = false;
  for (const line of scanLines(raw)) {
    if (line.delimiter) continue;
    if (line.fenced) {
      if (!inComment) out.push({ text: line.text, fenced: true });
      continue;
    }
    let rest = line.text;
    let kept = "";
    while (rest !== "") {
      if (inComment) {
        const close = rest.indexOf("-->");
        if (close === -1) break;
        inComment = false;
        rest = rest.slice(close + 3);
      } else {
        const open = rest.indexOf("<!--");
        if (open === -1) {
          kept += rest;
          break;
        }
        kept += rest.slice(0, open);
        inComment = true;
        rest = rest.slice(open + 4);
      }
    }
    out.push({ text: kept, fenced: false });
  }
  return out;
}

/**
 * The text a raw markdown body RENDERS, as one string: {@link renderedLines} joined — fence
 * delimiters dropped, HTML comments stripped, fenced content kept literally. For judges of raw
 * markdown that are not section-shaped, e.g. the formula's consumption check (formula.ts): a
 * `{{var}}` referenced only inside a comment interpolates into markup the render never shows, so
 * scanning the raw template counted it as consumed while the founder's value landed invisibly.
 */
export function renderedText(raw: string): string {
  return renderedLines(raw)
    .map((l) => l.text)
    .join("\n");
}

/**
 * The state of a section given every place its text can live. `written` wins over `prompt` (an
 * author who filled the description section has written it, whatever bd's field still holds), and a
 * body counts as a prompt only when EVERY line of it is one — a section where boxes were filled and
 * one TODO left beside them is authored, and calling it unwritten would ask for what is already there.
 *
 * Subheadings a section carries (see {@link sectionsOf}) are scaffolding, not spec: `### API` over
 * nothing but TODO boxes is as unwritten as the boxes alone. So are empty list markers
 * ({@link EMPTY_LIST_ITEM}), thematic breaks ({@link THEMATIC_BREAK}) and anything the render
 * hides — fence delimiters and HTML comments
 * ({@link renderedLines}): a section holding only `- [ ]`, an empty ``` block, or a
 * `<!-- template placeholder -->` says nothing, and counting any as text read it as authored —
 * approval and execution proceeded with no definition of done. Fenced CONTENT still counts, and
 * counts as LITERAL: heading-shaped or TODO-shaped lines inside a fence are a quoted example the
 * author wrote, so the scaffolding and prompt tests apply only outside fences — filtering a fenced
 * `# Expected title` rubric read an authored section as absent.
 *
 * Outside a fence the blockquote marker comes off first ({@link unquote}): it styles its content,
 * it is not content, so `> TODO — fill this in` must be judged as the prompt it renders. Leaving it
 * on defeated {@link PROMPT_LINE} and passed the blocking gate on a section stating no rubric.
 */
function stateOf(bodies: string[]): SectionState {
  let state: SectionState = "absent";
  for (const raw of bodies) {
    const lines = renderedLines(raw)
      .map((l) => ({ text: (l.fenced ? l.text : unquote(l.text)).trim(), fenced: l.fenced }))
      .filter(
        (l) =>
          l.text &&
          (l.fenced ||
            (!HEADING.test(l.text) && !EMPTY_LIST_ITEM.test(l.text) && !THEMATIC_BREAK.test(l.text))),
      );
    if (lines.length === 0) continue;
    if (!lines.every((l) => !l.fenced && PROMPT_LINE.test(l.text))) return "written";
    state = "prompt";
  }
  return state;
}

interface SectionRule {
  section: ContractSection;
  severity: ContractSeverity;
  /** Slugged headings that satisfy the rule. */
  keys: string[];
  message: string;
  /** The same gap when the heading IS there — the operator must not be told to add what they see. */
  promptMessage: string;
}

export const GOAL_KEYS = ["goal"];

/** The four advisory sections every task/bug/chore/feature carries, in the order they read best. */
const TICKET_RULES: SectionRule[] = [
  {
    section: "Goal",
    severity: "advisory",
    keys: GOAL_KEYS,
    message: "no `## Goal` section — nothing states what the work is for",
    promptMessage: "`## Goal` is still the formula's TODO prompt — nothing states what the work is for",
  },
  {
    section: "Context",
    severity: "advisory",
    keys: ["context"],
    message:
      "no `## Context` section — the agent has to rediscover which files and patterns apply (rewrite the description: `bd update <id> --body-file -`)",
    promptMessage:
      "`## Context` is still the formula's TODO prompt — the agent has to rediscover which files and patterns apply",
  },
  {
    section: "Out of scope",
    severity: "advisory",
    keys: ["outofscope"],
    message: "no `## Out of scope` section — nothing bounds the change",
    promptMessage: "`## Out of scope` is still the formula's TODO prompt — nothing bounds the change",
  },
  {
    section: "Verify",
    severity: "advisory",
    keys: ["verify", "verification"],
    message: "no `## Verify` section — no stated way to prove the work landed",
    promptMessage:
      "`## Verify` is still the formula's TODO prompt — no stated way to prove the work landed",
  },
];

export const ACCEPTANCE_KEYS = ["acceptance", "acceptancecriteria"];
export const SUCCESS_KEYS = ["successcriteria", "success", ...ACCEPTANCE_KEYS];

/** The headings that hold an epic's outcome: what the formula pours (`## Goal`), plus the name the
 * violation itself uses. Text before any heading counts too — see {@link preambleOf}. */
export const OUTCOME_KEYS = ["goal", "outcome"];

/** Every heading a TICKET's contract reads — the set {@link sectionsOf} lets open a section however
 * deeply it is nested, for that tier. Derived from the rules so a new section can't be added to one
 * alone. */
const TICKET_KEYS: ReadonlySet<string> = new Set([
  ...TICKET_RULES.flatMap((r) => r.keys),
  ...ACCEPTANCE_KEYS,
]);

/** The same, for an EPIC: its outcome aliases plus every spelling of its rubric. */
const EPIC_KEYS: ReadonlySet<string> = new Set([...OUTCOME_KEYS, ...SUCCESS_KEYS]);

/** Every tier's headings merged — only for a reader handed bare text ({@link sectionBody}), which
 * has no tier to narrow by. Tier-aware judging and reading must pass {@link contractKeysOf}: only
 * headings applicable to the bead's tier may terminate a deeper section (see {@link sectionsOf}). */
const CONTRACT_KEYS: ReadonlySet<string> = new Set([...TICKET_KEYS, ...EPIC_KEYS]);

/** The heading set {@link sectionsOf} sections a bead of this tier by. Exempt reads as ticket — the
 * same non-epic default {@link acceptanceKeysOf} and {@link goalKeysOf} apply. */
const contractKeysOf = (tier: ContractTier): ReadonlySet<string> =>
  tier === "epic" ? EPIC_KEYS : TICKET_KEYS;

/**
 * Which headings carry this bead's definition of done, by tier — the reader's half of the choice
 * {@link validateBeadContract} makes below. A view that assumed `## Acceptance` for every tier
 * rendered nothing for the epic whose rubric is `## Success Criteria`, the very section approval
 * had just accepted it on.
 */
export function acceptanceKeysOf(bead: Bead): string[] {
  return tierOf(bead) === "epic" ? SUCCESS_KEYS : ACCEPTANCE_KEYS;
}

/**
 * Which headings carry this bead's purpose, by tier — the same split {@link validateBeadContract}
 * judges on: a ticket states a `## Goal`, an epic may state either that or `## Outcome`.
 *
 * The alias is why this is tier-aware rather than one flat list: an epic authored as `## Outcome`
 * satisfies the gate, so a viewer reading `## Goal` alone showed a conformant-but-goal-less card,
 * while a TICKET spelled `## Outcome` must keep rendering blank beside the gap the gate reports.
 */
export function goalKeysOf(bead: Bead): string[] {
  return tierOf(bead) === "epic" ? OUTCOME_KEYS : GOAL_KEYS;
}

/**
 * The body of the first section whose heading matches one of `keys`, or undefined when none carries
 * text — the reader half of this module, for surfaces that RENDER a contract section rather than
 * judge it (board cards, detail views).
 *
 * It exists so those surfaces parse headings the way {@link validateBeadContract} does. A second
 * parser drifts silently and in the worst direction: one that only accepted `##` left a `# Goal`
 * bead judged conformant here and rendered blank everywhere, so the gate said "fine" and the board
 * showed nothing.
 *
 * One caveat: handed bare text, this has no tier to narrow by, so it sections by
 * {@link CONTRACT_KEYS} — every tier's headings merged — while the gate uses the tier's own set.
 * They diverge exactly on a tier-specific alias nested inside a section: a ticket grouping criteria
 * under `### Success` inside `## Acceptance` reads as authored to the gate (and to
 * {@link acceptanceBody}) but ends the section here. Callers holding a Bead must prefer
 * {@link acceptanceBody} / {@link goalBody}, which judge and render with the same tier keys.
 */
export function sectionBody(description: string | undefined, keys: string[]): string | undefined {
  if (!description) return undefined;
  const sections = sectionsOf(description, CONTRACT_KEYS);
  for (const key of keys) {
    const text = sections.get(key);
    if (text) return text;
  }
  return undefined;
}

/**
 * Every home the tier's acceptance text can occupy: bd's own field (under either name a read
 * populates it with) and the description section, judged together so a bead satisfies the rule
 * from whichever one its author used.
 */
const acceptanceBodies = (bead: Bead, sections: Map<string, string>, keys: string[]): string[] => [
  typeof bead.acceptance_criteria === "string" ? bead.acceptance_criteria : "",
  typeof bead.acceptance === "string" ? bead.acceptance : "",
  ...keys.map((k) => sections.get(k) ?? ""),
];

/**
 * The acceptance text a view RENDERS, across every home it can occupy — the reader half of the
 * choice {@link validateBeadContract} makes when it judges the same bead.
 *
 * A WRITTEN body wins over one still holding the formula's TODO prompt, whichever home each sits
 * in. That is the whole point: the repair the blocking gap prescribes (`bd update --acceptance`)
 * writes bd's field and leaves the cooked `## Success Criteria` prompt in the description, so a
 * description-first read showed the operator the TODO they had just answered — approval succeeded
 * while every card and detail view still displayed the placeholder.
 *
 * Among written bodies the DESCRIPTION section still wins, because that is the home the ticket
 * dialog edits; falling back to bd's field first would render a stale value the author had already
 * replaced. When nothing anywhere is written the prompt itself is returned — the bead genuinely has
 * no rubric yet, and the blocking marker beside it says so.
 */
export function acceptanceBody(bead: Bead): string | undefined {
  const description = typeof bead.description === "string" ? bead.description : "";
  const sections = sectionsOf(description, contractKeysOf(tierOf(bead)));
  const bodies = [
    ...acceptanceKeysOf(bead).map((k) => sections.get(k)),
    bead.acceptance_criteria,
    bead.acceptance,
  ].filter((b): b is string => typeof b === "string" && b.trim() !== "");
  return bodies.find((b) => stateOf([b]) === "written") ?? bodies[0];
}

/**
 * The goal/outcome text a view RENDERS, read on every home {@link validateBeadContract} judges —
 * the reader half of {@link goalKeysOf}, mirroring {@link acceptanceBody} for the other section.
 *
 * For an epic that includes the description PREAMBLE: the validator accepts an outcome written as
 * bare text ahead of the first heading ({@link preambleOf}), and a reader blind to that home
 * cleared the contract warning while rendering no outcome at all. A WRITTEN body also wins over
 * one still holding the formula's TODO prompt, whichever home each sits in — an epic whose cooked
 * `## Goal` prompt remains beside an authored `## Outcome` is conformant, and a first-key read
 * showed the stale TODO over the outcome the gate had just accepted. When nothing anywhere is
 * written the first body is returned — the bead genuinely has no goal yet, and the advisory
 * marker beside it says so.
 */
export function goalBody(bead: Bead): string | undefined {
  const description = typeof bead.description === "string" ? bead.description : "";
  const sections = sectionsOf(description, contractKeysOf(tierOf(bead)));
  const bodies = [
    ...goalKeysOf(bead).map((k) => sections.get(k)),
    ...(tierOf(bead) === "epic" ? [preambleOf(description)] : []),
  ].filter((b): b is string => typeof b === "string" && b.trim() !== "");
  return bodies.find((b) => stateOf([b]) === "written") ?? bodies[0];
}

/**
 * Did this bead come from a bd read — one that WOULD have carried the contract fields had the bead
 * had them? `bd list` / `show` / `ready` / `dep list` all return the full issue record: bd's own
 * created/updated stamps, and description/acceptance whenever they are non-empty. A bead assembled
 * anywhere else (a graph node, a fixture, a projection of id + title + type) carries none of those,
 * and faulting it would report sections that were simply never read.
 *
 * Callers that must tell "conformant" from "not judged" — the board — check this first;
 * {@link validateBeadContract} reports nothing when it is false.
 */
export function isContractReadable(bead: Bead): boolean {
  return (
    typeof bead.description === "string" ||
    typeof bead.acceptance_criteria === "string" ||
    typeof bead.acceptance === "string" ||
    typeof bead.created_at === "string" ||
    typeof bead.updated_at === "string"
  );
}

/**
 * Does the contract apply to this bead at all? False for an exempt tier and for a bead no bd read
 * produced. An empty {@link validateBeadContract} means two different things — "conformant" and
 * "never judged" — so anything reporting a conformance RATE must divide by this, not by the board.
 */
export function isContractJudged(bead: Bead): boolean {
  return tierOf(bead) !== "exempt" && isContractReadable(bead);
}

/**
 * A bead's contract gaps split by what they cost, for the surfaces that render the two differently
 * (the board marks a blocking gap as an error the Approve affordance refuses, an advisory one as a
 * nudge). `undefined` from {@link contractStatusOf} is neither — it means "never judged".
 */
export interface ContractStatus {
  /** Gaps that make the bead unrunnable — approval refuses it. */
  blocking: ContractViolation[];
  /** Gaps that degrade the run without stopping it. */
  advisory: ContractViolation[];
}

/**
 * Does the contract withhold this target's run? The one predicate every surface asks — the board
 * before it advertises Approve, and the gate behind it. An absent status means the bead was never
 * judged (no bd read behind it), which is not a violation.
 */
export function contractBlocks(contract: ContractStatus | undefined): boolean {
  return (contract?.blocking.length ?? 0) > 0;
}

/**
 * {@link validateBeadContract} split by severity, for a view model. Undefined when the bead is
 * exempt or came from no bd read — "not judged", which a caller must not render as conformant.
 */
export function contractStatusOf(bead: Bead): ContractStatus | undefined {
  if (!isContractJudged(bead)) return undefined;
  const violations = validateBeadContract(bead);
  return {
    blocking: violations.filter((v) => v.severity === "blocking"),
    advisory: violations.filter((v) => v.severity === "advisory"),
  };
}

/** One bead's gaps at a single severity — the unit both gates name an offender with. */
export interface ContractGap {
  id: string;
  violations: ContractViolation[];
}

/**
 * Every bead here that falls short at `severity`, in the order given. The two gates' shared input
 * (anton-j9zs): each asks for `blocking` to refuse the run, then for `advisory` to report and
 * proceed. A bead no bd read produced is never faulted (see {@link isContractReadable}), so a
 * projection that never carried the contract fields can't strand a run.
 */
export function contractGaps(beads: Bead[], severity: ContractSeverity): ContractGap[] {
  const gaps: ContractGap[] = [];
  for (const bead of beads) {
    const violations = validateBeadContract(bead).filter((v) => v.severity === severity);
    if (violations.length > 0) gaps.push({ id: bead.id, violations });
  }
  return gaps;
}

/**
 * Gaps as one line naming every offending bead and what it is missing — the body of a 422 or of a
 * park note. Each violation message already opens with its section ("no Acceptance criteria — …")
 * and carries the bd command that fixes it, so the operator reads the gap and the remedy together.
 */
export function formatContractGaps(gaps: ContractGap[]): string {
  return gaps.map((g) => `${g.id} → ${g.violations.map((v) => v.message).join(", ")}`).join("; ");
}

/**
 * Every way this bead falls short of the contract for its tier — empty when it is complete, exempt,
 * or not readable. Pure: no bd calls, no IO.
 */
export function validateBeadContract(bead: Bead): ContractViolation[] {
  const tier = tierOf(bead);
  if (tier === "exempt" || !isContractReadable(bead)) return [];

  const description = typeof bead.description === "string" ? bead.description : "";
  const sections = sectionsOf(description, contractKeysOf(tier));
  // A heading whose body is empty — or still the formula's TODO prompt — carries no spec, so it is
  // as absent as no heading at all.
  const sectionState = (keys: string[]) => stateOf(keys.map((k) => sections.get(k) ?? ""));
  const violations: ContractViolation[] = [];

  // An epic is read, not executed: a one-line outcome, the Success Criteria its features add up to,
  // and the one `area:` label the roadmap groups by (skills/bd/SKILL.md).
  if (tier === "epic") {
    // The outcome is judged like every other section, not by "is there any description text":
    // an epic cooked from the formula carries `## Goal` holding the prompt and `## Success Criteria`
    // holding real boxes, and a non-empty description read as an authored outcome let exactly that
    // bead report fully conformant.
    const outcome = stateOf([preambleOf(description), ...OUTCOME_KEYS.map((k) => sections.get(k) ?? "")]);
    if (outcome !== "written") {
      violations.push({
        section: "Outcome",
        severity: "advisory",
        message:
          outcome === "prompt"
            ? "the outcome is still the formula's TODO prompt — nothing states the result these features add up to"
            : "no outcome — an epic's description is the result its features add up to",
      });
    }
    const success = stateOf(acceptanceBodies(bead, sections, SUCCESS_KEYS));
    if (success !== "written") {
      violations.push({
        section: "Success Criteria",
        severity: "blocking",
        message:
          success === "prompt"
            ? "Success Criteria is still the formula's TODO prompt — nothing states when the outcome is reached (`bd update --acceptance`)"
            : "no Success Criteria — nothing states when the outcome is reached (`bd update --acceptance`)",
      });
    }
    violations.push(...areaViolations(bead));
    return violations;
  }

  const acceptance = stateOf(acceptanceBodies(bead, sections, ACCEPTANCE_KEYS));
  if (acceptance !== "written") {
    violations.push({
      section: "Acceptance",
      severity: "blocking",
      message:
        acceptance === "prompt"
          ? "Acceptance criteria is still the formula's TODO prompt — the run has no definition of done and self-review has no rubric (`bd update --acceptance`)"
          : "no Acceptance criteria — the run has no definition of done and self-review has no rubric (`bd update --acceptance`)",
    });
  }
  for (const rule of TICKET_RULES) {
    const state = sectionState(rule.keys);
    if (state === "written") continue;
    violations.push({
      section: rule.section,
      severity: rule.severity,
      message: state === "prompt" ? rule.promptMessage : rule.message,
    });
  }
  return violations;
}

/** Exactly one `area:` label, with a nonempty value — the roadmap's Area column and Linear project
 * routing key on it. Uniqueness counts EVERY `area:` label, valueless ones included: `labelValueOf`
 * returns whichever matches first (bd.ts), so a bare `area:` beside `area:reports` can still hand
 * the roadmap an empty surface depending on label order — discarding it here read that epic as
 * conformant while the board grouped it under nothing. */
function areaViolations(bead: Bead): ContractViolation[] {
  const areas = (bead.labels ?? []).filter((l) => l.startsWith("area:"));
  if (areas.length === 1 && areas[0].slice("area:".length).trim() !== "") return [];
  return [
    {
      section: "area:",
      severity: "advisory",
      message:
        areas.length === 0
          ? "no `area:` label — the roadmap has no product surface to group this outcome under (`bd tag <id> area:<surface>`)"
          : areas.length > 1
            ? `carries ${areas.length} \`area:\` labels (${areas.join(", ")}) — an epic carries exactly one`
            : "a bare `area:` label names no product surface — give it a value (`bd tag <id> area:<surface>`)",
    },
  ];
}
