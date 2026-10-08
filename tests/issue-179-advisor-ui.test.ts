import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #179 — composer "Review with ChatGPT" button + review dialog (client half).
 *
 * client.js is a plain-JS browser module (no build step): it ends with
 * `window.__ModuleLoader__.load({ id, factory })`. This harness captures that
 * descriptor, runs the factory against a minimal `react` stub, and exercises
 * the pure units exported on `mod.__test` (the real loader ignores it).
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

/**
 * Fixtures mirror the CURRENT public `ui-chat` Chat snapshot contract (issue
 * #186): a final Chat Node carries `kind`/`anchorSeq`/`location`/`data`, a
 * human message is a `user` Node whose `data.content` holds the message, and
 * an assistant row is an `assistant-step` Node whose `data.status` /
 * `data.blocks` / `data.finalNode` describe the step.
 *
 * These selection tests only exercise Node recognition, so the step/turn
 * coordinates are derived from the node seq; #180 and #186 cover the DSH turn
 * association explicitly.
 */
function chatSnapshot(nodes: Array<Record<string, any>>) {
  const order = nodes.map((node) => node.key as string);
  const store: Record<string, any> = {};
  for (const node of nodes) store[node.key as string] = node;
  return {
    order,
    nodes: { get: (key: string) => store[key] },
  };
}

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

/** `assistant-step` Node with an explicit lifecycle status. */
function assistantStep(seq: number, status: string, ...blocks: Array<Record<string, any>>) {
  return {
    key: `key-${seq}`,
    kind: "assistant-step",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "step", turn: { turn: seq }, step: { turn: seq, step: 1 } },
    data: {
      status,
      turn: seq,
      step: 1,
      blocks,
      time: seq,
      ...(status === "running" ? {} : { finalNode: { kind: "assistant", seq, turn: seq, step: 1, blocks } }),
    },
  };
}

/** A settled `assistant-step`: the only reviewable lifecycle status. */
function finalAssistant(seq: number, ...blocks: Array<Record<string, any>>) {
  return assistantStep(seq, "settled", ...blocks);
}

/** An interrupted `assistant-step` (aborted turn). */
function interruptAssistant(seq: number, ...blocks: Array<Record<string, any>>) {
  return assistantStep(seq, "interrupted", ...blocks);
}

