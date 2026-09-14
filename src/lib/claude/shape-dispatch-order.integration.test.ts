/**
 * Real-bd proof for /shape's Phase 5 audit. A reversed but mechanically valid `blocks` edge must
 * alter the printed executor order, not merely pass the board's mechanical checks.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { skillPath } from "./prompt";

let realBd = "";

function phaseFiveOrderCommand(): string {
  const skill = readFileSync(skillPath("shape"), "utf8");
  const match = skill.match(
    /# Prints every feature's actual executor dispatch order[\s\S]*?\n(node -e '[\s\S]*?\n')\n```/,
  );
  if (!match) throw new Error("/shape Phase 5 has no executable dispatch-order audit");
  return match[1];
}

function createGraph(repo: string): Record<string, string> {
  const plan = join(repo, "ordering-plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      nodes: [
        { key: "feature", title: "Delivery", type: "feature" },
        { key: "schema", title: "Schema", type: "task", parent_key: "feature" },
        { key: "wiring", title: "Wiring", type: "task", parent_key: "feature" },
      ],
      // This is syntactically valid but semantically reversed: it makes Wiring dispatch before Schema.
      edges: [{ from_key: "schema", to_key: "wiring", type: "blocks" }],
    }),
  );
  const output = execFileSync("bd", ["create", "--graph", plan, "--json"], { cwd: repo, encoding: "utf8" });
  const { ids, error } = JSON.parse(output) as { ids?: Record<string, string>; error?: string };
  if (!ids) throw new Error(`bd create --graph failed: ${error ?? output}`);
  return ids;
}

describeBd("/shape Phase 5 dispatch-order audit (real bd)", () => {
  let bdRepo: BdRepo;

  beforeAll(() => {
    realBd = execFileSync("which", ["bd"], { encoding: "utf8" }).trim();
    bdRepo = makeBdRepo();
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  it("prints the reversed edge's actual order through the supported open-plus-closed fallback", () => {
    const ids = createGraph(bdRepo.repo);

    const bin = join(bdRepo.repo, "fake-bin");
    const log = join(bdRepo.repo, "bd-invocations.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "bd"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$FAKE_BD_LOG"',
        'if [ "$1" = "list" ] && [ "$2" = "--status" ] && [ "$3" = "all" ]; then',
        "  exit 2",
        "fi",
        'exec "$REAL_BD" "$@"',
      ].join("\n"),
    );
    chmodSync(join(bin, "bd"), 0o755);

    const output = execFileSync("sh", ["-c", phaseFiveOrderCommand()], {
      cwd: bdRepo.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_BD_LOG: log,
        REAL_BD: realBd,
        PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    });

    expect(output).toContain(`feature ${ids.feature}:`);
    expect(output).toMatch(new RegExp(`1\\. ${ids.wiring}\\tWiring[\\s\\S]*2\\. ${ids.schema}\\tSchema`));
    expect(readFileSync(log, "utf8")).toContain("list --status closed --json --limit 0");
  });
});
