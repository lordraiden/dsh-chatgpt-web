import { describe, expect, test } from "bun:test";
import {
  accountIdentityFromStorageState,
  createChatGptWebRouteAuthority,
  requireChatGptWebRoute,
  availableChatGptWebRoutes,
} from "../src/chatgpt-web-authority";
import { defaultConfig } from "../src/config";
import { buildChatGptWebModelCatalog, buildChatGptWebModel } from "../src/model-catalog";
import { CHATGPT_WEB_LUNA_MODEL_ROUTE } from "../src/chatgpt-web-models";
import { modelsRequest } from "../src/server";

describe("issue #75 ChatGPT Web authority", () => {
  test("Free/limited Web capability exposes only non-Pro automatic routes", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: false,
    });
    expect(availableChatGptWebRoutes(authority).map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
    ]);
    expect(() => requireChatGptWebRoute("chatgpt-web/pro", authority)).toThrow(/unavailable/);
  });

  test("paid Web capability exposes Pro-gated routes", () => {
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

  test("unknown capability is fail-closed", () => {
    const authority = createChatGptWebRouteAuthority({
      capabilityState: {
        solAvailable: "unknown",
        proAvailable: "unknown",
      },
    });
    expect(availableChatGptWebRoutes(authority)).toEqual([]);
    expect(() => requireChatGptWebRoute("chatgpt-web/light", authority)).toThrow(/unknown or unverifiable/);
  });

  test("Codex/Work model ids are outside ChatGPT Web route authority", () => {
    const authority = createChatGptWebRouteAuthority({
      solAvailable: true,
      proAvailable: true,
    });
    expect(() => requireChatGptWebRoute("gpt-5.6-codex", authority)).toThrow(/outside this provider authority/);
    expect(() => requireChatGptWebRoute("chatgpt-work/pro", authority)).toThrow(/outside this provider authority/);
  });

  test("Web catalog rows contain only Web-owned fields", () => {
    const config = defaultConfig();
    const model = buildChatGptWebModel(CHATGPT_WEB_LUNA_MODEL_ROUTE, config);
    expect(model.slug).toBe("chatgpt-web/luna");
    expect(model).not.toHaveProperty("priority");
    expect(model).not.toHaveProperty("multi_agent_version");
    expect(model).not.toHaveProperty("comp_hash");
    expect(model).not.toHaveProperty("service_tiers_template");
  });

  test("Web catalog can be built without a native Codex catalog", () => {
    const config = defaultConfig();
    const catalog = buildChatGptWebModelCatalog(config);
    expect((catalog.models as Array<Record<string, unknown>>).map(model => model.slug)).toContain("chatgpt-web/luna");

    return modelsRequest(
      new Request("http://127.0.0.1/v1/models"),
      config,
      async () => new Response("native Codex unavailable", { status: 503 }),
    ).then(async response => {
      expect(response.status).toBe(200);
      const body = await response.json() as { models: Array<{ slug?: string }> };
      expect(body.models.some(model => model.slug === "chatgpt-web/luna")).toBe(true);
    });
  });

  test("authenticated session fingerprints are distinct from filesystem/profile identity", () => {
    const first = accountIdentityFromStorageState({
      cookies: [{ name: "session", value: "one", domain: "chatgpt.com" }],
      origins: [{ origin: "https://chatgpt.com", localStorage: [{ name: "a", value: "1" }] }],
    });
    const second = accountIdentityFromStorageState({
      cookies: [{ name: "session", value: "two", domain: "chatgpt.com" }],
      origins: [{ origin: "https://chatgpt.com", localStorage: [{ name: "a", value: "1" }] }],
    });
    expect(first.kind).toBe("authenticated-session");
    expect(second.kind).toBe("authenticated-session");
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{24}$/);
  });

  test("explicit manual Zero Risk route does not require automatic capability proof", () => {
    const authority = createChatGptWebRouteAuthority({
      browserInteractionMode: "manual",
      capabilityState: {
        solAvailable: "unknown",
        proAvailable: "unknown",
      },
    });
    expect(availableChatGptWebRoutes(authority).map(route => route.slug)).toEqual(["chatgpt-web/zero-risk"]);
  });
});
