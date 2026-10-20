// @vitest-environment jsdom
/**
 * `DigestEmptyWindow` (anton-rokar): the digest's "nothing new" state names when the viewer last
 * looked, or says nothing has happened yet for a viewer who never has.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DigestEmptyWindow } from "@/components/digest/empty-window";

afterEach(cleanup);

describe("DigestEmptyWindow", () => {
  it("names a project that has never been looked at, without inventing a timestamp", () => {
    render(<DigestEmptyWindow since={null} />);
    expect(screen.getByText("Nothing has happened on this project yet.")).toBeTruthy();
  });

  it("reports caught-up-as-of the stored watermark", () => {
    render(<DigestEmptyWindow since={Math.floor(Date.now() / 1000) - 3600} />);
    expect(screen.getByText(/Caught up as of/)).toBeTruthy();
  });
});
