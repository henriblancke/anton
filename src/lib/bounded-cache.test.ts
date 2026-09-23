import { describe, expect, it } from "vitest";
import { BoundedCache } from "./bounded-cache";

describe("BoundedCache", () => {
  it("evicts least recently used entries by weight, including after replacement", () => {
    const cache = new BoundedCache<string, number>(5);
    cache.set("a", 1, 2);
    cache.set("b", 2, 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3, 2);
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", 4, 4);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBe(4);
    cache.set("a", 5, 6);
    expect(cache.get("a")).toBeUndefined();
  });

  it("bounds the entry count even for tiny values and retains false", () => {
    const cache = new BoundedCache<string, boolean>(100, 2);
    cache.set("a", false);
    cache.set("b", true);
    expect(cache.get("a")).toBe(false);
    cache.set("c", true);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(false);
  });
});
