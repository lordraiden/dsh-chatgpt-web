import { describe, expect, test } from "bun:test";

import { WEB_CHAT_AUTH_PAGE_HTML } from "../src/web-chat/host/auth-page";

/**
 * Issue #299 — the live pointer relay's coordinate contract, executed rather than pattern-matched.
 *
 * The operator reported that a relayed drag "never lands exactly on the target", and then that the
 * piece did not move at all while the pointer was still down: the page accumulated the whole path
 * and sent it once, at the release. The relay is now live — `pointerdown` posts `pointer-down`, each
 * throttled `pointermove` posts its own `pointer-move`, and `pointerup` posts `pointer-up` at the
 * exact mapped release. These tests run the served page script against a minimal DOM, drive real
 * pointer events through it, and inspect the JSON the page would post. No browser and no new
 * dependency: the arithmetic and the ordering under test are the page's own.
 */

interface ElementStub {
  hidden: boolean;
  textContent: string;
  value: string;
  src: string;
  readonly attributes: Map<string, string>;
  readonly listeners: Map<string, Array<(event: PointerEventStub) => void>>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: unknown): void;
  addEventListener(type: string, listener: (event: PointerEventStub) => void): void;
  dispatch(type: string, event: PointerEventStub): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  focus(): void;
  setPointerCapture(): void;
  releasePointerCapture(): void;
  appendChild(child: ElementStub): void;
}

interface PointerEventStub {
  pointerId: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

const VIEWPORT = { width: 1280, height: 800 };

/**
 * A fractional, non-integer displayed rectangle that keeps the viewport's aspect ratio exactly
 * (`1000.75 * 800 / 1280 === 625.46875`), i.e. a perfectly ordinary `width:100%` image in a container
 * whose content width is not a whole number of pixels.
 */
const RECT = { left: 11.5, top: 7.25, width: 1000.75, height: 625.46875 };

function element(id: string): ElementStub {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Array<(event: PointerEventStub) => void>>();
  return {
    hidden: false,
    textContent: "",
    value: "",
    src: "",
    attributes,
    listeners,
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => { attributes.set(name, String(value)); },
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    getBoundingClientRect: () => ({ ...RECT }),
    focus: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    appendChild: () => {},
  };
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([\w-]+)="([^"]*)"/g;
  let match = pattern.exec(tag);
  while (match) {
    attributes.set(match[1]!, match[2]!);
    match = pattern.exec(tag);
  }
  return attributes;
}

/**
 * Run the served page script exactly once against a tiny DOM stub and return the harness.
 *
 * `bodies` are the JSON bodies the page posted to `sessions/<id>/input`, in order. The stream is
 * parked on a never-resolving read unless `blocks` are supplied; those are fed one per read, which is
 * how a frame's age and release metadata can be exercised without a provider.
 */
function runPage(options: { blocks?: string[] } = {}) {
  const html = WEB_CHAT_AUTH_PAGE_HTML;
  const bodyTag = /<body([^>]*)>/.exec(html)?.[1] ?? "";
  const bodyAttributes = attributesOf(bodyTag);
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.indexOf("</script>");
  const source = html.slice(scriptStart, scriptEnd);

  const elements = new Map<string, ElementStub>();
  const elementFor = (id: string) => {
    let found = elements.get(id);
    if (!found) { found = element(id); elements.set(id, found); }
    return found;
  };

  const documentStub = {
    getElementById: (id: string) => elementFor(id),
    querySelectorAll: () => [] as ElementStub[],
    createElement: () => element("option"),
    addEventListener: () => {},
    activeElement: null,
    body: {
      getAttribute: (name: string) => bodyAttributes.get(name) ?? null,
    },
  } as unknown as Document;

  const bodies: Array<Record<string, unknown>> = [];
  const clock = { value: 0 };
  const blocks = options.blocks ?? [];
  const fetchStub = async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "sessions" && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "session-1",
          providerId: "pixel-web",
          state: "awaiting_input",
          viewport: { ...VIEWPORT },
          expiresAt: Date.now() + 60_000,
        }),
      };
    }
    if (path.endsWith("/stream")) {
      let block = 0;
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => block < blocks.length
              ? Promise.resolve({ done: false, value: encoder.encode(blocks[block++]) })
              : new Promise<never>(() => {}),
            cancel: () => {},
          }),
        },
      };
    }
    if (path.endsWith("/input") && init?.method === "POST") {
      bodies.push(JSON.parse(init.body!) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ state: "awaiting_input" }) };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const windowStub = { addEventListener: () => {} };
  const storageStub = { getItem: () => null, setItem: () => {} };
  const performanceStub = { now: () => clock.value };

  const run = new Function(
    "document", "window", "sessionStorage", "performance", "fetch", "setTimeout", "clearTimeout",
    source,
  ) as (...args: unknown[]) => void;
  run(
    documentStub, windowStub, storageStub, performanceStub, fetchStub, setTimeout, clearTimeout,
  );

  const frame = elementFor("frame");
  const providerForm = elementFor("provider-form");
  const select = elementFor("provider");

  return {
    bodies,
    clock,
    frame,
    marker: elementFor("pointer-marker"),
    frameAge: elementFor("frame-age"),
    async open() {
      select.value = "pixel-web";
      providerForm.dispatch("submit", { preventDefault: () => {} } as never);
      // Let the POST, the state assignment and any supplied stream block settle.
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    },
    pointer(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientX: number, clientY: number) {
      frame.dispatch(type, {
        pointerId: 1,
        clientX,
        clientY,
        preventDefault: () => {},
      });
    },
    async settle() {
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    },
  };
}

