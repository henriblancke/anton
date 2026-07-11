/**
 * Next.js instrumentation hook — runs once when the server process boots. We use it to start the
 * durable job runner (anton-dzh.1) so approved epics execute autonomously. Node runtime only
 * (the runner uses better-sqlite3 / child processes), and skipped during `next build`.
 *
 * Set ANTON_RUNNER=off to boot the UI without the autonomous runner.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ANTON_RUNNER === "off") return;
  const { startRunner } = await import("./lib/jobs/service");
  startRunner();
}
