import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #186 — "Review with ChatGPT" must render with the CURRENT DSH
 * `ui-chat` Node contract.
 *
 * The Advisor control was reading the previous Chat snapshot shape
 * (`kind: "assistant"` plus top-level `blocks`/`content`). The published
 * contract nests the row payload on `data` and publishes assistant rows as
 * `assistant-step`:
 *
 *   user            Node: { kind: "user",            data: { content } }
 *   assistant-step  Node: { kind: "assistant-step",  data: { status, turn, step, blocks, finalNode? } }
 *
 * so `selectReviewableTurn()` returned null and the button never rendered.
 * These cases pin the selection to that contract with a snapshot fixture built
 * exactly like the target publishes it, and exercise the real composer
 * control (`AdvisorReviewButton`) so a regression is visible as "no button"
 * rather than only as a null selection.
 *
 * Same plain-JS module harness as the #179/#180 suites: capture the
 * `window.__ModuleLoader__.load` descriptor, run the factory against a minimal
 * `react` stub, and exercise the units exported on `mod.__test`.
 */
let mod: any;

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

/** A `ConversationLocation` for a Step: the nested TurnLocation carries the turn number. */
function stepLocation(turn: number, step = 1) {
  return {
    kind: "step" as const,
    turn: { turn, start: undefined, end: undefined, status: "closed" as const, steps: [] },
    step: { turn, step, start: undefined, end: undefined, status: "closed" as const },
  };
}

function chatSnapshot(nodes: Array<Record<string, any>>) {
  const order = nodes.map((node) => node.key as string);
  const store: Record<string, any> = {};
  for (const node of nodes) store[node.key as string] = node;
  return { order, nodes: { get: (key: string) => store[key] } };
}

/** `user` Node: the human message content lives on `data.content`. */
function userNode(seq: number, turn: number, ...content: Array<Record<string, unknown>>) {
  return {
    key: `key-${seq}`,
    kind: "user",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "turn", turn: { turn } },
    data: { kind: "user", seq, time: seq, content, source: {} },
  };
}

function textUserNode(seq: number, turn: number, ...texts: string[]) {
  return userNode(seq, turn, ...texts.map((text) => ({ type: "text", text })));
}

/**
 * `assistant-step` Node paying the contract: `status` is the lifecycle
 * ('running' | 'settled' | 'interrupted'), `turn` the DSH turn number,
 * `blocks` the content, and `finalNode` the durable finalized message (absent
 * only while the step is still streaming).
 */
function assistantStep(seq: number, turn: number, status: string, ...blocks: Array<Record<string, unknown>>) {
  return {
    key: `key-${seq}`,
    kind: "assistant-step",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: stepLocation(turn),
    data: {
      status,
      turn,
      step: 1,
      blocks,
      time: seq,
      ...(status === "running" ? {} : { finalNode: { kind: "assistant", seq, turn, step: 1, blocks } }),
    },
  };
}

/** A settled step: the only reviewable lifecycle status. */
function settledStep(seq: number, turn: number, ...blocks: Array<Record<string, unknown>>) {
  return assistantStep(seq, turn, "settled", ...blocks);
}

/** The composer control under test: the exact slot entry the plugin registers. */
function renderButton(chat: unknown, { running = false } = {}) {
  const t = (_key: string, fallback: string) => fallback;
  return mod.__test.AdvisorReviewButton(t, {
    sessionId: "sess-1",
    useChat: (selector: (snapshot: unknown) => unknown) => selector(chat),
    useSession: (selector: (session: unknown) => unknown) => selector({ running }),
  });
}

beforeAll(async () => {
  const captured: { descriptor: any } = { descriptor: null };
  (globalThis as any).window = {
    __ModuleLoader__: {
      load(d: any) {
        captured.descriptor = d;
      },
    },
    localStorage: makeStorage(),
  };
  // Cache-busted path: the other Advisor suites import client.js in the same
  // process, and a cached module would not re-run the factory registration.
  // @ts-expect-error plain-JS browser module without type declarations
  await import("../client.js?advisor-186");
  expect(captured.descriptor).not.toBeNull();
  expect(captured.descriptor.id).toBe("@lordraiden/dsh-chatgpt-web");

  const requireShim = (id: string) => {
    if (id === "react") {
      return {
        createElement: (...args: unknown[]) => args,
        useState: (init: unknown) => [init, () => {}],
        useEffect: () => {},
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: () => unknown) => fn,
      };
    }
    throw new Error(`unexpected require: ${id}`);
  };
  mod = captured.descriptor.factory(requireShim);
});

