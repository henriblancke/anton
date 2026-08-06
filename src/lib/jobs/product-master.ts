/**
 * product-master job (anton-d2sx). The recurring product question — what matters next, what is too
 * big, what should die — run on a schedule and landed as evidence-backed approvable proposals.
 *
 * The judgment tier ABOVE the gardener. Where that patrol detects STRUCTURAL hygiene in code
 * (anton-e42l), this dispatches a fresh-context claude session over the whole board and turns what it
 * reports into the same proposal beads: fingerprinted, evidence-carrying, `discovered-from`-linked,
 * applied on approval and suppressed on decline (anton-9qwq / anton-1t3n).
 *
 * The split of labour is the design. The SESSION judges and nothing else — it has no `bd`, no shell,
 * and no writes of any kind, so "this pass never mutates the board" is a property of how it is
 * dispatched rather than a promise in a prompt. anton owns everything mechanical: reading the board,
 * checking each claim against it, hashing the fingerprints, capping the pass, filing the beads. An
 * LLM cannot be a hash function, and one wrong digit files a duplicate ask forever.
 *
 * Off by default: the schedule is seeded disabled (schedules.ts). A pass costs a claude session and
 * spends a founder's attention on every proposal it files, so arming it is a deliberate act.
 *
 * TWO TIERS run here, and only one of them needs a session. Ahead of the judgment, a DETERMINISTIC
 * pre-pass re-runs the approve gate's own validator over the board snapshot (anton-xg5y): an approved
 * target whose Acceptance was edited away, whose tier shape broke, or that has been blocked since is
 * work the queue would hand a worker and anton would then refuse to start. That check is a fact, not
 * an opinion — so it costs no tokens, files ahead of the session, and survives a session that breaks.
 *
 * A pass over a healthy board files NOTHING and is a success. That is the outcome the pass is
 * designed around: an empty report is the answer, never a failure to find one, and the two are kept
 * distinguishable at every step — a session that breaks the protocol throws rather than degrading to
 * "no proposals", and a claim the board refuses is logged rather than dropped.
 */
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { isOpenWork, stampMsOf } from "../gardener/board-index";
import { nudgeSync, type NudgeTarget } from "../beads/sync-nudge";
import { runClaude } from "../claude/driver";
import type { GardenerDetection } from "../gardener/detections";
import {
  emitProposals,
  MAX_PROPOSALS_PER_PASS,
  PartialEmissionError,
  type EmissionResult,
} from "../gardener/emit";
import { shadowProposals } from "../gardener/shadow";
import {
  buildProductMasterPrompt,
  detectionsFor,
  MAX_RUNS,
  parsePmReport,
  type PmBoardInput,
} from "../pm/context";
import { revalidateApprovals } from "../pm/revalidate";
import { getProjectById, getProjectSettings, resolveAutonomyPolicy } from "../projects";
import { reviewReportOf } from "../review-report";
import { listRecentRuns } from "../runs";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import { reviewScoreOf } from "../ticket-view";
import { PoisonError } from "./errors";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ProductMasterPayload {
  projectId: string;
  scheduleId?: string;
}

export interface ProductMasterDeps {
  db: AntonDb;
  clock?: Clock;
  /** Injectable so a test can drive the pass without a live claude. */
  runClaude?: typeof runClaude;
  /** How the pass propagates the proposals it files; defaults to the shared write-sync nudge. */
  nudge?: (project: NudgeTarget) => void;
}

/**
 * Tools the pass may NOT use. Everything that writes, plus the shell — which is how `bd` would be
 * reached, and the whole point is that this session cannot touch the board. It needs none of them:
 * its entire input is the prompt anton assembles.
 *
 * Reading is deliberately left alone. A product judgment is better for having seen the project's own
 * direction (`.product/PRODUCT.md`, a README), and a read cannot change anything. `Bash` is denied
 * outright rather than by command prefix because a prefix filter has no way to cover every path to a
 * write — and unlike the reviewer (REVIEW_DENIED_TOOLS), this pass has no need to run the project's
 * checks, so there is nothing to trade off.
 */
export const PM_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"];

/**
 * How many reviewed run targets get their score SERIES hydrated. The `review-score:<n>` label on
 * every bead is free (it rides the board read); the round-by-round history behind it is one `bd show
 * --include-comments` each, and that series is the pass's strongest evidence — "three reviews at 4,
 * 3, 2" is a case, "currently 2" is a snapshot. Bounded because a board with a hundred reviewed
 * targets would otherwise cost a hundred bd spawns per pass; the most recently written are taken
 * first, which is where the judgment usually is.
 */
export const MAX_HYDRATED_SCORE_SERIES = 15;

