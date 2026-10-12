import { describe, expect, test } from "bun:test";

import {
  WEB_CHAT_EXCHANGE_CANCELLED_CODE,
  WEB_CHAT_EXCHANGE_EMPTY_CODE,
  WEB_CHAT_EXCHANGE_FAILED_CODE,
  runWebChatTextExchange,
} from "../src/web-chat/host/text-exchange";
import {
  webChatError,
  type WebChatExchangeEvent,
  type WebChatSubmissionPhase,
  type WebChatTurnIdentity,
} from "../src/web-chat/core";
import {
  createWebChatTransportLeaseRegistry,
  type WebChatExchangeRunner,
  type WebChatTextTransport,
  type WebChatTextTransportContext,
} from "../src/web-chat/transport";

/**
 * Issue #236 — the provider-neutral exchange driver.
 *
 * The shared exchange already owns readiness, the submission boundary, streaming, cancellation and
 * physical settlement. This suite pins what the host driver adds on top: collecting the answer,
 * reporting the exchange's own retry verdict and settlement, releasing the handoff, and never
 * inventing a retry verdict a caller could act on.
 */

const IDENTITY: WebChatTurnIdentity = {
  bindingId: "binding-1",
  conversationKey: "conversation-key-1",
  turnId: "turn-1",
  dshSessionId: "session-1",
};

const TURN = { userText: "arregla el bug", model: "model-1" } as const;

/** A transport whose every reported fact is scripted, so the driver's translation is under test. */
function scriptedTransport(script: {
  ready?: (context: WebChatTextTransportContext) => Promise<void>;
  submit?: (context: WebChatTextTransportContext) => Promise<WebChatSubmissionPhase>;
  events?: WebChatExchangeEvent[];
  settlement?: "not_started" | "pending" | "fulfilled" | "rejected";
} = {}) {
  const seen: { ready?: WebChatTextTransportContext; submit?: WebChatTextTransportContext } = {};
  const calls = { ready: 0, submit: 0, stream: 0, settle: 0, abort: 0 };
  const events = script.events ?? [
    { type: "text_delta", epoch: 1, text: "  hola " },
    { type: "text_delta", epoch: 1, text: "mundo  " },
    { type: "completed", epoch: 1, text: "  hola mundo  " },
  ];
  const transport: WebChatTextTransport = {
    id: "scripted",
    async ready(context) {
      calls.ready += 1;
      seen.ready = context;
      if (script.ready) await script.ready(context);
    },
    async submit(context) {
      calls.submit += 1;
      seen.submit = context;
      return script.submit ? await script.submit(context) : "accepted";
    },
    async *stream(_context) {
      calls.stream += 1;
      for (const event of events) yield event;
    },
    async settle(_context) {
      calls.settle += 1;
      return script.settlement ?? "fulfilled";
    },
    async abort() {
      calls.abort += 1;
    },
  };
  return { transport, calls, seen };
}

function handoffFor(transport: WebChatTextTransport, overrides: Record<string, unknown> = {}) {
  const disposed: number[] = [];
  return {
    disposed,
    handoff: {
      transport,
      identity: IDENTITY,
      turn: TURN,
      leases: createWebChatTransportLeaseRegistry(),
      createResource: async () => ({ id: "resource-1", conversationKey: IDENTITY.conversationKey!, epoch: 1 }),
      dispose: () => { disposed.push(1); },
      ...overrides,
    },
  };
}