describe("issue #186 — case 1: an existing session with a completed turn renders the button", () => {
  test("user -> settled assistant-step is reviewable and the composer control renders", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "arregla el bug"),
      settledStep(2, 1, { kind: "text", text: "Hecho: he corregido X." }),
    ]);

    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable).not.toBeNull();
    expect(reviewable.humanRequest).toBe("arregla el bug");
    expect(reviewable.dshResponse).toBe("Hecho: he corregido X.");

    const button = renderButton(chat);
    expect(button).not.toBeNull();
    expect(button[0]).toBe("button");
    expect(button[1].className).toBe("cwg-advisor-btn");
    expect(button[1].disabled).toBe(false);
    expect(button[2]).toBe("Review with ChatGPT");
  });

  test("the pre-#186 node shape ('assistant' + top-level blocks) is no longer selected", () => {
    const legacy = chatSnapshot([
      { key: "key-1", kind: "user", seq: 1, anchorSeq: 1, content: [{ type: "text", text: "hola" }] },
      { key: "key-2", kind: "assistant", seq: 2, anchorSeq: 2, blocks: [{ kind: "text", text: "respuesta" }] },
    ]);
    expect(mod.__test.selectReviewableTurn(legacy)).toBeNull();
    expect(renderButton(legacy)).toBeNull();
  });
});

describe("issue #186 — case 2: a new session before the first response renders nothing", () => {
  test("no turn at all", () => {
    expect(renderButton(chatSnapshot([]))).toBeNull();
  });

  test("human request sent, assistant step still streaming ('running')", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "hola"),
      assistantStep(2, 1, "running", { kind: "text", text: "escribiendo" }),
    ]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });

  test("human request only, no assistant step yet", () => {
    const chat = chatSnapshot([textUserNode(1, 1, "hola")]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });
});

describe("issue #186 — case 3: after the first completed turn the button appears without a new session", () => {
  test("the same session object grows a turn and the button follows the snapshot", () => {
    const before = chatSnapshot([textUserNode(1, 1, "hola")]);
    expect(renderButton(before)).toBeNull();

    const after = chatSnapshot([
      textUserNode(1, 1, "hola"),
      settledStep(2, 1, { kind: "text", text: "respuesta" }),
    ]);
    expect(renderButton(after)).not.toBeNull();
  });

  test("while DSH generates the control stays disabled (with a reviewable turn present)", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "hola"),
      settledStep(2, 1, { kind: "text", text: "respuesta" }),
    ]);
    const button = renderButton(chat, { running: true });
    expect(button).not.toBeNull();
    expect(button[1].disabled).toBe(true);
  });
});

describe("issue #186 — cases 4+5: interrupted and empty responses are not reviewable", () => {
  test("interrupted assistant-step (status 'interrupted') never renders the button", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "hola"),
      assistantStep(2, 1, "interrupted", { kind: "text", text: "a mitad de cam" }),
    ]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });

  test("settled but empty / non-text-only content never renders the button", () => {
    const empties = [
      // No blocks at all.
      settledStep(2, 1),
      // Whitespace-only text.
      settledStep(2, 1, { kind: "text", text: "   " }),
      // Reasoning only: nothing the human can review.
      settledStep(2, 1, { kind: "reasoning", text: "pensando" }),
      // Tool call only.
      settledStep(2, 1, { kind: "tool-call", callId: "c1", name: "read", argsRaw: "{}" }),
    ];
    for (const step of empties) {
      const chat = chatSnapshot([textUserNode(1, 1, "hola"), step]);
      expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
      expect(renderButton(chat)).toBeNull();
    }
  });

  test("a human request with no text block is not a reviewable request", () => {
    const chat = chatSnapshot([
      // Image-only human message: no human text to review.
      userNode(1, 1, { type: "image", attachment: { id: "a1" } }),
      settledStep(2, 1, { kind: "text", text: "respuesta" }),
    ]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });
});

