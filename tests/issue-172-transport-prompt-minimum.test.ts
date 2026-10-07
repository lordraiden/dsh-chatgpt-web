import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
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
    const text = compileChatGptWebPrompt(delta!, READ_ONLY_CAPS).text;
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
