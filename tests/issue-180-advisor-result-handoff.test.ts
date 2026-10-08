import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #180 — Advisor result card + "Send to DSH" handoff (client half).
 *
 * Same plain-JS module harness as the #179 tests: capture the
 * `window.__ModuleLoader__.load` descriptor, run the factory against a
 * minimal `react` stub, and exercise the pure units on `mod.__test`.
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

/** TurnTailOwnerProps.turn is a TurnLocation: `.turn` is the DSH turn number directly. */
function tailTurn(turn: number) {
  return { turn, start: undefined, end: undefined, status: "closed" as const };
}

/**
 * Chat fixtures follow the current public `ui-chat` contract (issue #186): an
 * assistant row is an `assistant-step` Node whose `data.turn` IS the DSH turn
 * number the turnTail card is keyed by, and `data.status` / `data.blocks`
 * describe the step.
 */
function userNode(seq: number, ...texts: string[]) {
  return {
    key: `key-${seq}`,
    kind: "user",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "turn", turn: { turn: seq } },
    data: { kind: "user", seq, time: seq, content: texts.map((text) => ({ type: "text", text })) },
  };
}

function assistantStep(seq: number, turn: number | undefined, ...blocks: Array<Record<string, unknown>>) {
  return {
    key: `key-${seq}`,
    kind: "assistant-step",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "step", turn: { turn: turn ?? seq }, step: { turn: turn ?? seq, step: 1 } },
    data: {
      status: "settled",
      ...(turn === undefined ? {} : { turn }),
      step: 1,
      blocks,
      time: seq,
      finalNode: { kind: "assistant", seq, turn: turn ?? seq, step: 1, blocks },
    },
  };
}

function chatSnapshot(nodes: Array<Record<string, unknown>>) {
  const order = nodes.map((node) => node.key as string);
  const store: Record<string, unknown> = {};
  for (const node of nodes) store[node.key as string] = node;
  return { order, nodes: { get: (key: string) => store[key] } };
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
  // Cache-busted path: the #179 suite also imports client.js in the same
  // process, and a cached module would not re-run the factory registration.
  // @ts-expect-error plain-JS browser module without type declarations
  await import("../client.js?advisor-180");
  expect(captured.descriptor).not.toBeNull();

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

describe("issue #180 — case 1: result associated to the correct turn", () => {
  test("selectReviewableTurn resolves the DSH turn number from the assistant-step data", () => {
    const reviewable = mod.__test.selectReviewableTurn(
      chatSnapshot([
        userNode(1, "hola"),
        assistantStep(2, 7, { kind: "text", text: "respuesta" }),
      ]),
    );
    expect(reviewable.dshTurn).toBe(7);
    expect(reviewable.turn).toBe(2); // node anchor preserved (#179 contract)
  });

  test("dshTurn is undefined when the assistant-step carries no usable turn number", () => {
    const reviewable = mod.__test.selectReviewableTurn(
      chatSnapshot([userNode(1, "hola"), assistantStep(2, undefined, { kind: "text", text: "respuesta" })]),
    );
    expect(reviewable).not.toBeNull();
    expect(reviewable.dshTurn).toBeUndefined();
  });

  test("record + select round-trips per turn and keeps the latest result per turn", () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r1", mode: "normal", model: "gpt", text: "primera" });
    mod.__test.recordAdvisorResult(storage, { turn: 9, reviewId: "r2", mode: "think", model: "gpt", text: "otra" });
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r3", mode: "think", model: "gpt", text: "nueva" });

    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(2);
    expect(mod.__test.selectResultForTurn(results, 7)?.text).toBe("nueva");
    expect(mod.__test.selectResultForTurn(results, 7)?.mode).toBe("think");
    expect(mod.__test.selectResultForTurn(results, 9)?.reviewId).toBe("r2");
    expect(mod.__test.selectResultForTurn(results, 8)).toBeNull();
    expect(mod.__test.selectResultForTurn(results, "7" as unknown as number)).toBeNull();
  });
});