/** A still-streaming `assistant-step`. */
function runningAssistant(seq: number, ...blocks: Array<Record<string, any>>) {
  return assistantStep(seq, "running", ...blocks);
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
  // @ts-expect-error plain-JS browser module without type declarations
  await import("../client.js");
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

describe("issue #179 — reviewable-turn selection (button visibility)", () => {
  test("returns null with no chat, no nodes, or only a human request", () => {
    expect(mod.__test.selectReviewableTurn(null)).toBeNull();
    expect(mod.__test.selectReviewableTurn(chatSnapshot([]))).toBeNull();
    expect(mod.__test.selectReviewableTurn(chatSnapshot([userNode(1, "hola")]))).toBeNull();
  });

  test("returns null while the assistant step is still streaming (issue #186, case 2)", () => {
    expect(
      mod.__test.selectReviewableTurn(
        chatSnapshot([userNode(1, "hola"), runningAssistant(2, { kind: "text", text: "a medias" })]),
      ),
    ).toBeNull();
  });

  test("returns null when the last assistant response was interrupted or empty", () => {
    expect(
      mod.__test.selectReviewableTurn(
        chatSnapshot([userNode(1, "hola"), interruptAssistant(2, { kind: "text", text: "a mitad" })]),
      ),
    ).toBeNull();
    expect(
      mod.__test.selectReviewableTurn(
        chatSnapshot([userNode(1, "hola"), finalAssistant(2, { kind: "tool-call", callId: "c1", name: "t", argsRaw: "{}" })]),
      ),
    ).toBeNull();
  });

  test("returns null when the assistant message does not come after the human request", () => {
    expect(
      mod.__test.selectReviewableTurn(
        chatSnapshot([finalAssistant(1, { kind: "text", text: "respuesta" }), userNode(2, "hola")]),
      ),
    ).toBeNull();
  });

  test("picks the LAST completed pair with full text (not bounded previews)", () => {
    const chat = chatSnapshot([
      userNode(1, "primera petición"),
      finalAssistant(2, { kind: "text", text: "primera respuesta" }),
      userNode(3, "segunda petición\nlínea dos"),
      finalAssistant(
        4,
        { kind: "reasoning", text: "razonamiento oculto" },
        { kind: "text", text: "segunda respuesta" },
        { kind: "text", text: "continuación" },
      ),
    ]);
    const reviewable = mod.__test.selectReviewableTurn(chat);
    expect(reviewable.humanRequest).toBe("segunda petición\nlínea dos");
    expect(reviewable.dshResponse).toBe("segunda respuesta\ncontinuación");
    expect(reviewable.turn).toBe(4);
  });
});

describe("issue #179 — button gating (lock during generation/review)", () => {
  const clean = { running: false, inFlight: false, reviewable: { turn: 4 } };
  test("enabled only with a reviewable turn and nothing in flight", () => {
    expect(mod.__test.canStartReview(clean)).toBe(true);
  });
  test("disabled while DSH is generating", () => {
    expect(mod.__test.canStartReview({ ...clean, running: true })).toBe(false);
  });
  test("disabled while a review is in flight (prevents a second simultaneous review)", () => {
    expect(mod.__test.canStartReview({ ...clean, inFlight: true })).toBe(false);
  });
  test("disabled with no reviewable turn", () => {
    expect(mod.__test.canStartReview({ ...clean, reviewable: null })).toBe(false);
  });
});

describe("issue #179 — dialog state (mode selection + instruction editing)", () => {
  test("mode defaults to Normal; Think is selectable; unknown values fall back to Normal", () => {
    const store = mod.__test.createAdvisorStore();
    expect(store.getSnapshot().mode).toBe("normal");
    store.setMode("think");
    expect(store.getSnapshot().mode).toBe("think");
    store.setMode("otro");
    expect(store.getSnapshot().mode).toBe("normal");
  });

  test("instructions are freely editable and the dialog preloads the given value", () => {
    const store = mod.__test.createAdvisorStore();
    const context = { humanRequest: "h", dshResponse: "d", turn: 4 };
    store.openDialog(context, "mi instrucción propia");
    expect(store.getSnapshot().instructions).toBe("mi instrucción propia");
    store.setInstructions("texto modificado");
    expect(store.getSnapshot().instructions).toBe("texto modificado");
    store.closeDialog();
    store.openDialog(context, "   ");
    expect(store.getSnapshot().instructions).toBe(mod.__test.DEFAULT_INSTRUCTIONS);
    expect(store.getSnapshot().context).toEqual(context);
  });
});

describe("issue #179 — correct #178 advisor call", () => {
  test("buildAdvisorFetch targets the control endpoint with Bearer auth and the full body", () => {
    const signal = { aborted: false };
    const { url, options } = mod.__test.buildAdvisorFetch({
      base: "http://127.0.0.1:17841",
      token: "tok-123",
      sessionId: "sess-1",
      humanRequest: "h",
      dshResponse: "d",
      instructions: "i",
      mode: "think",
      project: "my-proj",
      signal,
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/review");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer tok-123");
    expect(options.signal).toBe(signal);
    expect(JSON.parse(options.body)).toEqual({
      sessionId: "sess-1",
      humanRequest: "h",
      dshResponse: "d",
      instructions: "i",
      mode: "think",
      project: "my-proj",
    });
  });

  test("project is omitted when unknown (the API field is optional)", () => {
    const { options } = mod.__test.buildAdvisorFetch({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "s",
      humanRequest: "h",
      dshResponse: "d",
      instructions: "i",
      mode: "normal",
      project: undefined,
    });
    expect(JSON.parse(options.body).project).toBeUndefined();
  });

  test("selectProjectName sends the workspace basename, never a path", () => {
    const items = [
      { workspaceId: "w1", path: "/home/user/projects/my-proj", sessionIds: ["sess-1"] },
    ];
    expect(mod.__test.selectProjectName(items, "sess-1")).toBe("my-proj");
    expect(mod.__test.selectProjectName(items, "other")).toBeUndefined();
    expect(mod.__test.selectProjectName([{ path: "C:\\dev\\win-proj", sessionIds: ["sess-1"] }], "sess-1")).toBe("win-proj");
  });
});

describe("issue #179 — error handling with retry, context preserved", () => {
  function env(overrides: Record<string, unknown> = {}) {
    return {
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      project: undefined,
      storage: makeStorage(),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, reviewId: "r1", text: "review" }) }),
      ...overrides,
    };
  }

  test("network failure → error state, in-flight released, retry possible", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", turn: 4 }, "instr");
    store.runReview(env({ fetch: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(store.getSnapshot().status).toBe("loading");
    expect(store.inFlight).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().error).toBe("ECONNREFUSED");
    expect(store.getSnapshot().context).toEqual({ humanRequest: "h", dshResponse: "d", turn: 4 });
    expect(store.inFlight).toBe(false);
    // Retry: a second run after the error works.
    store.runReview(env());
    expect(store.inFlight).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().status).toBe("idle");
    expect(store.getSnapshot().open).toBe(false);
  });

  test("sidecar 502 ok:false → error with the sidecar message", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", turn: 4 }, "instr");
    store.runReview(env({ fetch: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, code: "browser_unavailable", message: "chatgpt web is unreachable" }) }) }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().error).toBe("chatgpt web is unreachable");
  });

  test("success closes the dialog and persists the instruction locally", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", turn: 4 }, "instrucción final");
    store.runReview(env({ storage }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().open).toBe(false);
    expect(store.getSnapshot().status).toBe("idle");
    expect(storage.getItem(mod.__test.LAST_INSTRUCTIONS_KEY)).toBe("instrucción final");
  });

  test("closing the dialog aborts the request without surfacing an error", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", turn: 4 }, "instr");
    let rejectFn: (e: unknown) => void = () => {};
    const pending = new Promise((_, reject) => { rejectFn = reject; });
    store.runReview(env({ fetch: () => pending }));
    store.closeDialog();
    const err = new Error("aborted");
    err.name = "AbortError";
    rejectFn(err);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().status).toBe("idle");
    expect(store.getSnapshot().error).toBeNull();
  });
});

