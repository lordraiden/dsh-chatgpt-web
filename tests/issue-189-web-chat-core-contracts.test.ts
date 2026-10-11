import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CHATGPT_WEB_CHAT_CLASSIFIED_CODES,
  CHATGPT_WEB_CHAT_UNCLASSIFIED_CODES,
  CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT,
  chatGptWebChatAccountBinding,
  chatGptWebChatTurnIdentity,
  classifyChatGptWebFailure,
} from "../src/adapters/chatgpt-web/web-chat-bridge";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  WEB_CHAT_ERROR_CATEGORIES,
  WEB_CHAT_EXCHANGE_EVENT_TYPES,
  WebChatError,
  assertTextOnlyWebChatTurn,
  assertWebChatReplayStateOwner,
  createWebChatDriverResolver,
  isWebChatError,
  isWebChatExchangeEventType,
  isWebChatModelDescriptor,
  isWebChatProviderReplayState,
  rejectUnsupportedWebChatFeatures,
  webChatConversationHandle,
  webChatConversationKey,
  webChatError,
  webChatReplayStateOwnedBy,
  type WebChatExchangeEvent,
  type WebChatProviderDriver,
} from "../src/web-chat/core";
import type { CodexParsedRequest } from "../src/types";

/**
 * Issue #189 — provider-neutral WebChat Core contracts.
 *
 * The core must describe a text-only web chat provider without knowing one, and the current
 * ChatGPT path must be expressible in it. These tests pin the contract itself (what it admits, what
 * it refuses, what it must never carry) and the consumption seam, including the exact conversation
 * key digests captured from `main` before the extraction.
 */

const ROOT = join(import.meta.dir, "..");

/** A real parsed ChatGPT request, shaped as the adapter consumes it. */
function chatGptRequest(threadId: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    context: { systemPrompt: [], messages: [] },
    stream: false,
    options: {},
    _dshContext: { dshSessionId: "dsh-session-1", threadId, turnId: "turn-1" },
  } as unknown as CodexParsedRequest;
}

/** Conversation keys captured from the pre-extraction implementation (must not change). */
const PINNED_CONVERSATION_KEYS: ReadonlyArray<{ namespace: string; threadId: string; key: string }> = [
  {
    namespace: "dsh-chatgpt-web",
    threadId: "dsh-111111111111111111111111",
    key: "8a0c4e8311c88118483ae736970f0f57a3d63c0359bfb3427646fdd1dacd1965",
  },
  {
    namespace: "dsh-chatgpt-web",
    threadId: "advisor-2222222222222222222222",
    key: "a78f92b42522eae632801d8ac2b1119404d6e425adb4fd045b9edb4d835da157",
  },
  {
    namespace: "other",
    threadId: "dsh-111111111111111111111111",
    key: "41db94f06480df467eb16855c619844407f9e37b0698d19447e4c33c4e6f6248",
  },
];

describe("issue #189 — error contract", () => {
  test("the vocabulary is the one the architecture lists, with no extras", () => {
    expect([...WEB_CHAT_ERROR_CATEGORIES]).toEqual([
      "AUTH_REQUIRED",
      "AUTH_EXPIRED",
      "ACCOUNT_UNAVAILABLE",
      "MODEL_UNAVAILABLE",
      "CONVERSATION_LOST",
      "CONVERSATION_STATE_MISMATCH",
      "SUBMISSION_AMBIGUOUS",
      "RESPONSE_TIMEOUT",
      "UPSTREAM_RATE_LIMITED",
      "UPSTREAM_ERROR",
      "INPUT_TOO_LARGE",
      "CANCELLED",
      "TRANSPORT_UNAVAILABLE",
      "UNSUPPORTED_OPTION",
      "SHUTDOWN",
    ]);
  });

  test("a category carries provider detail without being redefined", () => {
    const cause = new Error("socket closed");
    const failure = webChatError("TRANSPORT_UNAVAILABLE", "the page is gone", {
      providerId: "chatgpt-web",
      providerCode: "retained_surface_lost",
      providerDetail: { page: "closed" },
      cause,
    });
    expect(failure).toBeInstanceOf(WebChatError);
    expect(failure.category).toBe("TRANSPORT_UNAVAILABLE");
    expect(failure.providerId).toBe("chatgpt-web");
    expect(failure.providerCode).toBe("retained_surface_lost");
    expect(failure.providerDetail).toEqual({ page: "closed" });
    expect(failure.cause).toBe(cause);
    expect(failure.message).toBe("the page is gone");
  });

  test("recognition is structural, so a serialized failure is still recognized", () => {
    expect(isWebChatError(webChatError("CANCELLED", "stopped"))).toBe(true);
    const serialized = Object.assign(new Error("stopped"), { category: "CANCELLED" });
    expect(isWebChatError(serialized)).toBe(true);
    expect(isWebChatError(new Error("plain"))).toBe(false);
    expect(isWebChatError(Object.assign(new Error("bad"), { category: "NOT_A_CATEGORY" }))).toBe(false);
    expect(isWebChatError(null)).toBe(false);
    expect(isWebChatError("CANCELLED")).toBe(false);
  });
});

