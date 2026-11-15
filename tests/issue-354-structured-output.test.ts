import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import {
  ChatCompletionsRequestError,
  chatFinishReason,
  toChatCompletion,
  toChatCompletionStream,
  translateChatCompletionsRequest,
} from "../src/responses/chat-completions";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";

/**
 * Issue #354 — structured output and OpenAI wire fidelity on `/v1/chat/completions`.
 *
 * The integration this unblocks sends a `response_format` on every structured call and validates the
 * reply itself. The bridge is a text-only consumer web chat: it has no native schema enforcement, so
 * the only honest contract is
 *
 *   accept the wire shape → carry the request into the turn as text → return the reply verbatim,
 *   and declare that the mode is soft.
 *
 * These tests pin exactly that, plus the two smaller wire gaps from the same issue
 * (`max_completion_tokens`, `finish_reason`). They deliberately prove the *negative* properties too:
 * a schema is neither content (it never refuses a request) nor a capability (it is never declared as
 * dropped), the schema never becomes message text, and a truncation signal that is not provable is
 * never invented.
 */
const READ_ONLY_CAPS: ChatGptWebCapabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

const running: RunningServer[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { ...defaultConfig(), port: 0, host: "127.0.0.1", ...overrides };
}

const USER_MESSAGE = { role: "user", content: "hola" };
const BASE = { model: "chatgpt-web/luna", messages: [USER_MESSAGE] };

const SCHEMA = {
  type: "object",
  properties: { label: { type: "string" }, confidence: { type: "number" } },
  required: ["label", "confidence"],
  additionalProperties: false,
} as const;

const JSON_SCHEMA_FORMAT = {
  type: "json_schema",
  json_schema: { name: "verdict", strict: true, schema: SCHEMA },
} as const;

/** What the provider is asked to send, and what it answers, for the listener tests. */
interface StubTurn {
  request: {
    context?: { messages?: unknown[]; systemPrompt?: string[] };
  };
}

function stubAdapter(reply = "{\"label\":\"ok\",\"confidence\":0.9}", terminal: Record<string, unknown> = {}) {
  const turns: StubTurn[] = [];
  return {
    turns,
    factory: () => ({
      name: "issue-354-stub",
      runTurn: async (parsed: StubTurn["request"], _incoming: unknown, emit: (event: unknown) => void) => {
        turns.push({ request: parsed });
        emit({ type: "text_delta", text: reply, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true, ...terminal });
      },
    }) as never,
  };
}

