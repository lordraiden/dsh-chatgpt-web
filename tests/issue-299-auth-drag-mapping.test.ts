import { describe, expect, test } from "bun:test";

import { WEB_CHAT_AUTH_PAGE_HTML } from "../src/web-chat/host/auth-page";

/**
 * Issue #299 — the pointer relay's coordinate contract, executed rather than pattern-matched.
 *
 * The operator reported that a relayed drag "never lands exactly on the target". A click and a drag
 * share one mapper, the frame may be displayed at a fractional CSS size, and the release is a mapped
 * `pointerup` rather than the last throttled `pointermove`; each of those is a place where a few
 * pixels can disappear silently. The served page is one self-contained script, so these tests run
 * that exact script against a minimal DOM, drive real pointer events through it, and inspect the
 * JSON the page would post. No browser and no new dependency: the arithmetic under test is the
 * page's own.
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
 * `bodies` are the JSON bodies the page posted to `sessions/<id>/input`, in order; the stream is
 * parked on a never-resolving read because these tests only exercise the pointer relay.
 */
function runPage() {
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
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
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
    async open() {
      select.value = "pixel-web";
      providerForm.dispatch("submit", { preventDefault: () => {} } as never);
      // Let the POST, the state assignment and the parked stream read settle. The stream itself is
      // deliberately never resolved; only `state.id`/`state.viewport` matter for pointer events.
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
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
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

describe("issue #299 — the pointer mapping is one exact mapper for clicks and drags", () => {
  test("a click maps the `pointerdown` point with the exact fractional display scale", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 10_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 10_008;
    page.pointer("pointerup", PRESS.x, PRESS.y);
    await page.settle();

    expect(page.bodies).toHaveLength(1);
    const click = page.bodies[0] as { type: string; x: number; y: number };
    expect(click.type).toBe("click");
    // No integer truncation before scaling and no rounding after it: the page's answer is the same
    // real number the exact scale produces.
    expect(click.x).toBeCloseTo(mapped(PRESS.x, PRESS.y).x, 12);
    expect(click.y).toBeCloseTo(mapped(PRESS.x, PRESS.y).y, 12);
    expect(Number.isInteger(click.x)).toBe(false);
    expect(Number.isInteger(click.y)).toBe(false);
  });

  test("the same screen point maps to the same coordinate through the click and drag paths", async () => {
    const clickPage = runPage();
    await clickPage.open();
    clickPage.clock.value = 20_000;
    clickPage.pointer("pointerdown", RELEASE.x, RELEASE.y);
    clickPage.clock.value = 20_004;
    clickPage.pointer("pointerup", RELEASE.x, RELEASE.y);
    await clickPage.settle();
    const click = clickPage.bodies[0] as { type: string; x: number; y: number };
    expect(click.type).toBe("click");

    const dragPage = runPage();
    await dragPage.open();
    dragPage.clock.value = 30_000;
    dragPage.pointer("pointerdown", PRESS.x, PRESS.y);
    dragPage.clock.value = 30_040;
    dragPage.pointer("pointermove", MID.x, MID.y);
    dragPage.clock.value = 30_080;
    dragPage.pointer("pointermove", LAST_MOVE.x, LAST_MOVE.y);
    dragPage.clock.value = 30_096;
    dragPage.pointer("pointerup", RELEASE.x, RELEASE.y);
    await dragPage.settle();

    expect(dragPage.bodies).toHaveLength(1);
    const drag = dragPage.bodies[0] as {
      type: string;
      points: Array<{ x: number; y: number; atMs: number }>;
    };
    expect(drag.type).toBe("drag");
    expect(drag.points.length).toBeGreaterThanOrEqual(3);

    // The press is the mapped `pointerdown`, and the release is the mapped `pointerup`: one screen
    // point, one provider coordinate, whichever gesture carried it. A regression here is exactly the
    // "lands slightly off" report.
    expect(drag.points[0]!.x).toBeCloseTo(mapped(PRESS.x, PRESS.y).x, 12);
    expect(drag.points[0]!.y).toBeCloseTo(mapped(PRESS.x, PRESS.y).y, 12);
    expect(drag.points.at(-1)!.x).toBeCloseTo(click.x, 12);
    expect(drag.points.at(-1)!.y).toBeCloseTo(click.y, 12);

    // The release is not the last throttled move: that point is a different, older position.
    expect(drag.points.at(-1)!.x).not.toBeCloseTo(mapped(LAST_MOVE.x, LAST_MOVE.y).x, 6);
    expect(drag.points.at(-2)).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
    });
  });

  test("a release in the same millisecond as the last sample is still appended as the final point", async () => {
    const page = runPage();
    await page.open();
    page.clock.value = 35_000;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    page.clock.value = 35_040;
    page.pointer("pointermove", LAST_MOVE.x, LAST_MOVE.y);
    // Same clock instant as the sampled move: the old condition (`elapsed > lastAtMs`) dropped this
    // release, so the provider saw the move position and the gesture landed short.
    page.pointer("pointerup", RELEASE.x, RELEASE.y);
    await page.settle();

    const drag = page.bodies[0] as {
      type: string;
      points: Array<{ x: number; y: number; atMs: number }>;
    };
    expect(drag.type).toBe("drag");
    expect(drag.points.at(-1)!.x).toBeCloseTo(mapped(RELEASE.x, RELEASE.y).x, 12);
    expect(drag.points.at(-1)!.y).toBeCloseTo(mapped(RELEASE.x, RELEASE.y).y, 12);
    expect(drag.points.at(-1)!.atMs).toBe(drag.points.at(-2)!.atMs);
  });

  test("a long gesture keeps a bounded, coarse, real path and always ends at the release", async () => {
    const page = runPage();
    await page.open();
    const start = 40_000;
    page.clock.value = start;
    page.pointer("pointerdown", PRESS.x, PRESS.y);
    // A 5 s gesture, sampled far more often than the published interval: the effective interval grows
    // so the relayed path stays bounded, and every point is still a position the pointer really had.
    for (let elapsed = 10; elapsed <= 5_000; elapsed += 10) {
      page.clock.value = start + elapsed;
      const fraction = elapsed / 5_000;
      page.pointer("pointermove", PRESS.x + 500 * fraction, PRESS.y + 100 * fraction);
    }
    page.clock.value = start + 5_010;
    page.pointer("pointerup", RELEASE.x, RELEASE.y);
    await page.settle();

    expect(page.bodies).toHaveLength(1);
    const drag = page.bodies[0] as {
      type: string;
      points: Array<{ x: number; y: number; atMs: number }>;
    };
    expect(drag.type).toBe("drag");
    // Press + at most `data-drag-max-points` samples + the release.
    expect(drag.points.length).toBeLessThanOrEqual(66);
    expect(drag.points.length).toBeGreaterThan(8);
    // Ordered, non-decreasing clock: the contract the controllers validate.
    for (let index = 1; index < drag.points.length; index += 1) {
      expect(drag.points[index]!.atMs).toBeGreaterThanOrEqual(drag.points[index - 1]!.atMs);
    }
    expect(drag.points.at(-1)!.x).toBeCloseTo(mapped(RELEASE.x, RELEASE.y).x, 12);
    expect(drag.points.at(-1)!.y).toBeCloseTo(mapped(RELEASE.x, RELEASE.y).y, 12);
  });
});
