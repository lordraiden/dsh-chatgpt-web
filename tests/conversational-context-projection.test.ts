import { describe, expect, test } from "bun:test";
import type { RequestMessage } from "@deepseek-ai/dsh-llm";
import {
  ConversationalContextProjectionError,
  projectConversationalMessages,
} from "../src/conversation-projection";

function user(content: string): RequestMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
  } as RequestMessage;
}

function textOf(message: RequestMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

describe("conversational context projection", () => {
  test("extracts only the conversational history from the DSH transport envelope", () => {
    const envelope = `
Act as the model backend for the task encoded below.
<hindsight_knowledge>
SECRET HINDSIGHT KNOWLEDGE
</hindsight_knowledge>
<hindsight_memory>
SECRET HINDSIGHT MEMORY
</hindsight_memory>
<hindsight_future_internal_section>
SECRET FUTURE HINDSIGHT
</hindsight_future_internal_section>
<hindsight_knowledge_refresh>
SECRET HINDSIGHT REFRESH
</hindsight_knowledge_refresh>
<environment_context>
SECRET ENVIRONMENT CONTEXT
</environment_context>
<codex_context_json>
${JSON.stringify({
  messages: [
    { role: "user", content: "Hola" },
    { role: "assistant", content: "Respuesta anterior" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "Respuesta visible" },
      ],
    },
    { role: "developer", content: "internal developer instructions" },
    { role: "tool", content: "internal tool output" },
    {
      role: "user",
      content: [
        "not a valid block",
      ],
    },
  ],
})}
</codex_context_json>
<dsh_transport_resume>
CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2
Objective:
- internal state
</dsh_transport_resume>
`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toHaveLength(3);
    expect(projected.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(JSON.stringify(projected)).toContain("Hola");
    expect(JSON.stringify(projected)).toContain("Respuesta anterior");
    expect(JSON.stringify(projected)).toContain("Respuesta visible");
    expect(JSON.stringify(projected)).not.toContain("SECRET HINDSIGHT");
    expect(JSON.stringify(projected)).not.toContain("SECRET FUTURE HINDSIGHT");
    expect(JSON.stringify(projected)).not.toContain("SECRET ENVIRONMENT CONTEXT");
    expect(JSON.stringify(projected)).not.toContain("private reasoning");
    expect(JSON.stringify(projected)).not.toContain("internal developer");
    expect(JSON.stringify(projected)).not.toContain("internal tool");
    expect(JSON.stringify(projected)).not.toContain("CODEXLUNAPRIVATECHECKPOINT");
    expect(JSON.stringify(projected)).not.toContain("<dsh_transport_resume>");
  });

  test("drops injected operational time lines from projected user messages", () => {
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{
        role: "user",
        content: [
          "User question",
          "Time sampled while preparing turn 1, step 1: 2026-10-06T12:29:05+02:00[Europe/Madrid]",
          "Browser time zone for this request: Europe/Madrid.",
          "Elapsed since the preceding model-visible message: unavailable.",
        ].join("\n"),
      }],
    })}</codex_context_json>`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("User question");
  });

  test("handles braces and transport-closing text inside JSON strings", () => {
    const content = 'Literal } braces and </codex_context_json> text must remain user content.';
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{ role: "user", content }],
    })}</codex_context_json>`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe(content);
  });
  test("parses escaped quotes, backslashes and braces inside real JSON string content", () => {
    const content = 'Hindsight text includes "quoted instructions", escaped \\slashes, and JSON-like {braces}. It can also contain a literal sequence like \\n inside the source JSON string.';
    const envelope = `<codex_context_json>${JSON.stringify({
      version: 3,
      system: ["You are a concise conversational assistant."],
      messages: [
        { role: "user", content: "prueba de contexto enviado" },
        { role: "user", content: `<hindsight_knowledge>\n${content}\n</hindsight_knowledge>` },
      ],
    })}</codex_context_json>`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("prueba de contexto enviado");
    expect(JSON.stringify(projected)).not.toContain("quoted instructions");
    expect(JSON.stringify(projected)).not.toContain("\\slashes");
  });

  test("fails closed on malformed transport instead of forwarding raw protocol text", () => {
    expect(() =>
      projectConversationalMessages([user(
        "<codex_context_json>{\"messages\":[broken]</codex_context_json>",
      )]),
    ).toThrow(ConversationalContextProjectionError);

    expect(() =>
      projectConversationalMessages([user(
        "Act as the model backend for the task encoded below. transport is incomplete.",
      )]),
    ).toThrow(ConversationalContextProjectionError);
  });

  test("strips internal tagged blocks and private checkpoint tails from ordinary messages", () => {
    const projected = projectConversationalMessages([user(
      "Hola\n<hindsight_knowledge>secret</hindsight_knowledge>\nCODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2\nObjective: secret",
    )]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("Hola");
  });

  test("removes an unterminated internal block rather than leaking its remainder", () => {
    const projected = projectConversationalMessages([user(
      "Hola\n<hindsight_memory>secret never closed",
    )]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("Hola");
    expect(JSON.stringify(projected)).not.toContain("secret never closed");
  });

  test("preserves clean conversation when standalone injected context is in a separate message", () => {
    const projected = projectConversationalMessages([
      user("prueba de contexto enviado"),
      user("<hindsight_knowledge>internal memory that must not reach ChatGPT</hindsight_knowledge>"),
      user("Time sampled while preparing turn 1, step 1: 2026-10-06T12:29:05+02:00[Europe/Madrid]"),
    ]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("prueba de contexto enviado");
  });

  test("preserves clean user and assistant history around standalone injected context", () => {
    const projected = projectConversationalMessages([
      user("first user message"),
      {
        role: "assistant",
        content: [{ type: "text", text: "first assistant answer" }],
      } as unknown as RequestMessage,
      user("<hindsight_memory>private context</hindsight_memory>"),
      user("second user message"),
    ]);

    expect(projected.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(projected.map(textOf)).toEqual([
      "first user message",
      "first assistant answer",
      "second user message",
    ]);
  });

  test("detects and removes operational context when it is embedded after conversational text", () => {
    const projected = projectConversationalMessages([
      user("keep this line\nTime sampled while preparing turn 1, step 1: 2026-10-06T12:29:05+02:00[Europe/Madrid]\nkeep this too"),
    ]);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("keep this line\nkeep this too");
  });

  test("does not preserve hidden metadata from canonical embedded messages", () => {
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{
        role: "user",
        id: "internal-id",
        source: { kind: "internal", secret: "must not survive" },
        timestamp: 123,
        content: "visible canonical content",
      }],
    })}</codex_context_json>`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "visible canonical content" }],
      },
    ]);
  });

  test("strips embedded transport metadata instead of preserving raw internal message fields", () => {
    const projected = projectConversationalMessages([
      {
        role: "user",
        id: "internal-id",
        source: { kind: "internal", secret: "must not survive" },
        content: [{ type: "text", text: "visible user content" }],
      } as unknown as RequestMessage,
      user("<hindsight_memory>secret</hindsight_memory>"),
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "visible user content" }],
      },
    ]);
  });

  test("rejects multiple canonical context envelopes instead of concatenating histories", () => {
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{ role: "user", content: "canonical" }],
    })}</codex_context_json>`;

    expect(() =>
      projectConversationalMessages([user(envelope), user(envelope)]),
    ).toThrow(ConversationalContextProjectionError);
  });

  test("keeps clean non-envelope messages unchanged", () => {
    const message = user("  A normal user message with no internal markers.  \n");
    const projected = projectConversationalMessages([message]);

    expect(projected).toEqual([message]);
  });

  test("preserves non-envelope whitespace and roles without rewriting user content", () => {
    const messages = [
      user("  leading and trailing spaces  \n"),
      {
        role: "assistant",
        content: [{ type: "text", text: "  assistant text  " }],
      },
      {
        role: "developer",
        content: [{ type: "text", text: "developer content" }],
      },
    ] as unknown as RequestMessage[];

    expect(projectConversationalMessages(messages)).toEqual(messages);
  });

  test("requires the closing codex context tag before accepting an envelope", () => {
    expect(() =>
      projectConversationalMessages([user(
        "<codex_context_json>{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}",
      )]),
    ).toThrow(ConversationalContextProjectionError);
  });

  test("treats the embedded conversation as canonical and does not duplicate outer history", () => {
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{ role: "user", content: "canonical user message" }],
    })}</codex_context_json>`;
    const outerHistory = [
      user("duplicate outer user message"),
      user(envelope),
      {
        role: "assistant",
        content: [{ type: "text", text: "duplicate outer assistant message" }],
      },
    ] as unknown as RequestMessage[];

    const projected = projectConversationalMessages(outerHistory);

    expect(projected).toHaveLength(1);
    expect(textOf(projected[0]!)).toBe("canonical user message");
  });
});