function serve(adapterFactory: unknown): RunningServer {
  const server = startServer(makeConfig() as never, { adapterFactory } as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: RunningServer, body: unknown) =>
  fetch(url(server, "/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("issue #354 — response_format is accepted and carried as text", () => {
  test("a strict json_schema reaches the turn on the instruction channel, never as a message", () => {
    const translation = translateChatCompletionsRequest({ ...BASE, response_format: JSON_SCHEMA_FORMAT });

    // The surface reports the request it accepted, which is what the route declares as "soft".
    expect(translation.structuredOutput).toEqual({
      mode: "json_schema",
      name: "verdict",
      strict: true,
      schema: SCHEMA,
    });

    // The schema travels as plain text on the internal instruction channel. The provider is a text
    // web chat, so this is the only carrier that exists; nothing here claims enforcement.
    const instructions = translation.body.instructions as string;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("strict");
    expect(instructions).toContain("verdict");
    expect(instructions).toContain("one JSON value matching the supplied schema");
    expect(instructions).toContain("Do not wrap it in a Markdown code fence");
    expect(instructions).toContain("<dsh_output_schema_json>");
    expect(instructions).toContain(JSON.stringify(SCHEMA));
    expect(instructions).toContain("</dsh_output_schema_json>");

    // The caller's conversation stays message-only: the schema is not content the model reads as a
    // user turn, and the projected input is exactly the one user message.
    expect(translation.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] },
    ]);
    expect(JSON.stringify(translation.body.input)).not.toContain("label");
    // A schema is not a capability declaration: nothing was dropped, so nothing is declared.
    expect(translation.droppedCapabilities).toEqual([]);
  });

  test("json_object is accepted and carried as a text instruction", () => {
    const translation = translateChatCompletionsRequest({ ...BASE, response_format: { type: "json_object" } });

    expect(translation.structuredOutput).toEqual({ mode: "json_object" });
    const instructions = translation.body.instructions as string;
    expect(instructions).toContain("one JSON object");
    expect(instructions).toContain("Do not wrap it in a Markdown code fence");
    // There is no schema to carry, so no schema block is invented.
    expect(instructions).not.toContain("<dsh_output_schema_json>");
    expect(translation.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] },
    ]);
  });

  test("an optional name and strict are honoured, and an empty schema object is a valid schema", () => {
    const unnamed = translateChatCompletionsRequest({
      ...BASE,
      response_format: { type: "json_schema", json_schema: { schema: {} } },
    });
    expect(unnamed.structuredOutput).toEqual({ mode: "json_schema", schema: {} });
    expect(unnamed.body.instructions as string).toContain("JSON-schema final answer.");
    expect(unnamed.body.instructions as string).not.toContain("strict");

    const loose = translateChatCompletionsRequest({
      ...BASE,
      response_format: { type: "json_schema", json_schema: { name: "x", strict: false, schema: { type: "object" } } },
    });
    expect(loose.structuredOutput).toEqual({ mode: "json_schema", name: "x", strict: false, schema: { type: "object" } });
    expect(loose.body.instructions as string).not.toContain("strict");
  });

  test("{\"type\":\"text\"} and an absent response_format are byte-for-byte unchanged", () => {
    const absent = translateChatCompletionsRequest(BASE);
    const text = translateChatCompletionsRequest({ ...BASE, response_format: { type: "text" } });

    expect(JSON.stringify(text.body)).toBe(JSON.stringify(absent.body));
    // No instruction channel, no schema, no structured-output declaration: the historical response.
    expect("instructions" in absent.body).toBe(false);
    expect(absent.structuredOutput).toBeUndefined();
    expect(text.structuredOutput).toBeUndefined();
  });

  test("malformed or unknown response_format is a typed refusal with a stable code", () => {
    const malformed: unknown[] = [
      // Not an object at all.
      "json",
      ["json_object"],
      // Unknown / unsupported type.
      { type: "json" },
      { type: "xml" },
      { type: 7 },
      // json_schema without its declaration.
      { type: "json_schema" },
      { type: "json_schema", json_schema: null },
      { type: "json_schema", json_schema: "nope" },
      // A declaration without a usable schema.
      { type: "json_schema", json_schema: {} },
      { type: "json_schema", json_schema: { schema: null } },
      { type: "json_schema", json_schema: { schema: "nope" } },
      { type: "json_schema", json_schema: { schema: [] } },
      // A declaration whose optional fields are the wrong type.
      { type: "json_schema", json_schema: { name: 5, schema: {} } },
      { type: "json_schema", json_schema: { name: "", schema: {} } },
      { type: "json_schema", json_schema: { strict: "yes", schema: {} } },
    ];
    for (const responseFormat of malformed) {
      let error: unknown;
      try {
        translateChatCompletionsRequest({ ...BASE, response_format: responseFormat });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ChatCompletionsRequestError);
      // One stable code, so a caller can act on the refusal without matching message text.
      expect((error as ChatCompletionsRequestError).code).toBe("invalid_response_format");
    }
  });

  test("the schema is a wire format: neither content to refuse nor a capability to drop", () => {
    // A capability declaration beside a schema is still discarded-and-declared, never refused.
    const withTools = translateChatCompletionsRequest({
      ...BASE,
      response_format: JSON_SCHEMA_FORMAT,
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(withTools.droppedCapabilities).toEqual(["tools"]);
    expect(withTools.structuredOutput).toEqual({
      mode: "json_schema",
      name: "verdict",
      strict: true,
      schema: SCHEMA,
    });
    expect(JSON.stringify(withTools.body)).not.toContain("read_file");

    // Attached content still refuses: accepting a schema must never become a way to accept content
    // the text-only contract cannot carry.
    expect(() => translateChatCompletionsRequest({
      ...BASE,
      response_format: JSON_SCHEMA_FORMAT,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }] }],
    })).toThrow(/images/);
    expect(() => translateChatCompletionsRequest({
      ...BASE,
      response_format: JSON_SCHEMA_FORMAT,
      files: [{ id: "f" }],
    })).toThrow(/files/);
  });
});