describe("issue #180 — case 2: result does not auto-enter model history", () => {
  test("the result is written only to the browser-storage results key, never to a Session log", () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r1", mode: "normal", model: "gpt", text: "review" });
    expect(storage.getItem(mod.__test.RESULTS_KEY)).not.toBeNull();
    // Nothing else is written: no session/event/sessionLog key appears.
    expect(storage.getItem("sessionLog")).toBeNull();
    expect(storage.getItem("dsh-chatgpt-web.session")).toBeNull();
    // And the persisted value is plain result metadata, not an event envelope.
    const parsed = JSON.parse(storage.getItem(mod.__test.RESULTS_KEY)!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBeUndefined();
    expect(parsed[0].seq).toBeUndefined();
  });

  test("parseAdvisorResults tolerates corrupted, foreign, or partial data", () => {
    expect(mod.__test.parseAdvisorResults(null)).toEqual([]);
    expect(mod.__test.parseAdvisorResults("{no json")).toEqual([]);
    expect(mod.__test.parseAdvisorResults('{"a":1}')).toEqual([]);
    expect(
      mod.__test.parseAdvisorResults(
        JSON.stringify([
          { turn: "7", text: "x" },
          { turn: 7 },
          { turn: 7, text: "   " },
          { turn: 3, text: "ok", mode: "weird", model: 5, at: "no" },
          null,
        ]),
      ),
    ).toEqual([
      { turn: 3, reviewId: "", mode: "normal", model: "", text: "ok", at: 0 },
    ]);
  });
});

describe("issue #180 — cases 3+5: Send to DSH produces exactly one new NORMAL prompt via the official flow", () => {
  test("send() drives inputActions.setDraft + inputActions.submit in order — the normal prompt flow", () => {
    const calls: string[] = [];
    const inputActions = {
      setDraft: (text: string) => {
        calls.push(`setDraft:${text.length > 0 ? "text" : "empty"}`);
      },
      submit: () => {
        calls.push("submit");
      },
    };
    const store = mod.__test.createSendStore();
    const outcome = store.send({ turn: 7, prompt: "ChatGPT Advisor review:\n\nr", inputActions });
    expect(outcome).toBe("sent-requested");
    expect(calls).toEqual(["setDraft:text", "submit"]);
    expect(store.getSnapshot().sending.has(7)).toBe(true);
  });

  test("markSent resolves the sending state once the flow consumed the draft", () => {
    const store = mod.__test.createSendStore();
    store.send({
      turn: 7,
      prompt: "p",
      inputActions: { setDraft: () => {}, submit: () => {} },
    });
    store.markSent(7);
    const snapshot = store.getSnapshot();
    expect(snapshot.sending.has(7)).toBe(false);
    expect(snapshot.sent.has(7)).toBe(true);
    expect(snapshot.errors.get(7)).toBeUndefined();
  });
});

describe("issue #180 — case 4: prompt contains the review + minimal Advisor context", () => {
  test("buildHandoffPrompt carries the FULL review, the Advisor marker, and the evaluation instruction", () => {
    const review = "## Findings\n1. Correctness bug in X\n2. Missing test for Y";
    const prompt = mod.__test.buildHandoffPrompt({ text: review, reviewId: "r-123", mode: "think" });
    expect(prompt.startsWith("ChatGPT Advisor review:\n\n")).toBe(true);
    expect(prompt).toContain(review);
    expect(prompt).toContain("Evaluate this review against the current task and apply the relevant recommendations.");
    expect(prompt).toContain("Do not blindly follow recommendations that are incorrect or inconsistent with the current task.");
    // Minimum handoff content excludes internal IDs, history, and UI markup.
    expect(prompt).not.toContain("r-123");
    expect(prompt).not.toContain("reviewId");
    expect(prompt).not.toContain("<html");
  });

  test("buildHandoffPrompt returns an empty string without a usable review", () => {
    expect(mod.__test.buildHandoffPrompt(null)).toBe("");
    expect(mod.__test.buildHandoffPrompt({ text: "   " })).toBe("");
  });
});

describe("issue #180 — case 6: double activation produces no duplicate prompt", () => {
  test("a second send while one is in flight is refused and calls the actions exactly once", () => {
    let draftCalls = 0;
    let submitCalls = 0;
    const inputActions = {
      setDraft: () => {
        draftCalls += 1;
      },
      submit: () => {
        submitCalls += 1;
      },
    };
    const store = mod.__test.createSendStore();
    const first = store.send({ turn: 7, prompt: "p", inputActions });
    const second = store.send({ turn: 7, prompt: "p", inputActions });
    const third = store.send({ turn: 9, prompt: "p", inputActions });
    expect(first).toBe("sent-requested");
    expect(second).toBe("busy");
    expect(third).toBe("busy");
    expect(draftCalls).toBe(1);
    expect(submitCalls).toBe(1);
  });

  test("after markSent the guard is released and the next send works again", () => {
    let submitCalls = 0;
    const inputActions = {
      setDraft: () => {},
      submit: () => {
        submitCalls += 1;
      },
    };
    const store = mod.__test.createSendStore();
    store.send({ turn: 7, prompt: "p", inputActions });
    store.markSent(7);
    const again = store.send({ turn: 7, prompt: "p2", inputActions });
    expect(again).toBe("sent-requested");
    expect(submitCalls).toBe(2);
  });
});

