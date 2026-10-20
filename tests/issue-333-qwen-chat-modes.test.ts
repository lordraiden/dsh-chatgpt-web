import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config";
import {
  QWEN_CHAT_SEED_MODELS,
  QwenChatRequestError,
  createMemoryQwenChatConversationState,
  createQwenChatDriver,
  parseQwenChatPublicModels,
  qwenChatCatalogueRows,
  qwenChatDefaultMode,
  qwenChatFeatureConfig,
  qwenChatModesForModel,
  qwenChatCompletionRequest,
  qwenChatTurnMode,
  refreshQwenChatModels,
  resolveQwenChatProviderConfig,
  type QwenChatMode,
  type QwenChatProviderConfig,
} from "../src/adapters/qwen-chat";

/**
 * The mode mechanism and the model catalogue.
 *
 * The mode rule is the vendor bundle's own (`mv`/`gv`, quoted in `doc/provider-recon.md` §1.5); these
 * cases pin each branch of it rather than a paraphrase. The payload cases pin the exact
 * `feature_config` the recorded builder writes for each label.
 */

const ACCOUNT = "issue-333-qwen-chat-modes-account";

/** A provider config whose models spell out each ability branch. */
function providerWithModels(models: readonly unknown[]): QwenChatProviderConfig {
  return resolveQwenChatProviderConfig({
    ...defaultConfig(),
    webChat: {
      providers: {
        "qwen-chat": {
          accountIdentityFingerprint: ACCOUNT,
          models,
        },
      },
    },
  } as never);
}

describe("issue #333 — mode availability mirrors the vendor bundle rule", () => {
  test("auto_thinking decides whether Auto is offered", () => {
    expect(qwenChatModesForModel({ thinking: 1, autoThinking: true })).toEqual(["Auto", "Thinking", "Fast"]);
    expect(qwenChatModesForModel({ thinking: 4, autoThinking: true })).toEqual(["Auto", "Thinking"]);
    expect(qwenChatModesForModel({ thinking: 1, autoThinking: false })).toEqual(["Thinking", "Fast"]);
  });

  test("the numeric abilities enum maps to the recorded mode sets", () => {
    expect(qwenChatModesForModel({ thinking: 1 })).toEqual(["Thinking", "Fast"]);
    expect(qwenChatModesForModel({ thinking: 2 })).toEqual([]);
    expect(qwenChatModesForModel({ thinking: 3 })).toEqual(["Thinking", "Fast"]);
    expect(qwenChatModesForModel({ thinking: 4 })).toEqual(["Thinking"]);
    // The API sometimes renders the enum as a boolean; the rule accepts both.
    expect(qwenChatModesForModel({ thinking: true })).toEqual(["Thinking", "Fast"]);
    expect(qwenChatModesForModel({ thinking: false })).toEqual(["Thinking", "Fast"]);
  });

  test("an unknown ability follows the recorded default branch, never an invented Auto", () => {
    expect(qwenChatModesForModel({})).toEqual(["Thinking", "Fast"]);
  });

  test("the default mode mirrors gv", () => {
    expect(qwenChatDefaultMode({ thinking: 1, autoThinking: true })).toBe("Auto");
    expect(qwenChatDefaultMode({ thinking: 2 })).toBeUndefined();
    expect(qwenChatDefaultMode({ thinking: 3 })).toBe("Thinking");
    expect(qwenChatDefaultMode({ thinking: 4 })).toBe("Thinking");
    expect(qwenChatDefaultMode({ thinking: 1 })).toBe("Fast");
    expect(qwenChatDefaultMode({})).toBe("Fast");
  });

  test("qwenChatTurnMode refuses a mode the model does not offer and names the valid ones", () => {
    const fastOnly = { id: "m-fast", label: "M Fast", thinking: 1 as const };
    expect(() => qwenChatTurnMode(fastOnly, "Auto")).toThrow(QwenChatRequestError);
    let error: unknown;
    try {
      qwenChatTurnMode(fastOnly, "Auto");
    } catch (caught) {
      error = caught;
    }
    expect((error as QwenChatRequestError).code).toBe("unknown_reasoning_mode");
    expect((error as QwenChatRequestError).message).toContain("Thinking, Fast");
    expect(qwenChatTurnMode(fastOnly, "Thinking")).toEqual({ mode: "Thinking" });
    expect(qwenChatTurnMode(fastOnly, undefined)).toEqual({ mode: "Fast" });
  });

  test("a model whose abilities hide the selection resolves to no mode at all", () => {
    const hidden = { id: "m-hidden", label: "M Hidden", thinking: 2 as const };
    expect(qwenChatTurnMode(hidden, undefined)).toEqual({});
    expect(() => qwenChatTurnMode(hidden, "Fast")).toThrow(QwenChatRequestError);
  });
});

