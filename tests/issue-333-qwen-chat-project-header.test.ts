import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import { defaultConfig } from "../src/config";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { compileChatGptWebInstall } from "../src/adapters/chatgpt-web/prompt";
import {
  QWEN_CHAT_PROVIDER_ID,
  compileQwenChatInstallPrompt,
  compileQwenChatReplayPrompt,
  createMemoryQwenChatConversationState,
  createQwenChatProvider,
  qwenChatResponsesRequest,
  type QwenChatProviderComposition,
  type QwenChatRequestSession,
  type QwenChatTurnRequestFacility,
} from "../src/adapters/qwen-chat";
import {
  formatProjectIdentityHeader,
  projectIdentityFromMetadata,
  projectIdentityHeader,
  projectNameFromPackageName,
  repositoryUrlFromPackageMetadata,
  withProjectIdentityHeader,
} from "../src/project-identity";
import { createMemoryConversationStore, webChatAccountBindingId } from "../src/web-chat/core";

/**
 * Issue #333 — the deterministic project header of a Qwen Chat conversation install.
 *
 * `chat.qwen.ai` used to receive the caller's first message as bare text, while the same normal Chat
 * Mode install on ChatGPT carried the deterministic project header (`Project: "<name>"` plus the
 * authoritative `github:` URL). The header is the same provider-neutral identity on both providers
 * (`src/project-identity.ts`), it belongs to the **first physical message of a brand-new
 * conversation** only, and it carries no host context at all.
 *
 * This suite pins: the exact install content (and its byte-for-byte equality with the ChatGPT
 * install), the continuation that sends only the new text, the refusal when an install would carry no
 * human message, the omission of unresolvable metadata, the declared-purpose turn that is not an
 * install, and the replay that rebuilds canonical history without duplicating the header.
 */
const MODEL_ID = "qwen3.7-plus";
const MODEL_ROUTE = `${QWEN_CHAT_PROVIDER_ID}/${MODEL_ID}`;
const ACCOUNT = "issue-333-qwen-chat-header-account";

let home: string;
let savedHome: SavedChatGptWebHome;

afterEach(() => {
  restoreChatGptWebHome(savedHome, home);
});

/** The ChatGPT minimal install for the same human turn, as the equality reference. */
function chatGptInstall(userText: string): string {
  return compileChatGptWebInstall({
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "low" },
    context: {
      systemPrompt: ["ignored normal Chat system text"],
      messages: [{ role: "user", content: userText, timestamp: 1 }],
    },
  } as CodexParsedRequest).text;
}

/** The Qwen Chat install of this installation's own deterministic identity (the production call). */
function qwenInstall(userText: string): string {
  return compileQwenChatInstallPrompt(userText, projectIdentityHeader());
}

/** One recorded-shape SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A scripted turn answer. */
interface Script {
  readonly answer?: string;
  readonly rejectChat?: boolean;
}

/** The controlled network: the recorded shapes, driven by a queue of per-turn scripts. */
class ControlledNetwork {
  chatNewCalls = 0;
  completionCalls = 0;
  readonly prompts: string[] = [];
  readonly bodies: Record<string, unknown>[] = [];
  readonly scripts: Script[] = [];
  #chats = 0;