describe("issue #180 — case 7: send error is surfaced and retry is possible", () => {
  test("submit() throwing → error state with the message, then a retry succeeds", () => {
    let fail = true;
    const inputActions = {
      setDraft: () => {},
      submit: () => {
        if (fail) throw new Error("composer locked");
      },
    };
    const store = mod.__test.createSendStore();
    const first = store.send({ turn: 7, prompt: "p", inputActions });
    expect(first).toBe("error");
    let snapshot = store.getSnapshot();
    expect(snapshot.errors.get(7)).toBe("composer locked");
    expect(snapshot.sending.has(7)).toBe(false);
    // The guard is released: retry with a working composer.
    fail = false;
    const retry = store.send({ turn: 7, prompt: "p", inputActions });
    expect(retry).toBe("sent-requested");
    snapshot = store.getSnapshot();
    expect(snapshot.errors.get(7)).toBeUndefined();
    expect(snapshot.sending.has(7)).toBe(true);
  });

  test("missing or partial input actions → 'unavailable' (no session), without entering sending", () => {
    const store = mod.__test.createSendStore();
    expect(store.send({ turn: 7, prompt: "p", inputActions: undefined })).toBe("unavailable");
    expect(store.send({ turn: 7, prompt: "p", inputActions: { setDraft: () => {} } })).toBe("unavailable");
    const snapshot = store.getSnapshot();
    expect(snapshot.sending.has(7)).toBe(false);
    expect(snapshot.errors.get(7)).toBeUndefined();
  });

  test("an empty prompt is refused without touching the composer", () => {
    let draftCalls = 0;
    const store = mod.__test.createSendStore();
    const outcome = store.send({
      turn: 7,
      prompt: "   ",
      inputActions: {
        setDraft: () => {
          draftCalls += 1;
        },
        submit: () => {},
      },
    });
    expect(outcome).toBe("empty");
    expect(draftCalls).toBe(0);
  });
});

describe("issue #180 — case 8: no auto-execution of recommendations", () => {
  test("the handoff asks the agent to evaluate and apply — nothing is executed by the plugin", () => {
    const prompt = mod.__test.buildHandoffPrompt({ text: "apply fix A and add test B" });
    // The prompt is an instruction to the agent, not a command list: the
    // evaluation instruction is always appended and the review is quoted.
    expect(prompt).toContain("apply fix A and add test B");
    expect(prompt).toContain("Evaluate this review against the current task");
    // The send path only touches the normal input actions (case 3+5): no
    // session/event/execution API exists in the handoff units.
    expect(mod.__test.buildHandoffPrompt).not.toHaveProperty("execute");
  });

  test("the card component renders the recorded result for its turn and null for other turns", () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r1", mode: "think", model: "gpt-x", text: "review body" });
    (globalThis as any).window.localStorage = storage;

    const propsFor = (turn: number) => ({
      turn: tailTurn(turn),
      useInput: (sel: (s: any) => unknown) => sel({ phase: "plain", draft: "" }),
      inputActions: { setDraft: () => {}, submit: () => {} },
    });
    const t = (key: string, fallback: string) => fallback;

    const matching = mod.__test.AdvisorResultCard(t, propsFor(7));
    expect(matching).not.toBeNull();
    // The card tree contains the result text, the title, and the Send button.
    const serialized = JSON.stringify(matching);
    expect(serialized).toContain("review body");
    expect(serialized).toContain("ChatGPT Advisor");
    expect(serialized).toContain("Send to DSH");
    expect(serialized).toContain("gpt-x");

    expect(mod.__test.AdvisorResultCard(t, propsFor(8))).toBeNull();
    expect(mod.__test.AdvisorResultCard(t, { turn: undefined, useInput: (sel: (s: any) => unknown) => sel({ phase: "plain", draft: "" }) })).toBeNull();
  });
});
