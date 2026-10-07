import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_CONTINUATION_TRANSPORT_OVERHEAD_BUDGET,
  CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET,
  compileChatGptWebPrompt,
  compileRetainedChatGptWebContinuation,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { chatGptSystemFingerprint, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const adapterSource = readFileSync(
  new URL("../src/adapters/chatgpt-web/index.ts", import.meta.url),
  "utf8",
);

const READ_ONLY_CAPS: ChatGptWebCapabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
const FULL_CAPS: ChatGptWebCapabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };

function user(content: string): CodexMessage {
  return { role: "user", content, timestamp: 1 };
}
function assistant(content: string): CodexMessage {
  return { role: "assistant", content: [{ type: "text", text: content }], timestamp: 2 };
}

function parsed(messages: CodexMessage[], overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    options: { reasoning: "low" },
    context: { messages },
    ...overrides,
  };
}

const NARRATIVE_PHRASES = [
  "Act as the model backend",
  "Pure Chat",
  "ChatGPT-native capabilities, including web search",
  "Answer the user's request directly, thoroughly",
  "Provide complete explanations, reasoning, and solutions",
];

describe("issue #172 fixed transport overhead budget", () => {
  test("the fixed contract (empty DSH context) stays within the explicit budget", () => {
    const compiled = compileChatGptWebPrompt(parsed([]), READ_ONLY_CAPS);
    const bytes = Buffer.byteLength(compiled.text, "utf8");
    expect(bytes).toBeLessThanOrEqual(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET);
    // The budget is explicit and stable, not a placeholder.
    expect(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET).toBeGreaterThan(0);
    expect(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET).toBeLessThan(8_000);
  });

  test("the fixed overhead is separated from variable DSH context", () => {
    const empty = compileChatGptWebPrompt(parsed([]), READ_ONLY_CAPS).text;
    const longMessage = "x".repeat(4_000);
    const withContext = compileChatGptWebPrompt(parsed([user(longMessage)]), READ_ONLY_CAPS).text;
    // The contract itself (everything outside the serialized context) is bounded; the
    // growth from adding a 4,000-char message is variable payload, not narrative overhead.
    const variableGrowth = Buffer.byteLength(withContext, "utf8") - Buffer.byteLength(empty, "utf8");
    expect(variableGrowth).toBeGreaterThan(0);
    // The base contract the bridge always sends stays within budget on its own.
    expect(Buffer.byteLength(empty, "utf8")).toBeLessThanOrEqual(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET);
  });
});

