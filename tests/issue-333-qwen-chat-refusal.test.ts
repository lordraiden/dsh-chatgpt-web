import { afterEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import {
  QWEN_CHAT_PROVIDER_ID,
  createQwenChatPageRequestFacility,
  createQwenChatTextTransport,
  qwenChatRefusal,
  readQwenChatCreatedChatId,
  readQwenChatRefusal,
  type QwenChatRequestSession,
  type QwenChatTurnRequestFacility,
} from "../src/adapters/qwen-chat";
import type { WebChatExchangeEvent } from "../src/web-chat/core";
import type { WebChatTextTransportContext } from "../src/web-chat/transport";

/**
 * Issue #333 — a Qwen Chat refusal must arrive with its evidence.
 *
 * The live failure this covers: the operator's first real turn answered
 * `Qwen Chat refused to stream-a-completion (HTTP 200, application/json)` — status and content type,
 * and nothing else. The body that *was* the diagnosis (a WAF/punish document, a dead session, an
 * unknown chat, a request-shape refusal, an empty answer) was parsed and thrown away. These fixtures
 * are the shapes the recon measured on this site's write paths (recon §1.7) plus the shapes the app's
 * own envelope vocabulary uses; none of them is a live call.
 */
const MODEL_ID = "qwen3.7-plus";

/** A synthetic 34-character token. It must never appear in a refusal or in the log line. */
const SECRET = "SECRETQWENSESSION0123456789abcdef0123456789";

/** The Alibaba TMD/`x5sec` punish page, as the recon measured it (recon §1.7). */
const PUNISH_HTML = "<!DOCTYPE html><html><head><title>Access Verification</title></head>"
  + "<body onload=\"check()\"><script>sessionStorage.x5referer=location.href;"
  + "location.replace('/_____tmd_____/punish?x5secdata=abc');</script></body></html>";

/** The `aliyun_waf` block page, as the recon measured it (recon §1.7). */
const ALIYUN_WAF_HTML = "<!DOCTYPE html><html><head><meta name=\"aliyun_waf_aa\" content=\"1\">"
  + "<title>Security verification</title></head><body><p>Please complete the verification.</p></body></html>";

/** The TMD envelope a JSON-accepting client gets instead of the HTML page (recon §1.7). */
const PUNISH_JSON = JSON.stringify({
  ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::synthetic"],
  data: {
    url: "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=synthetic&action=captchaconnect&pureCaptcha=",
    dialogSize: {},
  },
});

const AUTH_JSON = JSON.stringify({
  success: false,
  request_id: "req-synthetic",
  data: { code: "Unauthorized", details: "401 Unauthorized" },
});

const CHAT_NOT_FOUND_JSON = JSON.stringify({
  success: false,
  request_id: "req-synthetic",
  data: { code: "ChatNotFound", details: "the chat does not exist" },
});

const BAD_REQUEST_JSON = JSON.stringify({
  success: false,
  request_id: "req-synthetic",
  data: { code: "invalid_params", details: "model is required" },
});

/** A refusal whose body carries a credential-shaped field. */
const SECRET_BEARING_JSON = JSON.stringify({
  success: false,
  data: { code: "invalid_params", details: "rejected" },
  token: SECRET,
});

/** Capture `console.warn` for one call, and hand back what was written. */
async function captureWarnings<T>(body: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    return { value: await body(), lines };
  } finally {
    console.warn = original;
  }
}

