import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as core from "../src/web-chat/core";
import { assertTextOnlyWebChatTurn } from "../src/web-chat/core/exchange";
import { decideWebChatRetry, webChatRetrySafetyOf } from "../src/web-chat/core/retry-authority";
import {
  createMemoryConversationStore,
  webChatAccountBindingId,
  webChatConversationHandle,
  webChatContinuationIdentity,
  type WebChatAccountBinding,
} from "../src/web-chat/core";

/**
 * Issue #194 — provider-neutral WebChat architecture contracts.
 *
 * The suite used to prove provider-neutrality, dependency direction, record shape and the core
 * surface by reading `src/**` and asserting on its text. Each surviving intent is asserted here
 * through observable behaviour instead: the runtime module surface, the store's own refusals, and
 * the lifecycle/retry vocabulary. Architecture invariants that cannot be expressed behaviourally
 * (import direction, forbidden identifiers) are recorded in the test-hardening report.
 */

/** The runtime value exports the core publishes; type-only exports are covered by `tsc`. */
const EXPECTED_CORE_RUNTIME_SURFACE = [
  // Issue #276 added the interactive-auth contract: the state vocabulary plus the guards. They are
  // deliberately in the pinned surface — the auth relay must validate its own inputs, frames and
  // capture envelope, and a rename or an extra auth value is a surface change, not just a diff.
  "AUTH_SESSION_STATES",
  "WEB_CHAT_ERROR_CATEGORIES",
  "WEB_CHAT_EXCHANGE_EVENT_TYPES",
  "WebChatError",
  "WebChatExchangeLifecycle",
  "assertCurrentWebChatGeneration",
  "assertNoWebChatSecrets",
  "assertTextOnlyWebChatTurn",
  "assertWebChatReplayStateOwner",
  "beginWebChatConversationAttempt",
  "commitWebChatConversationDraft",
  "confirmWebChatConversation",
  "createMemoryConversationStore",
  "createWebChatDriverResolver",
  "decideWebChatRetry",
  "isAuthCapture",
  "isAuthInput",
  "isAuthSessionState",
  "isProviderAuthView",
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
  "webChatRetrySafetyOf",
].sort();

const ROOT = join(import.meta.dir, "..");

const BINDING: WebChatAccountBinding = {
  providerId: "chatgpt-web",
  accountFingerprint: "fp-194",
  browserProfile: "/snap/bin/chromium",
};

const IDENTITY = webChatContinuationIdentity({
  binding: BINDING,
  dshSession: { sessionId: "dsh-session-194" },
  threadId: "dsh-thread-194",
  namespace: "dsh-chatgpt-web",
});

