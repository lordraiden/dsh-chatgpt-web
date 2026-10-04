import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  chatGptWebModelRoute,
} from "../src/chatgpt-web-models";
import {
  availableChatGptWebRoutes,
  createChatGptWebRouteAuthority,
  requireChatGptWebRoute,
  routeAccountingDomain,
} from "../src/chatgpt-web-authority";
import { defaultConfig } from "../src/config";
import { buildChatGptWebModelCatalog } from "../src/model-catalog";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";

describe("issue #71 ChatGPT Web product-route scope", () => {
  test("Free Web exposes only eligible automatic routes", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: false,
    });
    const routes = availableChatGptWebRoutes(authority);
    expect(routes.map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    for (const route of routes) expect(routeAccountingDomain(route)).toBe("chatgpt-web");
  });

  test("Paid Web exposes all Pro-gated Web routes", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: true,
    });
    expect(availableChatGptWebRoutes(authority).map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/pro",
    ]);
  });

  test("Luna-only capability exposes only Luna until Think is proven available", () => {
    const unavailable = createChatGptWebRouteAuthority({
      solAvailable: false,
      proAvailable: false,
      thinkAvailable: false,
    });
    expect(availableChatGptWebRoutes(unavailable).map(route => route.slug)).toEqual([
      "chatgpt-web/luna",
    ]);
    expect(() => requireChatGptWebRoute("chatgpt-web/think", unavailable))
      .toThrow(/Think is unavailable/);

    const available = createChatGptWebRouteAuthority({
      solAvailable: false,
      proAvailable: false,
      thinkAvailable: true,
    });
    expect(availableChatGptWebRoutes(available).map(route => route.slug)).toEqual([
      "chatgpt-web/luna",
      "chatgpt-web/think",
    ]);
    expect(requireChatGptWebRoute("chatgpt-web/luna", available).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(requireChatGptWebRoute("chatgpt-web/think", available).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(() => requireChatGptWebRoute("chatgpt-web/high", available)).toThrow();
  });

  test("Unknown capability is fail-closed", () => {
    const authority = createChatGptWebRouteAuthority({
      capabilityState: {
        solAvailable: "unknown",
        proAvailable: "unknown",
      },
    });
    expect(availableChatGptWebRoutes(authority)).toEqual([]);
    expect(() => requireChatGptWebRoute("chatgpt-web/light", authority)).toThrow(/unknown or unverifiable/);
  });

  test("Codex and Work routes cannot enter the Web authority", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: true,
    });
    for (const model of ["gpt-5.6-codex", "gpt-5.6-codex-mini", "chatgpt-work/pro", "work/pro"]) {
      expect(() => requireChatGptWebRoute(model, authority)).toThrow(/outside this provider authority/);
    }
  });

  test("backend model IDs are not accepted as public Web model routes", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: true,
    });
    for (const model of [CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_LUNA_BACKEND_MODEL, "chatgpt-web-zero-risk"]) {
      expect(() => requireChatGptWebRoute(model, authority)).toThrow();
    }
    expect(chatGptWebModelRoute("chatgpt-web/high")?.backendModel).toBe(CHATGPT_WEB_BACKEND_MODEL);
  });

  test("native DSH route resolution and Responses parsing share the same authority", () => {
    const config = defaultConfig();
    for (const model of [
      "chatgpt-web/light",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/luna",
      "chatgpt-web/think",
    ]) {
      const expected = (() => {
        try {
          return requireChatGptWebRoute(model, createChatGptWebRouteAuthority(config)).slug;
        } catch {
          return "rejected";
        }
      })();
      let resolved = "rejected";
      try {
        resolved = routeChatGptWebRequest(parseRequest({ model, input: "hello" }), config).slug;
      } catch {
        resolved = "rejected";
      }
      expect(resolved).toBe(expected);
    }
  });

  test("automatic Web catalog rows advertise image input while Zero Risk stays text-only", () => {
    const automatic = buildChatGptWebModelCatalog({
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: {
        solAvailable: "supported",
        proAvailable: "unsupported",
      },
      browserInteractionMode: "automatic",
    });
    const automaticModels = automatic.models as Array<Record<string, unknown>>;
    expect(automaticModels.length).toBeGreaterThan(0);
    expect(automaticModels.every(model => Array.isArray(model.input_modalities)
      && JSON.stringify(model.input_modalities) === JSON.stringify(["text", "image"]))).toBe(true);

    const manual = buildChatGptWebModelCatalog({
      ...defaultConfig(),
      browserInteractionMode: "manual",
      zeroRiskProEnabled: false,
    });
    const manualModels = manual.models as Array<Record<string, unknown>>;
    expect(manualModels).toHaveLength(1);
    expect(manualModels[0]?.input_modalities).toEqual(["text"]);
  });

  test("the Web catalog contains only authority-approved routes and no native Codex contamination", () => {
    const catalog = buildChatGptWebModelCatalog(defaultConfig());
    const models = catalog.models as Array<Record<string, unknown>>;
    expect(models.every(model => typeof model.slug === "string" && model.slug.startsWith("chatgpt-web/"))).toBe(true);
    expect(models.some(model => model.slug === "gpt-5.6-codex")).toBe(false);
    expect(models.some(model => model.slug === "chatgpt-work/pro")).toBe(false);
  });

  test("there is no public parser-side backend-model escape hatch", () => {
    const parsed = parseRequest({ model: CHATGPT_WEB_BACKEND_MODEL, input: "hello" });
    expect(() => routeChatGptWebRequest(parsed, defaultConfig())).toThrow();
  });
  test("internal Web backend IDs fail before native Codex passthrough", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    const response = await import("../src/server").then(({ responseRequest }) => responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: CHATGPT_WEB_BACKEND_MODEL, input: "hello", stream: false }),
      }),
      config,
      () => { throw new Error("Web adapter must not be selected"); },
    ));
    expect(response.status).toBe(400);
  });
});
