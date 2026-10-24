import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig } from "../src/config";
import {
  DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES,
  DEEPSEEK_WEB_DEFAULT_MODEL_TYPES,
  DEEPSEEK_WEB_PROVIDER_ID,
  DEEPSEEK_WEB_RECORDED_BODY_KEYS,
  DEEPSEEK_WEB_SESSION_ID_PATHS,
  DEEPSEEK_WEB_UNSENT_BODY_KEYS,
  createMemoryDeepSeekConversationState,
  createDeepSeekDriver,
  deepSeekApiHeaders,
  deepSeekCatalogueNote,
  deepSeekCatalogueRows,
  deepSeekCatalogueVisible,
  deepSeekCompletionRequest,
  deepSeekEnvelope,
  deepSeekModelDescriptors,
  deepSeekRefusal,
  readDeepSeekCreatedSessionId,
  readDeepSeekProofChallenge,
  resolveDeepSeekProviderConfig,
  unprovenDeepSeekProofOfWork,
  type DeepSeekRefusalInput,
} from "../src/adapters/deepseek-web";
import { isWebChatError } from "../src/web-chat/core";

/**
 * The DeepSeek Web wire vocabulary, the two-layer envelope and the catalogue rule.
 *
 * Every value is synthetic. The keys, paths and codes come from `doc/provider-recon.md` §2.2–§2.5.
 */

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(() => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("deepseek-web-protocol-", { clearFreeHome: true });
});

afterEach(() => {
  restoreChatGptWebHome(savedHome, home);
});

/** The configuration block a real deployment would write. */
function withModelTypes(modelTypes: unknown): never {
  return {
    ...defaultConfig(),
    webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes } } },
  } as never;
}

describe("deepseek-web — the completion body carries the keys the recon settles", () => {
  test("a first turn sends a null parent and an empty file list", () => {
    const body = deepSeekCompletionRequest({
      chatSessionId: "session-fixture",
      modelType: "default",
      prompt: "hola",
      thinkingEnabled: false,
      searchEnabled: false,
    });
    // The measured body: nine keys, `action: null` and `preempt: false`. The capture shows the app
    // does **not** send `source`, so it is no longer part of the recorded key set.
    expect(body).toEqual({
      chat_session_id: "session-fixture",
      parent_message_id: null,
      model_type: "default",
      prompt: "hola",
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    });
    expect(Object.keys(body).sort()).toEqual([...DEEPSEEK_WEB_RECORDED_BODY_KEYS].sort());
    expect(DEEPSEEK_WEB_UNSENT_BODY_KEYS).toEqual([]);
    expect(body).not.toHaveProperty("source");
  });

  test("a continuation sends the measured cursor (its own scalar) and no model_type", () => {
    // The signed-in capture's second interaction: `parent_message_id` is the previous answer's
    // `response_message_id` **as a JSON number**, and the app does not re-declare `model_type`
    // (the session owns the model). Both are reproduced here, without coercing either value.
    const body = deepSeekCompletionRequest({
      chatSessionId: "session-fixture",
      parentMessageId: 1713945000123,
      modelType: null,
      prompt: "again",
      thinkingEnabled: true,
      searchEnabled: true,
    });
    expect(body["parent_message_id"]).toBe(1713945000123);
    expect(typeof body["parent_message_id"]).toBe("number");
    expect(body["model_type"]).toBeNull();
    expect(body["thinking_enabled"]).toBe(true);
    expect(body["search_enabled"]).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...DEEPSEEK_WEB_RECORDED_BODY_KEYS].sort());
    // A string id is kept as a string — the scalar the provider sent is what goes back.
    expect(deepSeekCompletionRequest({
      chatSessionId: "session-fixture",
      parentMessageId: "message-fixture",
      modelType: null,
      prompt: "again",
      thinkingEnabled: false,
      searchEnabled: false,
    })["parent_message_id"]).toBe("message-fixture");
  });

  test("a body without a session id or a model_type is a programming error, not a guess", () => {
    expect(() => deepSeekCompletionRequest({
      chatSessionId: "", modelType: "default", prompt: "x", thinkingEnabled: false, searchEnabled: false,
    })).toThrow(TypeError);
    expect(() => deepSeekCompletionRequest({
      chatSessionId: "s", modelType: "", prompt: "x", thinkingEnabled: false, searchEnabled: false,
    })).toThrow(TypeError);
    expect(() => deepSeekCompletionRequest({
      chatSessionId: "s",
      parentMessageId: "",
      modelType: null,
      prompt: "x",
      thinkingEnabled: false,
      searchEnabled: false,
    })).toThrow(TypeError);
  });

  test("the deep-link prefill literal is exported as a documented non-catalogue", () => {
    // Documented so the code can name the thing it must never serve from; it is not a seed anywhere.
    expect([...DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES]).toEqual(["default", "expert", "vision"]);
  });

  test("the base header set is the measured one, with no client/device/credential invented", () => {
    // The capture shows the app sends the wildcard accept media range on JSON calls *and* on the SSE
    // completion; the client/device family and the credential are supplied per request by the page.
    expect(deepSeekApiHeaders()).toEqual({ accept: "*/*", "content-type": "application/json" });
    expect(JSON.stringify(deepSeekApiHeaders())).not.toContain("x-client");
    expect(JSON.stringify(deepSeekApiHeaders())).not.toContain("x-device");
    expect(JSON.stringify(deepSeekApiHeaders())).not.toContain("Authorization");
  });
});

