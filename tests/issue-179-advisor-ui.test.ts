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
    // Issue #224: the reviewed-turn identity the sidecar freezes on the task.
    expect(reviewable.reviewedTurnId).toBe("dsh-turn:4");
  });

  test("falls back to the render anchor when the target exposes no DSH turn number", () => {
    const chat = chatSnapshot([userNode(1, "hola"), finalAssistant(2, { kind: "text", text: "respuesta" })]);
    // `assistantStep` always sets `data.turn`; a node without one keeps a stable anchor identity.
    const withoutTurn = {
      ...finalAssistant(2, { kind: "text", text: "respuesta" }),
      data: { ...finalAssistant(2, { kind: "text", text: "respuesta" }).data, turn: undefined },
    };
    const reviewable = mod.__test.selectReviewableTurn(chatSnapshot([userNode(1, "hola"), withoutTurn]));
    expect(reviewable.reviewedTurnId).toBe("anchor:2");
    // The chat fixture above still resolves the DSH turn normally.
    expect(mod.__test.selectReviewableTurn(chat).reviewedTurnId).toBe("dsh-turn:2");
  });
});

describe("issue #179/#224 — button gating (lock during generation)", () => {
  const clean = { running: false, reviewable: { turn: 4 } };
  test("enabled only with a reviewable turn and no running generation", () => {
    expect(mod.__test.canStartReview(clean)).toBe(true);
  });
  test("disabled while DSH is generating", () => {
    expect(mod.__test.canStartReview({ ...clean, running: true })).toBe(false);
  });
  test("disabled with no reviewable turn", () => {
    expect(mod.__test.canStartReview({ ...clean, reviewable: null })).toBe(false);
  });

  test("submission needs at least one substantive selected source", () => {
    const context = { humanRequest: "h", dshResponse: "d", project: "p" };
    expect(mod.__test.hasSelectedSource(context, { request: true, response: true, project: true })).toBe(true);
    expect(mod.__test.hasSelectedSource(context, { request: false, response: false, project: true })).toBe(true);
    expect(mod.__test.hasSelectedSource(context, { request: false, response: false, project: false })).toBe(false);
    expect(mod.__test.hasSelectedSource({ humanRequest: "", dshResponse: "" }, { request: true, response: true, project: true })).toBe(false);
  });
});

describe("issue #224 — dialog state (dynamic model + inclusion)", () => {
  const choice = (route: string, label: string) => ({
    route,
    providerId: route.split("/")[0],
    providerLabel: "ChatGPT Web",
    modelId: route.split("/")[1],
    modelLabel: label,
    label: `ChatGPT Web — ${label}`,
    reasoningModes: [],
  });

  test("opening the launcher selects both text sources and the review view", () => {
    const store = mod.__test.createAdvisorStore();
    const context = { humanRequest: "h", dshResponse: "d", turn: 4, reviewedTurnId: "dsh-turn:4" };
    store.openReview(context, "mis instrucciones");
    const snapshot = store.getSnapshot();
    expect(snapshot.open).toBe(true);
    expect(snapshot.view).toBe("review");
    expect(snapshot.include).toEqual({ request: true, response: true, project: true });
    expect(snapshot.instructions).toBe("mis instrucciones");
    expect(snapshot.models.status).toBe("idle");
    expect(snapshot.selection).toBeNull();
  });

  test("inclusion toggles default to included and a dismissed source stays dismissed", () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", reviewedTurnId: "t" }, "i");
    store.setInclude("response", false);
    expect(store.getSnapshot().include.response).toBe(false);
    store.setInclude("not-a-field", false);
    expect(store.getSnapshot().include.request).toBe(true);
  });

  test("the first catalogue load preselects the last used route, else the deterministic first", () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", reviewedTurnId: "t" }, "i");
    const choices = [choice("chatgpt-web/high", "High"), choice("chatgpt-web/light", "Light")];
    store.applyModels(choices, "chatgpt-web/light");
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/light");
    const fresh = mod.__test.createAdvisorStore();
    fresh.openReview({ humanRequest: "h", dshResponse: "d", reviewedTurnId: "t" }, "i");
    fresh.applyModels(choices, "gone-web/x");
    expect(fresh.getSnapshot().selection.route).toBe("chatgpt-web/high");
  });

  test("a later load never silently replaces the displayed selection", () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", reviewedTurnId: "t" }, "i");
    store.applyModels([choice("chatgpt-web/high", "High"), choice("chatgpt-web/light", "Light")], undefined);
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/high");
    // The route disappeared from the refreshed catalogue: the selection stays, so the user must
    // choose explicitly instead of being silently switched to another model.
    store.applyModels([choice("chatgpt-web/light", "Light")], "chatgpt-web/light");
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/high");
    // An explicit choice is authoritative.
    store.setSelection("chatgpt-web/light");
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/light");
    store.setSelection("unknown-web/x");
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/light");
  });

  test("instructions are freely editable and the launcher preloads the given value", () => {
    const store = mod.__test.createAdvisorStore();
    const context = { humanRequest: "h", dshResponse: "d", turn: 4, reviewedTurnId: "dsh-turn:4" };
    store.openReview(context, "mi instrucción propia");
    expect(store.getSnapshot().instructions).toBe("mi instrucción propia");
    store.setInstructions("texto modificado");
    expect(store.getSnapshot().instructions).toBe("texto modificado");
    store.closeDialog();
    store.openReview(context, "   ");
    expect(store.getSnapshot().instructions).toBe(mod.__test.DEFAULT_INSTRUCTIONS);
    expect(store.getSnapshot().context).toEqual(context);
  });
});

