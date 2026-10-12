import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #214 — recovering a finished Advisor review from the dialog (client half).
 *
 * The reported failure is a review the plugin's browser turn gave up on while ChatGPT finished the
 * answer anyway. The dialog must offer a read-only recovery of that answer, show it in a
 * selectable field and record it for the turn, without sending anything to ChatGPT.
 *
 * This suite drives the real dialog through the singleton advisor store: it opens the dialog with
 * the composer control, makes the review fail against a stubbed fetch, and then exercises the
 * recovery path end to end.
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

function chatSnapshot(nodes: Array<Record<string, any>>) {
  const order = nodes.map((node) => node.key as string);
  const store: Record<string, any> = {};
  for (const node of nodes) store[node.key as string] = node;
  return { order, nodes: { get: (key: string) => store[key] } };
}

function textUserNode(seq: number, turn: number, text: string) {
  return {
    key: `key-${seq}`,
    kind: "user",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "turn", turn: { turn } },
    data: { kind: "user", seq, time: seq, content: [{ type: "text", text }] },
  };
}

function settledStep(seq: number, turn: number, text: string) {
  const blocks = [{ kind: "text", text }];
  return {
    key: `key-${seq}`,
    kind: "assistant-step",
    target: "chat",
    anchorSeq: seq,
    visibility: "visible",
    location: { kind: "step", turn: { turn }, step: { turn, step: 1 } },
    data: {
      status: "settled",
      turn,
      step: 1,
      blocks,
      time: seq,
      finalNode: { kind: "assistant", seq, turn, step: 1, blocks },
    },
  };
}

function walk(node: any, visit: (element: any[]) => void): void {
  if (Array.isArray(node)) {
    visit(node);
    for (const child of node.slice(2)) walk(child, visit);
  }
}

function find(tree: any, className: string): any[] | undefined {
  let found: any[] | undefined;
  walk(tree, (element) => {
    if (!found && element[1] && element[1].className === className) found = element;
  });
  return found;
}

/** Every rendered button, whatever class combination it carries. */
function findButtons(tree: any): any[][] {
  const found: any[][] = [];
  walk(tree, (element) => {
    if (element[0] === "button") found.push(element);
  });
  return found;
}

function buttonByText(tree: any, text: string): any[] | undefined {
  return findButtons(tree).find((node) => textOf(node).includes(text));
}

function textOf(node: any): string {
  if (typeof node === "string") return node;
  if (!Array.isArray(node)) return "";
  return node.slice(2).map(textOf).join("");
}

const T = (_key: string, fallback: string) => fallback;
const CONFIG_FORM = { getSnapshot: () => ({ value: { port: 17841 } }) };

/** Render the open dialog for the singleton store with a controllable fetch. */
function renderDialog() {
  const chat = chatSnapshot([textUserNode(1, 1, "arregla el bug"), settledStep(2, 1, "hecho")]);
  const control = mod.__test.AdvisorReviewButton(T, {
    sessionId: "sess-1",
    useChat: (selector: (snapshot: unknown) => unknown) => selector(chat),
    useSession: (selector: (session: unknown) => unknown) => selector({ running: false }),
  });
  expect(control).not.toBeNull();
  // The composer control is a container holding the launch action (and the activity entry).
  const button = buttonByText(control, "Review with Advisor");
  expect(button).toBeDefined();
  button![1].onClick();

  const props = {
    sessionId: "sess-1",
    useProjection: (key: string) => {
      if (key === mod.__test.ADVISOR_PROJECTION_KEY) return { controlToken: "tok" };
      return undefined;
    },
    useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({ items: [] }),
  };
  const render = () => mod.__test.AdvisorReviewDialog(T, props, CONFIG_FORM);
  return { render, button: control };
}

/**
 * Run one dialog interaction with a stubbed fetch. The stub is process-global (the dialog calls
 * `fetch` itself), so it is restored in a `finally`: a leaked stub breaks every suite that speaks
 * HTTP in the same bun process.
 */
async function withFetch(
  fetchImpl: (url: string, options: any) => Promise<any>,
  run: () => Promise<void>,
): Promise<void> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    await run();
  } finally {
    (globalThis as any).fetch = original;
  }
}

/** Await the store's in-flight request by letting its promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
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
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Cache-busted path: the other Advisor suites import client.js in the same process.
  // @ts-expect-error plain-JS browser module without type declarations
  await import("../client.js?advisor-214");
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

const CHOICE = {
  route: "chatgpt-web/light",
  providerId: "chatgpt-web",
  providerLabel: "ChatGPT Web",
  modelId: "light",
  modelLabel: "Light",
  label: "ChatGPT Web — Light",
  reasoningModes: [],
};

/**
 * A fresh browser storage for one test, with the shared store's in-memory activity reset to it.
 * The dialog drives one singleton store, so a test must not inherit the previous test's reviews.
 */