describe("issue #333 — the mode travels in feature_config, per message", () => {
  const cases: readonly {
    readonly mode: QwenChatMode;
    readonly thinkingEnabled: boolean;
    readonly autoThinking: boolean;
  }[] = [
    { mode: "Auto", thinkingEnabled: true, autoThinking: true },
    { mode: "Thinking", thinkingEnabled: true, autoThinking: false },
    { mode: "Fast", thinkingEnabled: false, autoThinking: false },
  ];

  for (const item of cases) {
    test(`${item.mode} writes the label plus both derived booleans`, () => {
      expect(qwenChatFeatureConfig({ mode: item.mode, thinkingFormat: "summary" })).toEqual({
        thinking_enabled: item.thinkingEnabled,
        auto_thinking: item.autoThinking,
        thinking_mode: item.mode,
        ...(item.thinkingEnabled ? { thinking_format: "summary" } : {}),
        output_schema: "phase",
      });
    });
  }

  test("thinking_format is only written when thinking is on", () => {
    expect(qwenChatFeatureConfig({ mode: "Fast", thinkingFormat: "summary" }))
      .not.toHaveProperty("thinking_format");
  });

  test("the completion body carries the mode only inside messages[0].feature_config", () => {
    const request = qwenChatCompletionRequest({
      chatId: "chat-fixture",
      prompt: "hola",
      model: "qwen3.7-plus",
      mode: "Thinking",
      thinkingFormat: "summary",
      timestampSeconds: 1,
      messageId: "msg-1",
      assistantId: "msg-2",
      requestId: "request-1",
    });
    expect(request.requestId).toBe("request-1");
    // The recorded body keys, and nothing that only exists as a header.
    expect(request.body).toMatchObject({
      stream: true,
      version: "2.1",
      incremental_output: true,
      chatId: "chat-fixture",
      chat_id: "chat-fixture",
      parentId: "",
      parent_id: null,
      chat_mode: "normal",
      model: "qwen3.7-plus",
      timestamp: 1,
    });
    expect(request.body).not.toHaveProperty("headers");
    expect(request.body).not.toHaveProperty("thinking_mode");
    const messages = request.body["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!["feature_config"]).toEqual({
      thinking_enabled: true,
      auto_thinking: false,
      thinking_mode: "Thinking",
      thinking_format: "summary",
      output_schema: "phase",
    });
  });

  test("a continuation names the parent cursor in both the top-level and message shapes", () => {
    const request = qwenChatCompletionRequest({
      chatId: "chat-fixture",
      prompt: "again",
      model: "qwen3.7-plus",
      mode: "Fast",
      timestampSeconds: 2,
      messageId: "msg-3",
      assistantId: "msg-4",
      parentId: "response-fixture",
    });
    expect(request.body["parentId"]).toBe("response-fixture");
    expect(request.body["parent_id"]).toBe("response-fixture");
    const message = (request.body["messages"] as Record<string, unknown>[])[0]!;
    expect(message["parentId"]).toBe("response-fixture");
    expect(message["parent_id"]).toBeNull();
  });
});