describe("deepseek-web — the two-layer envelope decides what a refusal means", () => {
  /** Classify one answer and return the shared error, asserting it is typed. */
  function refusal(input: Partial<DeepSeekRefusalInput> & { readonly status: number; readonly body?: unknown }): {
    readonly category: string;
    readonly providerCode?: string;
    readonly message: string;
  } {
    const error = deepSeekRefusal({
      status: input.status,
      what: input.what ?? "stream-a-completion",
      continuedSession: input.continuedSession ?? false,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.bodyText === undefined ? {} : { bodyText: input.bodyText }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    });
    expect(isWebChatError(error)).toBe(true);
    return { category: error.category, ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }), message: error.message };
  }

  test("the top-level 40002/40003 family is an authentication refusal at HTTP 200", () => {
    expect(refusal({ status: 200, body: { code: 40003, msg: "INVALID_TOKEN", data: null } }))
      .toMatchObject({ category: "AUTH_REQUIRED", providerCode: "DEEPSEEK_INVALID_TOKEN" });
    expect(refusal({ status: 200, body: { code: 40002, msg: "Missing Token", data: null } }))
      .toMatchObject({ category: "AUTH_REQUIRED", providerCode: "DEEPSEEK_INVALID_TOKEN" });
  });

  test("the nested data.biz_code layer is read too", () => {
    expect(refusal({ status: 200, body: { code: 0, msg: "", data: { biz_code: 40003, biz_msg: "INVALID_TOKEN" } } }))
      .toMatchObject({ category: "AUTH_REQUIRED", providerCode: "DEEPSEEK_BIZ_INVALID_TOKEN" });
  });

  test("a settings-style business refusal is not an authentication failure", () => {
    const mapped = refusal({
      status: 200,
      body: { code: 0, msg: "", data: { biz_code: 1, biz_msg: "SETTINGS_NOT_FOUND" } },
    });
    expect(mapped.category).toBe("UPSTREAM_ERROR");
    expect(mapped.providerCode).toBe("DEEPSEEK_CODE_1");
    expect(mapped.message).toContain("SETTINGS_NOT_FOUND");
  });

  test("a proof-of-work refusal is its own typed refusal, never a retry", () => {
    const mapped = refusal({ status: 200, body: { code: 0, msg: "", data: { biz_code: 1, biz_msg: "POW_HEADER_ERROR" } } });
    expect(mapped.category).toBe("UPSTREAM_ERROR");
    expect(mapped.providerCode).toBe("DEEPSEEK_POW_REJECTED");
    expect(mapped.message).toContain("proof of work");
  });

  test("a WAF challenge page is access verification, not a provider error", () => {
    const mapped = refusal({
      status: 202,
      bodyText: "<html><body>awsChallenge</body></html>",
      contentType: "text/html",
    });
    expect(mapped.category).toBe("AUTH_REQUIRED");
    expect(mapped.providerCode).toBe("DEEPSEEK_ACCESS_VERIFICATION");
    expect(mapped.message).toContain("chat.deepseek.com");
  });

  test("a recorded session the provider no longer has is a lost conversation, never a fork", () => {
    expect(refusal({ status: 404, body: { code: 0, msg: "", data: null }, continuedSession: true }))
      .toMatchObject({ category: "CONVERSATION_LOST", providerCode: "DEEPSEEK_SESSION_LOST" });
    expect(refusal({
      status: 200,
      body: { code: 0, msg: "", data: { biz_code: 404, biz_msg: "SESSION_NOT_FOUND" } },
      continuedSession: true,
    })).toMatchObject({ category: "CONVERSATION_LOST" });
    // The same answer on a *new* session is an upstream failure: nothing was continued.
    expect(refusal({ status: 404, body: { code: 0, msg: "", data: null }, continuedSession: false }).category)
      .toBe("UPSTREAM_ERROR");
  });

  test("an HTTP 401/403 is an authentication refusal even without an envelope", () => {
    expect(refusal({ status: 401 }).category).toBe("AUTH_REQUIRED");
    expect(refusal({ status: 403 }).category).toBe("AUTH_REQUIRED");
  });

  test("an unreadable answer is an upstream failure with its status kept", () => {
    const mapped = refusal({ status: 502, bodyText: "gateway", contentType: "text/plain" });
    expect(mapped.category).toBe("UPSTREAM_ERROR");
    expect(mapped.message).toContain("HTTP 502");
  });
});