/** The page's own mapping formula, written independently of its implementation. */
function mapped(clientX: number, clientY: number) {
  return {
    x: (clientX - RECT.left) * (VIEWPORT.width / RECT.width),
    y: (clientY - RECT.top) * (VIEWPORT.height / RECT.height),
  };
}

const PRESS = { x: 211.5, y: 157.25 };
const MID = { x: 511.25, y: 307.5 };
const LAST_MOVE = { x: 711.75, y: 357.25 };
const RELEASE = { x: 731.25, y: 369.5 };

interface Posted {
  readonly type: string;
  readonly x?: number;
  readonly y?: number;
}

const posted = (page: ReturnType<typeof runPage>): Posted[] => page.bodies as unknown as Posted[];
const moves = (page: ReturnType<typeof runPage>) => posted(page).filter(event => event.type === "pointer-move");
const eventsOf = (page: ReturnType<typeof runPage>, type: string) =>
  posted(page).filter(event => event.type === type);

function expectMapped(actual: number | undefined, expected: number): void {
  expect(actual).toBeCloseTo(expected, 12);
  // No integer truncation before scaling and no rounding after it: the page's answer is the real
  // number the exact scale produces.
  expect(Number.isInteger(actual)).toBe(false);
}

describe("issue #299 — a press, its moves and its release use one exact mapper", () => {
  test("a tap is one live press and one live release at the exact mapped point", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 10_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 10_008;
    page.pointer("pointerup", PRESS.x, PRESS.y);
    await page.settle();

    const types = posted(page).map(event => event.type);
    expect(types).toEqual(["pointer-down", "pointer-up"]);
    const down = eventsOf(page, "pointer-down")[0]!;
    const up = eventsOf(page, "pointer-up")[0]!;
    expectMapped(down.x, mapped(PRESS.x, PRESS.y).x);
    expectMapped(down.y, mapped(PRESS.x, PRESS.y).y);
    expectMapped(up.x, mapped(PRESS.x, PRESS.y).x);
    expectMapped(up.y, mapped(PRESS.x, PRESS.y).y);
  });

  test("the same screen point maps to the same coordinate on the press and on the release", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 20_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 20_040;
    page.pointer("pointermove", MID.x, MID.y);
    await page.settle();
    page.clock.value = 20_080;
    page.pointer("pointermove", LAST_MOVE.x, LAST_MOVE.y);
    await page.settle();
    page.clock.value = 20_096;
    page.pointer("pointerup", RELEASE.x, RELEASE.y);
    await page.settle();

    const down = eventsOf(page, "pointer-down")[0]!;
    expectMapped(down.x, mapped(PRESS.x, PRESS.y).x);
    expectMapped(down.y, mapped(PRESS.x, PRESS.y).y);

    // Every sample is a position the browser actually reported; the last one is the exact release,
    // never the last throttled move.
    const mid = moves(page).find(event => event.x !== undefined
      && Math.abs(event.x - mapped(MID.x, MID.y).x) < 1e-9);
    expect(mid).toBeDefined();
    const up = posted(page).at(-1)!;
    expect(up.type).toBe("pointer-up");
    expectMapped(up.x, mapped(RELEASE.x, RELEASE.y).x);
    expectMapped(up.y, mapped(RELEASE.x, RELEASE.y).y);
    expect(up.x).not.toBeCloseTo(mapped(LAST_MOVE.x, LAST_MOVE.y).x, 6);
  });

  test("a move and a release observed in the same millisecond are both delivered, in order", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 35_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 35_040;
    page.pointer("pointermove", LAST_MOVE.x, LAST_MOVE.y);
    await page.settle();
    // Same clock instant as the sampled move: the release is not conditionally dropped.
    page.pointer("pointerup", RELEASE.x, RELEASE.y);
    await page.settle();

    const order = posted(page).map(event => event.type);
    expect(order[0]).toBe("pointer-down");
    expect(order.at(-1)).toBe("pointer-up");
    const up = posted(page).at(-1)!;
    expectMapped(up.x, mapped(RELEASE.x, RELEASE.y).x);
    expectMapped(up.y, mapped(RELEASE.x, RELEASE.y).y);
    expect(order).toEqual(["pointer-down", "pointer-move", "pointer-up"]);
  });

  test("a long live gesture sends real samples as they happen and always ends at the release", async () => {
    const page = runPage();
    await page.open();
    const start = 40_000;
    page.clock.value = start;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    const sent: Array<{ x: number; y: number }> = [];
    for (let elapsed = 40; elapsed <= 2_000; elapsed += 40) {
      page.clock.value = start + elapsed;
      const fraction = elapsed / 2_000;
      const point = { x: PRESS.x + 500 * fraction, y: PRESS.y + 100 * fraction };
      page.pointer("pointermove", point.x, point.y);
      await page.settle();
      sent.push({ x: mapped(point.x, point.y).x, y: mapped(point.x, point.y).y });
    }
    page.clock.value = start + 2_040;
    page.pointer("pointerup", RELEASE.x, RELEASE.y);
    await page.settle();

    // Down first, release last, and nothing but real mapped samples in between: the page never
    // accumulates a path into one `drag` input any more.
    const all = posted(page);
    expect(all[0]!.type).toBe("pointer-down");
    expect(all.at(-1)!.type).toBe("pointer-up");
    expect(all.some(event => event.type === "drag")).toBe(false);
    const observed = moves(page);
    expect(observed.length).toBeGreaterThan(20);
    for (const move of observed) {
      expect(sent.some(point => Math.abs(point.x - move.x!) < 1e-9 && Math.abs(point.y - move.y!) < 1e-9))
        .toBe(true);
    }
    const up = all.at(-1)!;
    expectMapped(up.x, mapped(RELEASE.x, RELEASE.y).x);
    expectMapped(up.y, mapped(RELEASE.x, RELEASE.y).y);
  });

  test("a cancelled gesture lifts the held button with a cancel and never invents a release", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 50_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 50_040;
    page.pointer("pointermove", MID.x, MID.y);
    await page.settle();
    page.pointer("pointercancel", MID.x, MID.y);
    await page.settle();

    const all = posted(page);
    expect(all.map(event => event.type)).toEqual(["pointer-down", "pointer-move", "pointer-cancel"]);
    expect(all.at(-1)).toEqual({ type: "pointer-cancel" });
  });
});

