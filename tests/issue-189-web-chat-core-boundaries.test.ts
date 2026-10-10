import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #189 — WebChat Core boundary rules (architecture §18.1).
 *
 * The core is a semantic layer, not a second runtime: it may not reach into a provider, a browser,
 * the host's routing authority, or a store. These are source scans (the pattern the repository
 * already uses for import boundaries), plus a pinned export inventory so the core cannot grow
 * silently.
 */

const ROOT = join(import.meta.dir, "..");
const CORE_DIR = join(ROOT, "src", "web-chat", "core");

function coreFiles(): string[] {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
  return walk(CORE_DIR);
}

const coreSources = (): Array<{ path: string; source: string }> => coreFiles().map((path) => ({
  path: path.slice(ROOT.length + 1),
  source: readFileSync(path, "utf8"),
}));

describe("issue #189 — the core imports nothing outside itself", () => {
  test("every core import is a node builtin or a module inside the core", () => {
    for (const { path, source } of coreSources()) {
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const isBuiltin = specifier.startsWith("node:");
        const isInsideCore = specifier.startsWith("./") || specifier.startsWith("../");
        expect(
          isBuiltin || isInsideCore,
          `${path} imports "${specifier}"; the core may only import node builtins or its own modules`,
        ).toBe(true);
        if (isInsideCore) {
          expect(
            specifier.startsWith("./") || specifier.startsWith("../core/"),
            `${path} imports "${specifier}" outside the core directory`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("issue #189 — the core carries no provider, browser or routing knowledge", () => {
  const forbidden = [
    { pattern: /playwright/i, why: "an automation library is a provider transport detail" },
    { pattern: /\bLocator\b/, why: "a DOM locator is a provider transport detail" },
    { pattern: /\bBrowserContext\b/, why: "a browser context is a transport resource, not the core" },
    { pattern: /data-testid|querySelector|innerText/, why: "DOM selectors are provider-owned" },
    { pattern: /ctx\.llm|registerAdapter|LlmAdapter\b/, why: "the host runtime owns provider routing" },
    { pattern: /\bCodexParsedRequest\b|\bGenerateOptions\b|\bStreamChunk\b|\bAppConfig\b/, why: "host wire shapes are not the common contract" },
    { pattern: /chatgpt|qwen|deepseek/i, why: "a provider name in the core means provider knowledge leaked" },
    { pattern: /\/v1\/|https?:\/\//, why: "endpoint schemas belong to the driver" },
    // The rule catches credential *access or storage*, not the names themselves: the core must be
    // able to refuse to persist them (conversation-store.ts owns that refusal).
    { pattern: /\.cookie\s*[(=]|document\.cookie|navigator\.credentials|controlToken\s*[:=]|storageState\s*[:=]|_authToken\s*[:=]/, why: "credentials and session material never reach the core" },
  ];

  test("no forbidden concept appears in any core module", () => {
    for (const { path, source } of coreSources()) {
      for (const { pattern, why } of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern} — ${why}`).toBe(false);
      }
    }
  });
});

describe("issue #189 — the core is not a store, a registry or a transcript", () => {
  test("no persistence, no transcript API, no opaque-handle interpretation", () => {
    const forbidden = [
      /node:fs|writeFileSync|readFileSync/,
      /localStorage|sessionStorage|indexedDB/,
      /JSON\.parse/,
      /appendToTranscript|createWebChatTranscript|transcript\s*[:=]|\.append\(\s*\{\s*role/,
    ];
    for (const { path, source } of coreSources()) {
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern}; the core must keep no state`).toBe(false);
      }
    }
  });

  test("the published core surface is pinned, and holds no store/registry/catalog owner", () => {
    const indexPath = join(CORE_DIR, "index.ts");
    const source = readFileSync(indexPath, "utf8");
    const exported = [...source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter((entry) => entry.length > 0)
      .sort();

    const EXPECTED_CORE_SURFACE = [
      "WEB_CHAT_ERROR_CATEGORIES",
      "WEB_CHAT_EXCHANGE_EVENT_TYPES",
      "WebChatAccountBinding",
      "WebChatAccountBindingId",
      "WebChatAccountInspection",
      "WebChatAffinityKeyInput",
      "WebChatContinuationIntent",
      "WebChatContinuationOutcome",
      "WebChatContinuationPlan",
      "WebChatContinuationRequest",
      "WebChatConversation",
      "WebChatConversationAffinity",
      "WebChatConversationAssessment",
      "WebChatConversationAssessmentInput",
      "WebChatConversationCreateInput",
      "WebChatConversationDraft",
      "WebChatConversationHandle",
      "WebChatConversationIdentity",
      "WebChatConversationInitialization",
      "WebChatConversationRecord",
      "WebChatConversationReplayInput",
      "WebChatConversationResumeInput",
      "WebChatConversationSelection",
      "WebChatConversationStatus",
      "WebChatConversationStore",
      "WebChatConversationStoreOptions",
      "WebChatDriverResolver",
      "WebChatDshSessionIdentity",
      "WebChatError",
      "WebChatErrorCategory",
      "WebChatErrorOptions",
      "WebChatExchange",
      "WebChatExchangeCancelledEvent",
      "WebChatExchangeCompletedEvent",
      "WebChatExchangeErrorEvent",
      "WebChatExchangeEvent",
      "WebChatExchangeEventType",
      "WebChatExchangeReadyEvent",
      "WebChatExchangeSubmittedEvent",
      "WebChatExchangeTextDeltaEvent",
      "WebChatModelDescriptor",
      "WebChatProviderDriver",
      "WebChatProviderHealth",
      "WebChatProviderReplayState",
      "WebChatReasoningMode",
      "WebChatReplayMessage",
      "WebChatReplayStateOwner",
      "WebChatTurnCandidate",
      "WebChatTurnIdentity",
      "WebChatTurnInput",
      "assertCurrentWebChatGeneration",
      "assertNoWebChatSecrets",
      "assertTextOnlyWebChatTurn",
      "assertWebChatReplayStateOwner",
      "beginWebChatConversationAttempt",
      "commitWebChatConversationDraft",
      "confirmWebChatConversation",
      "createMemoryConversationStore",
      "createWebChatDriverResolver",
      "isWebChatError",
      "isWebChatExchangeEventType",
      "isWebChatInitializationCurrent",
      "isWebChatModelDescriptor",
      "isWebChatProviderReplayState",
      "legacyWebChatThreadKey",
      "rejectUnsupportedWebChatFeatures",
      "resolveWebChatContinuation",
      "validateWebChatConversationRecord",
      "webChatAccountBindingId",
      "webChatAffinityKey",
      "webChatContinuationIdentity",
      "webChatConversationHandle",
      "webChatError",
      "webChatReplayStateOwnedBy",
    ];
    // Code-unit sort, exactly what the parser's `.sort()` produces.
    expect(exported).toEqual([...EXPECTED_CORE_SURFACE].sort());

    // The pin is what keeps the core small: no durable implementation, no transcript, no catalog
    // and no provider registry. The conversation-store seam is the one allowed state surface —
    // architecture §18 puts `core/conversation-store.ts` in the core — and it is a port plus its
    // in-memory reference implementation: it holds no module state and performs no I/O.
    const CONVERSATION_STORE_SEAM = new Set([
      "WebChatConversationStore",
      "WebChatConversationStoreOptions",
      "createMemoryConversationStore",
    ]);
    for (const name of exported.filter((entry) => !CONVERSATION_STORE_SEAM.has(entry))) {
      expect(
        /store|transcript|persist|catalog|registry|register|append/i.test(name),
        `the core exports "${name}", which owns state or provider policy`,
      ).toBe(false);
    }
  });
});

describe("issue #189 — dependency direction", () => {
  test("provider code imports the core, and the core never imports provider code", () => {
    const providerFiles = [
      join(ROOT, "src", "adapters", "chatgpt-web", "conversation-key.ts"),
      join(ROOT, "src", "adapters", "chatgpt-web", "web-chat-bridge.ts"),
    ];
    for (const path of providerFiles) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must import the core`).toContain("web-chat/core");
    }
    for (const { path, source } of coreSources()) {
      expect(source, `${path} must not import provider code`).not.toContain("adapters/");
      expect(source, `${path} must not import provider code`).not.toContain("chatgpt-web");
    }
  });
});