describe("deepseek-web — the envelope helper reads both layers", () => {
  test("success needs both layers to agree", () => {
    expect(deepSeekEnvelope({ status: 200, body: { code: 0, msg: "", data: {} } }).accepted).toBe(true);
    expect(deepSeekEnvelope({ status: 200, body: { code: 0, data: { biz_code: 0 } } }).accepted).toBe(true);
    expect(deepSeekEnvelope({ status: 200, body: { code: 0, data: { biz_code: 1 } } }).accepted).toBe(false);
    expect(deepSeekEnvelope({ status: 200, body: { code: 40003 } }).accepted).toBe(false);
    expect(deepSeekEnvelope({ status: 200, body: "not json" }).accepted).toBe(false);
  });
});

describe("deepseek-web — the session id is read from its measured shape", () => {
  test("the recorded candidate paths resolve", () => {
    // The measured success shape: `{code:0, msg:"", data:{biz_code:0, biz_msg:"", biz_data:{chat_session:{id}}}}`.
    expect(readDeepSeekCreatedSessionId({
      status: 200,
      body: {
        code: 0,
        msg: "",
        data: { biz_code: 0, biz_msg: "", biz_data: { chat_session: { id: "session-a", model_type: "default" } } },
      },
    })).toBe("session-a");
    // The provisional alternatives from before the capture are gone: a different location is refused.
    expect(() => readDeepSeekCreatedSessionId({
      status: 200,
      body: { code: 0, msg: "", data: { chat_session: { id: "session-b" } } },
    })).toThrow();
  });

  test("an answer with no readable id is refused, naming the paths it tried", () => {
    let thrown: unknown;
    try {
      readDeepSeekCreatedSessionId({ status: 200, body: { code: 0, msg: "", data: { biz_data: { chat_session: {} } } } });
    } catch (error) {
      thrown = error;
    }
    expect(isWebChatError(thrown)).toBe(true);
    const error = thrown as { providerCode?: string; message: string };
    expect(error.providerCode).toBe("DEEPSEEK_SESSION_CREATE_UNREADABLE");
    for (const path of DEEPSEEK_WEB_SESSION_ID_PATHS) {
      expect(error.message).toContain(path.join("."));
    }
  });

  test("a refusal envelope on create is classified, not read for an id", () => {
    let thrown: unknown;
    try {
      readDeepSeekCreatedSessionId({ status: 200, body: { code: 40003, msg: "INVALID_TOKEN", data: null } });
    } catch (error) {
      thrown = error;
    }
    expect(isWebChatError(thrown)).toBe(true);
    expect((thrown as { category: string }).category).toBe("AUTH_REQUIRED");
  });
});