describe("issue #224 — control-API request builders", () => {
  test("the catalogue is a GET with Bearer auth", () => {
    const signal = { aborted: false };
    const { url, options } = mod.__test.buildAdvisorModelsFetch({
      base: "http://127.0.0.1:17841",
      token: "tok-123",
      signal,
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/models");
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer tok-123");
    expect(options.signal).toBe(signal);
  });

  test("start names the selected public route, the reviewed turn and the inclusion choices", () => {
    const signal = { aborted: false };
    const { url, options } = mod.__test.buildAdvisorStartFetch({
      base: "http://127.0.0.1:17841",
      token: "tok-123",
      sessionId: "sess-1",
      reviewedTurnId: "dsh-turn:4",
      humanRequest: "h",
      dshResponse: "d",
      instructions: "i",
      route: "chatgpt-web/light",
      reasoningMode: "fast",
      project: "my-proj",
      include: { request: true, response: false, project: true },
      signal,
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/reviews");
    expect(options.method).toBe("POST");
    expect(options.signal).toBe(signal);
    expect(JSON.parse(options.body)).toEqual({
      sessionId: "sess-1",
      reviewedTurnId: "dsh-turn:4",
      route: "chatgpt-web/light",
      instructions: "i",
      humanRequest: "h",
      dshResponse: "d",
      project: "my-proj",
      reasoningMode: "fast",
      includeRequest: true,
      includeResponse: false,
      includeProject: true,
    });
  });

  test("the project, the reasoning variant and the source text are optional", () => {
    const { options } = mod.__test.buildAdvisorStartFetch({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "s",
      reviewedTurnId: "t",
      instructions: "i",
      route: "chatgpt-web/light",
      include: { request: true, response: true, project: true },
    });
    const body = JSON.parse(options.body);
    expect(body.project).toBeUndefined();
    expect(body.reasoningMode).toBeUndefined();
    expect(body.humanRequest).toBeUndefined();
    expect(body.dshResponse).toBeUndefined();
  });

  test("status and list read by exact review id and by session", () => {
    const status = mod.__test.buildAdvisorStatusFetch({ base: "http://h:1", token: "t", reviewId: "r/1" });
    expect(status.url).toBe("http://h:1/v1/control/advisor/reviews/r%2F1");
    expect(status.options.method).toBe("GET");
    expect(mod.__test.buildAdvisorListFetch({ base: "http://h:1", token: "t" }).url)
      .toBe("http://h:1/v1/control/advisor/reviews");
    expect(mod.__test.buildAdvisorListFetch({ base: "http://h:1", token: "t", sessionId: "s 1", limit: 5 }).url)
      .toBe("http://h:1/v1/control/advisor/reviews?sessionId=s%201&limit=5");
  });

  test("recovery is a read-only POST naming the session and the displayed route", () => {
    const { url, options } = mod.__test.buildAdvisorRecoverFetch({
      base: "http://127.0.0.1:17841",
      token: "tok-123",
      sessionId: "sess-1",
      route: "chatgpt-web/light",
      timeoutMs: 5000,
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/recover");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ sessionId: "sess-1", route: "chatgpt-web/light", timeoutMs: 5000 });
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

describe("issue #224 — launch, tracking and failure", () => {
  const choice = {
    route: "chatgpt-web/light",
    providerId: "chatgpt-web",
    providerLabel: "ChatGPT Web",
    modelId: "light",
    modelLabel: "Light",
    label: "ChatGPT Web — Light",
    reasoningModes: [],
  };
  function task(overrides: Record<string, unknown> = {}) {
    return {
      reviewId: "review-1",
      state: "running",
      sessionId: "sess-1",
      reviewedTurnId: "dsh-turn:4",
      provenance: { route: "chatgpt-web/light", providerId: "chatgpt-web", providerLabel: "ChatGPT Web", modelId: "light", modelLabel: "Light" },
      source: { includedRequest: true, includedResponse: true, includedProject: false, instructions: "i" },
      createdAt: 1,
      ...overrides,
    };
  }
  function env(overrides: Record<string, unknown> = {}) {
    return {
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      project: undefined,
      storage: makeStorage(),
      fetch: async () => ({ ok: true, status: 202, json: async () => ({ ok: true, duplicate: false, task: task() }) }),
      ...overrides,
    };
  }
  function opened(store: any) {
    store.openReview({ humanRequest: "h", dshResponse: "d", turn: 4, dshTurn: 4, reviewedTurnId: "dsh-turn:4" }, "instr");
    store.applyModels([choice], undefined);
    return store;
  }

  test("an accepted review closes the launcher promptly and is tracked locally", async () => {
    const storage = makeStorage();
    const store = opened(mod.__test.createAdvisorStore());
    store.startReview(env({ storage }));
    expect(store.getSnapshot().start.status).toBe("starting");
    expect(store.inFlight).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const snapshot = store.getSnapshot();
    expect(snapshot.open).toBe(false);
    expect(snapshot.start.status).toBe("idle");
    expect(snapshot.activity.reviews).toHaveLength(1);
    expect(snapshot.activity.reviews[0].reviewId).toBe("review-1");
    expect(snapshot.activity.reviews[0].state).toBe("running");
    expect(snapshot.activity.reviews[0].label).toBe("ChatGPT Web — Light");
    expect(storage.getItem(mod.__test.LAST_INSTRUCTIONS_KEY)).toBe("instr");
    expect(storage.getItem(mod.__test.LAST_SELECTION_KEY)).toBe("chatgpt-web/light");
    expect(store.inFlight).toBe(false);
  });

  test("closing the dialog after acceptance does not cancel or lose the tracked review", async () => {
    const storage = makeStorage();
    const store = opened(mod.__test.createAdvisorStore());
    store.startReview(env({ storage }));
    await new Promise((r) => setTimeout(r, 5));
    store.closeDialog();
    expect(store.getSnapshot().open).toBe(false);
    expect(mod.__test.loadAdvisorActivity(storage)).toHaveLength(1);
    expect(mod.__test.loadAdvisorActivity(storage)[0].state).toBe("running");
  });

  test("a network failure keeps the context and stays retryable", async () => {
    const store = opened(mod.__test.createAdvisorStore());
    store.startReview(env({ fetch: async () => { throw new Error("ECONNREFUSED"); } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().start.status).toBe("error");
    expect(store.getSnapshot().start.error).toBe("ECONNREFUSED");
    expect(store.getSnapshot().open).toBe(true);
    expect(store.inFlight).toBe(false);
    store.startReview(env());
    expect(store.inFlight).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().open).toBe(false);
  });

  test("a refused model choice surfaces the failure and refreshes the catalogue", async () => {
    const calls: string[] = [];
    const store = opened(mod.__test.createAdvisorStore());
    store.startReview(env({
      fetch: async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith("/models")) {
          return { ok: true, status: 200, json: async () => ({ ok: true, choices: [choice] }) };
        }
        return { ok: false, status: 409, json: async () => ({ ok: false, code: "advisor_model_unavailable", message: "no longer served" }) };
      },
    }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().start.status).toBe("error");
    expect(store.getSnapshot().start.error).toBe("no longer served");
    // The catalogue was refreshed instead of silently substituting another model.
    expect(calls.some((url) => url.endsWith("/models"))).toBe(true);
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/light");
  });

  test("a catalogue load failure is explicit, retryable and never invents choices", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", reviewedTurnId: "t" }, "i");
    store.loadModels(env({ fetch: async () => { throw new Error("no sidecar"); } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().models.status).toBe("error");
    expect(store.getSnapshot().models.choices).toEqual([]);
    expect(store.getSnapshot().selection).toBeNull();
    store.loadModels(env({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, choices: [choice, { route: "broken" }] }) }),
    }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().models.status).toBe("ready");
    // A malformed entry is dropped; a valid one is kept.
    expect(store.getSnapshot().models.choices.map((c: any) => c.route)).toEqual(["chatgpt-web/light"]);
    expect(store.getSnapshot().selection.route).toBe("chatgpt-web/light");
  });

  test("the activity view reconciles completed work and records the result for this session", async () => {
    const storage = makeStorage();
    const store = opened(mod.__test.createAdvisorStore());
    store.startReview(env({ storage }));
    await new Promise((r) => setTimeout(r, 5));
    store.refreshActivity(env({
      storage,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reviews: [task({ state: "completed", text: "the review", completedAt: 9 })],
        }),
      }),
    }));
    await new Promise((r) => setTimeout(r, 5));
    const entry = store.getSnapshot().activity.reviews[0];
    expect(entry.state).toBe("completed");
    expect(entry.text).toBe("the review");
    // The reviewed turn identity survived the reconciliation.
    expect(entry.dshTurn).toBe(4);
    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("the review");
    expect(results[0].providerLabel).toBe("ChatGPT Web");
  });

  test("a review of another session is never written into the current session's turn card", async () => {
    const storage = makeStorage();
    const store = opened(mod.__test.createAdvisorStore());
    store.refreshActivity(env({
      storage,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reviews: [task({ sessionId: "sess-other", state: "completed", text: "other review" })],
        }),
      }),
    }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().activity.reviews).toHaveLength(1);
    expect(mod.__test.loadAdvisorResults(storage)).toEqual([]);
  });

  test("recovery stays read-only and records the retained answer for the turn", async () => {
    const storage = makeStorage();
    const store = opened(mod.__test.createAdvisorStore());
    store.recover(env({
      storage,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reviewId: "review-1", route: "chatgpt-web/light", providerLabel: "ChatGPT Web", modelLabel: "Light", text: "recovered", capturedAt: 3 }),
      }),
    }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().recovery.status).toBe("ready");
    expect(store.getSnapshot().recovery.text).toBe("recovered");
    const results = mod.__test.loadAdvisorResults(storage);
    expect(results[0].recovered).toBe(true);
    expect(results[0].modelLabel).toBe("Light");
  });

  test("closing the dialog aborts only the in-flight request, without an error", async () => {
    const store = opened(mod.__test.createAdvisorStore());
    let rejectFn: (e: unknown) => void = () => {};
    const pending = new Promise((_, reject) => { rejectFn = reject; });
    store.startReview(env({ fetch: () => pending }));
    store.closeDialog();
    const err = new Error("aborted");
    err.name = "AbortError";
    rejectFn(err);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getSnapshot().start.status).toBe("idle");
    expect(store.getSnapshot().start.error).toBeNull();
    expect(store.inFlight).toBe(false);
  });
});