  readonly facility: QwenChatTurnRequestFacility = {
    postJson: async (): Promise<{ status: number; body: unknown }> => {
      this.chatNewCalls += 1;
      this.#chats += 1;
      return { status: 200, body: { success: true, request_id: "req-fixture", data: { id: `chat-${this.#chats}` } } };
    },
    postEventStream: async (path, body, onChunk, options = {}) => {
      this.completionCalls += 1;
      this.bodies.push(body as Record<string, unknown>);
      const chatId = new URL(path, "https://chat.qwen.ai").searchParams.get("chat_id") ?? "";
      const messages = (body as { messages?: { content?: unknown }[] }).messages;
      const prompt = messages?.[0]?.content;
      if (typeof prompt === "string") this.prompts.push(prompt);
      const script = this.scripts.shift() ?? { answer: "controlled answer" };
      const responseId = `response-${this.completionCalls}`;
      if (script.rejectChat) {
        return {
          status: 404,
          contentType: "application/json",
          bodyText: JSON.stringify({ success: false, data: { code: "ChatNotFound" } }),
        };
      }
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
          delta: { role: "assistant", content: script.answer ?? "controlled answer", phase: "answer", status: "typing" },
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

/** The session over a controlled network. */
function controlledSession(network: ControlledNetwork): QwenChatRequestSession {
  return {
    id: "issue-333-qwen-chat-header-session",
    async ready() {},
    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(network.facility);
    },
    async close() {},
  };
}

/** Build one composition over a controlled network and in-memory durable state. */
function composition(): { readonly provider: QwenChatProviderComposition; readonly network: ControlledNetwork } {
  const network = new ControlledNetwork();
  const provider = createQwenChatProvider({
    config: {
      ...defaultConfig(),
      webChat: {
        providers: {
          [QWEN_CHAT_PROVIDER_ID]: {
            accountIdentityFingerprint: ACCOUNT,
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

/** The internal Responses body of one conversational turn. */
function body(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly userText: string;
  readonly history?: readonly { role: "user" | "assistant"; text: string }[];
  readonly purpose?: string;
}): Record<string, unknown> {
  const history = input.history ?? [{ role: "user" as const, text: input.userText }];
  return {
    model: MODEL_ROUTE,
    stream: false,
    input: history.map(message => ({
      type: "message",
      role: message.role,
      content: [{ type: "text", text: message.text }],
    })),
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        dsh_session_id: input.sessionId,
        thread_id: input.threadId,
        turn_id: input.turnId,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      }),
    },
  };
}

/** Run one turn through the real ingress and return its normalized events. */
async function runTurn(
  provider: QwenChatProviderComposition,
  requestBody: Record<string, unknown>,
): Promise<readonly AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const response = await qwenChatResponsesRequest({
    request,
    body: requestBody,
    provider,
    onAdapterEvent: event => events.push(event),
  });
  await response.json();
  return events;
}

/** The header occurrences of one compiled prompt. */
function headerLines(text: string): string[] {
  return text.match(/Project: /g) ?? [];
}

describe("issue #333 — the project header of a Qwen Chat conversation install", () => {
  beforeEach(() => {
    savedHome = captureChatGptWebHome();
    home = useTemporaryChatGptWebHome("issue-333-qwen-chat-header-", { clearFreeHome: true });
  });

  test("the install is the deterministic header plus the user's message, and nothing else", () => {
    const install = qwenInstall("hola");
    // Exactly the header plus the human turn: no history, no system prompt, no transport envelope.
    expect(install).toBe(`${projectIdentityHeader()}\n\nhola`);
    expect(install).not.toContain("User: ");
    expect(install).not.toContain("Assistant: ");
    for (const marker of ["<codex_context_json>", "<dsh_transport_resume>", "<environment_context>", "<AEGIS_DSH_ROUTING_BOOTSTRAP>"]) {
      expect(install).not.toContain(marker);
    }
    expect(headerLines(install)).toHaveLength(1);
  });

  test("the identity is the one the ChatGPT install produces, asserted by equality", () => {
    // Not a copied string: the two provider installs compile from the same neutral owner, so for the
    // same repository metadata they must be byte-for-byte the same first message.
    expect(qwenInstall("hola")).toBe(chatGptInstall("hola"));
    expect(qwenInstall("dime si funcionas")).toBe(chatGptInstall("dime si funcionas"));
    // …and that shared identity is this repository's own authoritative metadata.
    expect(projectNameFromPackageName("@lordraiden/dsh-chatgpt-web")).toBe("dsh-chatgpt-web");
    expect(repositoryUrlFromPackageMetadata("git+https://github.com/lordraiden/dsh-chatgpt-web.git"))
      .toBe("https://github.com/lordraiden/dsh-chatgpt-web");
  });

  test("an install with no human message is refused, exactly like the ChatGPT install", () => {
    expect(() => qwenInstall("")).toThrow("must carry a human message");
    expect(() => qwenInstall("   ")).toThrow("must carry a human message");
    expect(() => qwenInstall("\n\n")).toThrow("must carry a human message");
    expect(() => chatGptInstall("   ")).toThrow("must carry a human message");
  });

  test("unresolvable metadata omits the header instead of fabricating one", () => {
    expect(projectIdentityFromMetadata(undefined)).toBeUndefined();
    expect(projectIdentityFromMetadata({ name: "@lordraiden/dsh-chatgpt-web", repository: "not a url" })).toBeUndefined();
    expect(projectIdentityFromMetadata({ name: "", repository: "https://github.com/lordraiden/dsh-chatgpt-web" })).toBeUndefined();
    expect(projectIdentityFromMetadata({ name: 42, repository: {} })).toBeUndefined();
    expect(projectNameFromPackageName(undefined)).toBeUndefined();
    expect(projectNameFromPackageName("")).toBeUndefined();
    expect(repositoryUrlFromPackageMetadata("git+ssh://git@github.com/lordraiden/dsh-chatgpt-web.git")).toBeUndefined();
    expect(repositoryUrlFromPackageMetadata("not a url")).toBeUndefined();
    expect(formatProjectIdentityHeader(undefined)).toBeUndefined();

    // The install with no resolvable identity is exactly the human turn: no name, no URL, no guess.
    expect(withProjectIdentityHeader("hola", undefined)).toBe("hola");
    expect(compileQwenChatInstallPrompt("hola", undefined)).toBe("hola");
    expect(compileQwenChatInstallPrompt("hola", undefined)).not.toContain("Project:");
  });

  test("the header is injected idempotently, so a compiled install can never be duplicated", () => {
    const once = qwenInstall("hola");
    expect(headerLines(once)).toHaveLength(1);
    expect(withProjectIdentityHeader(once, projectIdentityHeader())).toBe(once);
    expect(qwenInstall(once)).toBe(once);
    expect(headerLines(qwenInstall(once))).toHaveLength(1);
  });

  test("the first turn carries the header and the second sends only the new text", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "first answer" }, { answer: "second answer" });

    const first = await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola" }));
    expect(first.at(-1)?.type).toBe("done");
    const second = await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "again" }));
    expect(second.at(-1)?.type).toBe("done");

    // One chat, and one provider message per turn: the install, then the continuation's new text.
    expect(network.chatNewCalls).toBe(1);
    expect(network.prompts).toEqual([qwenInstall("hola"), "again"]);
    expect(network.prompts[0]).toBe(chatGptInstall("hola"));
    const messages = network.bodies[0]!["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!["role"]).toBe("user");
    expect(messages[0]!["content"]).toBe(network.prompts[0]);
    expect(headerLines(network.prompts[1]!)).toEqual([]);
  });