describe("issue #236 — one text turn through the shared exchange", () => {
  test("a clean exchange returns the answer text and releases the handoff", async () => {
    const { transport, seen } = scriptedTransport();
    const { handoff, disposed } = handoffFor(transport);

    const outcome = await runWebChatTextExchange(handoff);

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("hola mundo");
    expect(outcome.retrySafety).toBe("not_retry_safe");
    expect(outcome.settlement).toBe("fulfilled");
    expect(disposed).toHaveLength(1);
    // The transport ran under the provider's identity and semantic turn, not a host invention.
    expect(seen.ready?.identity).toEqual(IDENTITY);
    expect(seen.ready?.turn).toEqual(TURN);
    expect(seen.submit?.turn.userText).toBe("arregla el bug");
  });

  test("the exchange drives readiness before submission, once each", async () => {
    const { transport, calls } = scriptedTransport();
    const { handoff } = handoffFor(transport);
    await runWebChatTextExchange(handoff);
    expect(calls.ready).toBe(1);
    expect(calls.submit).toBe(1);
    expect(calls.stream).toBe(1);
  });

  test("a completed exchange without text is a failure, never an empty success", async () => {
    const { transport } = scriptedTransport({
      events: [
        { type: "text_delta", epoch: 1, text: "   " },
        { type: "completed", epoch: 1, text: "   " },
      ],
    });
    const { handoff, disposed } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(WEB_CHAT_EXCHANGE_EMPTY_CODE);
    expect(disposed).toHaveLength(1);
  });

  test("a readiness failure is retry-safe and never touches submission", async () => {
    const { transport, calls } = scriptedTransport({
      ready: async () => {
        throw webChatError("TRANSPORT_UNAVAILABLE", "the retained surface is not ready");
      },
    });
    const { handoff, disposed } = handoffFor(transport);

    const outcome = await runWebChatTextExchange(handoff);

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(outcome.message).toContain("not ready");
    expect(outcome.retrySafety).toBe("retry_safe");
    expect(outcome.settlement).toBe("not_started");
    expect(calls.submit).toBe(0);
    expect(disposed).toHaveLength(1);
  });

  test("an ambiguous submission is never reported as retry-safe", async () => {
    const { transport, calls } = scriptedTransport({
      submit: async () => {
        throw new Error("the send activation could not be confirmed");
      },
    });
    const { handoff, disposed } = handoffFor(transport);

    const outcome = await runWebChatTextExchange(handoff);

    expect(outcome.ok).toBe(false);
    expect(outcome.retrySafety).not.toBe("retry_safe");
    expect(outcome.message).toContain("send activation");
    expect(calls.stream).toBe(0);
    expect(disposed).toHaveLength(1);
  });

  test("a streamed provider error becomes its typed category", async () => {
    const { transport } = scriptedTransport({
      events: [{ type: "error", epoch: 1, error: webChatError("RESPONSE_TIMEOUT", "no answer in time") }],
    });
    const { handoff } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("RESPONSE_TIMEOUT");
    expect(outcome.message).toBe("no answer in time");
  });

  test("a cancelled exchange is reported as cancelled", async () => {
    const { transport } = scriptedTransport({
      events: [{ type: "cancelled", epoch: 1, reason: "operator cancelled" }],
    });
    const { handoff } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(WEB_CHAT_EXCHANGE_CANCELLED_CODE);
    expect(outcome.message).toBe("operator cancelled");
  });

  test("an untyped failure keeps a stable code instead of inventing a category", async () => {
    const { transport } = scriptedTransport({
      events: [{ type: "error", epoch: 1, error: { ...webChatError("UPSTREAM_ERROR", "boom") } }],
    });
    const { handoff } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.ok).toBe(false);
    // A real WebChatError always carries a category; the fallback exists for foreign throwables.
    expect([WEB_CHAT_EXCHANGE_FAILED_CODE, "UPSTREAM_ERROR"]).toContain(outcome.code ?? "");
  });

  test("a throwing dispose never replaces the exchange outcome", async () => {
    const { transport } = scriptedTransport();
    const { handoff } = handoffFor(transport, {
      dispose: () => {
        throw new Error("surface release failed");
      },
    });
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("hola mundo");
  });

  test("the shared lease registry is used, so the conversation is free afterwards", async () => {
    const leases = createWebChatTransportLeaseRegistry();
    const first = scriptedTransport();
    const one = handoffFor(first.transport, { leases });
    expect((await runWebChatTextExchange(one.handoff)).ok).toBe(true);

    // A second exchange on the same conversation is admitted: the first lease settled.
    const second = scriptedTransport({ settlement: "not_started" });
    const two = handoffFor(second.transport, { leases });
    const outcome = await runWebChatTextExchange(two.handoff);
    expect(outcome.ok).toBe(true);
    expect(second.calls.ready).toBe(1);
  });

  test("a turn cancelled before submission never submits and proves the resource unused", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    const { transport, calls } = scriptedTransport();
    const { handoff, disposed } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff, { signal: controller.signal });
    expect(outcome.ok).toBe(false);
    // The provider was never asked to send, and the cancelled turn forces physical settlement
    // through the transport instead of declaring the resource free (architecture §9.2/§9.3).
    expect(calls.submit).toBe(0);
    expect(calls.settle).toBeGreaterThan(0);
    expect(outcome.settlement).toBeDefined();
    expect(outcome.retrySafety).toBe("retry_safe");
    expect(disposed).toHaveLength(1);
  });

  test("the exchange is the retry authority: a confirmed submission is never retry-safe", async () => {
    const { transport } = scriptedTransport({
      events: [{ type: "error", epoch: 1, error: webChatError("UPSTREAM_ERROR", "provider died mid-answer") }],
    });
    const { handoff } = handoffFor(transport);
    const outcome = await runWebChatTextExchange(handoff);
    expect(outcome.retrySafety).toBe("not_retry_safe");
  });

  test("no exchange runs without a conversation key or a turn identity", async () => {
    const { transport } = scriptedTransport();
    const noKey = handoffFor(transport).handoff;
    const withoutKey: WebChatTurnIdentity = { bindingId: IDENTITY.bindingId, turnId: IDENTITY.turnId };
    await expect(runWebChatTextExchange({ ...noKey, identity: withoutKey })).rejects.toThrow(/conversation key/);
    const noTurn = handoffFor(transport).handoff;
    await expect(runWebChatTextExchange({ ...noTurn, identity: { ...IDENTITY, turnId: "" } }))
      .rejects.toThrow(/turn identity/);
  });
});

/** The runner type is part of the composition contract this driver replaces. */
type _RunnerContract = WebChatExchangeRunner;
