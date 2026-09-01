import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { toastContractAdvisory } from "@/components/board/contract-advisory";

const warning = vi.fn();
const info = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    warning: (...a: unknown[]) => warning(...a),
    info: (...a: unknown[]) => info(...a),
  },
}));

beforeEach(() => {
  // The never-throws path logs; keep the run's output clean and the log itself assertable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** What a toast's description actually reads as, so the lines are asserted, not the JSX. */
function descriptionMarkup(mock = warning): string {
  const [, options] = mock.mock.calls[0] as [string, { description: ReactNode }];
  return renderToStaticMarkup(<>{options.description}</>);
}

describe("toastContractAdvisory", () => {
  it("warns once, counting the gaps and listing one line each", async () => {
    await toastContractAdvisory(
      jsonRes({ advisory: ["anton-1 → no Verify", "anton-2 → no Goal, no Context"] }),
    );

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe("2 spec gaps");
    const description = descriptionMarkup();
    expect(description).toContain("Runs as shaped, but thinner than it could be.");
    expect(description).toContain("anton-1 → no Verify");
    expect(description).toContain("anton-2 → no Goal, no Context");
  });

  it("says one gap in the singular", async () => {
    await toastContractAdvisory(jsonRes({ advisory: ["anton-1 → no Verify"] }));

    expect(warning.mock.calls[0][0]).toBe("1 spec gap");
    expect(descriptionMarkup()).toContain("anton-1 → no Verify");
  });

  it("stays silent on a conformant run — the common case", async () => {
    await toastContractAdvisory(jsonRes({ ok: true, runId: "r-1" }));
    await toastContractAdvisory(jsonRes({ advisory: [] }));
    await toastContractAdvisory(jsonRes(null));

    expect(warning).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("ignores non-string entries rather than toasting an empty line", async () => {
    await toastContractAdvisory(jsonRes({ advisory: [{ id: "anton-1" }, 7, null] }));
    await toastContractAdvisory(jsonRes({ advisory: "anton-1 → no Verify" }));

    expect(warning).not.toHaveBeenCalled();
  });

  // The never-throws property is load-bearing, not incidental: every caller awaits this inside the
  // `try` that wraps an approve that has ALREADY landed. A throw here would roll the optimistic
  // state back and toast an error for work that succeeded.
  describe("never throws", () => {
    it("swallows a body that isn't JSON", async () => {
      await expect(
        toastContractAdvisory(new Response("<html>gateway timeout</html>", { status: 200 })),
      ).resolves.toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
    });

    it("swallows a rejecting res.json()", async () => {
      const res = { json: () => Promise.reject(new Error("stream already consumed")) };
      await expect(
        toastContractAdvisory(res as unknown as Response),
      ).resolves.toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
    });

    it("swallows a response that can't be read at all", async () => {
      // A synchronous throw lands before `.catch` is attached, so only the outer guard catches it.
      const res = {
        json: () => {
          throw new TypeError("body used already");
        },
      };
      await expect(toastContractAdvisory(res as unknown as Response)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();

      await expect(toastContractAdvisory({} as unknown as Response)).resolves.toBeUndefined();
    });

    it("swallows a toast that fails to render", async () => {
      warning.mockImplementationOnce(() => {
        throw new Error("toaster unmounted");
      });

      await expect(
        toastContractAdvisory(jsonRes({ advisory: ["anton-1 → no Verify"] })),
      ).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });
  });
});

/**
 * The human-gate half (anton-qfso.2). Its own toast, on the same one call every surface already
 * makes — the operator learns how often the run will stop for them at the moment they start it.
 */
describe("human gates", () => {
  it("counts the tickets that need a person and names each one", async () => {
    await toastContractAdvisory(
      jsonRes({ humanGates: ["anton-1 → Buy the domain", "anton-2 → Sign the DPA"] }),
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("2 tickets need you");
    const description = descriptionMarkup(info);
    expect(description).toContain("anton runs the rest and holds these until you do them.");
    expect(description).toContain("anton-1 → Buy the domain");
    expect(description).toContain("anton-2 → Sign the DPA");
  });

  it("says one gate in the singular", async () => {
    await toastContractAdvisory(jsonRes({ humanGates: ["anton-1 → Buy the domain"] }));

    expect(info.mock.calls[0][0]).toBe("1 ticket needs you");
    expect(descriptionMarkup(info)).toContain("holds this one until you do it.");
  });

  it("stays silent when the field is absent, empty, or malformed", async () => {
    await toastContractAdvisory(jsonRes({ advisory: [] }));
    await toastContractAdvisory(jsonRes({ humanGates: [] }));
    await toastContractAdvisory(jsonRes({ humanGates: "anton-1 → Buy the domain" }));
    await toastContractAdvisory(jsonRes({ humanGates: [{ id: "anton-1" }, 7, null] }));

    expect(info).not.toHaveBeenCalled();
  });

  // Two costs, two toasts, one call: the spec gaps degrade the run's quality, the gates cost the
  // operator their own time, and a surface that reported only one of them would consume the body
  // and silently drop the other.
  it("rides the same call as the spec advisory without swallowing it", async () => {
    await toastContractAdvisory(
      jsonRes({ advisory: ["anton-1 → no Verify"], humanGates: ["anton-2 → Buy the domain"] }),
    );

    expect(warning.mock.calls[0][0]).toBe("1 spec gap");
    expect(info.mock.calls[0][0]).toBe("1 ticket needs you");
  });

  // The one shape where "anton runs the rest" is false: execute-epic poisons a human TARGET before
  // it dispatches anything under it, so no agent-run starts at all.
  it("says no run starts when the target itself is the human work", async () => {
    await toastContractAdvisory(
      jsonRes({ humanGates: ["anton-1 → Buy the domain"], humanTarget: true }),
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("This one is yours");
    const description = descriptionMarkup(info);
    expect(description).toContain("no agent-run starts");
    expect(description).not.toContain("anton runs the rest");
  });

  it("says it with no gate lines at all — the target's own label is the whole fact", async () => {
    // The route now reports `humanTarget` off the TARGET, not off the dispatch set, which empties on
    // a re-run whose children are all closed or which is already in review. Requiring a gate line
    // here would silence the notice on exactly those recoveries (PR #214 review).
    await toastContractAdvisory(jsonRes({ humanTarget: true }));

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("This one is yours");
  });

  it("still promises the rest of the run when only its tickets are human", async () => {
    await toastContractAdvisory(
      jsonRes({ humanGates: ["anton-1 → Buy the domain"], humanTarget: false }),
    );

    expect(info.mock.calls[0][0]).toBe("1 ticket needs you");
    expect(descriptionMarkup(info)).toContain("anton runs the rest");
  });

  it("never throws when the gate toast fails to render", async () => {
    info.mockImplementationOnce(() => {
      throw new Error("toaster unmounted");
    });

    await expect(
      toastContractAdvisory(jsonRes({ humanGates: ["anton-1 → Buy the domain"] })),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
