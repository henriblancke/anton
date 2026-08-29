/**
 * The nightly pass's deciding half: hand the scan to claude with the /scan-triage skill and read
 * back what it did with the signals. Extracted from the job handler (anton-xdgw) so the prompt —
 * the contract between anton's resolved context and the skill's rules — can be asserted without
 * driving a scan.
 */
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { loadSkill } from "../claude/prompt";
import { resolveScanSeverity, type ProjectSettings } from "../projects";
import { parseTriageOutcome, type TriageOutcome } from "../scan-health";
import {
  ANTON_CLASS_KEY,
  ANTON_SEVERITY_KEY,
  formatScanSeverityPolicy,
} from "../scan-severity";
import type { Project } from "../types";
import { readBoardContext } from "./nightly-stringer-board";

/**
 * The /scan-triage prompt for one scan. Three things ride along resolved rather than left to the
 * agent: each signal's severity (stamped onto the scan file itself by lib/stringer, so the bead's
 * label and this pass's health point read the same signal the same way), the project's severity
 * mapping (anton-bz1w — the skill documents the default, only the project says how to label), and
 * the board itself (anton-ol1l — the structure a signal routes into and the fingerprints every
 * producer already filed, so an unattended scan can't miss a read and duplicate work).
 */
export async function buildTriagePrompt(opts: {
  scanFile: string;
  settings: ProjectSettings;
  boardSection: string;
}): Promise<string> {
  const triagePrompt = await loadSkill("scan-triage");
  return [
    triagePrompt,
    ``,
    `---`,
    ``,
    `The stringer scan file to triage is: ${opts.scanFile}`,
    `Create the beads in this repository's beads tracker using \`bd\`. Report your summary line at the end.`,
    ``,
    `Every signal in that file carries \`${ANTON_SEVERITY_KEY}\` and \`${ANTON_CLASS_KEY}\` — anton's own derivation,`,
    `the same one this pass's health record counts by. Take a signal's severity from`,
    `\`${ANTON_SEVERITY_KEY}\`; do NOT re-derive one from its \`Priority\`/\`Kind\`/\`Source\`, or a bead's label`,
    `will contradict the trend the board charts for the same signal.`,
    ``,
    `This project's severity mapping — label and prioritize every bead you file by it:`,
    ``,
    formatScanSeverityPolicy(resolveScanSeverity(opts.settings)),
    ``,
    opts.boardSection,
  ].join("\n");
}

/**
 * Dispatch claude to turn the scan's signals into beads (via `bd`), and report what it did — out of
 * its own closing report (skills/scan-triage §6). A session that skipped the line reports no counts
 * rather than a fabricated zero. Throws when triage errored: its window is only legitimately spent
 * once triage READ the signals.
 */
export async function runTriage(opts: {
  project: Project;
  settings: ProjectSettings;
  scanFile: string;
  logPath: string;
  signal: AbortSignal;
  onEvent: (e: ClaudeEvent) => void;
}): Promise<TriageOutcome | undefined> {
  const { project, settings } = opts;
  const boardSection = await readBoardContext(project.repoPath, opts.logPath, project.slug);
  const prompt = await buildTriagePrompt({
    scanFile: opts.scanFile,
    settings,
    boardSection,
  });

  const claudeResult = await runClaude({
    cwd: project.repoPath,
    prompt,
    model: settings.model,
    permissionMode: settings.permissionMode ?? "bypassPermissions",
    signal: opts.signal,
    onEvent: opts.onEvent,
  });
  if (!claudeResult.ok) {
    throw new Error(`scan-triage reported an error: ${claudeResult.text ?? "unknown"}`);
  }
  return parseTriageOutcome(claudeResult.text);
}