  test("a declared-purpose turn is not a conversation install and carries no header", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "Session about Qwen" });

    const ephemeral = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "title-1",
      userText: "name this session",
      purpose: "session-title",
    }));

    expect(ephemeral.at(-1)?.type).toBe("done");
    expect(network.chatNewCalls).toBe(0);
    expect(network.prompts).toEqual(["name this session"]);
    expect(headerLines(network.prompts[0]!)).toEqual([]);
  });

  test("a replay rebuilds canonical history and never duplicates the header", async () => {
    const { provider, network } = composition();
    network.scripts.push({ answer: "first" }, { rejectChat: true }, { answer: "rebuilt" });

    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "turn-1", userText: "hola" }));
    await runTurn(provider, body({ sessionId: "session-a", threadId: "thread-a", turnId: "turn-2", userText: "again" }));
    const history = [
      { role: "user" as const, text: "hola" },
      { role: "assistant" as const, text: "first" },
      { role: "user" as const, text: "again please" },
    ];
    const recovered = await runTurn(provider, body({
      sessionId: "session-a",
      threadId: "thread-a",
      turnId: "turn-3",
      userText: "again please",
      history,
    }));
    expect(recovered.at(-1)?.type).toBe("done");
    // A new chat, rebuilt from the caller's canonical history alone.
    expect(network.chatNewCalls).toBe(2);
    expect(network.prompts[2]).toBe(compileQwenChatReplayPrompt(history));
    // The replay is not an install: no header, and certainly not a second copy of one.
    expect(headerLines(network.prompts[2]!)).toEqual([]);
  });

  test("a non-Chat-Mode path (the Advisor's neutral seam) installs no header", async () => {
    const { provider } = composition();
    const handoff = await provider.runtime.openTextExchange({
      route: MODEL_ROUTE,
      model: MODEL_ID,
      userText: "review the login flow",
      dshSession: { sessionId: "session-advisor" },
      affinity: {
        providerId: QWEN_CHAT_PROVIDER_ID,
        bindingId: webChatAccountBindingId({ providerId: QWEN_CHAT_PROVIDER_ID, accountFingerprint: ACCOUNT }),
        threadId: "advisor-thread",
      },
      turnId: "review-1",
    });
    expect(handoff.turn.userText).toBe("review the login flow");
    expect(headerLines(handoff.turn.userText)).toEqual([]);
  });
});
