/**
 * The pure half of the settings form (anton-tun): how a stored row becomes draft values, which
 * staged edits count as dirty, and what a save serializes. The rendered behaviour is covered by
 * settings-view.test.tsx; this pins the rules those panels all share.
 */
import { describe, expect, it } from "vitest";

import {
  dirtyFields,
  draftFromSettings,
  nominatedLabels,
  reviewerMissing,
  settingsPatchBody,
  type SettingsDraft,
} from "@/components/settings/settings-draft";
import type { EarnedKind } from "@/components/settings/settings-autonomy";
import type { EditableSettings } from "@/components/settings/settings-types";

const BUNDLED = ["nextjs", "fastapi"];
const NO_RECORD: Record<string, EarnedKind> = {};

function draft(settings: EditableSettings = {}): SettingsDraft {
  return draftFromSettings(settings, BUNDLED, NO_RECORD);
}

function dirty(edits: Partial<SettingsDraft>, baseline: EditableSettings = {}) {
  return dirtyFields({ ...draft(baseline), ...edits }, baseline, BUNDLED, NO_RECORD);
}

describe("draftFromSettings", () => {
  it("seeds every absent field to the default the server would apply", () => {
    const d = draft();
    expect(d.concurrency).toBe(3);
    expect(d.reviewEnabled).toBe(true);
    expect(d.autonomy).toBe(true);
    expect(d.budgetAware).toBe(false);
    expect(d.seedPrompt).toBe("");
  });

  it("seeds an absent allowlist to every bundled agent — the runtime's own reading of absent", () => {
    expect([...draft().activeAgents]).toEqual(BUNDLED);
    expect([...draft({ agents: ["nextjs"] }).activeAgents]).toEqual(["nextjs"]);
  });

  it("gives every ordered row a stable local id, so a reorder never remounts an input", () => {
    const d = draft({
      formulaVariants: [{ label: "risk:high", formula: "careful" }],
      valueLabels: ["revenue"],
    });
    expect(d.variantRows).toEqual([{ id: "v0", label: "risk:high", formula: "careful" }]);
    expect(d.valueLabelRows).toEqual([{ id: "vl0", label: "revenue" }]);
  });

  it("floors an unreadable stored autonomy level back to propose", () => {
    const d = draft({ proposalAutonomy: { stale: "nonsense", mispriority: "shadow" } });
    expect(d.proposalAutonomy["mispriority"]).toBe("shadow");
    expect(d.proposalAutonomy["stale"]).toBe("propose");
  });
});

describe("dirtyFields", () => {
  it("reads an untouched form as clean, defaults and all", () => {
    expect(Object.values(dirty({})).some(Boolean)).toBe(false);
  });

  it("names the SECTION key an edited field belongs to, not the field", () => {
    expect(dirty({ lintCommand: "bun run lint" }).gates).toBe(true);
    expect(dirty({ reviewMinScore: 8 }).review).toBe(true);
    expect(dirty({ weeklyTargetPct: 50 }).budget).toBe(true);
  });

  it("does not read trailing whitespace on a prompt as an edit", () => {
    expect(dirty({ seedPrompt: "  prefer RSC  " }, { seedPrompt: "prefer RSC" }).seedPrompt).toBe(
      false,
    );
  });

  it("reads a reordered allowlist as clean — it is a set, not a list", () => {
    const baseline: EditableSettings = { agents: ["fastapi", "nextjs"] };
    expect(dirty({}, baseline).agents).toBe(false);
  });

  it("reads turning a bundled agent off as an edit", () => {
    expect(dirty({ activeAgents: new Set(["nextjs"]) }).agents).toBe(true);
  });

  it("reads a reordered variant as an edit — the order IS the precedence", () => {
    const baseline: EditableSettings = {
      formulaVariants: [
        { label: "a", formula: "one" },
        { label: "b", formula: "two" },
      ],
    };
    const rows = draft(baseline).variantRows;
    expect(dirty({ variantRows: [rows[1], rows[0]] }, baseline).formulaVariants).toBe(true);
  });

  it("does not read a half-filled scaffolding row as an edit — the save drops it", () => {
    const rows = [...draft().variantRows, { id: "new-0", label: "risk:high", formula: "" }];
    expect(dirty({ variantRows: rows }).formulaVariants).toBe(false);
  });

  it("reads the shipped autonomy default as clean, not as an edit on every render", () => {
    expect(dirty({}).proposalAutonomy).toBe(false);
    const armed = { ...draft().proposalAutonomy, mispriority: "shadow" as const };
    expect(dirty({ proposalAutonomy: armed }).proposalAutonomy).toBe(true);
  });
});

describe("settingsPatchBody", () => {
  it("clears a blank override to null so the shipped default applies", () => {
    const body = settingsPatchBody(draft(), BUNDLED, []);
    expect(body.seedPrompt).toBeNull();
    expect(body.testCommand).toBeNull();
    expect(body.model).toBeNull();
  });

  it("sends only the bundled ids that are on, pruning a stale user agent", () => {
    const d = draft({ agents: ["nextjs", "my-own-agent"] });
    expect(settingsPatchBody(d, BUNDLED, []).agents).toEqual(["nextjs"]);
  });

  it("omits a reviewer that no longer resolves, so unrelated settings still apply", () => {
    const d = draft({ reviewAgent: "deleted-agent" });
    expect("reviewAgent" in settingsPatchBody(d, BUNDLED, [])).toBe(false);
    const live = settingsPatchBody(d, BUNDLED, [{ id: "deleted-agent", source: "project" }]);
    expect(live.reviewAgent).toBe("deleted-agent");
  });

  it("sends every autonomy kind explicitly — an omitted kind would keep whatever it held", () => {
    const policy = settingsPatchBody(draft(), BUNDLED, []).proposalAutonomy as Record<
      string,
      string
    >;
    expect(Object.values(policy).every((level) => level === "propose")).toBe(true);
    expect(Object.keys(policy).length).toBeGreaterThan(0);
  });
});

describe("nominatedLabels", () => {
  it("trims, drops blanks, and drops a repeat that could never reach its second tier", () => {
    expect(
      nominatedLabels([
        { id: "1", label: " revenue " },
        { id: "2", label: "  " },
        { id: "3", label: "revenue" },
        { id: "4", label: "growth" },
      ]),
    ).toEqual(["revenue", "growth"]);
  });
});

describe("reviewerMissing", () => {
  it("is false for the default reviewer, true only for a stored id nothing resolves", () => {
    expect(reviewerMissing("", [])).toBe(false);
    expect(reviewerMissing("nextjs", [{ id: "nextjs", source: "bundled" }])).toBe(false);
    expect(reviewerMissing("nextjs", [])).toBe(true);
  });
});