function freshStorage(): any {
  const storage = makeStorage();
  (globalThis as any).window.localStorage = storage;
  mod.__test.advisorStore.hydrateActivity(storage);
  return storage;
}

/** The base URL the config form resolves to in this suite. */
const BASE = "http://127.0.0.1:17841";

/** One task record as the sidecar returns it. */
function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: "review-1",
    state: "running",
    sessionId: "sess-1",
    reviewedTurnId: "dsh-turn:1",
    provenance: {
      route: CHOICE.route,
      providerId: CHOICE.providerId,
      providerLabel: CHOICE.providerLabel,
      modelId: CHOICE.modelId,
      modelLabel: CHOICE.modelLabel,
    },
    source: { includedRequest: true, includedResponse: true, includedProject: false, instructions: "i" },
    createdAt: 1,
    ...overrides,
  };
}

/** The task status/list answer of a review the provider's own turn gave up on (issue #214). */
function failedTask() {
  return taskRecord({
    state: "failed",
    failure: { code: "advisor_turn_failed", message: "ChatGPT response DOM disappeared while the browser turn was active" },
  });
}

/** Open the tracked-activity view through the real composer control. */
function openActivityView(): void {
  const chat = chatSnapshot([textUserNode(1, 1, "arregla el bug"), settledStep(2, 1, "hecho")]);
  const control = mod.__test.AdvisorReviewButton(T, {
    sessionId: "sess-1",
    useChat: (selector: (snapshot: unknown) => unknown) => selector(chat),
    useSession: (selector: (session: unknown) => unknown) => selector({ running: false }),
  });
  expect(control).not.toBeNull();
  const activityButton = buttonByText(control, "Advisor activity");
  expect(activityButton).toBeDefined();
  activityButton![1].onClick();
}

describe("issue #214 — the recovery request", () => {
  test("targets the recover endpoint with the session, the route and the bounded wait", () => {
    const { url, options } = mod.__test.buildAdvisorRecoverFetch({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      route: "chatgpt-web/light",
      timeoutMs: 120000,
    });
    expect(url).toBe(`${BASE}/v1/control/advisor/recover`);
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(options.body)).toEqual({ sessionId: "sess-1", route: "chatgpt-web/light", timeoutMs: 120000 });
  });

  test("omits an unusable route or timeout instead of sending junk", () => {
    const { options } = mod.__test.buildAdvisorRecoverFetch({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      route: "",
      timeoutMs: -1,
    });
    expect(JSON.parse(options.body)).toEqual({ sessionId: "sess-1" });
  });

  test("carries the cancellation signal", () => {
    const signal = { aborted: false };
    const { options } = mod.__test.buildAdvisorRecoverFetch({ base: BASE, token: "t", sessionId: "s", signal });
    expect(options.signal).toBe(signal);
  });
});

