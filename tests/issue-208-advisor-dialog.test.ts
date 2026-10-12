import { beforeAll, describe, expect, test } from "bun:test";

/**
 * Issue #208 — Advisor dialog presentation (client half).
 *
 * The dialog is registered in `conversation.input.overlay`, which DSH renders inside a
 * zero-height, absolutely-positioned anchor at the top of the composer card. A dialog that
 * stays in that flow overlaps the composer's own editable field and reads as a panel under the
 * text box, which is exactly what the report described; it must therefore be a fixed, centred
 * modal over the composer. It offers no DSH agent-preset context (issue #223).
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

function textOf(node: any): string {
  if (typeof node === "string") return node;
  if (!Array.isArray(node)) return "";
  return node.slice(2).map(textOf).join("");
}

function buttonByText(tree: any, text: string): any[] | undefined {
  let found: any[] | undefined;
  walk(tree, (element) => {
    if (!found && element[0] === "button" && textOf(element).includes(text)) found = element;
  });
  return found;
}

const T = (_key: string, fallback: string) => fallback;

/** Open the singleton dialog through the real composer control. */
async function renderDialog() {
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
      return undefined;
    },
    useWorkspaces: (selector: (snapshot: unknown) => unknown) => selector({ items: [] }),
  };
  const tree = mod.__test.AdvisorReviewDialog(T, props, undefined);
  return { tree };
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

describe("issue #223 — the dialog has no DSH agent-preset integration", () => {
  test("the module exposes no agent-preset roster store or helpers", () => {
    for (const name of [
      "createAdvisorPresetStore",
      "advisorPresetOptions",
      "defaultAdvisorPreset",
      "advisorPresetLabel",
      "loadAdvisorPresetOptions",
      "SESSION_PRESET_PROJECTION_KEY",
    ]) {
      expect(mod.__test[name]).toBeUndefined();
    }
  });

  test("the rendered dialog contains no preset selector", async () => {
    const { tree } = await renderDialog();
    expect(find(tree, "cwg-advisor-preset")).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("cwg-advisor-preset");
    expect(textOf(tree)).not.toContain("preset");
  });

  test("a review request never carries a preset field", () => {
    const { url, options } = mod.__test.buildAdvisorFetch({
      base: "http://127.0.0.1:17841",
      token: "tok",
      sessionId: "sess-1",
      humanRequest: "arregla el bug",
      dshResponse: "hecho",
      instructions: "review it",
      mode: "normal",
      project: "dsh-chatgpt-web",
    });
    expect(url).toBe("http://127.0.0.1:17841/v1/control/advisor/review");
    const body = JSON.parse(options.body);
    expect("preset" in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      ["dshResponse", "humanRequest", "instructions", "mode", "project", "sessionId"],
    );
  });

  test("a legacy stored result carrying extra preset metadata stays readable", () => {
    const parsed = mod.__test.parseAdvisorResults(JSON.stringify([
      { turn: 3, reviewId: "r", mode: "normal", model: "chatgpt-web/light", preset: "Senior reviewer", recovered: false, text: "ok", at: 1 },
    ]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("ok");
    // The legacy preset field is ignored, never surfaced as result metadata.
    expect("preset" in parsed[0]).toBe(false);
  });
});
