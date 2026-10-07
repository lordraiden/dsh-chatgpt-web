import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_FIXED_TRANSPORT_OVERHEAD_BUDGET,
  compileChatGptWebPrompt,
  compileRetainedChatGptWebContinuation,
  compileRetainedChatGptWebInstall,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import {
  chatGptSystemFingerprint,
  resolveChatGptResumeBranch,
  retainedConversationResumeRequest,
  type ChatGptResumeBranch,
} from "../src/adapters/chatgpt-web/conversation-key";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
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

describe("issue #172 retained composer transport", () => {
  const SYSTEM_PROMPT = "You are a concise conversational assistant.";
  const NEW_SYSTEM_PROMPT = "You are a verbose analytical assistant.";
  const WORKSPACE = "/home/raiden/Documents/dsh-chatgpt-web";

  function parsedWithSystem(messages: CodexMessage[], systemPrompt: string[] = [SYSTEM_PROMPT]): CodexParsedRequest {
    return parsed(messages, { context: { systemPrompt, messages } });
  }

  function parsedWithWorkspace(messages: CodexMessage[], systemPrompt: string[] = [SYSTEM_PROMPT]): CodexParsedRequest {
    return parsed(messages, {
      context: { systemPrompt, messages },
      _dshContext: {
        threadId: "dsh-test",
        turnId: "turn-1",
        environment: {
          cwd: WORKSPACE,
          roots: [WORKSPACE],
          writableRoots: [WORKSPACE],
          sandboxMode: "workspace-write",
          networkAccess: false,
        },
      },
    });
  }

  test("the first retained turn installs prefix + workspace + message as plain composer text", () => {
    const text = compileRetainedChatGptWebInstall(
      parsedWithWorkspace([user("hola, dime si funcionas?")]),
      {},
    ).text;
    expect(text).toBe(
      `You are a concise conversational assistant.\nWorking workspace: ${WORKSPACE}\n\nhola, dime si funcionas?`,
    );
    for (const marker of [
      "<codex_context_json>",
      "</codex_context_json>",
      "<dsh_transport_resume>",
      "Execute the latest active user request now",
    ]) {
      expect(text).not.toContain(marker);
    }
  });

  test("the first retained turn without a workspace reference is exactly prefix + message", () => {
    const text = compileRetainedChatGptWebInstall(
      parsedWithSystem([user("hola, dime si funcionas?")]),
      {},
    ).text;
    expect(text).toBe("You are a concise conversational assistant.\n\nhola, dime si funcionas?");
  });

  test("an install without a system prompt sends only the human content", () => {
    const text = compileRetainedChatGptWebInstall(parsed([user("hola")]), {}).text;
    expect(text).toBe("hola");
  });

  test("an install projects restart history into User:/Assistant: lines", () => {
    const text = compileRetainedChatGptWebInstall(
      parsedWithSystem([
        user("pregunta one"),
        assistant("respuesta one"),
        user("pregunta actual"),
      ]),
      {},
    ).text;
    expect(text).toBe(
      "You are a concise conversational assistant.\n\nUser: pregunta one\nAssistant: respuesta one\nUser: pregunta actual",
    );
  });

  test("an install strips internal blocks from the projected conversation", () => {
    const text = compileRetainedChatGptWebInstall(
      parsedWithSystem([
        user("Time sampled while preparing turn 1, step 1: 2026-10-07T18:00:00+02:00[Europe/Madrid]"),
        user("<AEGIS_DSH_ROUTING_BOOTSTRAP>You have Aegis.</AEGIS_DSH_ROUTING_BOOTSTRAP>hola"),
        assistant("sí"),
        user("pregunta actual"),
      ]),
      {},
    ).text;
    expect(text).toContain("hola");
    expect(text).toContain("User: pregunta actual");
    expect(text).not.toContain("AEGIS");
    expect(text).not.toContain("Time sampled");
  });

  test("the Aegis bootstrap is stripped from a continuation delta", () => {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("<AEGIS_DSH_ROUTING_BOOTSTRAP>\nYou have Aegis.\n</AEGIS_DSH_ROUTING_BOOTSTRAP>"),
      user("otra vez?"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const text = compileRetainedChatGptWebContinuation(delta, {}).text;
    expect(text).toBe("otra vez?");
  });

  test("a retained continuation sends only the new human content, no contract, no envelope", () => {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("pregunta dos"),
      assistant("respuesta dos"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const text = compileRetainedChatGptWebContinuation(delta, {}).text;
    expect(text).toBe("pregunta actual");
    for (const phrase of [
      "Read the complete inline JSON task context before acting",
      "Interpret every message role literally",
      "Do not mention this transport contract, context packaging, or capability routing",
      "continuation of this ChatGPT conversation",
      "Execute the latest active user request now",
    ]) {
      expect(text).not.toContain(phrase);
    }
    for (const marker of ["<codex_context_json>", "<dsh_transport_resume>"]) {
      expect(text).not.toContain(marker);
    }
  });

  test("a retained continuation does not re-send the installed systemPrompt", () => {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("pregunta actual"),
    ];
    const delta = retainedConversationResumeRequest(parsedWithSystem(full))!;
    const continuation = compileRetainedChatGptWebContinuation(delta, {});
    expect(continuation.text).not.toContain(SYSTEM_PROMPT);
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

  test("the continuation composer text is dramatically smaller than the first-turn envelope", () => {
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

  test("the continuation fixed overhead is zero: the composer text is exactly the human delta", () => {
    // Round 4: the composer transport has no framing at all. The fixed overhead is
    // 0 bytes, so the strongest possible assertion is exact text equality for the
    // smallest legal delta (one 1-character user message).
    const delta = retainedConversationResumeRequest(
      parsed([user("h"), assistant("a"), user("x")]),
    )!;
    expect(compileRetainedChatGptWebContinuation(delta, {}).text).toBe("x");
  });

  test("the continuation keeps only user-role content, in order", () => {
    const delta: CodexMessage[] = [
      user("uno"),
      { role: "developer", content: "dos", timestamp: 3 },
      user("tres"),
    ];
    const text = compileRetainedChatGptWebContinuation(parsed(delta), {}).text;
    expect(text).toBe("uno\n\ntres");
  });

  test("images work in the continuation through the per-turn attachment mechanism", () => {
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
    expect(compiled.text).toBe("what is in this image?");
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

  test("a delta without human content throws so the caller falls back to the envelope", () => {
    const delta: CodexMessage[] = [
      user("<AEGIS_DSH_ROUTING_BOOTSTRAP>You have Aegis.</AEGIS_DSH_ROUTING_BOOTSTRAP>"),
      user("Time sampled while preparing turn 2, step 1: 2026-10-07T18:00:00+02:00[Europe/Madrid]"),
      { role: "agentMessage", author: "lead", recipient: "worker", content: "internal", timestamp: 4 },
    ];
    expect(() => compileRetainedChatGptWebContinuation(parsed(delta), {})).toThrow(/human content/i);
  });

  test("the new transport prompt never emits the legacy recovery marker", () => {
    // Issue #172 / recovery boundary: the legacy marker stays a recognized
    // fail-closed input in conversation-projection, but neither the retained
    // install nor the continuation may emit it.
    const legacyMarker = "Act as the model backend for the task encoded below.";
    const install = compileRetainedChatGptWebInstall(parsedWithSystem([user("hola")]), {}).text;
    expect(install).not.toContain(legacyMarker);
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

describe("issue #172 compileResume orchestration (prefix frozen per physical conversation)", () => {
  const SYSTEM = "You are a concise conversational assistant.";
  const NEW_SYSTEM = "You are a verbose analytical assistant.";

  // The real delta a retained continuation carries, for a given system block.
  function deltaParsed(system: string[]): CodexParsedRequest {
    const full: CodexMessage[] = [
      user("pregunta one"),
      assistant("respuesta one"),
      user("pregunta actual"),
    ];
    return retainedConversationResumeRequest(
      parsed(full, { context: { systemPrompt: system, messages: full } }),
    )!;
  }

  // Executes the SAME branch decision the adapter's compileResume uses
  // (resolveChatGptResumeBranch in conversation-key.ts), then applies the real
  // compile function for the chosen branch. The decision is NOT re-stated here:
  // the production function owns it, so a test can only diverge from production
  // by changing the compile it feeds the result to — never the condition.
  function resume(
    sessions: ChatGptTurnSessions,
    conversationKey: string,
    generation: number,
    input: CodexParsedRequest,
  ): { branch: ChatGptResumeBranch; text: string } {
    const branch = resolveChatGptResumeBranch(
      sessions,
      conversationKey,
      generation,
      input.context.systemPrompt,
    );
    return {
      branch,
      text: branch === "continue"
        ? compileRetainedChatGptWebContinuation(input, {}).text
        : compileRetainedChatGptWebInstall(input, {}).text,
    };
  }

  test("case A: no recorded fingerprint for the generation → install with prefix + message, no envelope", () => {
    const sessions = new ChatGptTurnSessions();
    const key = "conversation-a";
    const { branch, text } = resume(sessions, key, 1, deltaParsed([SYSTEM]));
    expect(branch).toBe("install");
    expect(text).toBe(`${SYSTEM}\n\npregunta actual`);
    for (const marker of ["<codex_context_json>", "<dsh_transport_resume>"]) {
      expect(text).not.toContain(marker);
    }
  });

  test("case B: matching fingerprint in the current generation → continue with only the message", () => {
    const sessions = new ChatGptTurnSessions();
    const key = "conversation-b";
    sessions.recordSentSystemFingerprint(key, 1, chatGptSystemFingerprint([SYSTEM]));
    const { branch, text } = resume(sessions, key, 1, deltaParsed([SYSTEM]));
    expect(branch).toBe("continue");
    expect(text).toBe("pregunta actual");
    expect(text).not.toContain(SYSTEM);
  });

  test("case C: mismatched fingerprint in the same generation → continue with the prefix frozen", () => {
    // The prefix is installed once per physical conversation. A persona/system
    // change mid-conversation does NOT re-inject the envelope machinery; the
    // change takes effect in the next physical conversation.
    const sessions = new ChatGptTurnSessions();
    const key = "conversation-c";
    sessions.recordSentSystemFingerprint(key, 1, chatGptSystemFingerprint([SYSTEM]));
    const { branch, text } = resume(sessions, key, 1, deltaParsed([NEW_SYSTEM]));
    expect(branch).toBe("continue");
    expect(text).toBe("pregunta actual");
    expect(text).not.toContain(NEW_SYSTEM);
    expect(text).not.toContain(SYSTEM);
  });

  test("case D: a failed turn never records the fingerprint → next turn is an install", async () => {
    const sessions = new ChatGptTurnSessions();
    const key = "conversation-d";
    const generation = 1;
    // Mirror the adapter wiring: the fingerprint is recorded ONLY in the success
    // branch of the browser promise. A failed turn rejects, so the success
    // branch never runs and the fingerprint is never established.
    const fingerprint = chatGptSystemFingerprint([SYSTEM]);
    const failedBrowser = Promise.reject(new Error("browser turn failed"));
    await new Promise<void>(resolve => {
      void failedBrowser.then(
        () => { sessions.recordSentSystemFingerprint(key, generation, fingerprint); resolve(); },
        () => resolve(),
      );
    });
    expect(sessions.sentSystemFingerprint(key, generation)).toBeUndefined();
    // Next turn: the fingerprint is still absent → the production decision
    // installs the prefix again (the safe direction).
    const { branch, text } = resume(sessions, key, generation, deltaParsed([SYSTEM]));
    expect(branch).toBe("install");
    expect(text).toBe(`${SYSTEM}\n\npregunta actual`);
  });

  test("case E: a fingerprint recorded for generation N is never valid for N+1; only N+1's own settled fingerprint is", () => {
    const sessions = new ChatGptTurnSessions();
    const key = "conversation-gen";
    sessions.recordSentSystemFingerprint(key, 1, chatGptSystemFingerprint([SYSTEM]));
    // Same generation → valid (continue).
    expect(sessions.sentSystemFingerprint(key, 1)).toBe(chatGptSystemFingerprint([SYSTEM]));
    expect(resolveChatGptResumeBranch(sessions, key, 1, [SYSTEM])).toBe("continue");
    // Replacement epoch (N+1) → the generation-1 fingerprint is NOT valid → install.
    expect(sessions.sentSystemFingerprint(key, 2)).toBeUndefined();
    expect(resolveChatGptResumeBranch(sessions, key, 2, [SYSTEM])).toBe("install");
    // A system delivered to generation 2 settles → bound to generation 2;
    // generation 1 no longer reports a fingerprint.
    sessions.recordSentSystemFingerprint(key, 2, chatGptSystemFingerprint([SYSTEM]));
    expect(sessions.sentSystemFingerprint(key, 1)).toBeUndefined();
    expect(sessions.sentSystemFingerprint(key, 2)).toBe(chatGptSystemFingerprint([SYSTEM]));
    expect(resolveChatGptResumeBranch(sessions, key, 2, [SYSTEM])).toBe("continue");
  });
});
