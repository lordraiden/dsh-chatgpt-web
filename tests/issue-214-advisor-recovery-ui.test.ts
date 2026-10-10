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

function findAll(tree: any, className: string): any[][] {
  const found: any[][] = [];
  walk(tree, (element) => {
    if (element[1] && element[1].className === className) found.push(element);
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
function renderDialog(roster: any[] = [{ id: "reviewer", name: "Senior reviewer" }]) {
  const chat = chatSnapshot([textUserNode(1, 1, "arregla el bug"), settledStep(2, 1, "hecho")]);
  const button = mod.__test.AdvisorReviewButton(T, {
    sessionId: "sess-1",
    useChat: (selector: (snapshot: unknown) => unknown) => selector(chat),
    useSession: (selector: (session: unknown) => unknown) => selector({ running: false }),
  });
  expect(button).not.toBeNull();
  button[1].onClick();

  const props = {
    sessionId: "sess-1",
    useProjection: (key: string) => {
      if (key === mod.__test.ADVISOR_PROJECTION_KEY) return { controlToken: "tok" };
      if (key === mod.__test.SESSION_PRESET_PROJECTION_KEY) return "reviewer";
      return undefined;
    },
    useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({ items: [] }),
  };
  const store = mod.__test.createAdvisorPresetStore();
  // The dialog's roster effect does not run under the react stub, so the roster is pre-loaded the
  // way the effect would load it.
  const ready = store.load(async () => mod.__test.advisorPresetOptions(roster));
  const presets = { store, read: async () => [] };
  const render = () => mod.__test.AdvisorReviewDialog(T, props, CONFIG_FORM, presets);
  return { render, button, ready };
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

describe("issue #214 — the recovery request", () => {
  test("targets the recover endpoint with the session, mode and bounded wait", () => {
    const { url, options } = mod.__test.buildAdvisorRecoverFetch({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      mode: "think",
      timeoutMs: 120000,
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/recover");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(options.body)).toEqual({ sessionId: "sess-1", mode: "think", timeoutMs: 120000 });
  });

  test("omits an unusable mode or timeout instead of sending junk", () => {
    const { options } = mod.__test.buildAdvisorRecoverFetch({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      mode: "deep",
      timeoutMs: -1,
    });
    expect(JSON.parse(options.body)).toEqual({ sessionId: "sess-1" });
  });

  test("carries the cancellation signal", () => {
    const signal = { aborted: false };
    const { options } = mod.__test.buildAdvisorRecoverFetch({ base: "http://127.0.0.1:17841", token: "t", sessionId: "s", signal });
    expect(options.signal).toBe(signal);
  });
});

describe("issue #214 — a failed review offers the recovery, and the answer is copyable", () => {
  test("the failed review shows the recover action, and recovering shows the recorded answer", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const storage = makeStorage();
    (globalThis as any).window.localStorage = storage;
    const { render, ready } = renderDialog();
    await ready;
    await withFetch(async (url: string, options: any) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/advisor/review")) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ ok: false, code: "advisor_turn_failed", message: "ChatGPT response DOM disappeared while the browser turn was active" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reviewId: "recover-1", mode: "normal", model: "chatgpt-web/luna", recovered: true, text: "**Verdict: request changes.**\n\n- arreglar X" }),
      };
    }, async () => {
      // The dialog is open: start the review and let it fail while ChatGPT keeps working.
      const dialog = render();
      buttonByText(dialog, "Review")![1].onClick();
      await settle();

      const failed = render();
      expect(textOf(find(failed, "cwg-advisor-error"))).toContain("The review failed. You can retry.");
      expect(textOf(find(failed, "cwg-advisor-error"))).toContain("response DOM disappeared");

      // The failure offers the read-only recovery instead of only an error.
      const recoverButton = buttonByText(failed, "Recover answer from ChatGPT");
      expect(recoverButton).toBeDefined();
      recoverButton![1].onClick();
      await settle();
    });

    expect(calls.at(-1)?.url).toBe("http://127.0.0.1:17841/v1/control/advisor/recover");
    expect(calls.at(-1)?.body).toEqual({ sessionId: "sess-1", mode: "normal" });

    // The answer is shown in a selectable read-only field with a copy action.
    const recovered = render();
    const field = find(recovered, "cwg-advisor-result-body");
    expect(field).toBeDefined();
    expect(field![1].readOnly).toBe(true);
    expect(field![1].value).toContain("Verdict: request changes");
    expect(textOf(find(recovered, "cwg-advisor-result-note"))).toContain("Recorded for this turn");
    const copyButton = buttonByText(recovered, "Copy");
    expect(copyButton).toBeDefined();
    // The recover action is replaced by the recovered result.
    expect(buttonByText(recovered, "Recover answer from ChatGPT")).toBeUndefined();
  });

  test("a recovered review is recorded for the turn, so the card and the handoff carry it", async () => {
    const storage = makeStorage();
    (globalThis as any).window.localStorage = storage;
    const { render, ready } = renderDialog();
    await ready;
    await withFetch(async (url: string) => {
      if (url.endsWith("/advisor/review")) {
        return { ok: false, status: 502, json: async () => ({ ok: false, message: "turn failed" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reviewId: "recover-2", mode: "normal", model: "chatgpt-web/luna", recovered: true, text: "respuesta recuperada" }),
      };
    }, async () => {
      const dialog = render();
      buttonByText(dialog, "Review")![1].onClick();
      await settle();
      buttonByText(render(), "Recover answer from ChatGPT")![1].onClick();
      await settle();
    });

    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ turn: 1, recovered: true, text: "respuesta recuperada", model: "chatgpt-web/luna" });
    expect(mod.__test.buildHandoffPrompt(results[0])).toContain("respuesta recuperada");
  });

  test("the fix hint is offered as the preset label context of the review", async () => {
    const calls: any[] = [];
    const { render, ready } = renderDialog();
    await ready;
    await withFetch(async (url: string, options: any) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: false, status: 502, json: async () => ({ ok: false, message: "turn failed" }) };
    }, async () => {
      const dialog = render();
      buttonByText(dialog, "Review")![1].onClick();
      await settle();
    });
    expect(calls[0]?.url).toContain("/advisor/review");
    // The session preset is resolved to its reviewer-facing label before the request.
    expect(calls[0]?.body.preset).toBe("Senior reviewer");
  });

  test("a failed recovery keeps the review error and shows its own reason", async () => {
    const { render, ready } = renderDialog();
    await ready;
    await withFetch(async (url: string) => {
      if (url.endsWith("/advisor/review")) {
        return { ok: false, status: 502, json: async () => ({ ok: false, message: "turn failed" }) };
      }
      return {
        ok: false,
        status: 502,
        json: async () => ({ ok: false, code: "advisor_recovery_unavailable", message: "The retained ChatGPT conversation is no longer available." }),
      };
    }, async () => {
      const dialog = render();
      buttonByText(dialog, "Review")![1].onClick();
      await settle();
      buttonByText(render(), "Recover answer from ChatGPT")![1].onClick();
      await settle();
    });

    const failed = render();
    const errors = findAll(failed, "cwg-advisor-error").map(textOf);
    // The review error stays visible, and the recovery reports its own reason next to it.
    expect(errors.some((text) => text.includes("The review failed"))).toBe(true);
    expect(errors.some((text) => text.includes("no longer available"))).toBe(true);
    expect(find(failed, "cwg-advisor-result-body")).toBeUndefined();
    // The action stays available for a retry: a recovery is read-only.
    expect(buttonByText(failed, "Recover answer from ChatGPT")).toBeDefined();
  });

  test("a recovery failure never clobbers the review error", () => {
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", dshTurn: 1 }, "i");
    store.fail("review boom");
    store.failRecovery("recovery boom");
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("review boom");
    expect(snapshot.recovery).toMatchObject({ status: "error", error: "recovery boom" });
    store.clearRecovery();
    expect(store.getSnapshot().recovery).toEqual({ status: "idle", text: "", error: null });
    expect(store.getSnapshot().error).toBe("review boom");
    store.closeDialog();
    expect(store.getSnapshot().recovery.status).toBe("idle");
  });

  test("a cancelled recovery returns to idle instead of reporting an error", async () => {
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", dshTurn: 1 }, "i");
    let rejectFetch: (error: unknown) => void = () => {};
    const pending = new Promise((_resolve, reject) => { rejectFetch = reject; });
    store.recover({
      base: "http://127.0.0.1:17841",
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
    (globalThis as any).window.localStorage = storage;
    const store = mod.__test.createAdvisorStore();
    // No dshTurn: the answer is shown, it simply cannot be attached to a turn card.
    store.openDialog({ humanRequest: "h", dshResponse: "d" }, "i");
    store.recover({
      base: "http://127.0.0.1:17841",
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
