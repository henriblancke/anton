import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText, sleepMs } from "./retry-helpers";

describe("sleepMs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves once the requested delay has elapsed, not before", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = sleepMs(50).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("unrefs the timer so a pending sleep cannot hold the process open", () => {
    const unref = vi.fn();
    const handle = { unref } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setTimeout").mockReturnValue(handle);
    void sleepMs(1_000);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("tolerates a timer handle without unref (browser-shaped setTimeout)", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    await expect(sleepMs(1)).resolves.toBeUndefined();
  });
});

describe("errorText", () => {
  it("returns an Error's message", () => {
    expect(errorText(new Error("bd refused"))).toBe("bd refused");
  });

  it("stringifies anything that is not an Error", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
    expect(errorText(undefined)).toBe("undefined");
  });
});
