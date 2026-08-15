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
 * and no writes of any kind, so "the session never mutates the board" is a property of how it is
 * dispatched rather than a promise in a prompt. anton owns everything mechanical: reading the board,
 * checking each claim against it, hashing the fingerprints, capping the pass, filing the beads — and
 * applying the ones whose kind the operator armed (anton-4ab3), under a cap of its own. An LLM
 * cannot be a hash function, and one wrong digit files a duplicate ask forever.
 *
 * Off by default: the schedule is seeded disabled (schedules.ts). A pass costs a claude session and
 * spends a founder's attention on every proposal it files, so arming it is a deliberate act.
 *
 * TWO TIERS run here, and only one of them needs a session — both live in product-master-steps.ts
 * (anton-l4do), and the handler below is the order they run in. Ahead of the judgment, a
 * DETERMINISTIC pre-pass re-runs the approve gate's own validator over the board snapshot
 * (anton-xg5y): an approved target whose Acceptance was edited away, whose tier shape broke, or that
 * has been blocked since is work the queue would hand a worker and anton would then refuse to start.
 * That check is a fact, not an opinion — so it costs no tokens, files ahead of the session, and
 * survives a session that breaks.
 *
 * A pass over a healthy board files NOTHING and is a success. That is the outcome the pass is
 * designed around: an empty report is the answer, never a failure to find one, and the two are kept
 * distinguishable at every step — a session that breaks the protocol throws rather than degrading to
 * "no proposals", and a claim the board refuses is logged rather than dropped.
 */
import { loadAllIssues } from "../beads/issues";
import { nudgeSync, type NudgeTarget } from "../beads/sync-nudge";
import { runClaude } from "../claude/driver";
import { getProjectSettings, resolveAutonomyPolicy } from "../projects";
import { remainingApplyBudget } from "./pass-budget";
import {
  messageOf,
  openPassSession,
  passProject,
  pullBoard,
  type PassScope,
} from "./pass-preamble";
import { collectBoardInput } from "./product-master-context";
import {
  acceptClaims,
  judgeBoard,
  makeProposalFiler,
  revalidationTier,
} from "./product-master-steps";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export { MAX_HYDRATED_SCORE_SERIES } from "./product-master-context";
export { PM_DENIED_TOOLS } from "./product-master-steps";

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

/** Build the runner handler bound to a db/clock. Register it as the "product-master" handler. */
export function makeProductMasterHandler(deps: ProductMasterDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const claude = deps.runClaude ?? runClaude;
  const nudge = deps.nudge ?? ((project: NudgeTarget) => nudgeSync(project, "product-master"));

  return async function productMaster(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as ProductMasterPayload;
    const project = await passProject(db, projectId);
    const repo = project.repoPath;
    const settings = await getProjectSettings(db, projectId);

    // `jobId` is the durable half of the link: this pass writes no run row, so once it settles the
    // jobs page is the only route to its log — including the shadow records (anton-lmps). The live
    // handle (anton-susu) names the project repo itself: no worktree, because nothing here touches
    // code.
    const session = await openPassSession(db, clock, {
      ctx,
      projectId,
      kind: "product-master",
      cwd: repo,
    });
    const log = session.log;

    // The row exists from here on, so everything that can throw settles it — the budget read
    // included. A pass whose db read failed before the first tier would otherwise leave a session
    // reading "running" with no job behind it.
    try {
      const scope: PassScope = {
        project: { id: project.id, repoPath: repo },
        slug: project.slug,
        // Read once: a policy change mid-pass must not have the two tiers shadowing under different
        // rules (anton-nbyy).
        policy: resolveAutonomyPolicy(settings),
        // What earlier attempts of THIS job already applied comes off the cap: the runner retries a
        // pass that died after its writes under the same job id, and a fresh cap per attempt would
        // let one scheduled pass apply several caps' worth unattended. Read before the pass writes
        // anything, so this attempt's own (empty) log cannot count against it.
        applyBudget: await remainingApplyBudget({
          db,
          jobId: ctx.jobId,
          producer: "[product-master]",
          log,
        }),
        clock,
        ctx,
        nudge,
        log,
      };

      // Pull first, as every board-derived write does: this checkout's Dolt state can be a sync
      // heartbeat behind, and a proposal another machine filed is a fingerprint this pass would
      // otherwise re-raise.
      await pullBoard(repo, async (e) => {
        const reason = messageOf(e);
        await log(`[product-master] WARNING: board pull failed — ${reason}\n`);
        console.warn(`[product-master] ${project.slug}: board pull failed — ${reason}`);
      });

      // The premise fence, stamped BEFORE the read every proposal's evidence describes. Every "has
      // this moved since we asked" check in apply.ts dates against it, and stamping it early is the
      // safe direction: a bead written while the read is in flight dates as unseen, which costs a
      // refusal at approve time rather than a write against falsified evidence (see gardener.ts).
      const observedAtMs = clock.now();
      const board = await loadAllIssues(repo);
      await ctx.heartbeat();

      // One filer for both tiers: one board, one fence, own emission each — so the judgment pass is
      // entitled to its full ten proposals whether or not approvals have rotted. It carries the
      // snapshot rather than taking it, because an armed apply replaces it (see `snapshot`).
      const file = makeProposalFiler(scope, { board, observedAtMs });

      await file(await revalidationTier(scope, board, observedAtMs));
      await ctx.heartbeat();

      // The board tier 1 LEFT, not the one it found: armed at `apply`, revalidation withdraws
      // approvals, and a session judging the pre-write picture would reason about beads this same
      // pass had already changed — with its claims then eligible for unattended application. The
      // filer re-reads only when a write actually landed, so the ordinary pass costs no second read.
      const judged = file.snapshot();
      const boardInput = await collectBoardInput(scope, {
        db,
        board: judged.board,
        observedAtMs: judged.observedAtMs,
      });
      await ctx.heartbeat();

      const claims = await judgeBoard(scope, {
        settings,
        boardInput,
        claude,
        onEvent: session.onEvent,
      });

      await file(
        await acceptClaims(scope, {
          claims,
          board: judged.board,
          observedAtMs: judged.observedAtMs,
        }),
      );

      await session.end("done");
    } catch (e) {
      await log(`[product-master] ERROR: ${messageOf(e)}\n`);
      await session.end("failed");
      throw e; // let the runner apply job-level durability (quota backoff / retry / park)
    }
  };
}
