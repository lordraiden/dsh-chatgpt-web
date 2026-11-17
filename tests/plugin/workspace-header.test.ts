import { describe, expect, test } from "bun:test";

import { defaultConfig } from "../../src/config";
import type { AdapterEvent, CodexParsedRequest } from "../../src/types";
import {
  compileChatGptWebContinuation,
  compileChatGptWebInstall,
} from "../../src/adapters/chatgpt-web/prompt";
import { compileQwenChatInstallPrompt } from "../../src/adapters/qwen-chat/prompt";
import {
  QWEN_CHAT_PROVIDER_ID,
  createMemoryQwenChatConversationState,
  createQwenChatProvider,
  qwenChatResponsesRequest,
  type QwenChatProviderComposition,
  type QwenChatRequestSession,
  type QwenChatTurnRequestFacility,
} from "../../src/adapters/qwen-chat";
import { projectIdentityHeader } from "../../src/project-identity";
import { translateChatCompletionsRequest } from "../../src/responses/chat-completions";
import {
  NATIVE_WORKSPACE_KEY,
  nativeTurnMetadataFor,
  nativeTurnMetadataFromBody,
  nativeTurnMetadataString,
  parseNativeTurnMetadata,
  projectContextName,
  resolveNativeTurnIdentity,
  workspaceInstallHeader,
} from "../../src/web-chat/host/turn-identity";
import { createMemoryConversationStore } from "../../src/web-chat/core";

/**
 * doc/plugin.md §3.3 — the declared workspace in the first-message header.
 *
 * The DSH plugin sends `workspace` in `client_metadata["x-codex-turn-metadata"]` (next to
 * `dsh_session_id`/`thread_id`/`purpose`). The service uses that name — never a path, never a
 * fabricated one — for the header of the **first** message of a conversation, and only when the
 * caller declared it: without a declaration the existing package-identity header is unchanged, so
 * Hindsight and OpenAI-compatible callers see no regression. A continuation never carries a header.
 *
 * This suite pins the metadata parsing (string/object shape, trimming, blank = absence, malformed =
 * no partial identity), the exact ChatGPT and Qwen Chat install texts, the fallback to the package
 * identity, the propagation through the Qwen turn resolution, and the continuation with no header.
 */
const MODEL_ID = "qwen3.7-plus";
const MODEL_ROUTE = `${QWEN_CHAT_PROVIDER_ID}/${MODEL_ID}`;
const WORKSPACE = "dsh-chatgpt-web";

/** The native metadata payload of one request, in the string shape the plugin sends. */
function metadataBody(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
  };
}

/** The ChatGPT minimal install for one human turn and one declared workspace. */
function chatGptParsed(
  userText: string,
  metadata?: Record<string, unknown>,
  nativeWorkspace?: string,
): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "low" },
    context: {
      systemPrompt: ["ignored normal Chat system text"],
      messages: [{ role: "user", content: userText, timestamp: 1 }],
    },
    ...(metadata !== undefined ? { _rawBody: metadataBody(metadata) } : {}),
    ...(nativeWorkspace !== undefined
      ? { _dshContext: { threadId: "thread-1", turnId: "turn-1", workspace: nativeWorkspace } }
      : {}),
  } as CodexParsedRequest;
}

/** The exact first-message header a declared workspace compiles to. */
const WORKSPACE_HEADER = `Project: "${WORKSPACE}"`;