describe("issue #186 — case 6: multiple turns select the latest completed reviewable turn", () => {
  test("the second completed turn wins, not the first", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "primera petición"),
      settledStep(2, 1, { kind: "text", text: "primera respuesta" }),
      textUserNode(3, 2, "segunda petición"),
      settledStep(4, 2, { kind: "text", text: "segunda respuesta" }),
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable.humanRequest).toBe("segunda petición");
    expect(reviewable.dshResponse).toBe("segunda respuesta");
    expect(reviewable.turn).toBe(4);
    expect(renderButton(chat)).not.toBeNull();
  });

  test("an interrupted latest turn is never reviewed in place of the previous completed turn", () => {
    // The preserved #179 pairing: the latest human request must have a settled
    // response after it. An interrupted attempt is non-reviewable, so the
    // selection is empty rather than silently reviewing the older turn.
    const chat = chatSnapshot([
      textUserNode(1, 1, "primera petición"),
      settledStep(2, 1, { kind: "text", text: "primera respuesta" }),
      textUserNode(3, 2, "segunda petición"),
      assistantStep(4, 2, "interrupted", { kind: "text", text: "cortada" }),
    ]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });

  test("a pending human request after the last answer is not paired with the older answer", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "primera petición"),
      settledStep(2, 1, { kind: "text", text: "primera respuesta" }),
      textUserNode(3, 2, "segunda petición"),
    ]);
    expect(mod.__test.selectReviewableTurn(chat)).toBeNull();
    expect(renderButton(chat)).toBeNull();
  });

  test("only the latest settled step of one turn is reviewed", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "petición"),
      settledStep(2, 1, { kind: "text", text: "borrador" }),
      settledStep(3, 1, { kind: "text", text: "respuesta final" }),
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable.humanRequest).toBe("petición");
    expect(reviewable.dshResponse).toBe("respuesta final");
    expect(reviewable.turn).toBe(3);
  });
});

describe("issue #186 — case 7: the DSH turn number survives for the result card", () => {
  test("dshTurn is AssistantChatData.turn of the reviewed step, never the anchor seq", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "primera petición"),
      settledStep(2, 1, { kind: "text", text: "primera respuesta" }),
      textUserNode(11, 2, "segunda petición"),
      settledStep(12, 2, { kind: "text", text: "segunda respuesta" }),
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable.dshTurn).toBe(2);
    expect(reviewable.turn).toBe(12);
  });

  test("the resolved turn round-trips through recordAdvisorResult for the turnTail card", () => {
    const storage = makeStorage();
    const chat = chatSnapshot([
      textUserNode(1, 1, "primera petición"),
      settledStep(2, 1, { kind: "text", text: "primera respuesta" }),
      textUserNode(11, 2, "segunda petición"),
      settledStep(12, 2, { kind: "text", text: "segunda respuesta" }),
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);

    // This is exactly what runReview() records after a successful review.
    mod.__test.recordAdvisorResult(storage, {
      turn: reviewable.dshTurn,
      reviewId: "r1",
      mode: "normal",
      model: "gpt",
      text: "review body",
    });

    const results = mod.__test.loadAdvisorResults(storage);
    expect(mod.__test.selectResultForTurn(results, 2)?.text).toBe("review body");
    // No result lands on the anchor seq of the reviewed node.
    expect(mod.__test.selectResultForTurn(results, 12)).toBeNull();
  });

  test("a reviewable turn without a resolvable turn number is still selectable but not recordable", () => {
    const chat = chatSnapshot([
      textUserNode(1, 1, "petición"),
      {
        key: "key-2",
        kind: "assistant-step",
        target: "chat",
        anchorSeq: 2,
        visibility: "visible",
        location: stepLocation(1),
        data: { status: "settled", step: 1, blocks: [{ kind: "text", text: "respuesta" }], time: 2 },
      },
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable).not.toBeNull();
    expect(reviewable.dshTurn).toBeUndefined();
    // runReview() records nothing without a turn number: the card stays empty.
    expect(mod.__test.selectResultForTurn(mod.__test.loadAdvisorResults(makeStorage()), reviewable.dshTurn)).toBeNull();
  });
});
