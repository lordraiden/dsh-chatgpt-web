import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  safeErrorDescriptor,
  safeTextDescriptor,
  toolCallDiagnosticSummary,
} from "../src/lib/safe-diagnostics";
import {
  accountIdentityFromStorageState,
  accountIdentityFromUserId,
} from "../src/chatgpt-web-authority";
import { detectChatGptAuthenticatedAccountIdentity } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";
import {
  ControlledSurface,
  captureConsole,
  controlledIncoming,
  controlledParsed,
  controlledProviderConfig,
} from "./support/chatgpt-web-surface";
import { createChatGptWebAdapter, closeNativeChatGptContinuityStores } from "../src/adapters/chatgpt-web/index";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig as configFixture, saveConfig } from "../src/config";

/**
 * Issue #79 — security and observability hardening.
 *
 * The redaction primitives are asserted directly. The two invariants that used to be checked by
 * reading `src/**` are asserted here by running the real code with a payload that must never be
 * logged (the listener's stream-failure path and the adapter's failure path), and by probing the
 * authenticated-session binding with a fake page.
 */
const SECRET = "S3CRET-PAYLOAD-must-never-be-logged-9f8e7d6c";

let home: string;
let savedHome: SavedChatGptWebHome;
const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (savedHome) {
    await closeNativeChatGptContinuityStores();
    chatGptTurnSessions.clear();
    restoreChatGptWebHome(savedHome, home);
  }
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { ...defaultConfig(), port: 0, host: "127.0.0.1", ...overrides };
}

describe("issue #79 security and observability hardening", () => {
  test("tool diagnostics never serialize arguments or freeform input", () => {
    const calls = [
      { name: "exec_command", arguments: { command: "cat /secret.txt", token: "secret-value" } },
      { name: "view_image", input: "private image payload" },
      { name: "exec_command", arguments: { command: "echo second" } },
    ] as const;

    const summary = toolCallDiagnosticSummary(calls);
    expect(summary).toContain("count=3");
    expect(summary).toContain("exec_commandx2");
    expect(summary).toContain("view_image");
    expect(summary).toContain("argumentChars=");
    expect(summary).toContain("inputChars=");
    expect(summary).not.toContain("/secret.txt");
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("private image payload");
  });

  test("error diagnostics preserve stable identity but never expose the error message", () => {
    const descriptor = safeErrorDescriptor({
      name: "ChatGptWebAdapterError",
      code: "provider_timeout",
      errorType: "server_error",
      status: 504,
      message: "prompt text and tool output must not be logged",
    });

    expect(descriptor).toContain("name=ChatGptWebAdapterError");
    expect(descriptor).toContain("code=provider_timeout");
    expect(descriptor).toContain("type=server_error");
    expect(descriptor).toContain("status=504");
    expect(descriptor).not.toContain("prompt text");
    expect(descriptor).not.toContain("tool output");
  });

  test("arbitrary sidecar text is represented only by safe metadata", () => {
    const descriptor = safeTextDescriptor("browser credential and tool output");
    expect(descriptor).toMatch(/^chars=\d+ fp=[a-f0-9]{12}$/);
    expect(descriptor).not.toContain("browser credential");
    expect(descriptor).not.toContain("tool output");
  });

  test("browser account binding uses authenticated session identity, not mutable storage-state hashing", async () => {
    const page = { evaluate: (fn: () => Promise<unknown>) => fn() } as never;
    const originalFetch = globalThis.fetch;
    const sessions = [
      { user: { id: "user-abc" } },
      { user: { id: "user-abc" }, cookies: "whatever the storage state happens to hold" },
    ];
    let sessionIndex = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/session") return Response.json(sessions[Math.min(sessionIndex++, sessions.length - 1)]);
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const first = await detectChatGptAuthenticatedAccountIdentity(page);
      const second = await detectChatGptAuthenticatedAccountIdentity(page);
      // The authenticated session decides the identity: it is stable and derived from the user id.
      expect(first).toEqual(accountIdentityFromUserId("user-abc"));
      expect(second).toEqual(first);
      expect(first.kind).toBe("authenticated-session");
      // A different storage state produces a different (legacy) fingerprint, so a binding that
      // hashed storage state could not have produced the stable session identity above.
      expect(accountIdentityFromStorageState({ cookies: [{ name: "session", value: "a" }] }).fingerprint)
        .not.toBe(first.fingerprint);
      expect(accountIdentityFromStorageState({ cookies: [{ name: "session", value: "b" }] }).fingerprint)
        .not.toBe(first.fingerprint);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an unauthenticated session binding fails closed instead of falling back to storage state", async () => {
    const page = { evaluate: (fn: () => Promise<unknown>) => fn() } as never;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
      await expect(detectChatGptAuthenticatedAccountIdentity(page)).rejects.toThrow(/auth session probe failed/);

      globalThis.fetch = (async () => Response.json({ user: {} })) as unknown as typeof globalThis.fetch;
      await expect(detectChatGptAuthenticatedAccountIdentity(page)).rejects.toThrow(/stable user id/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runtime log sites expose no raw payload or error message", async () => {
    // A provider failure whose message carries the payload: only a sanitized descriptor may reach
    // the log. The real listener runs the failure path end to end over HTTP.
    const server = startServer(makeConfig() as never, {
      adapterFactory: () => ({
        name: "issue-79-leak-probe",
        runTurn: async (_parsed: unknown, _incoming: unknown, emit: (event: unknown) => void) => {
          emit({ type: "text_delta", text: `partial output ${SECRET}`, phase: "final_answer" });
          throw Object.assign(new Error(`provider rejected the request: ${SECRET}`), {
            name: "PayloadLeakError",
            code: "upstream_unavailable",
          });
        },
      }),
    } as never);
    running.push(server);

    const captured = captureConsole();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/light", input: "hello", stream: true }),
      });
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      captured.restore();
    }

    // Whatever the listener logs on this path, the payload and the raw message must not be in it.
    expect(captured.text()).not.toContain(SECRET);
    expect(captured.text()).not.toContain("provider rejected the request");
  });

  test("an adapter failure with a secret-bearing message logs no raw text", async () => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-79-log-redaction-", { clearFreeHome: true });
    chatGptTurnSessions.clear();
    await closeNativeChatGptContinuityStores();
    saveConfig({ ...configFixture(), webChat: { conversationStorePath: join(home, "conversations.json") } });

    const surface = new ControlledSurface();
    surface.enqueue({
      error: new ChatGptWebAdapterError(`provider payload leaked: ${SECRET}`, {
        status: 500,
        errorType: "server_error",
        code: "provider_timeout",
        retryable: false,
      }),
    });
    const adapter = createChatGptWebAdapter(controlledProviderConfig(home), {
      surfaceTransport: surface.transport,
    });

    const captured = captureConsole();
    try {
      await adapter.runTurn(controlledParsed(), controlledIncoming(), () => {});
    } finally {
      captured.restore();
    }

    // The adapter does log on a turn (the high-level diagnostic), so this is not an empty capture.
    expect(captured.text()).toContain("[chatgpt-web]");
    expect(captured.text()).not.toContain(SECRET);
    expect(captured.text()).not.toContain("provider payload leaked");
  });
});
