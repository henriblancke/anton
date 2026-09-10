import { describe, expect, it } from "vitest";
import { fetchGatewayModelIds, gatewayModelsUrl, modelIdsFromGatewayResponse } from "./gateway-models";

describe("gateway model discovery", () => {
  it("normalizes an origin or a /v1 base to the gateway's model endpoint", () => {
    expect(gatewayModelsUrl("http://localhost:20128")).toBe("http://localhost:20128/v1/models");
    expect(gatewayModelsUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1/models");
  });

  it("keeps only unique, usable model ids from the OpenAI-compatible response", () => {
    expect(
      modelIdsFromGatewayResponse({
        data: [{ id: " cc/opus " }, { id: "cx/gpt" }, { id: "cc/opus" }, { name: "missing" }, { id: "" }],
      }),
    ).toEqual(["cc/opus", "cx/gpt"]);
  });

  it("sends the configured token to the gateway without returning it", async () => {
    const prior = process.env.GATEWAY_TOKEN;
    process.env.GATEWAY_TOKEN = "secret";
    const requests: RequestInit[] = [];
    try {
      await expect(
        fetchGatewayModelIds(
          { claudeBaseUrl: "http://gateway", claudeAuthTokenEnv: "GATEWAY_TOKEN" },
          async (_url, init) => {
            requests.push(init ?? {});
            return new Response(JSON.stringify({ data: [{ id: "cc/opus" }] }));
          },
        ),
      ).resolves.toEqual(["cc/opus"]);
      expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer secret" });
    } finally {
      if (prior === undefined) delete process.env.GATEWAY_TOKEN;
      else process.env.GATEWAY_TOKEN = prior;
    }
  });
});