describe("issue #214 — a tracked failure offers the recovery, and the answer is copyable", () => {
  test("the failed task shows the recover action, and recovering shows the recorded answer", async () => {
    const storage = freshStorage();
    const calls: Array<{ url: string; body: any }> = [];
    const { render } = renderDialog();
    mod.__test.advisorStore.applyModels([CHOICE], undefined);

    await withFetch(async (url: string, options: any) => {
      calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
      if (url.endsWith("/advisor/reviews")) {
        return { ok: true, status: 202, json: async () => ({ ok: true, duplicate: false, task: taskRecord() }) };
      }
      if (url.endsWith("/advisor/recover")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reviewId: "recover-1",
            route: CHOICE.route,
            providerLabel: CHOICE.providerLabel,
            modelLabel: CHOICE.modelLabel,
            text: "**Verdict: request changes.**\n\n- arreglar X",
            capturedAt: 5,
          }),
        };
      }
      if (url.includes("/advisor/reviews?")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, reviews: [failedTask()] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, choices: [CHOICE] }) };
    }, async () => {
      // Start the review, then let the sidecar report that its turn failed.
      buttonByText(render(), "Start review")![1].onClick();
      await settle();
      mod.__test.advisorStore.refreshActivity({
        base: BASE,
        token: "tok",
        sessionId: "sess-1",
        storage,
        fetch: (u: string, o: any) => (globalThis as any).fetch(u, o),
      });
      await settle();

      // The failure is tracked, so the activity entry offers the read-only recovery.
      openActivityView();
      const activity = render();
      expect(buttonByText(activity, "Recover retained answer")).toBeDefined();
      buttonByText(activity, "Recover retained answer")![1].onClick();
      await settle();
    });

    // The recovery named the failed review's route and no mode at all.
    expect(calls.at(-1)?.url).toBe(`${BASE}/v1/control/advisor/recover`);
    expect(calls.at(-1)?.body).toEqual({ sessionId: "sess-1", route: CHOICE.route });

    // The answer is shown in a selectable read-only field with a copy action.
    const recovered = render();
    const field = find(recovered, "cwg-advisor-result-body");
    expect(field).toBeDefined();
    expect(field![1].readOnly).toBe(true);
    expect(field![1].value).toContain("Verdict: request changes");
    expect(textOf(find(recovered, "cwg-advisor-result-note"))).toContain("Recorded for this turn");
    expect(buttonByText(recovered, "Copy")).toBeDefined();
  });

  test("a recovered review is recorded for the turn, so the card and the handoff carry it", async () => {
    const storage = freshStorage();
    const store = mod.__test.createAdvisorStore();
    store.applyModels([CHOICE], undefined);
    store.openReview({ humanRequest: "h", dshResponse: "d", dshTurn: 1, reviewedTurnId: "dsh-turn:1" }, "i");
    store.recover({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      route: CHOICE.route,
      storage,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reviewId: "recover-2", route: CHOICE.route, providerLabel: CHOICE.providerLabel, modelLabel: CHOICE.modelLabel, text: "respuesta recuperada", capturedAt: 9 }),
      }),
    });
    await settle();

    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ turn: 1, recovered: true, text: "respuesta recuperada", route: CHOICE.route });
    expect(mod.__test.buildHandoffPrompt(results[0])).toContain("respuesta recuperada");
  });

  test("a failed recovery keeps its own reason and stays retryable", async () => {
    const storage = freshStorage();
    const store = mod.__test.createAdvisorStore();
    store.applyModels([CHOICE], undefined);
    store.openReview({ humanRequest: "h", dshResponse: "d", dshTurn: 1, reviewedTurnId: "dsh-turn:1" }, "i");
    store.recover({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      route: CHOICE.route,
      storage,
      fetch: async () => ({
        ok: false,
        status: 502,
        json: async () => ({ ok: false, code: "advisor_recovery_unavailable", message: "The retained ChatGPT conversation is no longer available." }),
      }),
    });
    await settle();
    expect(store.getSnapshot().recovery).toMatchObject({ status: "error", error: "The retained ChatGPT conversation is no longer available." });
    expect(mod.__test.loadAdvisorResults(storage)).toEqual([]);
  });

  test("a recovery failure never clobbers the review error", () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", dshTurn: 1, reviewedTurnId: "dsh-turn:1" }, "i");
    store.fail("review boom");
    store.failRecovery("recovery boom");
    const snapshot = store.getSnapshot();
    expect(snapshot.start).toMatchObject({ status: "error", error: "review boom" });
    expect(snapshot.recovery).toMatchObject({ status: "error", error: "recovery boom" });
    store.clearRecovery();
    expect(store.getSnapshot().recovery).toEqual({ status: "idle", text: "", error: null });
    expect(store.getSnapshot().start.error).toBe("review boom");
    store.closeDialog();
    expect(store.getSnapshot().recovery.status).toBe("idle");
  });

  test("a cancelled recovery returns to idle instead of reporting an error", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openReview({ humanRequest: "h", dshResponse: "d", dshTurn: 1, reviewedTurnId: "dsh-turn:1" }, "i");
    let rejectFetch: (error: unknown) => void = () => {};
    const pending = new Promise((_resolve, reject) => { rejectFetch = reject; });
    store.recover({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      storage: makeStorage(),
      fetch: () => pending,
    });
    expect(store.getSnapshot().recovery.status).toBe("loading");
    store.closeDialog();
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    rejectFetch(aborted);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getSnapshot().recovery).toEqual({ status: "idle", text: "", error: null });
    expect(store.inFlight).toBe(false);
  });

  test("a recovery for a turn with no resolvable DSH turn still shows the answer", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    // No dshTurn: the answer is shown, it simply cannot be attached to a turn card.
    store.openReview({ humanRequest: "h", dshResponse: "d" }, "i");
    store.recover({
      base: BASE,
      token: "tok",
      sessionId: "sess-1",
      storage,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: "respuesta sin turno" }) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getSnapshot().recovery).toEqual({ status: "ready", text: "respuesta sin turno", error: null });
    expect(mod.__test.loadAdvisorResults(storage)).toHaveLength(0);
  });
});
