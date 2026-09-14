// @vitest-environment jsdom
/**
 * The one failed-load panel five views share (anton-iquy). What these assertions pin is exactly
 * what a careless edit here would silently change on all five surfaces at once: the retry wiring,
 * the decorative (aria-hidden) icon, and the dialog layout that must NOT inherit the page's
 * flex-1 / p-8 because it sits inside an already-padded dialog body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ErrorState } from "@/components/ui/error-state";

afterEach(cleanup);

describe("ErrorState", () => {
  it("shows the message and fires the retry callback on click", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Failed to load tickets" onRetry={onRetry} />);

    expect(screen.getByText("Failed to load tickets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("marks the alert icon decorative so the message carries the meaning", () => {
    const { container } = render(<ErrorState message="Boom" onRetry={vi.fn()} />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("fills its view by default and keeps the dialog's tighter layout under layout=dialog", () => {
    const { container: page } = render(<ErrorState message="Boom" onRetry={vi.fn()} />);
    const pageClasses = page.firstElementChild!.className;
    expect(pageClasses).toContain("flex-1");
    expect(pageClasses).toContain("p-8");

    const { container: dialog } = render(
      <ErrorState message="Boom" onRetry={vi.fn()} layout="dialog" />,
    );
    const dialogClasses = dialog.firstElementChild!.className;
    expect(dialogClasses).toContain("py-10");
    expect(dialogClasses).not.toContain("flex-1");
    expect(dialogClasses).not.toContain("p-8");
  });
});