describe("declared workspace — native metadata parsing", () => {
  test("the workspace is read from the JSON-string and the already-parsed object shape", () => {
    const fromString = nativeTurnMetadataFromBody(metadataBody({ dsh_session_id: "session-1", workspace: "  my-repo  " }));
    expect(nativeTurnMetadataString(fromString, NATIVE_WORKSPACE_KEY)).toBe("my-repo");

    const fromObject = nativeTurnMetadataFromBody({
      client_metadata: { "x-codex-turn-metadata": { dsh_session_id: "session-1", workspace: "my-repo" } },
    });
    expect(nativeTurnMetadataString(fromObject, NATIVE_WORKSPACE_KEY)).toBe("my-repo");

    // The key is exported so no reader spells the wire field itself.
    expect(NATIVE_WORKSPACE_KEY).toBe("workspace");
  });

  test("a blank workspace is absence, and identity is unaffected by it", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      const resolved = resolveNativeTurnIdentity({ dsh_session_id: "session-1", workspace: blank }, undefined);
      expect(resolved.workspace).toBeUndefined();
      expect(resolved.dshSessionId).toBe("session-1");
      expect(resolved.threadId).toBe("session-1");
    }
    expect(resolveNativeTurnIdentity({ workspace: 42 }, undefined).workspace).toBeUndefined();
    expect(resolveNativeTurnIdentity(undefined, undefined)).toEqual({});
  });

  test("malformed metadata produces no partial identity, including the workspace", () => {
    // The broken payload names a session and a workspace; neither may be read out of it.
    const malformed = parseNativeTurnMetadata('{"dsh_session_id":"session-1","workspace":"my-repo"');
    expect(malformed).toBeUndefined();
    expect(resolveNativeTurnIdentity(malformed, undefined)).toEqual({});
    expect(nativeTurnMetadataString(malformed, NATIVE_WORKSPACE_KEY)).toBeUndefined();
  });

  test("a declared workspace is normalized to a name, never a path", () => {
    expect(projectContextName("/home/raiden/Projects/dsh-chatgpt-web")).toBe(WORKSPACE);
    expect(projectContextName("C:\\dev\\my-repo")).toBe("my-repo");
    expect(projectContextName("my-repo")).toBe("my-repo");
    expect(projectContextName("/")).toBeUndefined();
    expect(projectContextName("")).toBeUndefined();
    expect(projectContextName(undefined)).toBeUndefined();

    expect(resolveNativeTurnIdentity({ workspace: "/home/raiden/Projects/dsh-chatgpt-web" }, undefined).workspace)
      .toBe(WORKSPACE);
    expect(workspaceInstallHeader("/home/raiden/Projects/dsh-chatgpt-web")).toBe(WORKSPACE_HEADER);
    expect(workspaceInstallHeader("   ")).toBeUndefined();
    expect(workspaceInstallHeader(undefined)).toBeUndefined();
  });

  test("the forwarded metadata keeps the declared workspace, normalized", () => {
    const forwarded = nativeTurnMetadataFor(
      { dsh_session_id: "session-1", workspace: "  /home/raiden/Projects/dsh-chatgpt-web  " },
      "thread-1",
    );
    expect(forwarded.workspace).toBe(WORKSPACE);
    expect(forwarded.dsh_session_id).toBe("session-1");
    expect(forwarded.thread_id).toBe("thread-1");

    // No declaration, no invented one.
    expect(nativeTurnMetadataFor({ dsh_session_id: "session-1" }, "thread-1")).not.toHaveProperty("workspace");
  });

  test("the chat-completions surface forwards the declared workspace on the native channel", () => {
    // The OpenAI-compatible surface re-emits the caller's metadata instead of replacing it, so the
    // declaration reaches the adapter's parsed request on the one native channel.
    const translated = translateChatCompletionsRequest({
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          dsh_session_id: "session-1",
          workspace: "/home/raiden/Projects/dsh-chatgpt-web",
        }),
      },
    });
    const metadata = nativeTurnMetadataFromBody(translated.body);
    expect(nativeTurnMetadataString(metadata, NATIVE_WORKSPACE_KEY)).toBe(WORKSPACE);
    expect(metadata?.dsh_session_id).toBe("session-1");
  });
});

