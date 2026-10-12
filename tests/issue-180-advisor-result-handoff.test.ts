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
    const SESSION = "sess-180";
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r1", route: "chatgpt-web/light", providerLabel: "ChatGPT Web", modelLabel: "Light", text: "primera", sessionId: SESSION });
    mod.__test.recordAdvisorResult(storage, { turn: 9, reviewId: "r2", route: "chatgpt-web/high", providerLabel: "ChatGPT Web", modelLabel: "High", text: "otra", sessionId: SESSION });
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "r3", route: "qwen-web/fast", providerLabel: "Qwen Chat", modelLabel: "Fast", text: "nueva", sessionId: SESSION });

    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(2);
    expect(mod.__test.selectResultForTurn(results, 7, SESSION)?.text).toBe("nueva");
    // Issue #224: the recorded provenance is the provider-qualified model identity.
    expect(mod.__test.selectResultForTurn(results, 7, SESSION)?.route).toBe("qwen-web/fast");
    expect(mod.__test.selectResultForTurn(results, 7, SESSION)?.providerLabel).toBe("Qwen Chat");
    expect(mod.__test.selectResultForTurn(results, 9, SESSION)?.reviewId).toBe("r2");
    expect(mod.__test.selectResultForTurn(results, 8, SESSION)).toBeNull();
    expect(mod.__test.selectResultForTurn(results, "7" as unknown as number, SESSION)).toBeNull();
    // The card is per session: the same turn number of another session is never selected here.
    mod.__test.recordAdvisorResult(storage, { turn: 7, reviewId: "foreign", route: "chatgpt-web/light", providerLabel: "ChatGPT Web", modelLabel: "Light", text: "otra sesión", sessionId: "sess-otra" });
    expect(mod.__test.selectResultForTurn(mod.__test.loadAdvisorResults(storage), 7, SESSION)?.text).toBe("nueva");
    expect(mod.__test.selectResultForTurn(mod.__test.loadAdvisorResults(storage), 7, "sess-otra")?.text).toBe("otra sesión");
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
          { turn: 3, text: "ok", route: 5, providerLabel: 5, at: "no" },
          null,
        ]),
      ),
    ).toEqual([
      { turn: 3, reviewId: "", route: "", providerLabel: "", modelLabel: "", sessionId: "", recovered: false, text: "ok", at: 0 },
    ]);
  });
});

describe("issue #180 — case 4: the injected message contains the review + minimal Advisor context", () => {
  test("buildInjectedPrompt carries the FULL review, the Advisor marker, and the evaluation instruction", () => {
    const review = "## Findings\n1. Correctness bug in X\n2. Missing test for Y";
    const prompt = mod.__test.buildInjectedPrompt(review);
    expect(prompt.startsWith("WebChat Advisor review:\n\n")).toBe(true);
    expect(prompt).toContain(review);
    expect(prompt).toContain("Evaluate this feedback against the current task and available context.");
    expect(prompt).toContain("Verify the findings independently and apply only the relevant, correct recommendations.");
    expect(prompt).toContain("If a finding is incorrect or inconsistent with the task, explain why rather than following it blindly.");
    // Minimum handoff content excludes internal IDs, history, and UI markup.
    expect(prompt).not.toContain("reviewId");
    expect(prompt).not.toContain("<html");
  });

  test("buildInjectedPrompt returns an empty string without a usable review", () => {
    expect(mod.__test.buildInjectedPrompt(null)).toBe("");
    expect(mod.__test.buildInjectedPrompt("   ")).toBe("");
  });

  test("the injected message never carries the reviewed request/answer or internal identifiers", () => {
    const prompt = mod.__test.buildInjectedPrompt("only the edited review");
    for (const leaked of ["chatgpt-web/light", "session-1", "dsh-turn:4", "review-1", "Human request:", "DSH response:"]) {
      expect(prompt).not.toContain(leaked);
    }
  });
});

describe("issue #180 — case 8: no auto-execution of recommendations", () => {
  test("the injected message asks the agent to evaluate and apply — nothing is executed by the plugin", () => {
    const prompt = mod.__test.buildInjectedPrompt("apply fix A and add test B");
    // The message is an instruction to the agent, not a command list: the evaluation instruction is
    // always appended and the edited review is quoted.
    expect(prompt).toContain("apply fix A and add test B");
    expect(prompt).toContain("Evaluate this feedback against the current task");
  });

  test("the card renders the recorded result for its turn and null for other turns", () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, {
      turn: 7,
      reviewId: "r1",
      route: "chatgpt-web/high",
      providerLabel: "ChatGPT Web",
      modelLabel: "High",
      sessionId: "session-1",
      text: "review body",
    });
    (globalThis as any).window.localStorage = storage;

    const propsFor = (turn: number) => ({ turn: tailTurn(turn), sessionId: "session-1" });
    const t = (key: string, fallback: string) => fallback;

    const matching = mod.__test.AdvisorResultCard(t, propsFor(7));
    expect(matching).not.toBeNull();
    const serialized = JSON.stringify(matching);
    expect(serialized).toContain("review body");
    expect(serialized).toContain("Advisor");
    // Issue #224: the card shows the recorded provider-qualified model, not a hardcoded mode.
    expect(serialized).toContain("ChatGPT Web — High");
    // Issue #225: the card is an entry point to the result editor, never a submit action.
    expect(serialized).toContain("Open result");
    expect(serialized).not.toContain("Send to DSH");

    expect(mod.__test.AdvisorResultCard(t, propsFor(8))).toBeNull();
    expect(mod.__test.AdvisorResultCard(t, { turn: undefined })).toBeNull();
  });
});