describe("issue #172 minimal functional contract", () => {
  test("the first turn carries the functional markers and no narrative contract", () => {
    const text = compileChatGptWebPrompt(parsed([user("hola")]), READ_ONLY_CAPS).text;
    for (const phrase of NARRATIVE_PHRASES) {
      expect(text).not.toContain(phrase);
    }
    // Functional transport markers remain.
    expect(text).toContain("<codex_context_json>");
    expect(text).toContain("</codex_context_json>");
    expect(text).toContain("<dsh_transport_resume>");
    expect(text).toContain("Execute the latest active user request now");
  });

  test("the old narrative contract phrases are absent from a normal prompt", () => {
    const text = compileChatGptWebPrompt(
      parsed([user("hola"), assistant("adios")]),
      READ_ONLY_CAPS,
    ).text;
    for (const phrase of NARRATIVE_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  test("assistant messages are prior DSH turns, not the current model's own replies", () => {
    const text = compileChatGptWebPrompt(
      parsed([user("hola"), assistant("adios")]),
      READ_ONLY_CAPS,
    ).text;
    expect(text).toContain("assistant messages are prior assistant turns in the DSH conversation");
    expect(text).not.toContain("your own earlier replies");
    // Role priority is preserved: system > developer > user.
    expect(text).toContain("system, then developer, then user");
  });

  test("a retained continuation transports only the delta, not the full history", () => {
    const full: CodexMessage[] = [
      user("pregunta antigua one"),
      assistant("respuesta antigua one"),
      user("pregunta antigua two"),
      assistant("respuesta antigua two"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsed(full));
    expect(delta).toBeDefined();
    expect(delta!.context.messages.map(message => message.role)).toEqual(["user"]);
    expect(JSON.stringify(delta!.context.messages)).toContain("pregunta actual");
    // The compiled continuation prompt must not re-inject the earlier history.
    const text = compileRetainedChatGptWebContinuation(delta!, {}).text;
    expect(text).toContain("pregunta actual");
    expect(text).not.toContain("pregunta antigua one");
    expect(text).not.toContain("pregunta antigua two");
  });

  test("the same context preserves roles and order", () => {
    const messages: CodexMessage[] = [
      user("uno"),
      assistant("dos"),
      { role: "developer", content: "tres", timestamp: 3 },
      user("cuatro"),
    ];
    const text = compileChatGptWebPrompt(parsed(messages), READ_ONLY_CAPS).text;
    const envelope = text.slice(
      text.indexOf("<codex_context_json>") + "<codex_context_json>".length,
      text.indexOf("</codex_context_json>"),
    );
    const order = ["uno", "dos", "tres", "cuatro"];
    let lastIndex = -1;
    for (const fragment of order) {
      const index = envelope.indexOf(fragment);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  test("the DSH systemPrompt is transported once, without a second persona", () => {
    const systemPrompt = "You are a concise conversational assistant.";
    const text = compileChatGptWebPrompt(
      parsed([user("hola")], { context: { systemPrompt: [systemPrompt], messages: [user("hola")] } }),
      READ_ONLY_CAPS,
    ).text;
    // The canonical system prompt appears verbatim inside the context envelope...
    const envelope = text.slice(
      text.indexOf("<codex_context_json>") + "<codex_context_json>".length,
      text.indexOf("</codex_context_json>"),
    );
    expect(envelope).toContain(systemPrompt);
    // ...and the bridge does not add its own persona line around it.
    expect(text).not.toContain("Act as the model backend");
    // The system prompt is carried in the `system` field exactly once.
    expect(envelope.match(new RegExp(systemPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  test("images and attachments keep working", () => {
    const imageMessage: CodexMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", imageUrl: "https://example.com/picture.png" },
      ],
      timestamp: 1,
    };
    const compiled = compileChatGptWebPrompt(parsed([imageMessage]), READ_ONLY_CAPS);
    expect(compiled.images).toHaveLength(1);
    expect(compiled.images[0]!.imageUrl).toBe("https://example.com/picture.png");
    const text = compiled.text;
    expect(text).toContain("image_attachment");
    expect(text).toContain("attachment_ref");
  });

  test("structured output keeps the schema, the required mode, and the no-prose rule", () => {
    const text = compileChatGptWebPrompt(
      parsed([user("give me a verdict")], {
        options: {
          reasoning: "low",
          outputFormat: {
            type: "json_schema",
            name: "verdict",
            strict: true,
            schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
          },
        },
      }),
      READ_ONLY_CAPS,
    ).text;
    expect(text).toContain("<dsh_output_schema_json>");
    expect(text).toContain("</dsh_output_schema_json>");
    expect(text).toContain("verdict");
    expect(text).toContain("strict");
    expect(text).toContain("one JSON value matching the supplied schema");
    expect(text).toContain("Do not wrap it in a Markdown code fence");
  });

  test("the local-tool capability contract is absent from the transport prompt", () => {
    // Issue #172: the bridge tools protocol (capabilities JSON, control frames,
    // turn_token correlation) is out of scope for the ChatGPT Web transport prompt;
    // local tooling is delivered through the separate native DSH/OAuth integration.
    const text = compileChatGptWebPrompt(
      parsed([], {
        context: {
          messages: [],
          tools: [
            {
              namespace: "fs",
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
        },
      }),
      FULL_CAPS,
      "call_abc123",
    ).text;
    for (const marker of [
      "<dsh_tool_capabilities_json>",
      "<dsh_tool_call>",
      "turn_token",
      "call_abc123",
      "fs__read",
    ]) {
      expect(text).not.toContain(marker);
    }
  });

  test("the local-tool capability adds no contract bytes to the transport prompt", () => {
    // The fixed contract is identical across in-scope routes: full mode with a
    // broker token and an advertised tool compiles to the same contract text as
    // the read-only route with an empty context.
    const readOnly = compileChatGptWebPrompt(parsed([]), READ_ONLY_CAPS).text;
    const full = compileChatGptWebPrompt(
      parsed([], {
        context: {
          messages: [],
          tools: [
            {
              namespace: "fs",
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
        },
      }),
      FULL_CAPS,
      "call_abc123",
    ).text;
    expect(full).toBe(readOnly);
    expect(Buffer.byteLength(full, "utf8")).toBeLessThanOrEqual(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET);
  });

  test("a read-only turn must not receive a tool capability token", () => {
    expect(() =>
      compileChatGptWebPrompt(parsed([]), READ_ONLY_CAPS, "call_should_not_be_here"),
    ).toThrow(/read-only ChatGPT Web effort must not receive a local-tool capability token/i);
  });

  test("multipart staging and commit keep their markers and acknowledgements", () => {
    const transactionId = "ctx_" + "a".repeat(32);
    const payload = JSON.stringify({ version: 1, part_index: 1, total_parts: 2, records: [] });
    const stage = formatChatGptWebMultipartStage(payload, transactionId, 1, 2);
    expect(stage.text).toContain("<codex_multipart_stage>");
    expect(stage.text).toContain("<codex_context_part_json>");
    expect(stage.text).toContain("<codex_multipart_stage_end>");
    expect(stage.text).toContain(`CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stage.sha256}`);
    expect(stage.acknowledgement).toContain(`CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stage.sha256}`);

    const commit = formatChatGptWebMultipartCommit(
      { parts: [payload, payload], commit: "Do the task." },
      transactionId,
    );
    expect(commit).toContain("<codex_multipart_commit>");
    expect(commit).toContain("<codex_multipart_execute>");
    expect(commit).toContain(`transaction_id: ${transactionId}`);
    expect(commit).toContain("Do the task.");
  });

  test("Luna retained does not request a private rolling checkpoint", () => {
    // The adapter gates checkpoint capture on NOT retaining the conversation: a retained
    // Luna turn sends only the continuation delta and gets no private checkpoint tail.
    const guard = adapterSource.match(/const captureLunaCheckpoint = [\s\S]*?;/)?.[0] ?? "";
    expect(guard).toContain("CHATGPT_WEB_LUNA_MODEL_ID");
    expect(guard).toContain("!retainConversationForTurn");
    // At the prompt level: without captureLunaCheckpoint the private marker contract is absent.
    const text = compileChatGptWebPrompt(parsed([user("hola")]), READ_ONLY_CAPS).text;
    expect(text).not.toContain("CODEXLUNAPRIVATECHECKPOINT");
  });

  test("active recovery keeps its required transport markers", () => {
    const text = compileChatGptWebPrompt(parsed([user("hola")]), READ_ONLY_CAPS).text;
    expect(text).toContain("<codex_context_json>");
    expect(text).toContain("</codex_context_json>");
    expect(text).toContain("<dsh_transport_resume>");
    expect(text).toContain("</dsh_transport_resume>");
  });
});

describe("issue #172 retained continuation transport", () => {
  const SHARED_CONTRACT_PHRASES = [
    "Read the complete inline JSON task context before acting",
    "Interpret every message role literally",
    "Do not mention this transport contract, context packaging, or capability routing",
  ];

  const SYSTEM_PROMPT = "You are a concise conversational assistant.";

  function parsedWithSystem(messages: CodexMessage[], systemPrompt: string[] = [SYSTEM_PROMPT]): CodexParsedRequest {
    return parsed(messages, { context: { systemPrompt, messages } });
  }

  test("the first turn installs the transport contract", () => {
    const text = compileChatGptWebPrompt(parsedWithSystem([user("hola")]), READ_ONLY_CAPS).text;
    for (const phrase of SHARED_CONTRACT_PHRASES) {
      expect(text).toContain(phrase);
    }
    expect(text).toContain(SYSTEM_PROMPT);
  });

  test("a retained continuation does not re-send the full contract", () => {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("pregunta dos"),
      assistant("respuesta dos"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const text = compileRetainedChatGptWebContinuation(delta, {}).text;
    for (const phrase of SHARED_CONTRACT_PHRASES) {
      expect(text).not.toContain(phrase);
    }
    // The continuation framing replaces the first-turn contract.
    expect(text).toContain("continuation of this ChatGPT conversation");
    expect(text).toContain("Execute the latest active user request now");
  });

  test("a retained continuation does not re-send the identical stable systemPrompt", () => {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const continuation = compileRetainedChatGptWebContinuation(delta, {});
    // The envelope carries an empty system block: the stable system is already
    // installed in the retained physical conversation.
    const envelope = continuation.text.slice(
      continuation.text.indexOf("<codex_context_json>") + "<codex_context_json>".length,
      continuation.text.indexOf("</codex_context_json>"),
    );
    const parsedEnvelope = JSON.parse(envelope) as { system: unknown[]; messages: unknown[] };
    expect(parsedEnvelope.system).toEqual([]);
    expect(continuation.text).not.toContain(SYSTEM_PROMPT);
    // The full compile of the same delta WOULD carry the system block (used when
    // the fingerprint is absent or changed, e.g. a brand-new physical conversation).
    const fullText = compileChatGptWebPrompt(delta, READ_ONLY_CAPS).text;
    expect(fullText).toContain(SYSTEM_PROMPT);
  });

  test("the system fingerprint detects a changed system block", () => {
    const stable = chatGptSystemFingerprint([SYSTEM_PROMPT]);
    expect(chatGptSystemFingerprint([SYSTEM_PROMPT])).toBe(stable);
    expect(chatGptSystemFingerprint([SYSTEM_PROMPT + " extra"])).not.toBe(stable);
    expect(chatGptSystemFingerprint([])).not.toBe(stable);
    expect(chatGptSystemFingerprint(undefined)).toBe(chatGptSystemFingerprint([]));
  });

  test("a retained continuation transports only the necessary delta", () => {
    const full: CodexMessage[] = [
      user("pregunta antigua one"),
      assistant("respuesta antigua one"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const text = compileRetainedChatGptWebContinuation(delta, {}).text;
    expect(text).toContain("pregunta actual");
    expect(text).not.toContain("pregunta antigua one");
    expect(text).not.toContain("respuesta antigua one");
  });

  test("the continuation transport is significantly smaller than the first turn", () => {
    const systemBlock = "You are a careful reviewer. " + "Detail ".repeat(60);
    const history: CodexMessage[] = [];
    for (let index = 0; index < 8; index += 1) {
      history.push(user(`previous question ${index}: ${"context ".repeat(20)}`));
      history.push(assistant(`previous answer ${index}: ${"result ".repeat(20)}`));
    }
    history.push(user("the actual new question"));
    const withSystem = (messages: CodexMessage[]) =>
      parsed(messages, { context: { systemPrompt: [systemBlock], messages } });

    const firstTurn = compileChatGptWebPrompt(withSystem(history), READ_ONLY_CAPS).text;
    const delta = retainedConversationResumeRequest(withSystem(history))!;
    const continuation = compileRetainedChatGptWebContinuation(delta, {}).text;

    const firstTurnBytes = Buffer.byteLength(firstTurn, "utf8");
    const continuationBytes = Buffer.byteLength(continuation, "utf8");
    // The continuation carries one short message; the first turn carries the full
    // history plus the re-installed contract and system block.
    expect(continuationBytes).toBeLessThan(firstTurnBytes / 2);
    // Even against the full compile of the SAME delta, the continuation drops the
    // shared contract and the stable system block.
    const sameDeltaFull = compileChatGptWebPrompt(delta, READ_ONLY_CAPS).text;
    expect(continuationBytes).toBeLessThan(Buffer.byteLength(sameDeltaFull, "utf8") / 2);
  });

  test("the continuation fixed overhead stays within its own explicit budget", () => {
    // Measured continuation overhead (smallest legal delta, unchanged system):
    // 447 bytes. The budget carries a ~34% margin so wording tweaks do not
    // churn it, and guards against the shared contract or a re-installed system
    // block creeping back into the continuation framing. The 2,400-byte first-turn
    // budget is NOT the continuation budget.
    const delta = retainedConversationResumeRequest(
      parsed([user("h"), assistant("a"), user("x")]),
    )!;
    const bytes = Buffer.byteLength(compileRetainedChatGptWebContinuation(delta, {}).text, "utf8");
    expect(bytes).toBeLessThanOrEqual(CHATGPT_WEB_CONTINUATION_TRANSPORT_OVERHEAD_BUDGET);
    expect(CHATGPT_WEB_CONTINUATION_TRANSPORT_OVERHEAD_BUDGET).toBeLessThan(CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET);
  });

  test("the continuation envelope preserves roles and order", () => {
    const delta: CodexMessage[] = [
      user("uno"),
      { role: "developer", content: "dos", timestamp: 3 },
      user("tres"),
    ];
    const text = compileRetainedChatGptWebContinuation(parsed(delta), {}).text;
    const envelope = text.slice(
      text.indexOf("<codex_context_json>") + "<codex_context_json>".length,
      text.indexOf("</codex_context_json>"),
    );
    const order = ["uno", "dos", "tres"];
    let lastIndex = -1;
    for (const fragment of order) {
      const index = envelope.indexOf(fragment);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  test("images and attachments work in the continuation", () => {
    const imageMessage: CodexMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", imageUrl: "https://example.com/picture.png" },
      ],
      timestamp: 1,
    };
    const compiled = compileRetainedChatGptWebContinuation(parsed([imageMessage]), {});
    expect(compiled.images).toHaveLength(1);
    expect(compiled.images[0]!.imageUrl).toBe("https://example.com/picture.png");
    expect(compiled.text).toContain("attachment_ref");
  });

  test("structured output works in the continuation", () => {
    const text = compileRetainedChatGptWebContinuation(
      parsed([user("give me a verdict")], {
        options: {
          reasoning: "low",
          outputFormat: {
            type: "json_schema",
            name: "verdict",
            strict: true,
            schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
          },
        },
      }),
      {},
    ).text;
    expect(text).toContain("<dsh_output_schema_json>");
    expect(text).toContain("</dsh_output_schema_json>");
    expect(text).toContain("verdict");
    expect(text).toContain("strict");
    expect(text).toContain("one JSON value matching the supplied schema");
  });

  test("the new transport prompt never emits the legacy recovery marker", () => {
    // Issue #172 / recovery boundary: the legacy marker stays a recognized
    // fail-closed input in conversation-projection, but neither the first-turn
    // compile nor the continuation compile may emit it.
    const legacyMarker = "Act as the model backend for the task encoded below.";
    const firstTurn = compileChatGptWebPrompt(parsedWithSystem([user("hola")]), READ_ONLY_CAPS).text;
    expect(firstTurn).not.toContain(legacyMarker);
    const delta = retainedConversationResumeRequest(parsedWithSystem([
      user("hola"),
      assistant("adios"),
      user("otra vez"),
    ]))!;
    const continuation = compileRetainedChatGptWebContinuation(delta, {}).text;
    expect(continuation).not.toContain(legacyMarker);
  });

  test("Luna respects retained-vs-rolling-checkpoint", () => {
    const lunaMessages: CodexMessage[] = [
      user("hola luna"),
      assistant("adios luna"),
      user("otra vez"),
    ];
    const lunaDelta = retainedConversationResumeRequest(
      parsed(lunaMessages, { modelId: CHATGPT_WEB_LUNA_MODEL_ID }),
    )!;
    // A retained Luna continuation sends the delta without a private checkpoint tail.
    const retained = compileRetainedChatGptWebContinuation(lunaDelta, {}).text;
    expect(retained).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
    // The same Luna delta with rolling checkpoint capture requests the private tail.
    const rolling = compileRetainedChatGptWebContinuation(lunaDelta, { captureLunaCheckpoint: true }).text;
    expect(rolling).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  });

  test("a read-only run emits no synthetic Pure Chat commentary", () => {
    // Issue #172 / final experience: the synthetic "Pure Chat Mode" banner was
    // provider commentary the user never asked for; the adapter no longer emits it.
    expect(adapterSource).not.toContain("emitReadOnlyContextWarning");
    expect(adapterSource).not.toContain("Pure Chat Mode");
    const text = compileChatGptWebPrompt(parsed([user("hola")]), READ_ONLY_CAPS).text;
    expect(text).not.toContain("Pure Chat");
  });
});
