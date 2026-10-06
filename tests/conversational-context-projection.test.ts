import { describe, expect, test } from "bun:test";
import type { RequestMessage } from "@deepseek-ai/dsh-llm";
import {
  ConversationalContextProjectionError,
  projectConversationalMessages,
} from "../src/conversation-projection";

function user(content: string): RequestMessage {
  return { role: "user", content } as RequestMessage;
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
    expect((projected[0] as { content: string }).content).toBe("User question");
  });

  test("handles braces and transport-closing text inside JSON strings", () => {
    const content = 'Literal } braces and </codex_context_json> text must remain user content.';
    const envelope = `<codex_context_json>${JSON.stringify({
      messages: [{ role: "user", content }],
    })}</codex_context_json>`;

    const projected = projectConversationalMessages([user(envelope)]);

    expect(projected).toHaveLength(1);
    expect((projected[0] as { content: string }).content).toBe(content);
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
    expect((projected[0] as { content: string }).content).toBe("Hola");
  });

  test("removes an unterminated internal block rather than leaking its remainder", () => {
    const projected = projectConversationalMessages([user(
      "Hola\n<hindsight_memory>secret never closed",
    )]);

    expect(projected).toHaveLength(1);
    expect((projected[0] as { content: string }).content).toBe("Hola");
    expect(JSON.stringify(projected)).not.toContain("secret never closed");
  });

  test("keeps clean non-envelope messages unchanged", () => {
    const message = user("A normal user message with no internal markers.");
    const projected = projectConversationalMessages([message]);

    expect(projected).toEqual([message]);
  });
});