describe("issue #189 — normalized exchange events", () => {
  test("the vocabulary is exactly the six normalized events", () => {
    expect([...WEB_CHAT_EXCHANGE_EVENT_TYPES]).toEqual([
      "ready",
      "submitted",
      "text_delta",
      "completed",
      "cancelled",
      "error",
    ]);
    for (const type of WEB_CHAT_EXCHANGE_EVENT_TYPES) expect(isWebChatExchangeEventType(type)).toBe(true);
    expect(isWebChatExchangeEventType("reasoning_delta")).toBe(false);
    expect(isWebChatExchangeEventType(undefined)).toBe(false);
  });

  test("the union is exhaustively consumable with provider-specific phases absent", () => {
    const events: WebChatExchangeEvent[] = [
      { type: "ready" },
      { type: "submitted" },
      { type: "text_delta", text: "hola" },
      { type: "completed", text: "hola" },
      { type: "cancelled", reason: "user" },
      { type: "error", error: webChatError("UPSTREAM_ERROR", "boom") },
    ];
    const seen = events.map((event) => event.type);
    expect(seen).toEqual([...WEB_CHAT_EXCHANGE_EVENT_TYPES]);
    // No provider phase vocabulary leaks into the common events.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("commentary");
    expect(serialized).not.toContain("phase");
  });
});

describe("issue #189 — text-only admission", () => {
  test("a text turn is admitted and normalized to the semantic fields only", () => {
    const admitted = assertTextOnlyWebChatTurn({
      userText: "  revisa el diff  ",
      model: " chatgpt-web/light ",
      systemInstructions: ["eres un revisor"],
      developerInstructions: ["no inventes"],
      reasoningMode: "high",
      replayHistory: [{ role: "user", text: "antes" }, { role: "assistant", text: "después" }],
      // A field outside the common contract is dropped, not carried through.
      providerPrivate: { anything: true },
    });
    expect(admitted).toEqual({
      userText: "revisa el diff",
      model: "chatgpt-web/light",
      systemInstructions: ["eres un revisor"],
      developerInstructions: ["no inventes"],
      reasoningMode: "high",
      replayHistory: [{ role: "user", text: "antes" }, { role: "assistant", text: "después" }],
    });
    expect("providerPrivate" in admitted).toBe(false);
  });

  test("every feature outside the text-only layer is refused by name", () => {
    for (const feature of ["files", "images", "audio", "video", "attachments", "tools", "toolChoice", "mcp"]) {
      const candidate = { userText: "hola", model: "m", [feature]: [{ anything: true }] };
      expect(() => assertTextOnlyWebChatTurn(candidate)).toThrow(WebChatError);
      try {
        assertTextOnlyWebChatTurn(candidate);
        throw new Error("expected the turn to be refused");
      } catch (error) {
        expect(isWebChatError(error)).toBe(true);
        expect((error as WebChatError).category).toBe("UNSUPPORTED_OPTION");
        expect((error as WebChatError).message).toContain(feature);
      }
    }
  });

  test("an empty or absent feature slot carries nothing and is admitted", () => {
    expect(() => rejectUnsupportedWebChatFeatures({ files: [], images: [], tools: [], mcp: {} })).not.toThrow();
    expect(() => rejectUnsupportedWebChatFeatures({ files: null, images: undefined, tools: "" })).not.toThrow();
    expect(() => rejectUnsupportedWebChatFeatures(undefined)).not.toThrow();
    expect(() => assertTextOnlyWebChatTurn({ userText: "hola", model: "m", images: [] })).not.toThrow();
  });

  test("a malformed candidate is a caller defect, not a provider failure", () => {
    // Malformed input is not a provider failure, so it is not one of the semantic categories.
    expect(() => assertTextOnlyWebChatTurn(null)).toThrow(TypeError);
    expect(() => assertTextOnlyWebChatTurn({ model: "m" })).toThrow(TypeError);
    expect(() => assertTextOnlyWebChatTurn({ userText: "   ", model: "m" })).toThrow(TypeError);
    expect(() => assertTextOnlyWebChatTurn({ userText: "x", model: "" })).toThrow(TypeError);
    expect(() => assertTextOnlyWebChatTurn({ userText: "x", model: "m", replayHistory: [{ role: "tool", text: "x" }] })).toThrow(TypeError);
    expect(() => assertTextOnlyWebChatTurn({ userText: "x", model: "m", systemInstructions: [7] })).toThrow(TypeError);
  });

  test("the rejected candidate never reaches a driver with the feature silently dropped", () => {
    let refused = 0;
    try {
      assertTextOnlyWebChatTurn({ userText: "x", model: "m", images: [{ b64: "..." }] });
    } catch (error) {
      refused += 1;
      expect((error as WebChatError).providerDetail).toEqual({ unsupported: ["images"] });
    }
    expect(refused).toBe(1);
  });
});