describe("issue #333 — a Qwen Chat refusal names what the provider actually answered", () => {
  test("the TMD/aliyun_waf HTML punish page is an access verification, with its title", () => {
    for (const [body, title] of [[PUNISH_HTML, "Access Verification"], [ALIYUN_WAF_HTML, "Security verification"]] as const) {
      const read = readQwenChatRefusal({
        status: 200,
        contentType: "text/html; charset=utf-8",
        bodyText: body,
        what: "stream-a-completion",
        continuedChat: false,
      });
      expect(read.kind).toBe("access-verification");
      expect(read.category).toBe("AUTH_REQUIRED");
      expect(read.providerCode).toBe("QWEN_CHAT_ACCESS_VERIFICATION");
      expect(read.message).toContain("access-verification challenge");
      expect(read.message).toContain("HTTP 200");
      expect(read.message).toContain("content-type: text/html; charset=utf-8");
      expect(read.message).toContain("the provider answered with a non-JSON document");
      expect(read.message).toContain(title);
      expect(read.message).toContain("/v1/control/auth/");
      // The document is the evidence, but it is never echoed whole.
      expect(read.message).not.toContain("x5secdata=abc");
      expect(read.message.length).toBeLessThan(600);
    }
  });

  test("the TMD JSON envelope is recognized as the same challenge instead of a generic refusal", () => {
    const read = readQwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: PUNISH_JSON,
      what: "stream-a-completion",
      continuedChat: false,
    });

    expect(read.kind).toBe("access-verification");
    expect(read.providerCode).toBe("QWEN_CHAT_ACCESS_VERIFICATION");
    expect(read.message).toContain("HTTP 200");
    expect(read.message).toContain("content-type: application/json");
    expect(read.message).toContain("body snippet:");
    // The measured tokens of the JSON variant, not just the HTML one's.
    expect(read.message).toContain("FAIL_SYS_USER_VALIDATE");
    expect(read.message).toContain("RGV587_ERROR");
    // The punish URL is a URL: the shared sanitizer replaces it, never leaks it whole.
    expect(read.message).toContain("[url]");
  });

  test("a dead session is an authentication refusal, quoting the provider's own code", () => {
    const read = readQwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: AUTH_JSON,
      what: "stream-a-completion",
      continuedChat: false,
    });

    expect(read.kind).toBe("session-unauthorized");
    expect(read.category).toBe("AUTH_REQUIRED");
    expect(read.providerCode).toBe("QWEN_CHAT_SESSION_UNAUTHORIZED");
    expect(read.message).toContain("no longer accepted");
    expect(read.message).toContain("HTTP 200");
    expect(read.message).toContain("content-type: application/json");
    expect(read.message).toContain("Unauthorized 401 Unauthorized");
    expect(read.reason).toBe("Unauthorized 401 Unauthorized");
  });

  test("an unknown chat is continuity loss when it was the recorded chat, and a request refusal when it was not", () => {
    const continued = readQwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: CHAT_NOT_FOUND_JSON,
      what: "stream-a-completion",
      continuedChat: true,
    });
    expect(continued.kind).toBe("chat-lost");
    expect(continued.category).toBe("CONVERSATION_LOST");
    expect(continued.providerCode).toBe("QWEN_CHAT_CHAT_LOST");
    expect(continued.message).toContain("no longer has the chat");
    expect(continued.message).toContain("explicit replay");

    // The same answer on a chat this adapter generated (an ephemeral turn) is not "lost": there is
    // no conversation to lose, so it is reported as the provider's own refusal.
    const refused = readQwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: CHAT_NOT_FOUND_JSON,
      what: "stream-a-completion",
      continuedChat: false,
    });
    expect(refused.kind).toBe("request-refused");
    expect(refused.category).toBe("UPSTREAM_ERROR");
    expect(refused.providerCode).toBe("QWEN_CHAT_COMPLETION_REFUSED");
    expect(refused.message).toContain("ChatNotFound");
  });

  test("a JSON request refusal keeps the provider's code and a bounded body snippet", () => {
    const read = readQwenChatRefusal({
      status: 200,
      contentType: "application/json; charset=utf-8",
      bodyText: BAD_REQUEST_JSON,
      what: "stream-a-completion",
      continuedChat: false,
    });

    expect(read.kind).toBe("request-refused");
    expect(read.providerCode).toBe("QWEN_CHAT_COMPLETION_REFUSED");
    expect(read.message).toContain("HTTP 200");
    expect(read.message).toContain("content-type: application/json; charset=utf-8");
    expect(read.message).toContain("invalid_params model is required");
    expect(read.message).toContain("body snippet:");
    expect(read.message).toContain('"success":false');
  });

  test("an empty answer says so instead of pretending it was JSON", () => {
    const read = readQwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: "",
      body: undefined,
      what: "stream-a-completion",
      continuedChat: false,
    });

    expect(read.kind).toBe("empty-answer");
    expect(read.category).toBe("UPSTREAM_ERROR");
    expect(read.providerCode).toBe("QWEN_CHAT_EMPTY_ANSWER");
    expect(read.message).toContain("HTTP 200");
    expect(read.message).toContain("content-type: application/json");
    expect(read.message).toContain("empty body");
    expect(read.evidence).toBe("");
  });

  test("a refusal with headers this seam could not observe says (none) rather than inventing one", () => {
    const read = readQwenChatRefusal({
      status: 500,
      bodyText: "the upstream proxy failed",
      what: "create-a-chat",
      continuedChat: false,
    });

    expect(read.kind).toBe("request-refused");
    expect(read.message).toContain("HTTP 500");
    expect(read.message).toContain("content-type: (none)");
    expect(read.message).toContain("non-JSON body");
  });

  test("the operator's message and the one log line carry the same evidence, and no secret", async () => {
    const { value: error, lines } = await captureWarnings(() => qwenChatRefusal({
      status: 200,
      contentType: "application/json",
      bodyText: SECRET_BEARING_JSON,
      what: "stream-a-completion",
      continuedChat: false,
    }));

    const line = lines.join("");
    // One line, not many: the log is a single structured record.
    expect(lines).toHaveLength(1);
    expect(line).toContain("qwen_chat_refusal");
    expect(line).toContain(QWEN_CHAT_PROVIDER_ID);
    expect(line).toContain('"status":200');
    expect(line).toContain('"contentType":"application/json"');
    expect(line).toContain('"kind":"request-refused"');
    // The log line carries the body bytes themselves, redacted and bounded — not a paraphrase.
    expect(line).toContain('"body":"');
    expect(line).toContain("invalid_params");

    // The credential-shaped field is redacted in both places, and the token never surfaces.
    expect(error.message).toContain("[redacted]");
    expect(line).toContain("[redacted]");
    expect(error.message).not.toContain(SECRET);
    expect(line).not.toContain(SECRET);
    expect(error.providerCode).toBe("QWEN_CHAT_COMPLETION_REFUSED");
    // The structured detail rides along without changing the category.
    expect(error.providerDetail).toMatchObject({ kind: "request-refused", status: 200 });
  });

  test("a multi-line HTML refusal is a single log line (control characters stripped)", async () => {
    const { lines } = await captureWarnings(() => qwenChatRefusal({
      status: 200,
      contentType: "text/html; charset=utf-8",
      bodyText: PUNISH_HTML,
      what: "create-a-chat",
      continuedChat: false,
    }));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.includes("\n")).toBe(false);
    expect(lines[0]).toContain("Access Verification");
  });
});