describe("issue #224 — persisted activity across dialog close, remount and restart", () => {
  function serverTask(overrides: Record<string, unknown> = {}) {
    return {
      reviewId: "review-1",
      state: "running",
      sessionId: "sess-1",
      reviewedTurnId: "dsh-turn:4",
      provenance: { route: "chatgpt-web/light", providerId: "chatgpt-web", providerLabel: "ChatGPT Web", modelId: "light", modelLabel: "Light" },
      source: { includedRequest: true, includedResponse: true, includedProject: false, instructions: "i" },
      createdAt: 1,
      ...overrides,
    };
  }

  test("a persisted task the sidecar still knows takes the sidecar's state", () => {
    const persisted = [mod.__test.advisorTaskEntry(serverTask(), { dshTurn: 4 })];
    const merged = mod.__test.reconcileAdvisorActivity(persisted, [serverTask({ state: "completed", text: "done" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe("completed");
    expect(merged[0].text).toBe("done");
    expect(merged[0].dshTurn).toBe(4);
  });

  test("a persisted active task the sidecar no longer knows becomes unavailable, not running", () => {
    const persisted = [mod.__test.advisorTaskEntry(serverTask(), { dshTurn: 4 })];
    const merged = mod.__test.reconcileAdvisorActivity(persisted, []);
    expect(merged[0].state).toBe("unavailable");
    expect(merged[0].failure.code).toBe("advisor_task_unavailable");
  });

  test("a completed result the sidecar no longer knows is kept", () => {
    const persisted = [mod.__test.advisorTaskEntry(serverTask({ state: "completed", text: "kept" }), { dshTurn: 4 })];
    const merged = mod.__test.reconcileAdvisorActivity(persisted, []);
    expect(merged[0].state).toBe("completed");
    expect(merged[0].text).toBe("kept");
  });

  test("activity storage round-trips, is newest first, and is bounded", () => {
    const storage = makeStorage();
    for (let index = 0; index < 60; index += 1) {
      mod.__test.upsertAdvisorActivity(storage, mod.__test.advisorTaskEntry(serverTask({ reviewId: `r-${index}`, createdAt: index }), {}));
    }
    const entries = mod.__test.loadAdvisorActivity(storage);
    expect(entries).toHaveLength(50);
    expect(entries[0].reviewId).toBe("r-59");
    expect(mod.__test.parseAdvisorActivity("not json")).toEqual([]);
    expect(mod.__test.upsertAdvisorActivity(storage, null)).toHaveLength(50);
  });

  test("only completed results of the current session with a known turn are recorded", () => {
    const storage = makeStorage();
    const reviews = [
      { ...mod.__test.advisorTaskEntry(serverTask({ state: "completed", text: "a" }), {}), dshTurn: 4, sessionId: "sess-1" },
      { ...mod.__test.advisorTaskEntry(serverTask({ reviewId: "r2", state: "completed", text: "b" }), {}), dshTurn: 5, sessionId: "other" },
      { ...mod.__test.advisorTaskEntry(serverTask({ reviewId: "r3", state: "running" }), {}), dshTurn: 6, sessionId: "sess-1" },
    ];
    mod.__test.recordAdvisorResultsForActivity(storage, reviews, "sess-1");
    const results = mod.__test.loadAdvisorResults(storage);
    expect(results.map((entry: any) => entry.text)).toEqual(["a"]);
  });
});

describe("issue #179 — local persistence of the last instruction and selection (browser only)", () => {
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

  test("the last successful model selection is remembered and best-effort", () => {
    const storage = makeStorage();
    expect(mod.__test.loadLastSelection(storage)).toBeUndefined();
    mod.__test.saveLastSelection(storage, "chatgpt-web/light");
    expect(mod.__test.loadLastSelection(storage)).toBe("chatgpt-web/light");
    mod.__test.saveLastSelection(storage, "   ");
    expect(mod.__test.loadLastSelection(storage)).toBe("chatgpt-web/light");
    expect(() => mod.__test.saveLastSelection(undefined, "x")).not.toThrow();
  });
});

describe("issue #179/#224 — module wiring", () => {
  test("registers the official projection key and the browser-storage keys", () => {
    expect(mod.__test.ADVISOR_PROJECTION_KEY).toBe("dsh-chatgpt-web:sidecar");
    expect(mod.__test.LAST_INSTRUCTIONS_KEY).toBe("dsh-chatgpt-web.advisor.lastInstructions");
    expect(mod.__test.LAST_SELECTION_KEY).toBe("dsh-chatgpt-web.advisor.lastSelection");
    expect(mod.__test.ACTIVITY_KEY).toBe("dsh-chatgpt-web.advisor.activity");
  });
});