describe("issue #189 — conversation key and opaque handle", () => {
  test("the key derivation is unchanged from the pre-extraction implementation", () => {
    for (const fixture of PINNED_CONVERSATION_KEYS) {
      expect(webChatConversationKey(fixture.namespace, fixture.threadId)).toBe(fixture.key);
      // The ChatGPT owner resolves the same key through the core derivation.
      expect(chatGptConversationKey(chatGptRequest(fixture.threadId), fixture.namespace)).toBe(fixture.key);
    }
  });

  test("namespace and thread both participate, and the key is stable", () => {
    const left = webChatConversationKey("ns", "thread");
    expect(left).toBe(webChatConversationKey("ns", "thread"));
    expect(left).not.toBe(webChatConversationKey("other", "thread"));
    expect(left).not.toBe(webChatConversationKey("ns", "other"));
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a handle is admitted opaquely and never interpreted", () => {
    expect(webChatConversationHandle("opaque-handle") as string | undefined).toBe("opaque-handle");
    expect(webChatConversationHandle("")).toBeUndefined();
    expect(webChatConversationHandle({ handle: "x" })).toBeUndefined();
    // Whatever shape the provider chose, the core keeps it verbatim.
    const handle = webChatConversationHandle("provider:private:state:42");
    expect(JSON.stringify({ handle })).toContain("provider:private:state:42");
  });
});

describe("issue #189 — driver contract and resolution", () => {
  function fakeDriver(id: string): WebChatProviderDriver {
    const conversation = {
      key: webChatConversationKey("ns", "thread"),
      providerId: id,
      bindingId: "binding-1",
      generation: 1,
      handle: webChatConversationHandle("handle-1")!,
      status: "resumable" as const,
    };
    return {
      id,
      inspectAccount: async () => ({ authenticated: true, accountFingerprint: "fp-1" }),
      listModels: async () => [{ id: "model-1", label: "Model 1", text: true, reasoningModes: ["low", "high"] }],
      resolveModel: async (model) => (model === "model-1" ? { id: "model-1", label: "Model 1", text: true } : undefined),
      assessConversation: async () => ({ status: "resumable" }),
      createConversation: async () => ({ ...conversation, status: "new" }),
      resumeConversation: async () => conversation,
      replayConversation: async () => ({ ...conversation, generation: 2, status: "resumable" }),
      health: async () => ({ ok: true }),
      shutdown: async () => {},
    };
  }

  test("a driver is implementable with text-only data and no browser page", async () => {
    const driver = fakeDriver("chatgpt-web");
    expect(await driver.inspectAccount()).toEqual({ authenticated: true, accountFingerprint: "fp-1" });
    const models = await driver.listModels();
    expect(models).toHaveLength(1);
    expect(isWebChatModelDescriptor(models[0])).toBe(true);
    expect(await driver.resolveModel("model-1")).toEqual({ id: "model-1", label: "Model 1", text: true });
    expect(await driver.resolveModel("other")).toBeUndefined();
    const created = await driver.createConversation({
      dshSession: { sessionId: "s" },
      binding: { providerId: "chatgpt-web", accountFingerprint: "fp-1" },
      affinity: { providerId: "chatgpt-web", bindingId: "binding-1", threadId: "thread" },
      model: "model-1",
    });
    expect(created.status).toBe("new");
    expect(created.handle as string).toBe("handle-1");
    expect(await driver.health()).toEqual({ ok: true });
  });

  test("a model descriptor must declare the text-only contract", () => {
    expect(isWebChatModelDescriptor({ id: "m", label: "M", text: true })).toBe(true);
    expect(isWebChatModelDescriptor({ id: "m", label: "M" })).toBe(false);
    expect(isWebChatModelDescriptor({ id: "", label: "M", text: true })).toBe(false);
  });

  test("resolution only maps an already-selected route, and never invents one", () => {
    const resolver = createWebChatDriverResolver([fakeDriver("chatgpt-web"), fakeDriver("qwen-web")]);
    expect(resolver.providerIds).toEqual(["chatgpt-web", "qwen-web"]);
    expect(resolver.resolve("chatgpt-web")?.id).toBe("chatgpt-web");
    expect(resolver.resolve("unknown")).toBeUndefined();
    expect(() => createWebChatDriverResolver([fakeDriver("chatgpt-web"), fakeDriver("chatgpt-web")]))
      .toThrow(/Duplicate WebChat provider driver id/);
  });
});