describe("issue #354 — max_completion_tokens is an alias of max_tokens", () => {
  test("either name sets the same internal budget", () => {
    const legacy = translateChatCompletionsRequest({ ...BASE, max_tokens: 64 });
    const modern = translateChatCompletionsRequest({ ...BASE, max_completion_tokens: 64 });
    expect(legacy.body.max_output_tokens).toBe(64);
    expect(modern.body.max_output_tokens).toBe(64);
    // Both names with the same value agree, so the request is accepted.
    expect(translateChatCompletionsRequest({ ...BASE, max_tokens: 64, max_completion_tokens: 64 }).body.max_output_tokens)
      .toBe(64);
    // Neither name leaves the turn unbounded, exactly as before.
    expect("max_output_tokens" in translateChatCompletionsRequest(BASE).body).toBe(false);
  });

  test("both names with different values are refused with a stable code", () => {
    let error: unknown;
    try {
      translateChatCompletionsRequest({ ...BASE, max_tokens: 64, max_completion_tokens: 32 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatCompletionsRequestError);
    expect((error as ChatCompletionsRequestError).code).toBe("conflicting_max_tokens");
  });
});

describe("issue #354 — finish_reason reports only a provable truncation", () => {
  test("max_output_tokens is length; every other terminal state keeps stop", () => {
    expect(chatFinishReason({ status: "completed" })).toBe("stop");
    expect(chatFinishReason({})).toBe("stop");
    expect(chatFinishReason({ status: "incomplete" })).toBe("stop");
    expect(chatFinishReason({ status: "incomplete", incomplete_details: null })).toBe("stop");
    // The one provable signal: the output budget was exhausted.
    expect(chatFinishReason({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))
      .toBe("length");
    // Cut-offs that are NOT the output-budget limit keep "stop": re-labelling them "length" would
    // invent a signal the provider never reported, and a caller would retry for the wrong reason.
    for (const reason of ["content_filter", "adapter_eof", "stream_ended", "cancelled", "upstream_stall_timeout"]) {
      expect(chatFinishReason({ status: "incomplete", incomplete_details: { reason } })).toBe("stop");
    }
    expect(chatFinishReason({ status: "failed", incomplete_details: { reason: "max_output_tokens" } })).toBe("stop");
  });

  test("a batch completion and the streaming terminal frame agree", async () => {
    const truncated = {
      id: "resp_354",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"label\":\"ok\"" }] }],
    };
    const completion = toChatCompletion(truncated, "chatgpt-web/luna") as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    // The reply is returned exactly as the model produced it: no parse, no repair, no re-serialize.
    expect(completion.choices[0]!.message.content).toBe("{\"label\":\"ok\"");
    expect(completion.choices[0]!.finish_reason).toBe("length");

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of [
          { type: "response.output_text.delta", delta: "{\"label\":\"ok\"" },
          { type: "response.incomplete", response: truncated },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    const text = await new Response(toChatCompletionStream(upstream, "chatgpt-web/luna")).text();
    const frames = text.split("\n\n").filter((frame) => frame.startsWith("data:") && !frame.includes("[DONE]"));
    const last = JSON.parse(frames.at(-1)!.slice("data:".length).trim());
    expect(last.choices[0].finish_reason).toBe("length");

    // A completed turn is unchanged: the historical "stop".
    const completed = toChatCompletion({ id: "resp_355", status: "completed", output: [] }, "chatgpt-web/luna") as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(completed.choices[0]!.finish_reason).toBe("stop");
  });
});