describe("declared workspace — ChatGPT install header", () => {
  test("a declared workspace replaces the package identity, exactly", () => {
    const compiled = compileChatGptWebInstall(chatGptParsed("hola", { dsh_session_id: "session-1", workspace: WORKSPACE }));
    expect(compiled.text).toBe(`${WORKSPACE_HEADER}\n\nhola`);
    expect(compiled.text).not.toContain("github:");
    expect(compiled.text).not.toContain("ignored normal Chat system text");
  });

  test("a path-shaped workspace collapses to its last segment", () => {
    const compiled = compileChatGptWebInstall(
      chatGptParsed("hola", { workspace: "/home/raiden/Projects/dsh-chatgpt-web" }),
    );
    expect(compiled.text).toBe(`${WORKSPACE_HEADER}\n\nhola`);
    expect(compiled.text).not.toContain("/home/raiden");
  });

  test("the trusted native projection carries the declaration too", () => {
    const compiled = compileChatGptWebInstall(chatGptParsed("hola", undefined, "/home/raiden/Projects/native-repo"));
    expect(compiled.text).toBe('Project: "native-repo"\n\nhola');
  });

  test("without a workspace the existing package-identity header is unchanged", () => {
    const expected = `${projectIdentityHeader()}\n\nhola`;
    expect(compileChatGptWebInstall(chatGptParsed("hola")).text).toBe(expected);
    expect(compileChatGptWebInstall(chatGptParsed("hola", { dsh_session_id: "session-1" })).text).toBe(expected);
    // A blank declaration is absence, not an empty header.
    expect(compileChatGptWebInstall(chatGptParsed("hola", { workspace: "   " })).text).toBe(expected);
  });

  test("a continuation carries no header", () => {
    const compiled = compileChatGptWebContinuation(
      chatGptParsed("again", { dsh_session_id: "session-1", workspace: WORKSPACE }),
    );
    expect(compiled.text).toBe("again");
    expect(compiled.text).not.toContain("Project:");
  });
});

describe("declared workspace — Qwen Chat install header", () => {
  test("a declared workspace replaces the package identity, exactly like ChatGPT", () => {
    const install = compileQwenChatInstallPrompt("hola", projectIdentityHeader(), WORKSPACE);
    expect(install).toBe(`${WORKSPACE_HEADER}\n\nhola`);
    expect(install).not.toContain("github:");
    expect(install).toBe(compileChatGptWebInstall(chatGptParsed("hola", { workspace: WORKSPACE })).text);
  });

  test("a path-shaped workspace collapses to its last segment", () => {
    expect(compileQwenChatInstallPrompt("hola", projectIdentityHeader(), "/home/raiden/Projects/dsh-chatgpt-web"))
      .toBe(`${WORKSPACE_HEADER}\n\nhola`);
  });

  test("without a workspace the existing package-identity header is unchanged", () => {
    expect(compileQwenChatInstallPrompt("hola", projectIdentityHeader()))
      .toBe(`${projectIdentityHeader()}\n\nhola`);
    expect(compileQwenChatInstallPrompt("hola", projectIdentityHeader(), "   "))
      .toBe(`${projectIdentityHeader()}\n\nhola`);
  });

  test("the resolved turn carries the declared workspace, normalized", () => {
    const { provider } = qwenComposition();
    const declared = provider.resolveTurn(
      qwenBody({ userText: "hola", workspace: "/home/raiden/Projects/dsh-chatgpt-web" }),
      new Headers(),
    );
    expect(declared.workspace).toBe(WORKSPACE);

    const none = provider.resolveTurn(qwenBody({ userText: "hola" }), new Headers());
    expect(none.workspace).toBeUndefined();
  });

  test("the install carries the header and the continuation does not", async () => {
    const { provider, network } = qwenComposition();
    await runTurn(provider, qwenBody({ turnId: "turn-1", userText: "hola", workspace: WORKSPACE }));
    await runTurn(provider, qwenBody({ turnId: "turn-2", userText: "again", workspace: WORKSPACE }));

    expect(network.chatNewCalls).toBe(1);
    expect(network.prompts).toEqual([`${WORKSPACE_HEADER}\n\nhola`, "again"]);
    expect(network.prompts[1]).not.toContain("Project:");
  });
});

