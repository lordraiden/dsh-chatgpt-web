import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #208 — Advisor dialog presentation and DSH agent-preset context (client half).
 *
 * The dialog is registered in `conversation.input.overlay`, which DSH renders inside a
 * zero-height, absolutely-positioned anchor at the top of the composer card. A dialog that
 * stays in that flow overlaps the composer's own editable field and reads as a panel under the
 * text box, which is exactly what the report described; it must therefore be a fixed, centred
 * modal, and it must offer the deployment's DSH agent presets as review context.
 *
 * Same plain-JS module harness as the other Advisor suites: capture the
 * `window.__ModuleLoader__.load` descriptor, run the factory against a minimal `react` stub, and
 * exercise the units exported on `mod.__test`.
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

/** Render elements are `[type, props, ...children]`; this walks them. */
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

const T = (_key: string, fallback: string) => fallback;

const ROSTER = [
  { id: "standard", name: "Standard", description: "Everyday work", isDefault: true },
  { id: "reviewer", name: "Senior reviewer", description: "Review-heavy" },
];

/** Open the singleton dialog through the real composer control, with a loaded roster. */
async function renderDialog({ sessionPreset = "reviewer", roster = ROSTER }: Record<string, any> = {}) {
  const chat = chatSnapshot([textUserNode(1, 1, "arregla el bug"), settledStep(2, 1, "hecho")]);
  const button = mod.__test.AdvisorReviewButton(T, {
    sessionId: "sess-1",
    useChat: (selector: (snapshot: unknown) => unknown) => selector(chat),
    useSession: (selector: (session: unknown) => unknown) => selector({ running: false }),
  });
  expect(button).not.toBeNull();
  button[1].onClick();

  const store = mod.__test.createAdvisorPresetStore();
  await store.load(async () => mod.__test.advisorPresetOptions(roster));

  const props = {
    sessionId: "sess-1",
    useProjection: (key: string) => {
      if (key === mod.__test.ADVISOR_PROJECTION_KEY) return { controlToken: "tok" };
      if (key === mod.__test.SESSION_PRESET_PROJECTION_KEY) return sessionPreset;
      return undefined;
    },
    useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({ items: [] }),
  };
  const tree = mod.__test.AdvisorReviewDialog(T, props, undefined, { store, read: async () => [] });
  return { tree, store };
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
  await import("../client.js?advisor-208");
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

describe("issue #208 — the dialog is a centred modal over the composer", () => {
  test("the rendered tree is a backdrop wrapping the dialog, not an in-flow panel", async () => {
    const { tree } = await renderDialog();
    expect(tree[0]).toBe("div");
    expect(tree[1].className).toBe("cwg-advisor-backdrop");

    const dialog = find(tree, "cwg-advisor-dialog");
    expect(dialog).toBeDefined();
    expect(dialog![1].role).toBe("dialog");
    expect(dialog![1]["aria-modal"]).toBe("true");
    // The dialog is a child of the backdrop: it can never be laid out inside the composer flow.
    expect(JSON.stringify(dialog![1])).not.toContain("cwg-advisor-backdrop");
  });

  test("the layout contract is declared: fixed, centred, above the composer, bounded card", () => {
    const css = mod.__test.ADVISOR_CSS;
    expect(css).toMatch(/\.cwg-advisor-backdrop\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.cwg-advisor-backdrop\s*\{[^}]*inset:\s*0/);
    expect(css).toMatch(/\.cwg-advisor-backdrop\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.cwg-advisor-backdrop\s*\{[^}]*justify-content:\s*center/);
    expect(css).toMatch(/\.cwg-advisor-backdrop\s*\{[^}]*z-index:\s*1200/);
    expect(css).toMatch(/\.cwg-advisor-dialog\s*\{[^}]*max-height/);
    expect(css).toMatch(/\.cwg-advisor-dialog\s*\{[^}]*overflow-y:\s*auto/);
    // The previous in-flow card must not come back.
    expect(css).not.toMatch(/\.cwg-advisor-dialog\s*\{[^}]*position:\s*absolute/);
  });

  test("the modal owns dismissal: backdrop click and the close control", async () => {
    const { tree } = await renderDialog();
    const backdrop = tree[1];
    expect(typeof backdrop.onClick).toBe("function");
    expect(typeof backdrop.onKeyDown).toBe("function");
    const close = find(tree, "cwg-advisor-close");
    expect(close).toBeDefined();
    expect(typeof close![1].onClick).toBe("function");
  });
});

describe("issue #208 — the DSH agent-preset selector", () => {
  test("roster rows become options; broken and blank rows are skipped", () => {
    const options = mod.__test.advisorPresetOptions([
      { id: "standard", name: "Standard", isDefault: true, description: "Everyday work" },
      { id: "ptc", name: "PTC" },
      { id: "broken", name: "Broken", broken: "activation failed" },
      { id: "  ", name: "blank id" },
      { name: "no id" },
      null,
    ]);
    expect(options).toEqual([
      { id: "standard", name: "Standard", description: "Everyday work", isDefault: true },
      { id: "ptc", name: "PTC", description: "", isDefault: false },
    ]);
  });

  test("the dialog preselects the preset the session runs, else the deployment default, else none", () => {
    const options = mod.__test.advisorPresetOptions(ROSTER);
    expect(mod.__test.defaultAdvisorPreset(options, "reviewer")).toBe("reviewer");
    expect(mod.__test.defaultAdvisorPreset(options, "missing")).toBe("standard");
    expect(mod.__test.defaultAdvisorPreset(options, null)).toBe("standard");
    expect(mod.__test.defaultAdvisorPreset(options, undefined)).toBe("standard");
    expect(mod.__test.defaultAdvisorPreset([], "reviewer")).toBe("");
  });

  test("the reviewer label is the preset display name, falling back to its id", () => {
    const options = mod.__test.advisorPresetOptions(ROSTER);
    expect(mod.__test.advisorPresetLabel(options, "reviewer")).toBe("Senior reviewer");
    expect(mod.__test.advisorPresetLabel(options, "unknown-id")).toBe("unknown-id");
    expect(mod.__test.advisorPresetLabel(options, "")).toBe("");
    expect(mod.__test.advisorPresetLabel(options, null)).toBe("");
  });

  test("the roster read mirrors DSH: an unavailable invocation is an empty roster, other refusals are errors", async () => {
    const read = mod.__test.loadAdvisorPresetOptions;
    // No gateway namespace at all (headless or older shell): no presets, never a failure.
    expect(await read({})).toEqual([]);
    expect(await read(undefined)).toEqual([]);
    expect(await read({ agentPresets: { list: async () => ({ ok: true, value: { presets: ROSTER } }) } }))
      .toHaveLength(2);
    expect(await read({
      agentPresets: {
        list: async () => ({ ok: false, error: { code: "gateway/invocation-unavailable", message: "no service" } }),
      },
    })).toEqual([]);
    await expect(read({
      agentPresets: { list: async () => ({ ok: false, error: { code: "gateway/refused", message: "roster refused" } }) },
    })).rejects.toThrow("roster refused");
  });

  test("the dialog lists the roster, keeps an explicit 'no preset' option and preselects the session preset", async () => {
    const { tree } = await renderDialog({ sessionPreset: "reviewer" });
    const select = find(tree, "cwg-advisor-preset");
    expect(select).toBeDefined();
    expect(select![1].value).toBe("reviewer");
    const values = select!.slice(2).filter((child: any) => Array.isArray(child)).map((child: any) => child[1].value);
    expect(values).toEqual(["", "standard", "reviewer"]);
    const labels = select!.slice(2).filter((child: any) => Array.isArray(child)).map((child: any) => child[2]);
    expect(labels).toEqual(["No preset", "Standard", "Senior reviewer"]);
    // Changing the select is what records the choice.
    expect(typeof select![1].onChange).toBe("function");
  });

  test("a deployment without presets disables the selector and says so", async () => {
    const { tree, store } = await renderDialog({ roster: [] });
    expect(store.getSnapshot().status).toBe("unavailable");
    const select = find(tree, "cwg-advisor-preset");
    expect(select![1].disabled).toBe(true);
    const notes = findAll(tree, "cwg-advisor-context-label").map((node) => node[2]);
    expect(notes).toContain("No DSH agent presets are available in this deployment.");
  });

  test("the review request carries the chosen label only when one is chosen", () => {
    const base = {
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      humanRequest: "h",
      dshResponse: "d",
      instructions: "i",
      mode: "normal",
    };
    const withPreset = mod.__test.buildAdvisorFetch({ ...base, preset: "Senior reviewer" });
    expect(JSON.parse(withPreset.options.body).preset).toBe("Senior reviewer");
    const withoutPreset = mod.__test.buildAdvisorFetch(base);
    expect("preset" in JSON.parse(withoutPreset.options.body)).toBe(false);
    expect("preset" in JSON.parse(mod.__test.buildAdvisorFetch({ ...base, preset: "" }).options.body)).toBe(false);
  });
});

describe("issue #208 — the preset survives into the result and the handoff", () => {
  test("a review sends the resolved label, records it and the handoff carries it", async () => {
    const storage = makeStorage();
    const seen: any = {};
    const store = mod.__test.createAdvisorStore();
    store.openDialog({ humanRequest: "h", dshResponse: "d", dshTurn: 7 }, "instr");
    store.setPreset("reviewer");
    store.runReview({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      project: undefined,
      // The dialog resolves the roster id to the reviewer-facing label before starting.
      preset: "Senior reviewer",
      storage,
      fetch: async (url: string, options: any) => {
        seen.url = url;
        seen.body = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, reviewId: "r1", model: "gpt-x", text: "review body" }) };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(seen.url).toContain("/v1/control/advisor/review");
    expect(seen.body.preset).toBe("Senior reviewer");

    const results = mod.__test.loadAdvisorResults(storage);
    expect(results).toHaveLength(1);
    expect(results[0].preset).toBe("Senior reviewer");
    const prompt = mod.__test.buildHandoffPrompt(results[0]);
    expect(prompt).toContain('Reviewed DSH agent preset: "Senior reviewer"');
    expect(prompt).toContain("review body");
    // The preset label is context, never an internal id leak.
    expect(prompt).not.toContain("reviewer\n");
  });

  test("a preset-free review keeps the previous result and handoff shapes", async () => {
    const storage = makeStorage();
    const record = mod.__test.recordAdvisorResult(storage, { turn: 3, reviewId: "r", mode: "think", model: "gpt", text: "body" });
    expect(record.preset).toBe("");
    const results = mod.__test.loadAdvisorResults(storage);
    expect(results[0].preset).toBe("");
    expect(mod.__test.buildHandoffPrompt(results[0])).not.toContain("DSH agent preset");
  });

  test("the result card shows the preset next to the mode and model", async () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, {
      turn: 7,
      reviewId: "r1",
      mode: "think",
      model: "gpt-x",
      preset: "Senior reviewer",
      text: "review body",
    });
    (globalThis as any).window.localStorage = storage;
    const card = mod.__test.AdvisorResultCard(T, {
      turn: { turn: 7, start: undefined, end: undefined, status: "closed" },
      useInput: (selector: (state: unknown) => unknown) => selector({ phase: "plain", draft: "" }),
      inputActions: { setDraft: () => {}, submit: () => {} },
    });
    expect(card).not.toBeNull();
    const meta = find(card, "cwg-advisor-card-meta");
    expect(meta).toBeDefined();
    expect(meta![2]).toContain("Think");
    expect(meta![2]).toContain("gpt-x");
    expect(meta![2]).toContain("Senior reviewer");
  });
});