describe("issue #194 — the published core surface", () => {
  test("the runtime surface is pinned, and holds no store/registry/catalog owner", () => {
    const exported = Object.keys(core)
      .filter(name => name !== "default")
      .sort();
    // The runtime module is what a consumer can actually import: pinning it makes an added
    // authority or a renamed public value a test failure, not just a diff.
    expect(exported).toEqual([...EXPECTED_CORE_RUNTIME_SURFACE].sort());

    // The one allowed state owner is the conversation-store seam (architecture §18): a port plus its
    // in-memory reference implementation. Anything else that owns state or provider policy is a leak.
    const ALLOWED_STATE_OWNER = new Set(["createMemoryConversationStore"]);
    for (const name of exported.filter(name => !ALLOWED_STATE_OWNER.has(name))) {
      expect(
        /store|transcript|persist|catalog|registry|register|append/i.test(name),
        `the core exports "${name}", which owns state or provider policy`,
      ).toBe(false);
    }
  });

  test("the stored record shape is pinned: no transport resource and no credential field", async () => {
    const store = createMemoryConversationStore({ now: () => 1_000 });
    const record = await store.update(IDENTITY, () => ({
      identity: IDENTITY,
      generation: 1,
      handle: webChatConversationHandle("opaque-handle-1")!,
      status: "resumable",
      checkpoint: "confirmed",
    }));

    // The persisted record carries only the continuity fields, and never a physical resource or
    // credential field.
    const ALLOWED_RECORD_KEYS = [
      "checkpoint",
      "createdAt",
      "generation",
      "handle",
      "identity",
      "initialization",
      "lastConfirmedTurn",
      "revision",
      "status",
      "updatedAt",
    ];
    for (const key of Object.keys(record)) {
      expect(ALLOWED_RECORD_KEYS, `the record carries "${key}"`).toContain(key);
    }
    for (const required of ["identity", "generation", "handle", "status", "checkpoint", "revision", "createdAt", "updatedAt"]) {
      expect(record).toHaveProperty(required);
    }
    for (const forbidden of ["page", "context", "lease", "surface", "transport", "browser", "cookie", "token"]) {
      expect(record).not.toHaveProperty(forbidden);
    }

    // A draft that tries to add such a field is refused by the store, not silently dropped.
    await expect(store.update(IDENTITY, () => ({
      identity: IDENTITY,
      generation: 1,
      handle: webChatConversationHandle("opaque-handle-1")!,
      status: "resumable",
      checkpoint: "confirmed",
      transport: { page: "browser-page" },
    } as never))).rejects.toThrow(/no "transport" field/);

    await expect(store.update(IDENTITY, () => ({
      identity: IDENTITY,
      generation: 1,
      handle: webChatConversationHandle("opaque-handle-1")!,
      status: "resumable",
      checkpoint: "confirmed",
      cookies: "session=secret",
    } as never))).rejects.toThrow(/authentication material/);
  });

  test("the account binding identity is credential-free and the record stays opaque", async () => {
    const store = createMemoryConversationStore({ now: () => 1_000 });
    const opaque = "conversation/with:mixed.punctuation-and-no-meaning-42";
    const record = await store.update(IDENTITY, () => ({
      identity: IDENTITY,
      generation: 3,
      handle: webChatConversationHandle(opaque)!,
      status: "resumable",
      checkpoint: "confirmed",
    }));
    // The core stores the provider handle verbatim and never interprets it.
    expect(record.handle as string | undefined).toBe(opaque);
    expect((await store.read(IDENTITY))?.handle as string | undefined).toBe(opaque);
    expect(webChatAccountBindingId(BINDING)).toBe(webChatAccountBindingId({ ...BINDING }));
    expect(webChatAccountBindingId(BINDING)).not.toBe(webChatAccountBindingId({ ...BINDING, accountFingerprint: "other" }));
  });
});