/** Build the runner handler bound to a db/clock. Register it as the "product-master" handler. */
export function makeProductMasterHandler(deps: ProductMasterDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const claude = deps.runClaude ?? runClaude;
  const nudge = deps.nudge ?? ((project: NudgeTarget) => nudgeSync(project, "product-master"));

  return async function productMaster(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as ProductMasterPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;
    const settings = await getProjectSettings(db, projectId);

    const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
      projectId,
      kind: "product-master",
    });
    // Live handle (anton-susu): this job writes no run row, and it runs claude in the project repo
    // itself — no worktree, because nothing it does touches code.
    ctx.report({ sessionId, cwd: repo });

    try {
      // Pull first, as every board-derived write does: this checkout's Dolt state can be a sync
      // heartbeat behind, and a proposal another machine filed is a fingerprint this pass would
      // otherwise re-raise. Best-effort — an unreachable remote costs freshness, not the pass.
      await beads.pull(repo).catch(async (e) => {
        const reason = messageOf(e);
        await appendSessionLog(logPath, `[product-master] WARNING: board pull failed — ${reason}\n`);
        console.warn(`[product-master] ${project.slug}: board pull failed — ${reason}`);
      });

      // The premise fence, stamped BEFORE the read every proposal's evidence describes. Every "has
      // this moved since we asked" check in apply.ts dates against it, and stamping it early is the
      // safe direction: a bead written while the read is in flight dates as unseen, which costs a
      // refusal at approve time rather than a write against falsified evidence (see gardener.ts).
      const observedAtMs = clock.now();
      const board = await loadAllIssues(repo);
      await ctx.heartbeat();

      const logEmission = (emission: EmissionResult) => {
        if (emission.created.length > 0) {
          console.log(
            `[product-master] ${project.slug}: filed ${emission.created.length} proposal(s) ` +
              `(${emission.created.map((p) => p.id).join(", ")})` +
              `${emission.suppressed > 0 ? `, ${emission.suppressed} already on the board` : ""}`,
          );
          nudge({ id: project.id, repoPath: repo });
        }
        // Never a silent cap: the overflow is deterministic and the next pass files it, but a reader
        // has to be able to tell "the board is this healthy" from "we stopped at ten".
        if (emission.deferred > 0) {
          console.log(
            `[product-master] ${project.slug}: held back ${emission.deferred} proposal(s) — one pass ` +
              `files at most ${MAX_PROPOSALS_PER_PASS}; the next one picks them up`,
          );
        }
      };

      // How far this project lets a filed proposal go, per kind (anton-nbyy). Read once: a policy
      // change mid-pass must not have the two tiers shadowing under different rules.
      const policy = resolveAutonomyPolicy(settings);

      /**
       * What the armed pass WOULD have done with what this tier just filed (anton-lmps). Runs against
       * a board read fresh at this moment, exactly as an approval would, and writes nothing — so a
       * shadow that fails is a line in the log rather than a failed pass.
       */
      const shadow = (emission: EmissionResult) =>
        shadowProposals({
          repo,
          created: emission.created,
          policy,
          observedAtMs,
          nowMs: clock.now(),
          producer: "[product-master]",
          log: (chunk) => appendSessionLog(logPath, chunk),
          signal: ctx.signal,
        });

      /** File one tier's detections, reporting whatever landed before a failure rather than losing it. */
      const file = async (detections: GardenerDetection[]): Promise<void> => {
        ctx.signal.throwIfAborted();
        try {
          const emission = await emitProposals(repo, {
            board,
            detections,
            observedAtMs,
            signal: ctx.signal,
          });
          logEmission(emission);
          await shadow(emission);
        } catch (e) {
          // Whatever landed before a create failed is real board state living only in the local
          // working set — report and propagate it, or a pass that parks leaves the proposals that DID
          // file invisible to every other machine.
          if (e instanceof PartialEmissionError) logEmission(e.result);
          throw e;
        }
      };

      // The deterministic pre-pass (anton-xg5y), filed AHEAD of the session on purpose. Approval rot
      // is a FACT — the approve gate's own validator, re-run over the snapshot just read — so it
      // costs no judgment and must not depend on one: filed here, it lands even on a pass whose
      // session errors or breaks the report protocol. It reuses this board and spawns no `bd` of its
      // own. Its own emission, so the two tiers cannot cap each other out: the judgment pass is
      // entitled to its full ten proposals whether or not approvals have rotted.
      const degraded = revalidateApprovals(board, observedAtMs);
      if (degraded.length > 0) {
        await appendSessionLog(
          logPath,
          `[product-master] ${degraded.length} approved target(s) no longer meet the approve gate\n`,
        );
      }
      await file(degraded);
      await ctx.heartbeat();

      const boardInput: PmBoardInput = {
        board,
        scores: await scoreSeries(repo, board, logPath, project.slug),
        runs: await listRecentRuns(db, projectId, MAX_RUNS),
        now: observedAtMs,
      };
      await ctx.heartbeat();

      const { prompt, reasoningFrom } = await buildProductMasterPrompt({ settings, board: boardInput });
      await appendSessionLog(
        logPath,
        `[product-master] judging ${board.length} bead(s) with the ${reasoningFrom.kind === "prompt" ? "operator's prompt" : "shipped contract"}\n`,
      );

      const result = await claude({
        cwd: repo,
        prompt,
        model: settings.model,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        disallowedTools: PM_DENIED_TOOLS,
        signal: ctx.signal,
        onEvent,
      });
      if (!result.ok) {
        throw new Error(`the product-master session reported an error: ${result.text ?? "unknown"}`);
      }

      // A broken protocol is NOT an empty board. Thrown so the runner retries and eventually parks:
      // reading an unparseable report as "nothing to propose" would publish a clean bill of health
      // this pass never reached, which is the one failure that looks exactly like success.
      const report = parsePmReport(result.text);
      if (!report.ok) {
        throw new Error(
          `the product-master session broke the report protocol (${report.violation}) — anton cannot ` +
            `tell a healthy board from a report it failed to read`,
        );
      }

      // Every claim is checked against the board it was made about before it becomes a bead. A
      // rejection is LOGGED, never swallowed: a pass whose claims were all refused would otherwise
      // be indistinguishable from a pass that found a healthy board.
      // Checked against `observedAtMs`, the stamp of the read the claims were made about — not a
      // fresh clock. A session runs for many minutes, and dating the in-flight check now would let a
      // bead whose run-lease expired mid-session pass as a free subject: a proposal racing a run that
      // was live when the judgment was made.
      const { detections, rejected } = detectionsFor(report.claims, board, observedAtMs);
      for (const { claim, reason } of rejected) {
        const line = `[product-master] REFUSED a ${claim.kind} claim about ${claim.bead}: ${reason}`;
        await appendSessionLog(logPath, `${line}\n`);
        console.warn(`${line} (${project.slug})`);
      }
      await appendSessionLog(
        logPath,
        `[product-master] ${report.claims.length} claim(s) reported, ${detections.length} accepted\n`,
      );

      await file(detections);

      await endSession(db, clock, sessionId, "done");
    } catch (e) {
      await appendSessionLog(logPath, `[product-master] ERROR: ${messageOf(e)}\n`);
      await endSession(db, clock, sessionId, "failed");
      throw e; // let the runner apply job-level durability (quota backoff / retry / park)
    }
  };
}

