import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bead } from "@/lib/beads/types";
import { contractStatusOf } from "@/lib/beads/contract";
import { runContractStatus } from "@/lib/ticket-view";
import { ApproveBlocked, ContractChip } from "@/components/board/contract-mark";

const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

/** A bead a bd read produced, so the contract is judged rather than skipped. */
const readBead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: "Resumable crawl checkpoints",
  status: "open",
  issue_type: "task",
  created_at: "2026-07-20T00:00:00.000Z",
  ...over,
});

// Every status here comes from the shared validator rather than hand-written violations, so the
// marks are tested against the exact wording approve and the runner would use.
const statusOf = (over: Partial<Bead>) => contractStatusOf(readBead({ id: "anton-1", ...over }))!;

describe("ContractChip", () => {
  it("renders nothing for a bead the contract never judged", () => {
    expect(renderToStaticMarkup(<ContractChip />)).toBe("");
  });

  it("renders nothing for a conformant bead", () => {
    const contract = statusOf({ description: `${SHAPED}\n\n## Acceptance\n- [ ] it works` });
    expect(contract).toEqual({ blocking: [], advisory: [] });
    expect(renderToStaticMarkup(<ContractChip contract={contract} />)).toBe("");
  });

  it("names the missing section on a blocking gap, with the fix in the title", () => {
    const html = renderToStaticMarkup(
      <ContractChip contract={statusOf({ description: SHAPED })} />,
    );
    expect(html).toContain("needs Acceptance");
    expect(html).toContain("Can&#x27;t run as shaped — no Acceptance criteria");
    // Blocking reads as an error, not as the neutral nudge.
    expect(html).toContain("text-risk-high");
    expect(html).not.toContain("spec gap");
  });

  it("counts advisory gaps instead of naming them, singular and plural", () => {
    const one = renderToStaticMarkup(
      <ContractChip
        contract={statusOf({
          description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO",
          acceptance_criteria: "- [ ] it works",
        })}
      />,
    );
    expect(one).toContain("1 spec gap");
    expect(one).not.toContain("1 spec gaps");
    expect(one).toContain("Runs as shaped, but thinner than it could be — ");
    // A nudge never speaks in the blocking chip's voice.
    expect(one).not.toContain("needs ");

    const many = renderToStaticMarkup(
      <ContractChip
        contract={statusOf({
          description: "## Goal\nG\n\n## Context\nC",
          acceptance_criteria: "- [ ] it works",
        })}
      />,
    );
    expect(many).toContain("2 spec gaps");
  });

  it("renders both marks when a bead both blocks the run and thins it", () => {
    const contract = statusOf({ description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO" });
    expect(contract.blocking.length).toBeGreaterThan(0);
    expect(contract.advisory.length).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<ContractChip contract={contract} />);
    expect(html).toContain("needs Acceptance");
    expect(html).toContain("1 spec gap");
  });

  it("dedupes a section the run is missing twice, while the title still lists each violation", () => {
    // A feature and its open ticket can both lack Acceptance — "needs Acceptance + Acceptance"
    // names one fix twice.
    const target = readBead({ id: "feat-1", issue_type: "feature", description: SHAPED });
    const child = readBead({ id: "task-1", parent: "feat-1", description: SHAPED });
    const contract = runContractStatus(target, [child])!;
    expect(contract.blocking).toHaveLength(2);

    const html = renderToStaticMarkup(<ContractChip contract={contract} />);
    expect(html).toContain("needs Acceptance");
    expect(html).not.toContain("Acceptance + Acceptance");
    // Both offenders stay readable on hover — only the fix is deduped.
    expect(html).toContain("task-1");
    expect(html).toMatch(/no Acceptance criteria[^"]*;[^"]*no Acceptance criteria/);
  });

  it("passes its className to each chip it renders", () => {
    const html = renderToStaticMarkup(
      <ContractChip
        contract={statusOf({ description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO" })}
        className="mark-under-test"
      />,
    );
    expect(html.match(/mark-under-test/g)).toHaveLength(2);
  });
});

describe("ApproveBlocked", () => {
  const blocking = () => statusOf({ description: SHAPED }).blocking;

  it("renders nothing when the contract withholds nothing", () => {
    expect(renderToStaticMarkup(<ApproveBlocked violations={[]} />)).toBe("");
  });

  it("keeps the affordance in place, inert, and saying what is missing", () => {
    const html = renderToStaticMarkup(<ApproveBlocked violations={blocking()} />);
    const reason = "Can&#x27;t approve — no Acceptance criteria";
    expect(html).toContain('disabled=""');
    // The title rides the wrapper because a disabled button takes no pointer events.
    expect(html).toContain(`title="${reason}`);
    expect(html).toContain(`aria-label="Approve: ${reason}`);
    expect(html).toContain("Approve");
  });

  it("honors the surface's own wording and button scale", () => {
    const xs = renderToStaticMarkup(<ApproveBlocked violations={blocking()} />);
    expect(xs).toContain("h-6"); // the board card's scale, by default

    const sm = renderToStaticMarkup(
      <ApproveBlocked violations={blocking()} label="Run feature" size="sm" />,
    );
    expect(sm).toContain("h-7"); // a detail header's scale
    expect(sm).not.toContain("h-6");
    expect(sm).toContain("Run feature");
    expect(sm).toContain('aria-label="Run feature: Can&#x27;t approve');
  });
});