describe("issue #299 — the page draws the operator's hand and explains frame age locally", () => {
  test("the pointer marker follows the pointer without a round trip, and is not a hover effect", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 60_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    await page.settle();
    const pressedStyle = page.marker.getAttribute("style");
    expect(pressedStyle).toContain("left:");
    expect(page.marker.hidden).toBe(false);

    page.clock.value = 60_040;
    page.pointer("pointermove", MID.x, MID.y);
    await page.settle();
    const movedStyle = page.marker.getAttribute("style");
    expect(movedStyle).not.toBe(pressedStyle);
    // The marker moved with the hand, before any relayed frame or input response could have arrived.
    expect(page.marker.getAttribute("data-marker")).toBe("pointer");

    page.pointer("pointerup", MID.x, MID.y);
    await page.settle();
    expect(page.marker.getAttribute("data-marker")).toBe("release");

    // Nothing in the page depends on hover, and the marker is drawn from pointer events only.
    expect(WEB_CHAT_AUTH_PAGE_HTML).not.toMatch(/:hover|mouseenter|mouseover/);
  });

  test("a frame older than the operator's release is labelled as such with its age", async () => {
    const staleFrame = Buffer.from("stale-frame").toString("base64");
    const page = runPage({
      blocks: [
        `data: ${JSON.stringify({
          seq: 0,
          state: "awaiting_input",
          terminal: false,
          frame: staleFrame,
          frameAgeMs: 380,
          frameCapturedAt: 1_000,
          release: { x: 210, y: 160, at: 2_000 },
        })}\n\n`,
      ],
    });
    await page.open();
    await page.settle();

    expect(page.frameAge.textContent).toContain("380 ms old");
    expect(page.frameAge.textContent).toContain("captured before your release");
    expect(page.frameAge.textContent).toContain("(210, 160)");
    expect(page.frame.src).toBe("data:image/png;base64," + staleFrame);
  });

  test("a frame captured after the release is labelled as including it", async () => {
    const settledFrame = Buffer.from("settled-frame").toString("base64");
    const page = runPage({
      blocks: [
        `data: ${JSON.stringify({
          seq: 0,
          state: "awaiting_input",
          terminal: false,
          frame: settledFrame,
          frameAgeMs: 20,
          frameCapturedAt: 3_000,
          release: { x: 210, y: 160, at: 2_000 },
        })}\n\n`,
      ],
    });
    await page.open();
    await page.settle();

    expect(page.frameAge.textContent).toContain("20 ms old");
    expect(page.frameAge.textContent).toContain("includes your release");
    expect(page.frame.src).toBe("data:image/png;base64," + settledFrame);
  });

  test("a JPEG burst frame is labelled with the type the relay reported", async () => {
    const jpeg = Buffer.from("jpeg-burst").toString("base64");
    const page = runPage({
      blocks: [
        `data: ${JSON.stringify({
          seq: 0,
          state: "awaiting_input",
          terminal: false,
          frame: jpeg,
          frameType: "image/jpeg",
          frameAgeMs: 5,
          frameCapturedAt: 4_000,
        })}\n\n`,
      ],
    });
    await page.open();
    await page.settle();
    expect(page.frame.src).toBe("data:image/jpeg;base64," + jpeg);
  });
});