describe("deepseek-web — the proof of work is one seam whose default refuses", () => {
  test("the challenge is read from data.biz_data.challenge", () => {
    const challenge = readDeepSeekProofChallenge({
      status: 200,
      body: {
        code: 0,
        msg: "",
        data: {
          biz_data: {
            challenge: {
              challenge: "synthetic",
              difficulty: 4,
              salt: "s",
              signature: "sig",
              expire_at: 1_700_000_000,
              expire_after: 300,
            },
          },
        },
      },
    });
    expect(challenge).toMatchObject({
      challenge: "synthetic",
      difficulty: 4,
      salt: "s",
      signature: "sig",
      expireAt: 1_700_000_000,
      expireAfter: 300,
    });
    expect(challenge.raw).toHaveProperty("difficulty", 4);
  });

  test("a challenge at the wrong place is refused, never guessed", () => {
    let thrown: unknown;
    try {
      readDeepSeekProofChallenge({ status: 200, body: { code: 0, data: { challenge: { challenge: "x" } } } });
    } catch (error) {
      thrown = error;
    }
    expect(isWebChatError(thrown)).toBe(true);
    expect((thrown as { providerCode?: string }).providerCode).toBe("DEEPSEEK_POW_CHALLENGE_INVALID");
  });

  test("the default solver throws a typed TRANSPORT_UNAVAILABLE and never fabricates a header", async () => {
    const solver = unprovenDeepSeekProofOfWork();
    let thrown: unknown;
    try {
      await solver({ targetPath: "/api/v0/chat/completion", challenge: { raw: {} } });
    } catch (error) {
      thrown = error;
    }
    expect(isWebChatError(thrown)).toBe(true);
    const error = thrown as { category: string; providerCode?: string; message: string };
    expect(error.category).toBe("TRANSPORT_UNAVAILABLE");
    expect(error.providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");
    expect(error.message).toContain("proof of work");
    expect(error.message).toContain("chat.deepseek.com");
  });
});

describe("deepseek-web — the measured default row is served, and configuration overrides or extends it", () => {
  test("an unconfigured deployment publishes exactly the measured default row", () => {
    const config = defaultConfig();
    expect(deepSeekCatalogueVisible(config)).toBe(true);
    const provider = resolveDeepSeekProviderConfig(config);
    // One row, the measured enabled one: `default`. No second id is seeded, and the deep-link prefill
    // literal (`default`/`expert`/`vision`) is never a catalogue.
    expect(provider.modelTypes).toEqual(DEEPSEEK_WEB_DEFAULT_MODEL_TYPES);
    expect(provider.modelTypes).toEqual([{ id: "default", label: "DeepSeek Chat", thinking: true, search: true }]);
    const rows = deepSeekCatalogueRows(provider);
    expect(rows.map(row => row.slug)).toEqual([`${DEEPSEEK_WEB_PROVIDER_ID}/default`]);
    expect(rows[0]?.display_name).toBe("DeepSeek Chat");
    expect(deepSeekModelDescriptors(provider)).toEqual([{ id: "default", label: "DeepSeek Chat", text: true }]);
    // The two toggles are on because the site had them on in both captured completions.
    expect(provider.modelTypes[0]?.thinking).toBe(true);
    expect(provider.modelTypes[0]?.search).toBe(true);
    // The disabled server-side rows are never offered just because the prefill literal names them.
    for (const modelType of DEEPSEEK_WEB_DEEP_LINK_MODEL_TYPES) {
      if (modelType === "default") continue;
      expect(rows.map(row => row.slug)).not.toContain(`${DEEPSEEK_WEB_PROVIDER_ID}/${modelType}`);
    }
    expect(deepSeekCatalogueNote(config)).toContain("served by default: default");
    expect(deepSeekCatalogueNote(config)).toContain("no configuration is needed");
  });

  test("an explicit empty list is the deliberate 'serve nothing', not an error", () => {
    const config = withModelTypes([]);
    expect(deepSeekCatalogueVisible(config)).toBe(false);
    expect(deepSeekCatalogueRows(resolveDeepSeekProviderConfig(config))).toEqual([]);
    // The honest state still says why, and names the configuration field.
    const note = deepSeekCatalogueNote(config);
    expect(note).toContain('webChat.providers["deepseek-web"].modelTypes');
    expect(note).toContain("empty list");
  });

  test("configured model types override the seeded defaults and extend the list", () => {
    const config = withModelTypes([
      { id: "default", label: "My DeepSeek", thinking: false },
      { id: "expert", label: "DeepSeek Expert", thinking: true },
    ]);
    expect(deepSeekCatalogueVisible(config)).toBe(true);
    const provider = resolveDeepSeekProviderConfig(config);
    // `default` keeps the seeded label/toggles where the entry is silent (`search`), and the entry
    // overrides what it states (`label`, `thinking`). A non-seeded id takes the conservative defaults.
    expect(provider.modelTypes).toEqual([
      { id: "default", label: "My DeepSeek", thinking: false, search: true },
      { id: "expert", label: "DeepSeek Expert", thinking: true, search: false },
    ]);
    const rows = deepSeekCatalogueRows(provider);
    expect(rows.map(row => row.slug)).toEqual(["deepseek-web/default", "deepseek-web/expert"]);
    for (const row of rows) {
      expect(row["input_modalities"]).toEqual(["text"]);
      expect(row["supported_reasoning_levels"]).toEqual([]);
      expect(row["default_reasoning_level"]).toBeNull();
      expect(row["context_window"]).toBeNull();
      expect(row["max_context_window"]).toBeNull();
      expect(row["tool_mode"]).toBeNull();
    }
    expect(deepSeekModelDescriptors(provider)).toEqual([
      { id: "default", label: "My DeepSeek", text: true },
      { id: "expert", label: "DeepSeek Expert", text: true },
    ]);
    expect(deepSeekCatalogueNote(config)).toContain("configured: default, expert");
  });

  test("a plain id keeps the seeded defaults, and an explicit boolean overrides them", () => {
    expect(resolveDeepSeekProviderConfig(withModelTypes(["default"])).modelTypes).toEqual([
      { id: "default", label: "DeepSeek Chat", thinking: true, search: true },
    ]);
    expect(resolveDeepSeekProviderConfig(withModelTypes([
      { id: "default", thinking: false, search: false },
    ])).modelTypes).toEqual([
      { id: "default", label: "DeepSeek Chat", thinking: false, search: false },
    ]);
  });

  test("a malformed block is a configuration error, never a silent fallback", () => {
    expect(() => resolveDeepSeekProviderConfig({
      ...defaultConfig(),
      webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes: "default" } } },
    } as never)).toThrow(/modelTypes/);
    expect(() => resolveDeepSeekProviderConfig({
      ...defaultConfig(),
      webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes: ["default", "default"] } } },
    } as never)).toThrow(/duplicate/);
    expect(() => resolveDeepSeekProviderConfig({
      ...defaultConfig(),
      webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes: [{ id: "default", thinking: "yes" }] } } },
    } as never)).toThrow(/thinking/);
    // An unknown field is a typed configuration error, never silently ignored: a typo must not look
    // like a configured capability.
    expect(() => resolveDeepSeekProviderConfig({
      ...defaultConfig(),
      webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes: [{ id: "default", reasoning: true }] } } },
    } as never)).toThrow(/modelTypes\[0\]\.reasoning: unknown field/);
    expect(() => resolveDeepSeekProviderConfig({
      ...defaultConfig(),
      webChat: { providers: { [DEEPSEEK_WEB_PROVIDER_ID]: { modelTypes: [{ id: "default", enabled: false }] } } },
    } as never)).toThrow(/unknown field/);
  });

  test("the provider reads its own credential directory, never another provider's", () => {
    const provider = resolveDeepSeekProviderConfig(withModelTypes(["default"]));
    expect(provider.storageStatePath).toBe(`${home}/providers/${DEEPSEEK_WEB_PROVIDER_ID}/storage-state.json`);
    expect(provider.chatStatePath).toBe(`${home}/providers/${DEEPSEEK_WEB_PROVIDER_ID}/conversations.json`);
    expect(provider.accountIdentityRecorded).toBe(false);
    expect(provider.accountFingerprint).toBe("deepseek-web-unrecorded-account");
  });
});