/** One recorded-shape SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The controlled network: the recorded Qwen Chat shapes, one answer per turn. */
class ControlledNetwork {
  chatNewCalls = 0;
  completionCalls = 0;
  readonly prompts: string[] = [];
  #chats = 0;

  readonly facility: QwenChatTurnRequestFacility = {
    postJson: async (): Promise<{ status: number; body: unknown }> => {
      this.chatNewCalls += 1;
      this.#chats += 1;
      return { status: 200, body: { success: true, request_id: "req-fixture", data: { id: `chat-${this.#chats}` } } };
    },
    postEventStream: async (path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      const chatId = new URL(path, "https://chat.qwen.ai").searchParams.get("chat_id") ?? "";
      const messages = (body as { messages?: { content?: unknown }[] }).messages;
      const prompt = messages?.[0]?.content;
      if (typeof prompt === "string") this.prompts.push(prompt);
      const responseId = `response-${this.completionCalls}`;
      options.onOpen?.({ status: 200, contentType: "text/event-stream" });
      onChunk(frame({
        "response.created": {
          chat_id: chatId,
          parent_id: `parent-${this.completionCalls}`,
          response_id: responseId,
          response_index: this.completionCalls,
        },
      }));
      onChunk(frame({
        choices: [{
          delta: { role: "assistant", content: "controlled answer", phase: "answer", status: "typing" },
        }],
        response_id: responseId,
      }));
      onChunk(frame({
        choices: [{ delta: { role: "assistant", content: "", phase: "answer", status: "finished" } }],
        response_id: responseId,
      }));
      return { status: 200, contentType: "text/event-stream" };
    },
  } as QwenChatTurnRequestFacility;
}

/** The session over the controlled network. */
function controlledSession(network: ControlledNetwork): QwenChatRequestSession {
  return {
    id: "plugin-workspace-header-session",
    async ready() {},
    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(network.facility);
    },
    async close() {},
  };
}

/** One Qwen Chat composition over the controlled network and in-memory durable state. */
function qwenComposition(): {
  readonly provider: QwenChatProviderComposition;
  readonly network: ControlledNetwork;
} {
  const network = new ControlledNetwork();
  const provider = createQwenChatProvider({
    config: {
      ...defaultConfig(),
      webChat: {
        providers: {
          [QWEN_CHAT_PROVIDER_ID]: {
            accountIdentityFingerprint: "plugin-workspace-header-account",
            models: [{ id: MODEL_ID, label: "Qwen3.7-Plus", thinking: 1, autoThinking: true, thinkingFormat: "summary" }],
          },
        },
      },
    } as never,
    session: controlledSession(network),
    store: createMemoryConversationStore(),
    state: createMemoryQwenChatConversationState(),
  });
  return { provider, network };
}

/** The internal Responses body of one Qwen Chat conversational turn. */
function qwenBody(input: {
  readonly userText: string;
  readonly turnId?: string;
  readonly workspace?: string;
}): Record<string, unknown> {
  return {
    model: MODEL_ROUTE,
    stream: false,
    input: [{ type: "message", role: "user", content: [{ type: "text", text: input.userText }] }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        dsh_session_id: "plugin-workspace-session",
        thread_id: "plugin-workspace-thread",
        turn_id: input.turnId ?? "turn-1",
        ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      }),
    },
  };
}

/** Run one turn through the real ingress and drain its events. */
async function runTurn(
  provider: QwenChatProviderComposition,
  body: Record<string, unknown>,
): Promise<readonly AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await qwenChatResponsesRequest({
    request,
    body,
    provider,
    onAdapterEvent: event => events.push(event),
  });
  await response.json();
  return events;
}