describe("issue #333 — a refusal answer survives the production facility", () => {
  const originalFetch = globalThis.fetch;
  const globalRecord = globalThis as unknown as Record<string, unknown>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete globalRecord["window"];
  });

  /** A page whose `evaluate` runs the page-side closure in-process, with the bindings it exposes. */
  function fakePage(): Page {
    globalRecord["window"] = globalThis;
    return {
      async evaluate(fn: (arg: unknown) => unknown, arg: unknown) { return await fn(arg); },
      async exposeBinding(name: string, callback: (source: unknown, payload: unknown) => unknown) {
        globalRecord[name] = (payload: unknown) => callback(undefined, payload);
        return undefined;
      },
    } as unknown as Page;
  }

  /** Answer every request with one fixed response. */
  function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  }

  test("postJson keeps the status, the content type and the raw body (a JSON punish envelope)", async () => {
    stubFetch(() => new Response(PUNISH_JSON, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const facility = createQwenChatPageRequestFacility(fakePage());

    const result = await facility.postJson("/api/v2/chats/new", {});

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/json");
    expect(result.bodyText).toBe(PUNISH_JSON);
    // And the refusal built from it is the classified one, not "HTTP 200, no content type".
    expect(() => readQwenChatCreatedChatId(result)).toThrow(/access-verification challenge/);
    expect(() => readQwenChatCreatedChatId(result)).toThrow(/FAIL_SYS_USER_VALIDATE/);
  });

  test("postJson keeps an HTML block page as text, so a create refusal names it", async () => {
    stubFetch(() => new Response(ALIYUN_WAF_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const facility = createQwenChatPageRequestFacility(fakePage());

    const result = await facility.postJson("/api/v2/chats/new", {});

    expect(typeof result.body).toBe("string");
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(() => readQwenChatCreatedChatId(result)).toThrow(/non-JSON document/);
  });

  test("postEventStream keeps a non-stream JSON answer as its own body text", async () => {
    stubFetch(() => new Response(AUTH_JSON, { status: 200, headers: { "content-type": "application/json" } }));
    const facility = createQwenChatPageRequestFacility(fakePage());

    const result = await facility.postEventStream("/api/v2/chat/completions?chat_id=chat-1", {}, () => false);

    expect(result.contentType).toBe("application/json");
    expect(result.bodyText).toBe(AUTH_JSON);
    expect(result.status).toBe(200);
  });

  test("a successful stream is unaffected: chunks arrive and no refusal is produced", async () => {
    const body = 'data: {"choices":[{"delta":{"role":"assistant","content":"hola",'
      + '"phase":"answer","status":"typing"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer",'
      + '"status":"finished"}}]}\n\n'
      + "data: [DONE]\n\n";
    stubFetch(() => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    const facility = createQwenChatPageRequestFacility(fakePage());
    const chunks: string[] = [];

    const result = await facility.postEventStream(
      "/api/v2/chat/completions?chat_id=chat-1",
      {},
      chunk => { chunks.push(chunk); return false; },
    );

    expect(result.bodyText).toBeUndefined();
    expect(result.contentType).toContain("text/event-stream");
    expect(chunks.join("")).toContain('"content":"hola"');
    expect(chunks.join("")).toContain("[DONE]");
  });
});

/** A session that runs the turn on one injected facility. */
function sessionOver(facility: QwenChatTurnRequestFacility): QwenChatRequestSession {
  return {
    id: "issue-333-qwen-chat-refusal-session",
    async ready() {},
    async run<T>(body: (facility: QwenChatTurnRequestFacility) => Promise<T>): Promise<T> {
      return await body(facility);
    },
    async close() {},
  };
}

/** A facility that creates a chat, then answers the completion with one fixed non-stream refusal. */
function refusingFacility(refusal: { status: number; contentType: string; bodyText: string }): QwenChatTurnRequestFacility {
  return {
    async postJson() {
      return { status: 200, body: { success: true, request_id: "req", data: { id: "chat-1" } }, contentType: "application/json", bodyText: "{}" };
    },
    async postEventStream(_path, _body, _onChunk, options = {}) {
      options.onOpen?.({ status: refusal.status, contentType: refusal.contentType });
      return { status: refusal.status, contentType: refusal.contentType, bodyText: refusal.bodyText };
    },
  };
}

const CONTEXT: WebChatTextTransportContext = {
  identity: { bindingId: "binding", conversationKey: "conversation", turnId: "turn" },
  turn: { userText: "hola", model: MODEL_ID },
  epoch: 1,
  signal: new AbortController().signal,
};

describe("issue #333 — the transport reports the refusal, and streams normally otherwise", () => {
  test("a JSON punish answer fails the turn with the classified message, not a bare 200", async () => {
    const transport = createQwenChatTextTransport({
      session: sessionOver(refusingFacility({ status: 200, contentType: "application/json", bodyText: PUNISH_JSON })),
      model: MODEL_ID,
      mode: "Auto",
    });

    await transport.ready(CONTEXT);
    // The provider's *head* is a 200 JSON answer, which is the submission the surface confirms; the
    // refusal itself is what the stream then reports. That is exactly the operator's observation — a
    // turn that was accepted and then failed with `HTTP 200, application/json` and no explanation.
    expect(await transport.submit(CONTEXT)).toBe("accepted");

    const events: WebChatExchangeEvent[] = [];
    for await (const event of transport.stream(CONTEXT) as AsyncIterable<WebChatExchangeEvent>) {
      events.push(event);
    }
    const failure = events.at(-1);
    expect(failure?.type).toBe("error");
    if (failure?.type !== "error") throw new Error("the refused turn did not report an error event");
    expect(failure.error.providerCode).toBe("QWEN_CHAT_ACCESS_VERIFICATION");
    expect(failure.error.message).toContain("access-verification challenge");
    expect(failure.error.message).toContain("HTTP 200");
    expect(failure.error.message).toContain("content-type: application/json");
    expect(failure.error.message).toContain("FAIL_SYS_USER_VALIDATE");
    expect(failure.error.message).toContain("/v1/control/auth/");
  });

  test("a successful stream still completes with its text", async () => {
    const facility: QwenChatTurnRequestFacility = {
      async postJson() {
        return { status: 200, body: { success: true, request_id: "req", data: { id: "chat-1" } } };
      },
      async postEventStream(_path, _body, onChunk, options = {}) {
        options.onOpen?.({ status: 200, contentType: "text/event-stream" });
        onChunk('data: {"response.created":{"chat_id":"chat-1","parent_id":"parent-1",'
          + '"response_id":"response-1","response_index":1}}\n\n');
        onChunk('data: {"choices":[{"delta":{"role":"assistant","content":"hola",'
          + '"phase":"answer","status":"typing"}}],"response_id":"response-1"}\n\n');
        onChunk('data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer",'
          + '"status":"finished"}}],"response_id":"response-1"}\n\n');
        return { status: 200, contentType: "text/event-stream" };
      },
    };
    const transport = createQwenChatTextTransport({ session: sessionOver(facility), model: MODEL_ID, mode: "Auto" });

    await transport.ready(CONTEXT);
    expect(await transport.submit(CONTEXT)).toBe("accepted");
    const events: string[] = [];
    for await (const event of transport.stream(CONTEXT) as AsyncIterable<WebChatExchangeEvent>) {
      events.push(event.type);
    }
    expect(events).toEqual(["text_delta", "completed"]);
  });
});