describe("issue #179 — local persistence of the last instruction (browser only)", () => {
  test("returns the stored instruction when present and non-empty", () => {
    const storage = makeStorage();
    storage.setItem(mod.__test.LAST_INSTRUCTIONS_KEY, "recordada");
    expect(mod.__test.loadLastInstructions(storage)).toBe("recordada");
  });

  test("falls back to the recommended default when missing, blank, or storage throws", () => {
    expect(mod.__test.loadLastInstructions(makeStorage())).toBe(mod.__test.DEFAULT_INSTRUCTIONS);
    const blank = makeStorage();
    blank.setItem(mod.__test.LAST_INSTRUCTIONS_KEY, "   ");
    expect(mod.__test.loadLastInstructions(blank)).toBe(mod.__test.DEFAULT_INSTRUCTIONS);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => {} };
    expect(mod.__test.loadLastInstructions(throwing)).toBe(mod.__test.DEFAULT_INSTRUCTIONS);
  });

  test("saving is best-effort: no storage / blank value / throwing storage never throw", () => {
    expect(() => mod.__test.saveLastInstructions(undefined, "x")).not.toThrow();
    const storage = makeStorage();
    mod.__test.saveLastInstructions(storage, "   ");
    expect(storage.getItem(mod.__test.LAST_INSTRUCTIONS_KEY)).toBeNull();
    mod.__test.saveLastInstructions(storage, "ok");
    expect(storage.getItem(mod.__test.LAST_INSTRUCTIONS_KEY)).toBe("ok");
    const throwing = { getItem: () => null, setItem: () => { throw new Error("denied"); } };
    expect(() => mod.__test.saveLastInstructions(throwing, "x")).not.toThrow();
  });
});

describe("issue #179 — module wiring", () => {
  test("registers the official projection key and the browser-storage key", () => {
    expect(mod.__test.ADVISOR_PROJECTION_KEY).toBe("dsh-chatgpt-web:sidecar");
    expect(mod.__test.LAST_INSTRUCTIONS_KEY).toBe("dsh-chatgpt-web.advisor.lastInstructions");
  });
});
