// @vitest-environment jsdom
/**
 * Configuring a gateway is concrete, not inferred (anton-dxs6). Two things are gated here:
 *
 * 1. The worked example is PRESENT and complete — an operator can fill all four values from it
 *    without going and reading a vendor's blog post first.
 * 2. The section stays GENERIC — the vendor is the example, never the mechanism. A title or field
 *    label that names 9Router would be a regression, because the field drives any
 *    Anthropic-compatible gateway.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  GATEWAY_EXAMPLE,
  GatewaySection,
} from "@/components/settings/sections/gateway-section";
import {
  ANTHROPIC_AUTH_TOKEN_ENV,
  ANTHROPIC_BASE_URL_ENV,
  GATEWAY_MODEL_DISCOVERY_ENV,
} from "@/lib/claude/driver-routing";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** Only the two members the section reads; the rest of the form is another suite's concern. */
function renderSection() {
  const set = vi.fn();
  const form = {
    draft: { claudeBaseUrl: "", claudeAuthTokenEnv: "", claudeGatewayModelDiscovery: false },
    set,
  } as unknown as SettingsForm;
  render(<GatewaySection form={form} />);
  return { set };
}

/** The panel's copy as one string — for assertions on a sentence a <code> element splits. */
const flatText = (): string => document.body.textContent?.replace(/\s+/g, " ") ?? "";

afterEach(cleanup);

describe("gateway section — worked example (anton-dxs6)", () => {
  it("names the vendor's local port as the base URL", () => {
    renderSection();
    // Twice over: the placeholder AND the example, so the magic number is explained where it appears.
    expect(screen.getAllByText(GATEWAY_EXAMPLE.baseUrl).length).toBeGreaterThan(0);
    expect(screen.getByText(/port 20128/)).toBeTruthy();
    // The `/v1` caveat is split by a <code>, so it is matched on the joined text.
    expect(flatText()).toMatch(/no \/v1 suffix/i);
  });

  it("says what goes in the token env var — the key, exported in anton's own environment", () => {
    renderSection();
    expect(screen.getAllByText(GATEWAY_EXAMPLE.tokenEnv).length).toBeGreaterThan(0);
    expect(screen.getByText(/export that variable to your 9Router API key/i)).toBeTruthy();
  });

  it("says what model discovery does, naming the env var it sets", () => {
    renderSection();
    expect(screen.getByText(GATEWAY_EXAMPLE.discoveryEnv)).toBeTruthy();
    expect(screen.getByText(/which models and combos it serves/i)).toBeTruthy();
  });

  /**
   * The trap the ticket is about: the gateway form reads as complete without a model, and anton's
   * `--model` outranks the gateway's `ANTHROPIC_MODEL`, so a combo exported to the environment is
   * silently overridden.
   */
  it("states that the model field takes a gateway combo name, with a real example", () => {
    renderSection();
    expect(screen.getAllByText(GATEWAY_EXAMPLE.model).length).toBeGreaterThan(0);
    expect(screen.getByText(/ANTHROPIC_MODEL/)).toBeTruthy();
  });

  it("points at where the model field lives rather than only naming it", () => {
    renderSection();
    expect(screen.getByRole("button", { name: /go to model routing/i })).toBeTruthy();
    expect(screen.getByText(/one rule per kind of work/i)).toBeTruthy();
  });

  it("keeps the example's env var names in step with the ones the driver actually sets", () => {
    // The section stays server-import-free, so its copy is a duplicate of driver-routing's
    // constants; a rename there must not leave the docs teaching a dead variable.
    expect(GATEWAY_EXAMPLE.tokenEnv).toBe(ANTHROPIC_AUTH_TOKEN_ENV);
    expect(GATEWAY_EXAMPLE.discoveryEnv).toBe(GATEWAY_MODEL_DISCOVERY_ENV);
    expect(ANTHROPIC_BASE_URL_ENV).toBe("ANTHROPIC_BASE_URL");
  });
});

describe("gateway section — the mechanism stays generic (anton-dxs6)", () => {
  /** The title and every field label describe the mechanism; the vendor appears only as example. */
  it("titles the section by the mechanism, not the vendor", () => {
    renderSection();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Claude gateway");
    expect(heading.textContent).not.toMatch(/9Router/i);
  });

  it("labels the three fields generically", () => {
    renderSection();
    for (const label of ["Base URL", "Auth token env var", "Discover models from the gateway"]) {
      const field = screen.getByLabelText(label);
      expect(field, `missing generic field: ${label}`).toBeTruthy();
    }
    for (const label of screen.getAllByRole("switch").concat(screen.getAllByRole("textbox"))) {
      expect(label.getAttribute("aria-label")).not.toMatch(/9router/i);
    }
  });

  it("says the mechanism is any Anthropic-compatible gateway", () => {
    renderSection();
    expect(screen.getByText(/Anthropic-compatible gateway/i)).toBeTruthy();
  });

  it("confines the vendor to the worked example", () => {
    renderSection();
    // Every 9Router mention sits inside the example block, so the form above it reads for any gateway.
    const example = screen.getByText(/Worked example/i).closest("div");
    expect(example).toBeTruthy();
    for (const node of screen.getAllByText(/9Router/)) {
      expect(example?.contains(node), `9Router leaked outside the example: ${node.textContent}`).toBe(
        true,
      );
    }
  });
});

/**
 * The README carries the same example so it is discoverable without opening the app — and the
 * failure mode is drift: two copies of a port number, one of which quietly goes stale.
 */
describe("README carries the same worked example (anton-dxs6)", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8").replace(/\s+/g, " ");

  it("names the same four values as the UI", () => {
    for (const value of Object.values(GATEWAY_EXAMPLE)) {
      expect(readme, `README is missing the UI's example value: ${value}`).toContain(value);
    }
  });

  it("carries the model warning, not just the three gateway fields", () => {
    expect(readme).toMatch(/--model.{0,120}ANTHROPIC_MODEL|ANTHROPIC_MODEL.{0,120}--model/);
    expect(readme).toMatch(/Model routing/);
  });

  it("still describes the mechanism generically alongside the example", () => {
    expect(readme).toMatch(/Claude-compatible \*\*gateway\*\*|Anthropic-compatible gateway/);
  });
});