describe("issue #194 — dependency direction, proven by the module loader", () => {
  /**
   * The former scans read every file under `src/web-chat` and asserted on its import text. These
   * runs the module loader instead: a plugin refuses to resolve a forbidden layer, then the layer is
   * imported. If it imported the forbidden layer the import would throw. A positive control is
   * imported last and must be refused, proving the guard is actually active.
   */
  function runLoaderGuard(blockFilter: string, probes: string[]): Record<string, unknown> {
    const probeEntries = probes
      .map(probe => `["${probe}", await load("./${probe}")]`)
      .join(", ");
    const script = `
      const refused = [];
      Bun.plugin({
        name: "issue-194-layering-guard",
        setup(build) {
          build.onResolve({ filter: new RegExp(${JSON.stringify(blockFilter)}) }, () => ({
            path: "issue-194-blocked",
            namespace: "issue-194-blocked",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "issue-194-blocked" },
            () => ({ contents: 'throw new Error("BLOCKED_LAYER")', loader: "js" }),
          );
        },
      });
      const load = async (path) => {
        try {
          await import(path);
          return true;
        } catch (error) {
          return { blocked: String(error && error.message).includes("BLOCKED_LAYER") };
        }
      };
      const results = Object.fromEntries([${probeEntries}]);
      console.log(JSON.stringify(results));
    `;
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, `stderr: ${new TextDecoder().decode(result.stderr).slice(0, 400)}`).toBe(0);
    return JSON.parse(new TextDecoder().decode(result.stdout).trim()) as Record<string, unknown>;
  }

  test("no web-chat layer loads a provider adapter, a browser worker or Playwright", () => {
    const results = runLoaderGuard("(?:/adapters/|browser-worker|playwright)", [
      "src/web-chat/core/index.ts",
      "src/web-chat/transport/index.ts",
      "src/web-chat/persistence/conversation-store-file.ts",
      // Positive control: a provider layer must be refused by the guard.
      "src/adapters/chatgpt-web/provider-core.ts",
    ]);
    expect(results["src/adapters/chatgpt-web/provider-core.ts"]).toEqual({ blocked: true });
    expect(results["src/web-chat/core/index.ts"]).toBe(true);
    expect(results["src/web-chat/transport/index.ts"]).toBe(true);
    expect(results["src/web-chat/persistence/conversation-store-file.ts"]).toBe(true);
  });

  test("the core loads without the durable persistence layer", () => {
    const results = runLoaderGuard("(?:/persistence/|conversation-store-file)", [
      // The core must not depend on the durable backend.
      "src/web-chat/core/index.ts",
      "src/web-chat/transport/index.ts",
      // Positive control: the durable backend itself is refused by the guard.
      "src/web-chat/persistence/conversation-store-file.ts",
    ]);
    expect(results["src/web-chat/persistence/conversation-store-file.ts"]).toEqual({ blocked: true });
    expect(results["src/web-chat/core/index.ts"]).toBe(true);
    expect(results["src/web-chat/transport/index.ts"]).toBe(true);
  });

  test("a provider implementation loads without any sibling provider implementation", () => {
    const results = runLoaderGuard("(?:/adapters/qwen-web/|/adapters/deepseek-web/|/adapters/codex-web/)", [
      // ChatGPT Web is the only current provider; a sibling provider is not a dependency of it.
      "src/adapters/chatgpt-web/index.ts",
      // Positive control: a sibling provider directory is refused by the guard.
      "src/adapters/qwen-web/index.ts",
    ]);
    expect(results["src/adapters/qwen-web/index.ts"]).toEqual({ blocked: true });
    expect(results["src/adapters/chatgpt-web/index.ts"]).toBe(true);
  });
});

describe("issue #194 — unsupported request content fails explicitly", () => {
  test("unsupported non-text content is refused rather than silently projected to text", () => {
    expect(() => assertTextOnlyWebChatTurn({ userText: "hello", model: "m", files: [{ id: "f" }] }))
      .toThrow(/unsupported request features: files/);
  });
});

describe("issue #194 — one retry authority after submission", () => {
  test("WebChat refuses submitted, ambiguous, and partial turns", () => {
    const cases = [
      { state: "SUBMISSION_AMBIGUOUS", partial: false },
      { state: "SUBMITTED", partial: false },
      { state: "STREAMING", partial: true },
    ] as const;
    for (const item of cases) {
      const exchange = new core.WebChatExchangeLifecycle({
        exchangeId: `issue-194-${item.state}`,
        conversationKey: `issue-194-conversation-${item.state}`,
        epoch: 1,
        maxSubmits: 3,
      });
      exchange.markPreparing();
      exchange.markTransportReady();
      exchange.markSubmitting();
      if (item.state === "SUBMISSION_AMBIGUOUS") exchange.markSendActivated();
      else {
        exchange.markSubmitted();
        if (item.state === "STREAMING") exchange.markStreaming();
      }
      const snapshot = exchange.snapshot();
      expect(snapshot.state).toBe(item.state);
      const observation = { snapshot, partialOutputObserved: item.partial };
      expect(webChatRetrySafetyOf(observation)).not.toBe("retry_safe");
      expect(decideWebChatRetry(observation).allowed).toBe(false);
    }
  });
});