describe("issue #333 — the catalogue publishes real ids and their real modes", () => {
  test("the seed is the measured list, and every seed model is usable", () => {
    expect(QWEN_CHAT_SEED_MODELS.map(model => model.id)).toEqual([
      "qwen3.7-plus",
      "qwen3.8-max",
      "qwen3.8-omni-flash",
    ]);
    for (const model of QWEN_CHAT_SEED_MODELS) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  test("rows expose exactly the modes each model's abilities support", () => {
    const provider = providerWithModels([
      { id: "m-auto", label: "M Auto", thinking: 1, autoThinking: true },
      { id: "m-think", label: "M Think", thinking: 4, autoThinking: true },
      { id: "m-fast", label: "M Fast", thinking: 1 },
      { id: "m-hidden", label: "M Hidden", thinking: 2 },
    ]);
    const rows = qwenChatCatalogueRows(provider);
    expect(rows.map(row => row.slug)).toEqual([
      "qwen-chat/m-auto",
      "qwen-chat/m-think",
      "qwen-chat/m-fast",
      "qwen-chat/m-hidden",
    ]);
    expect(rows[0]!.supported_reasoning_levels).toEqual([
      { effort: "Auto", description: expect.any(String) },
      { effort: "Thinking", description: expect.any(String) },
      { effort: "Fast", description: expect.any(String) },
    ]);
    expect(rows[0]!.default_reasoning_level).toBe("Auto");
    expect(rows[1]!.supported_reasoning_levels).toEqual([
      { effort: "Auto", description: expect.any(String) },
      { effort: "Thinking", description: expect.any(String) },
    ]);
    expect(
      (rows[2]!.supported_reasoning_levels as { effort: string }[]).map(level => level.effort),
    ).toEqual(["Thinking", "Fast"]);
    expect(rows[2]!.default_reasoning_level).toBe("Fast");
    expect(rows[3]!.supported_reasoning_levels).toEqual([]);
    expect(rows[3]!.default_reasoning_level).toBeNull();
  });

  test("the driver resolves the route and refuses an unsupported mode", async () => {
    const provider = providerWithModels([
      { id: "m-auto", label: "M Auto", thinking: 1, autoThinking: true },
      { id: "m-fast", label: "M Fast", thinking: 1 },
    ]);
    const driver = createQwenChatDriver({
      provider,
      state: createMemoryQwenChatConversationState(),
    });
    expect(await driver.resolveModel("qwen-chat/m-auto", "Auto")).toMatchObject({ id: "m-auto" });
    expect(await driver.resolveModel("qwen-chat/m-auto", undefined)).toMatchObject({ id: "m-auto" });
    expect(await driver.resolveModel("qwen-chat/m-fast", "Auto")).toBeUndefined();
    expect(await driver.resolveModel("qwen-chat/m-fast", "Fast")).toMatchObject({ id: "m-fast" });
    expect(await driver.resolveModel("qwen-chat/not-served")).toBeUndefined();
  });
});

describe("issue #333 — the public model list is a hint, parsed from both envelopes", () => {
  const v2 = {
    success: true,
    request_id: "req",
    data: {
      data: [{
        id: "qwen3.7-plus",
        name: "Qwen3.7-Plus",
        info: {
          meta: {
            auto_thinking: true,
            thinking_format: "summary",
            max_context_length: 1_000_000,
            abilities: { thinking: 1 },
          },
        },
      }],
    },
  };
  const v1 = {
    data: [{
      id: "qwen3.8-max",
      name: "Qwen3.8-Max",
      info: { meta: { auto_thinking: true, abilities: { thinking: 4 } } },
    }],
  };

  test("both measured envelopes parse", () => {
    expect(parseQwenChatPublicModels(v2)).toEqual([{
      id: "qwen3.7-plus",
      label: "Qwen3.7-Plus",
      thinking: 1,
      autoThinking: true,
      thinkingFormat: "summary",
      contextWindow: 1_000_000,
    }]);
    expect(parseQwenChatPublicModels(v1)).toMatchObject([{ id: "qwen3.8-max", thinking: 4 }]);
  });

  test("an answer with no model is a refusal, never an empty catalogue", () => {
    expect(() => parseQwenChatPublicModels({ data: [] })).toThrow();
    expect(() => parseQwenChatPublicModels({ nope: true })).toThrow();
  });

  test("refresh tries v2 then v1 and caches what it read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qwen-chat-models-"));
    const file = join(directory, "models.json");
    const requested: string[] = [];
    try {
      const models = await refreshQwenChatModels({
        file,
        fetchImpl: async url => {
          requested.push(url);
          if (url.includes("/api/v2/models")) {
            return { ok: false, status: 404, json: async () => ({}) };
          }
          return { ok: true, status: 200, json: async () => v1 };
        },
      });
      expect(requested).toEqual([
        "https://chat.qwen.ai/api/v2/models",
        "https://chat.qwen.ai/api/models",
      ]);
      expect(models.map(model => model.id)).toEqual(["qwen3.8-max"]);
      const cached = JSON.parse(readFileSync(file, "utf8")) as { version: number; models: { id: string }[] };
      expect(cached.version).toBe(1);
      expect(cached.models.map(model => model.id)).toEqual(["qwen3.8-max"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a refresh that reads no list leaves the cache alone and fails loudly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qwen-chat-models-"));
    const file = join(directory, "models.json");
    try {
      await expect(refreshQwenChatModels({
        file,
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      })).rejects.toThrow(/could not be read/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