describe("deepseek-web — the driver states its own unproven facts", () => {
  test("it is unhealthy without a verified session, and says a capture is not one", async () => {
    const driver = createDeepSeekDriver({
      provider: resolveDeepSeekProviderConfig(withModelTypes(["default"])),
      state: createMemoryDeepSeekConversationState(),
    });
    const health = await driver.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("no DeepSeek session is stored");
    const account = await driver.inspectAccount();
    expect(account.authenticated).toBe(false);
    expect(account.capabilities).toMatchObject({ text: "supported", tools: "unsupported", images: "unsupported" });
    expect(account).not.toHaveProperty("accountFingerprint");
  });

  test("no reasoning level is resolvable, and the seeded row resolves without configuration", async () => {
    const driver = createDeepSeekDriver({
      provider: resolveDeepSeekProviderConfig(withModelTypes(["default"])),
      state: createMemoryDeepSeekConversationState(),
    });
    expect(await driver.resolveModel("deepseek-web/default")).toMatchObject({ id: "default" });
    expect(await driver.resolveModel("deepseek-web/default", "Thinking")).toBeUndefined();
    // No configuration at all still resolves the measured default row: that is what makes the provider
    // selectable. An explicitly empty list is the only state that serves no model.
    const unconfigured = createDeepSeekDriver({
      provider: resolveDeepSeekProviderConfig(defaultConfig()),
      state: createMemoryDeepSeekConversationState(),
    });
    expect(await unconfigured.resolveModel("deepseek-web/default")).toMatchObject({ id: "default" });
    expect(await unconfigured.resolveModel("deepseek-web/expert")).toBeUndefined();
    expect(await unconfigured.health()).toMatchObject({ ok: false });
    const nothing = createDeepSeekDriver({
      provider: resolveDeepSeekProviderConfig(withModelTypes([])),
      state: createMemoryDeepSeekConversationState(),
    });
    expect(await nothing.resolveModel("deepseek-web/default")).toBeUndefined();
  });
});
