"use client";

import { Toggle } from "@/components/atoms";
import { SectionHeading, TextField } from "@/components/settings/settings-fields";
import { showSection } from "@/components/settings/settings-sections";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * The worked example the section teaches from (anton-dxs6) — 9Router, because it is the gateway an
 * operator is most likely to be pointing at, and because every one of its values is a thing you
 * cannot guess: the port, the variable the token lives in, and the shape of a combo name.
 *
 * Exported so the README's copy of this example is checked against it rather than trusted. The env
 * var names deliberately duplicate `driver-routing.ts` (this module stays server-import-free, like
 * `settings-constants.ts`); the test asserts they still agree.
 */
export const GATEWAY_EXAMPLE = {
  vendor: "9Router",
  baseUrl: "http://localhost:20128",
  tokenEnv: "ANTHROPIC_AUTH_TOKEN",
  discoveryEnv: "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  /** A real 9Router combo name — the value that goes in a routing rule's model column. */
  model: "cc/claude-opus-5[1m]",
} as const;

/**
 * Point this project at a Claude-compatible gateway (anton-n16m) without touching the shell that
 * launched anton. The token itself is never stored — only the NAME of the env var anton reads it
 * from at spawn time, out of its own environment.
 *
 * The section is generic on purpose — the mechanism is any Anthropic-compatible gateway — but a
 * generic form of three fields is not configurable without prior research (anton-dxs6), so one
 * concrete gateway is worked end to end below it. The value most likely to bite is the MODEL, which
 * lives in another section entirely: anton passes `--model`, which outranks the gateway's own
 * `ANTHROPIC_MODEL`, so a combo name set in the environment is silently overridden.
 */
export function GatewaySection({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Claude gateway"
        hint="route this project through an Anthropic-compatible gateway instead of the Claude API"
      />

      <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
        <TextField
          label="Base URL"
          value={draft.claudeBaseUrl}
          onChange={(value) => set("claudeBaseUrl", value)}
          placeholder={`e.g. ${GATEWAY_EXAMPLE.baseUrl}`}
          hint="an http(s) URL · empty = the Claude API"
          maxLength={2000}
        />
        <TextField
          label="Auth token env var"
          value={draft.claudeAuthTokenEnv}
          onChange={(value) => set("claudeAuthTokenEnv", value)}
          placeholder={`e.g. ${GATEWAY_EXAMPLE.tokenEnv}`}
          hint="the NAME of an env var, not the token"
          maxLength={256}
        />
      </div>

      <div className="flex max-w-2xl items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px]">Discover models from the gateway</span>
          <span className="text-[10.5px] text-subtle">
            ask the gateway which models it serves · off by default
          </span>
        </div>
        <span className="ml-auto">
          <Toggle
            checked={draft.claudeGatewayModelDiscovery}
            onChange={(next) => set("claudeGatewayModelDiscovery", next)}
            label="Discover models from the gateway"
          />
        </span>
      </div>

      <span className="max-w-2xl text-[11px] text-subtle">
        The gateway token is <strong className="font-semibold text-foreground">never stored</strong>.
        anton reads it at spawn time from the named environment variable in its own environment — set
        that variable in the shell or service that runs anton. Saving a base URL requires a token env
        var name.
      </span>

      <WorkedExample />
    </section>
  );
}

/**
 * One gateway configured end to end. Four rows and not three: the model is part of pointing a
 * project at a gateway even though its field is in another section, and leaving it out is what
 * makes a correctly-filled gateway form still run against the wrong model.
 */
function WorkedExample() {
  const { vendor, baseUrl, tokenEnv, discoveryEnv, model } = GATEWAY_EXAMPLE;
  return (
    <div className="flex max-w-2xl flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
      <span className="text-[12.5px]">
        Worked example — <strong className="font-semibold">{vendor}</strong>
      </span>

      <dl className="flex flex-col gap-1.5 text-[11px]">
        <ExampleRow term="Base URL" value={baseUrl}>
          {vendor} runs as a local proxy on port 20128 and serves the Anthropic messages API
          natively, so the base URL is the bare origin — no{" "}
          <code className="font-mono text-[11px]">/v1</code> suffix.
        </ExampleRow>

        <ExampleRow term="Auth token env var" value={tokenEnv}>
          export that variable to your {vendor} API key in anton&apos;s own environment. The field
          takes the variable&apos;s NAME; the key never reaches anton.
        </ExampleRow>

        <ExampleRow term="Discover models" value="on">
          sets <code className="font-mono text-[11px]">{discoveryEnv}</code> for the run, so the
          driver asks {vendor} which models and combos it serves instead of assuming the Claude
          catalogue.
        </ExampleRow>

        <ExampleRow term="Model" value={model}>
          a {vendor} combo name. anton passes <code className="font-mono text-[11px]">--model</code>,
          which outranks the gateway&apos;s own{" "}
          <code className="font-mono text-[11px]">ANTHROPIC_MODEL</code> — so the combo goes in a
          routing rule&apos;s model column, not in the environment.
        </ExampleRow>
      </dl>

      {/* The model field is a section away, so it gets a link rather than a name: the gateway form
          reads as complete without it, which is exactly the trap. */}
      <span className="text-[11px] text-subtle">
        The model field takes any name your gateway accepts — a plain model id or a combo like{" "}
        <code className="font-mono text-[11px]">{model}</code> — and lives under{" "}
        <strong className="font-medium text-foreground">Model routing</strong>, one rule per kind of
        work. General&apos;s <em className="not-italic text-foreground">Default model</em> offers
        anton&apos;s own catalogue only, so a gateway name goes in a rule.{" "}
        <button
          type="button"
          onClick={() => showSection("model-routing")}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Go to Model routing
        </button>
      </span>
    </div>
  );
}

/** One `term → value` line of the worked example, with the why beneath it. */
function ExampleRow({
  term,
  value,
  children,
}: {
  term: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-subtle">{term}</span>
        <span className="font-mono text-[11px] text-foreground">{value}</span>
      </dt>
      <dd className="text-subtle">{children}</dd>
    </div>
  );
}