describe("issue #354 — over the real listener", () => {
  test("a structured request returns the model's JSON verbatim and declares the soft mode", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, { ...BASE, response_format: JSON_SCHEMA_FORMAT });

    expect(response.status).toBe(200);
    // The caller can tell "asked for JSON" from "enforced JSON" without inspecting the reply.
    expect(response.headers.get("x-dsh-chatgpt-web-structured-output")).toBe("soft");
    // A schema is not a capability: nothing was dropped, so nothing is declared as dropped.
    expect(response.headers.get("x-dsh-chatgpt-web-ignored-features")).toBeNull();

    const completion = await response.json() as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    // Verbatim: the JSON text the model produced, not a parsed/re-serialized object.
    expect(completion.choices[0]!.message.content).toBe("{\"label\":\"ok\",\"confidence\":0.9}");
    expect(completion.choices[0]!.finish_reason).toBe("stop");

    // The proof that matters: the schema reached the turn's instruction channel, and never a message.
    expect(stub.turns).toHaveLength(1);
    const systemPrompt = stub.turns[0]!.request.context?.systemPrompt ?? [];
    expect(systemPrompt.join("\n")).toContain("<dsh_output_schema_json>");
    expect(systemPrompt.join("\n")).toContain(JSON.stringify(SCHEMA));
    const messages = JSON.stringify(stub.turns[0]!.request.context?.messages ?? []);
    expect(messages).toContain("hola");
    expect(messages).not.toContain("dsh_output_schema_json");
    expect(messages).not.toContain("confidence");
  });

  test("a plain request publishes no structured-output header", async () => {
    const server = serve(stubAdapter().factory);

    for (const body of [BASE, { ...BASE, response_format: { type: "text" } }]) {
      const response = await post(server, body);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-dsh-chatgpt-web-structured-output")).toBeNull();
    }
  });

  test("a malformed schema is a typed 400 and submits nothing to the provider", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, {
      ...BASE,
      response_format: { type: "json_schema", json_schema: { name: "verdict" } },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { type?: string; code?: string; message?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.code).toBe("invalid_response_format");
    expect(body.error?.message).toContain("response_format.json_schema.schema");
    expect(stub.turns).toHaveLength(0);
  });

  test("conflicting max token names are a typed 400 and submit nothing", async () => {
    const stub = stubAdapter();
    const server = serve(stub.factory);

    const response = await post(server, { ...BASE, max_tokens: 64, max_completion_tokens: 32 });
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("conflicting_max_tokens");
    expect(stub.turns).toHaveLength(0);
  });

  test("a turn the provider marks as max_tokens is reported as finish_reason length", async () => {
    // The bridge's own terminal vocabulary: `stopReason: "max_tokens"` becomes
    // `status: "incomplete", incomplete_details.reason: "max_output_tokens"`, which is the one signal
    // this surface maps to "length". No adapter emits it today, but the mapping is real, not a stub.
    const stub = stubAdapter("{\"label\":\"ok\"", { stopReason: "max_tokens" });
    const server = serve(stub.factory);

    const response = await post(server, { ...BASE, response_format: JSON_SCHEMA_FORMAT });
    expect(response.status).toBe(200);
    const completion = await response.json() as { choices: Array<{ message: { content: string }; finish_reason: string }> };
    expect(completion.choices[0]!.message.content).toBe("{\"label\":\"ok\"");
    expect(completion.choices[0]!.finish_reason).toBe("length");
  });

  test("the streaming terminal frame carries the same proven finish reason", async () => {
    const stub = stubAdapter("{\"label\":\"ok\"", { stopReason: "max_tokens" });
    const server = serve(stub.factory);

    const response = await post(server, { ...BASE, response_format: JSON_SCHEMA_FORMAT, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dsh-chatgpt-web-structured-output")).toBe("soft");

    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data:") && !frame.includes("[DONE]"))
      .map((frame) => JSON.parse(frame.slice("data:".length).trim()));
    expect(frames.at(-1)!.choices[0].finish_reason).toBe("length");
  });
});

describe("issue #354 — the schema is provider-visible text, not a hidden field", () => {
  test("the ChatGPT transport prompt carries the schema the surface accepted", () => {
    // End to end through the real owners: the wire translation builds the internal body, the real
    // Responses parser turns it into a parsed request, and the real ChatGPT prompt compiler serializes
    // the instruction channel into the composer text. This is what "carried softly" means for the
    // provider that has an instruction channel at all.
    const translation = translateChatCompletionsRequest({
      model: CHATGPT_WEB_MODEL_ID,
      messages: [{ role: "user", content: "give me a verdict" }],
      response_format: JSON_SCHEMA_FORMAT,
    });
    const parsed = parseRequest(translation.body);
    expect(parsed.context.systemPrompt?.join("\n")).toContain("<dsh_output_schema_json>");

    const compiled = compileChatGptWebPrompt(parsed, READ_ONLY_CAPS);
    expect(compiled.text).toContain("<dsh_output_schema_json>");
    expect(compiled.text).toContain("verdict");
    expect(compiled.text).toContain("one JSON value matching the supplied schema");
    // The schema is output-format data, not a second conversation turn.
    expect(compiled.text).toContain("give me a verdict");
  });
});