describe("issue #189 — provider-tagged replay state fails closed", () => {
  const expected = { providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-1" };

  test("only state that provably belongs to the conversation is owned", () => {
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-1", detail: {} }, expected)).toBe(true);
    // Cross-provider, cross-binding, wrong conversation, malformed and absent state are never owned.
    expect(webChatReplayStateOwnedBy({ providerId: "qwen-web", bindingId: "binding-1", conversationKey: "key-1", detail: {} }, expected)).toBe(false);
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-2", conversationKey: "key-1", detail: {} }, expected)).toBe(false);
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-2", detail: {} }, expected)).toBe(false);
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-1", detail: undefined }, expected)).toBe(false);
    expect(webChatReplayStateOwnedBy(null, expected)).toBe(false);
    expect(webChatReplayStateOwnedBy("key-1", expected)).toBe(false);
  });

  test("a caller that names no conversation accepts any key of its own binding", () => {
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-1", detail: {} }, { providerId: "chatgpt-web", bindingId: "binding-1" })).toBe(true);
    expect(webChatReplayStateOwnedBy({ providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-9", detail: {} }, { providerId: "chatgpt-web", bindingId: "binding-1" })).toBe(true);
  });

  test("an unowned state is refused with the semantic mismatch category", () => {
    expect(isWebChatProviderReplayState({ providerId: "chatgpt-web", bindingId: "b", detail: {} })).toBe(true);
    expect(() => assertWebChatReplayStateOwner({ providerId: "qwen-web", bindingId: "binding-1", detail: {} }, expected))
      .toThrow(WebChatError);
    try {
      assertWebChatReplayStateOwner({ providerId: "qwen-web", bindingId: "binding-1", detail: {} }, expected);
    } catch (error) {
      expect((error as WebChatError).category).toBe("CONVERSATION_STATE_MISMATCH");
    }
    expect(assertWebChatReplayStateOwner({ providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-1", detail: { x: 1 } }, expected))
      .toEqual({ providerId: "chatgpt-web", bindingId: "binding-1", conversationKey: "key-1", detail: { x: 1 } });
  });
});

describe("issue #189 — the ChatGPT path consumes the core", () => {
  test("a real ChatGPT turn is expressible as a core turn identity", () => {
    const parsed = chatGptRequest("dsh-111111111111111111111111");
    const projected = chatGptWebChatTurnIdentity(parsed, { bindingId: "binding-1", namespace: "dsh-chatgpt-web" });
    expect(projected).toEqual({
      bindingId: "binding-1",
      dshSessionId: "dsh-session-1",
      turnId: "turn-1",
      threadId: "dsh-111111111111111111111111",
      conversationKey: PINNED_CONVERSATION_KEYS[0]!.key,
    });
    // The provider-specific Luna fallback stays provider-specific: it still projects, and the
    // projection simply reports the thread the ChatGPT path would use.
    const lunaWithoutNativeContext = { modelId: "gpt-5.6-luna", context: { systemPrompt: [], messages: [] }, stream: false, options: {} } as unknown as CodexParsedRequest;
    expect(chatGptWebChatTurnIdentity(lunaWithoutNativeContext, { bindingId: "b", namespace: "ns" }).threadId).toBe("dsh-session");
    // A request with no provider identity at all fails closed rather than inventing one.
    const identityless = { modelId: "gpt-5.6-sol", context: { systemPrompt: [], messages: [] }, stream: false, options: {} } as unknown as CodexParsedRequest;
    expect(() => chatGptWebChatTurnIdentity(identityless, { bindingId: "b", namespace: "ns" })).toThrow(/no provider thread identity/);
    expect(() => chatGptWebChatTurnIdentity(parsed, { bindingId: "", namespace: "ns" })).toThrow(/binding identity/);
  });

  test("the ChatGPT account identity is expressible as a core account binding", () => {
    expect(chatGptWebChatAccountBinding({
      providerId: "chatgpt-web",
      accountFingerprint: "72d088c86234a9bc3cef9cf7",
      browserProfile: "/snap/bin/chromium",
      browserContext: "/home/user/state.json",
    })).toEqual({
      providerId: "chatgpt-web",
      accountFingerprint: "72d088c86234a9bc3cef9cf7",
      browserProfile: "/snap/bin/chromium",
      browserContext: "/home/user/state.json",
    });
    expect(chatGptWebChatAccountBinding({ providerId: "chatgpt-web", accountFingerprint: "fp" }))
      .toEqual({ providerId: "chatgpt-web", accountFingerprint: "fp" });
    expect(() => chatGptWebChatAccountBinding({ providerId: "chatgpt-web", accountFingerprint: "" })).toThrow(/account fingerprint/);
  });

  test("every ChatGPT failure code is classified or explicitly excluded with a reason", () => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
      }
    };
    walk(join(ROOT, "src", "adapters", "chatgpt-web"));
    files.push(join(ROOT, "src", "server.ts"));

    const codes = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/code:\s*"([a-z0-9_]+)"/g)) codes.add(match[1]!);
      for (const match of source.matchAll(/[A-Z_]+_CODE\s*=\s*"([a-z0-9_]+)"/g)) codes.add(match[1]!);
    }
    expect(codes.size).toBeGreaterThan(20);
    for (const code of codes) {
      const classified = CHATGPT_WEB_CHAT_CLASSIFIED_CODES.includes(code);
      const excluded = Object.hasOwn(CHATGPT_WEB_CHAT_UNCLASSIFIED_CODES, code);
      expect(
        classified || excluded,
        `ChatGPT failure code "${code}" is neither classified nor explicitly excluded; map it in web-chat-bridge.ts or document the exclusion`,
      ).toBe(true);
      expect(classified && excluded, `"${code}" is both classified and excluded`).toBe(false);
    }
    // The exclusions are documented reasons, not a dumping ground.
    for (const reason of Object.values(CHATGPT_WEB_CHAT_UNCLASSIFIED_CODES)) {
      expect(reason).toContain("architecture §20");
    }
  });

  test("classification is total: every classified code yields a vocabulary category", () => {
    for (const code of CHATGPT_WEB_CHAT_CLASSIFIED_CODES) {
      expect(WEB_CHAT_ERROR_CATEGORIES).toContain(classifyChatGptWebFailure(code));
      // A code is either classified or excluded, never both (the scan test enforces the union).
      expect(Object.hasOwn(CHATGPT_WEB_CHAT_UNCLASSIFIED_CODES, code)).toBe(false);
    }
    expect(classifyChatGptWebFailure({ code: "chatgpt_session_expired" })).toBe("AUTH_EXPIRED");
    expect(classifyChatGptWebFailure("chatgpt_submission_ambiguous")).toBe("SUBMISSION_AMBIGUOUS");
    expect(classifyChatGptWebFailure("something_new")).toBe(CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT);
    expect(classifyChatGptWebFailure(undefined)).toBe(CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT);
    expect(classifyChatGptWebFailure({ code: null })).toBe(CHATGPT_WEB_CHAT_UNCLASSIFIED_DEFAULT);
  });
});