/**
 * The per-bead review-score series, hydrated for the most recently written reviewed targets.
 *
 * Best-effort per bead: a comment thread that will not load costs that bead its history, not the
 * pass its judgment — the label-derived score is still on the board line either way. Returns
 * undefined for a board with nothing reviewed, so the context renders no series rather than an empty
 * one (a bead with no reviews and a bead that scored nothing are opposite claims).
 */
async function scoreSeries(
  repo: string,
  board: Bead[],
  logPath: string,
  slug: string,
): Promise<Map<string, number[]> | undefined> {
  // Open work only: the board context renders scores for open, non-proposal beads, so a closed or
  // abandoned bead that carries a `review-score:` label would spend one of the cap's bd spawns on a
  // series the session never sees — and push an open bead's history out of the window to do it.
  const reviewed = board
    .filter((b) => isOpenWork(b) && reviewScoreOf(b) !== undefined)
    .sort((a, b) => (stampMsOf(b) ?? 0) - (stampMsOf(a) ?? 0))
    .slice(0, MAX_HYDRATED_SCORE_SERIES);
  if (reviewed.length === 0) return undefined;

  const series = new Map<string, number[]>();
  for (const bead of reviewed) {
    try {
      const rounds = reviewReportOf(await beads.showWithComments(repo, bead.id)).rounds;
      const scores = rounds.flatMap((r) => (r.score === undefined ? [] : [r.score]));
      // Fall back to the label when the thread carries no readable round: the latest score is still
      // real evidence, and an empty series would read as "never reviewed".
      series.set(bead.id, scores.length > 0 ? scores : [reviewScoreOf(bead) as number]);
    } catch (e) {
      await appendSessionLog(
        logPath,
        `[product-master] WARNING: could not read ${bead.id}'s review history — ${messageOf(e)}\n`,
      );
      console.warn(`[product-master] ${slug}: could not read ${bead.id}'s review history`);
      series.set(bead.id, [reviewScoreOf(bead) as number]);
    }
  }
  return series;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
