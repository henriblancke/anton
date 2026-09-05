// @vitest-environment jsdom
/**
 * The grouping preference's two halves (anton-wds3): the SERVER SNAPSHOT — what the very first paint
 * arranges the board as — and the POST-MOUNT ADOPTION that keeps a choice made in this tab.
 *
 * The load-bearing test hydrates a server render and asserts the hook never once reported `stage`
 * for a board stored on Epic. That is the flash itself, expressed as a value: the old localStorage
 * store could only serve `stage` to the server, so the board painted stage columns — Up Next lane
 * and all — and dropped them on mount, on every single load.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { BoardGrouping } from "@/components/board/board-utils";
import { boardGroupingCookieName } from "@/lib/board-grouping";
import { useBoardGrouping } from "@/lib/use-board-grouping";

/** What the page does on the server: the request's cookie, or the default when there is none. */
function stored(slug: string): string | undefined {
  return document.cookie
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${boardGroupingCookieName(slug)}=`))
    ?.split("=")[1];
}

/** The store the preference lived in before the server had to read it. */
const LEGACY_KEY = "anton:board-grouping:";

function forget(slug: string) {
  document.cookie = `${boardGroupingCookieName(slug)}=; path=/; max-age=0`;
}

afterEach(() => {
  cleanup();
  forget("tmp");
  forget("other");
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("useBoardGrouping server snapshot (anton-wds3)", () => {
  it("paints the server's grouping, not the default, on the first render", () => {
    // No cookie in this jsdom document at all: the server's read is the ONLY source the first
    // render may use, which is exactly the situation on the server itself.
    const html = renderToString(createElement(Probe, { slug: "tmp", initial: "epic" }));

    expect(html).toContain("epic");
  });

  it("never reports the default for a board stored on Epic — the paint-then-vanish is gone", async () => {
    document.cookie = `${boardGroupingCookieName("tmp")}=epic; path=/`;
    const seen: BoardGrouping[] = [];
    const element = createElement(Probe, { slug: "tmp", initial: "epic", seen });

    // Server pass, then hydration of its markup — the full load an operator actually sees.
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    await act(async () => {
      hydrateRoot(container, element);
    });

    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["epic"]);
    expect(container.textContent).toBe("epic");
  });

  it("stays on the stage default when the request carried no preference", () => {
    const { result } = renderHook(() => useBoardGrouping("tmp"));

    expect(result.current[0]).toBe("stage");
  });
});

describe("useBoardGrouping post-mount adoption (anton-wds3)", () => {
  it("adopts a choice made in this tab and stores it where the server will read it", () => {
    const { result } = renderHook(() => useBoardGrouping("tmp"));

    act(() => result.current[1]("epic"));

    expect(result.current[0]).toBe("epic");
    expect(stored("tmp")).toBe("epic");
  });

  it("reads a cookie the page did not know about — a choice made since the render", () => {
    document.cookie = `${boardGroupingCookieName("tmp")}=epic; path=/`;

    // `initial` is the stage default the server saw; the client store still adopts the newer cookie.
    const { result } = renderHook(() => useBoardGrouping("tmp", "stage"));

    expect(result.current[0]).toBe("epic");
  });

  it("drops the cookie when the operator returns to the default", () => {
    const { result } = renderHook(() => useBoardGrouping("tmp"));

    act(() => result.current[1]("epic"));
    act(() => result.current[1]("stage"));

    expect(result.current[0]).toBe("stage");
    // One cookie per board that left `stage`, not one per board ever opened.
    expect(stored("tmp")).toBeUndefined();
  });

  it("keeps the preference per project", () => {
    const tmp = renderHook(() => useBoardGrouping("tmp"));
    const other = renderHook(() => useBoardGrouping("other"));

    act(() => tmp.result.current[1]("epic"));

    expect(tmp.result.current[0]).toBe("epic");
    expect(other.result.current[0]).toBe("stage");
  });

  it("honours the choice for the session when cookies cannot be written", () => {
    const own = Object.getOwnPropertyDescriptor(document, "cookie");
    // Blocked cookies fail SILENTLY — the write is simply dropped, and the read stays empty.
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => {},
    });
    try {
      const { result } = renderHook(() => useBoardGrouping("tmp"));
      act(() => result.current[1]("epic"));
      expect(result.current[0]).toBe("epic");
      // Back to the default while still unwritable, so the session fallback holds nothing for the
      // next suite — the map is module state, not per render.
      act(() => result.current[1]("stage"));
      expect(result.current[0]).toBe("stage");
    } finally {
      if (own) Object.defineProperty(document, "cookie", own);
      else Reflect.deleteProperty(document, "cookie");
    }
  });
});

describe("useBoardGrouping legacy storage (PR #226 review)", () => {
  it("carries a pre-cookie preference across the format change instead of resetting it", () => {
    window.localStorage.setItem(LEGACY_KEY + "tmp", "epic");

    const { result } = renderHook(() => useBoardGrouping("tmp"));

    expect(result.current[0]).toBe("epic");
    // Adopted into the store the SERVER reads, so the next load paints Epic without this rescue.
    expect(stored("tmp")).toBe("epic");
    expect(window.localStorage.getItem(LEGACY_KEY + "tmp")).toBeNull();
  });

  it("leaves a board alone whose choice was already made in the new format", () => {
    document.cookie = `${boardGroupingCookieName("tmp")}=stage; path=/`;
    window.localStorage.setItem(LEGACY_KEY + "tmp", "epic");

    const { result } = renderHook(() => useBoardGrouping("tmp"));

    expect(result.current[0]).toBe("stage");
    expect(window.localStorage.getItem(LEGACY_KEY + "tmp")).toBeNull();
  });

  it("keeps the old key when the cookie it would migrate into cannot be written", () => {
    window.localStorage.setItem(LEGACY_KEY + "tmp", "epic");
    const own = Object.getOwnPropertyDescriptor(document, "cookie");
    Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: () => {} });
    try {
      const { result } = renderHook(() => useBoardGrouping("tmp"));

      expect(result.current[0]).toBe("epic");
      // The only durable copy stays put rather than being traded for a session-only one.
      expect(window.localStorage.getItem(LEGACY_KEY + "tmp")).toBe("epic");
      act(() => result.current[1]("stage"));
    } finally {
      if (own) Object.defineProperty(document, "cookie", own);
      else Reflect.deleteProperty(document, "cookie");
    }
  });

  it("ignores an unrecognised stored value", () => {
    window.localStorage.setItem(LEGACY_KEY + "tmp", "sideways");

    const { result } = renderHook(() => useBoardGrouping("tmp"));

    expect(result.current[0]).toBe("stage");
    expect(window.localStorage.getItem(LEGACY_KEY + "tmp")).toBeNull();
  });
});

/** A component whose whole output is the grouping the hook reported, on every render it made. */
function Probe({
  slug,
  initial,
  seen,
}: {
  slug: string;
  initial?: BoardGrouping;
  seen?: BoardGrouping[];
}) {
  const [grouping] = useBoardGrouping(slug, initial);
  seen?.push(grouping);
  return createElement("span", null, grouping);
}
