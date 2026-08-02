import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { toastContractAdvisory } from "@/components/board/contract-advisory";

const warning = vi.fn();

vi.mock("sonner", () => ({
  toast: { warning: (...a: unknown[]) => warning(...a) },
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

/** What the toast's description actually reads as, so the gap lines are asserted, not the JSX. */
function descriptionMarkup(): string {
  const [, options] = warning.mock.calls[0] as [string, { description: ReactNode }];
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
