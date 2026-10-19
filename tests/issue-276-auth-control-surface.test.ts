import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import type {
  AuthCapture,
  AuthInput,
  AuthSessionState,
  ProviderAuthController,
  ProviderAuthSession,
} from "../src/web-chat/core";

/**
 * Issue #276, slice 2a — the interactive sign-in host surface and its page.
 *
 * The suite runs the REAL listener (as `tests/issue-247-*` and `tests/issue-248-*` do) against a
 * FAKE provider: no browser, no chromium, no ChatGPT login and no network. The fake relays a
 * synthetic 1x1 PNG and declares the viewport the page must map clicks into, so every claim below is
 * about the surface's own behaviour — the relay, the capture handoff, the authority boundary and the
 * served page — not about any provider.
 */

const API_KEY = "issue-276-slice2a-api-key-0123456789";
const CONTROL_TOKEN = "issue-276-slice2a-control-token-0123456789";

/** A real 1x1 PNG. The surface relays it byte-for-byte and never decodes it. */
const ONE_BY_ONE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PIXEL_PROVIDER = "pixel-web";
const NO_PIXEL_PROVIDER = "device-code-web";
const OPAQUE_PAYLOAD_SECRET = "issue-276-opaque-payload-value";

interface FakeProvider {
  readonly providerId: string;
  readonly label: string;
  readonly controller: ProviderAuthController;
  readonly inputs: AuthInput[];
  readonly stores: AuthCapture[];
  readonly captureCalls: () => number;
  readonly counts: () => { starts: number; views: number; inputs: number; cancels: number };
}

/**
 * A provider double with no browser.
 *
 * `pixels: true` relays synthetic frames and a 320x480 viewport (so a relayed click can be asserted
 * to arrive in the provider's own coordinates); `pixels: false` refuses `view()` outright, which is
 * the device-code/OTP provider whose sign-in needs no display.
 */
function fakeProvider(options: {
  providerId: string;
  label: string;
  pixels: boolean;
  capture?: AuthCapture;
  storeResult?: { stored: boolean; location?: string; detail?: string };
}): FakeProvider {
  let state: AuthSessionState = "starting";
  let starts = 0;
  let views = 0;
  let inputs = 0;
  let cancels = 0;
  let captureCalls = 0;
  const seen: AuthInput[] = [];
  const stores: AuthCapture[] = [];

  const session: ProviderAuthSession = {
    providerId: options.providerId,
    state: () => state,
    async view() {
      views += 1;
      if (!options.pixels) throw new Error("this provider relays no frames");
      const png = new Uint8Array(ONE_BY_ONE_PNG.length + 1);
      png.set(ONE_BY_ONE_PNG, 0);
      png[ONE_BY_ONE_PNG.length] = views;
      return { png, width: 320, height: 480 };
    },
    async input(event) {
      inputs += 1;
      seen.push(event);
      if (event.type === "type" && (event.text === "user@example.test" || event.text === "12345678")) {
        state = "verifying";
      } else if (event.type === "key" && event.key === "Enter") {
        state = "captured";
      }
    },
    async capture() {
      captureCalls += 1;
      return options.capture ?? { kind: "none" };
    },
    async cancel() {
      cancels += 1;
      if (state !== "captured") state = "expired";
    },
  };

  const controller: ProviderAuthController = {
    async startAuth() {
      starts += 1;
      state = "awaiting_input";
      return session;
    },
    async storeCapture(capture) {
      stores.push(capture);
      // A tiny delay, so a missing "store once" guard would race two concurrent observers.
      if (options.storeResult) await new Promise((resolve) => setTimeout(resolve, 5));
      return options.storeResult ?? { stored: capture.kind !== "none" };
    },
  };

  return {
    providerId: options.providerId,
    label: options.label,
    controller,
    inputs: seen,
    stores,
    captureCalls: () => captureCalls,
    counts: () => ({ starts, views, inputs, cancels }),
  };
}

const running: RunningServer[] = [];
beforeEach(() => {
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
});
afterEach(async () => {
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function serve(
  providers: FakeProvider[],
  auth: { frameIntervalMs?: number; session?: Record<string, unknown> } = {},
): RunningServer {
  const surfaceOptions = {
    providers: providers.map(provider => ({
      providerId: provider.providerId,
      label: provider.label,
      controller: provider.controller,
    })),
    ...(auth.frameIntervalMs !== undefined ? { frameIntervalMs: auth.frameIntervalMs } : {}),
    ...(auth.session !== undefined ? { session: auth.session } : {}),
  };
  const server = startServer(
    { ...defaultConfig(), port: 0, host: "127.0.0.1", controlToken: CONTROL_TOKEN } as never,
    { auth: surfaceOptions } as never,
  );
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const control = (value: string = CONTROL_TOKEN) => ({ ...bearer(value), "content-type": "application/json" });
const getJson = async (server: RunningServer, path: string, headers: Record<string, string>) =>
  fetch(url(server, path), { headers });

async function openSession(server: RunningServer, providerId: string) {
  const response = await fetch(url(server, "/v1/control/auth/sessions"), {
    method: "POST",
    headers: control(),
    body: JSON.stringify({ providerId }),
  });
  expect(response.status, `open ${providerId}`).toBe(201);
  return await response.json() as { id: string; providerId: string; state: string; expiresAt: number };
}

async function postInput(server: RunningServer, id: string, input: unknown) {
  return fetch(url(server, `/v1/control/auth/sessions/${id}/input`), {
    method: "POST",
    headers: control(),
    body: JSON.stringify(input),
  });
}

/** Every input the fake provider received, in the order it received them, as comparable strings. */
const inputOrder = (fake: FakeProvider): string[] =>
  fake.inputs.map(event =>
    event.type === "type" ? `type:${event.text}` : event.type === "key" ? `key:${event.key}` : event.type);

/** Read the SSE relay block by block, with the event name, and a bounded wait. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 2_500): Promise<{ name: string; data: Record<string, unknown> }> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let name = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length === 0) continue;
          return { name, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for an SSE block");
        const chunk = await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for an SSE block")), remaining);
          reader.read().then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
          );
        });
        if (chunk.done) throw new Error("the SSE stream ended before the expected block");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function readEvent(reader: ReturnType<typeof sseReader>, timeoutMs?: number) {
  try {
    return await reader.next(timeoutMs);
  } catch (error) {
    throw new Error(`reading the relay: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("issue #276 slice 2a — the sign-in API keeps the control-token authority", () => {
  const API_ROUTES: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/v1/control/auth/providers"],
    ["POST", "/v1/control/auth/sessions"],
    ["GET", "/v1/control/auth/sessions/missing-session"],
    ["GET", "/v1/control/auth/sessions/missing-session/stream"],
    ["POST", "/v1/control/auth/sessions/missing-session/input"],
    ["DELETE", "/v1/control/auth/sessions/missing-session"],
  ];

  test("no credentials and the API key are both refused; the control token opens every route", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);

    for (const [method, path] of API_ROUTES) {
      const anonymous = await fetch(url(server, path), { method, body: method === "POST" ? "{}" : undefined });
      expect(anonymous.status, `${method} ${path} without credentials`).toBe(401);

      const withApiKey = await fetch(url(server, path), {
        method,
        headers: { ...bearer(API_KEY), "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(withApiKey.status, `${method} ${path} with the API key`).toBe(401);

      const withControl = await fetch(url(server, path), {
        method,
        headers: control(),
        body: method === "POST" ? "{}" : undefined,
      });
      // Never 401: the token was accepted and the route answered on its merits (a missing session is
      // a 404, an empty open body a 400).
      expect(withControl.status, `${method} ${path} with the control token`).not.toBe(401);
    }

    const providers = await getJson(server, "/v1/control/auth/providers", control());
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({
      ok: true,
      providers: [{ providerId: PIXEL_PROVIDER, label: "Pixel Web" }],
    });
  });

  test("the control token still cannot open the public API, and the API key cannot open the control surface", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);

    expect((await fetch(url(server, "/v1/models"), { headers: bearer(CONTROL_TOKEN) })).status).toBe(401);
    expect((await fetch(url(server, "/v1/models"), { headers: bearer(API_KEY) })).status).toBe(200);
    expect((await fetch(url(server, "/v1/control/auth/providers"), { headers: bearer(API_KEY) })).status).toBe(401);
  });

  test("the page itself is the one anonymous path, and it carries no data", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);

    // A browser cannot attach a header to a navigation, so the document is anonymous by design...
    const page = await fetch(url(server, "/v1/control/auth/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<img");
    expect(html).toContain("<form");
    // ...while everything that carries data is behind the token (proven above).
    expect((await fetch(url(server, "/v1/control/auth/providers"))).status).toBe(401);
    expect(html).not.toContain(OPAQUE_PAYLOAD_SECRET);
  });
});

describe("issue #276 slice 2a — opening sessions", () => {
  test("open returns the session id and state, and a second open for the same provider is refused", async () => {
    const pixel = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const deviceCode = fakeProvider({ providerId: NO_PIXEL_PROVIDER, label: "Device Code", pixels: false });
    const server = serve([pixel, deviceCode]);

    const session = await openSession(server, PIXEL_PROVIDER);
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.providerId).toBe(PIXEL_PROVIDER);
    expect(session.state).toBe("awaiting_input");
    expect(session.expiresAt).toBeGreaterThan(Date.now() - 1_000);

    const second = await fetch(url(server, "/v1/control/auth/sessions"), {
      method: "POST",
      headers: control(),
      body: JSON.stringify({ providerId: PIXEL_PROVIDER }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, code: "TRANSPORT_UNAVAILABLE" });

    // A different provider is a different account: allowed alongside the first.
    const other = await openSession(server, NO_PIXEL_PROVIDER);
    expect(other.id).not.toBe(session.id);
  });

  test("an unknown provider is a 404 that names the valid ones, and a malformed body is a 400", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);

    const unknown = await fetch(url(server, "/v1/control/auth/sessions"), {
      method: "POST",
      headers: control(),
      body: JSON.stringify({ providerId: "qwen-web" }),
    });
    expect(unknown.status).toBe(404);
    const body = await unknown.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("MODEL_UNAVAILABLE");
    expect(body.message).toContain(PIXEL_PROVIDER);

    for (const raw of ["{}", "[]", "not json", JSON.stringify({ providerId: 42 })]) {
      const refused = await fetch(url(server, "/v1/control/auth/sessions"), {
        method: "POST",
        headers: control(),
        body: raw,
      });
      expect(refused.status, raw).toBe(400);
    }
  });

  test("the session view carries the lifecycle, never a credential or a frame", async () => {
    const fake = fakeProvider({
      providerId: PIXEL_PROVIDER,
      label: "Pixel Web",
      pixels: true,
      capture: { kind: "opaque", payload: { secret: OPAQUE_PAYLOAD_SECRET } },
    });
    const server = serve([fake]);
    const session = await openSession(server, PIXEL_PROVIDER);

    const response = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    expect(response.status).toBe(200);
    const raw = await response.text();
    const view = JSON.parse(raw) as Record<string, unknown>;
    expect(view).toMatchObject({ ok: true, id: session.id, providerId: PIXEL_PROVIDER, state: "awaiting_input" });
    expect(typeof view.expiresAt).toBe("number");
    for (const forbidden of ["frame", "png", "cookie", "storageState", "capture"]) {
      expect(raw, `the view must not carry ${forbidden}`).not.toContain(forbidden);
    }
    expect(raw).not.toContain(OPAQUE_PAYLOAD_SECRET);
  });
});

describe("issue #276 slice 2a — the frame relay", () => {
  test("the stream is SSE, relays a decodable PNG with its viewport, and paints a new frame after an input", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    // A 5s cadence, so a new frame can only come from the input's wake signal, not from the tick.
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const session = await openSession(server, PIXEL_PROVIDER);

    const response = await fetch(url(server, `/v1/control/auth/sessions/${session.id}/stream`), {
      headers: control(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseReader(response);

    const first = await readEvent(reader);
    expect(first.data.state).toBe("awaiting_input");
    expect(first.data.terminal).toBe(false);
    const firstFrame = first.data.frame as string;
    expect(Buffer.from(firstFrame, "base64").subarray(0, 8)).toEqual(Buffer.from(PNG_SIGNATURE));
    // The page must not guess the ratio between the displayed size and the provider's own viewport.
    expect(first.data.viewport).toEqual({ width: 320, height: 480 });
    expect(first.data.seq).toBe(0);

    // A click is relayed in the provider's own frame geometry, verbatim.
    const clicked = await postInput(server, session.id, { type: "click", x: 123, y: 45 });
    expect(clicked.status).toBe(200);
    expect((await clicked.json() as { state: string }).state).toBe("awaiting_input");
    expect(fake.inputs.at(-1)).toEqual({ type: "click", x: 123, y: 45 });

    const afterClick = await readEvent(reader);
    expect(afterClick.data.frame).not.toBe(firstFrame);
    expect(fake.counts().views).toBeGreaterThan(1);

    // A typed credential moves the state; the frame follows immediately (no 5s wait).
    const typed = await postInput(server, session.id, { type: "type", text: "user@example.test" });
    expect(typed.status).toBe(200);
    expect((await typed.json() as { state: string }).state).toBe("verifying");

    const afterType = await readEvent(reader);
    expect(afterType.data.state).toBe("verifying");
    expect(afterType.data.frame).not.toBe(afterClick.data.frame);

    // Enter completes the sign-in; the terminal frame is the last relayed frame and the stream ends.
    expect((await postInput(server, session.id, { type: "key", key: "Enter" })).status).toBe(200);
    const terminal = await readEvent(reader);
    expect(terminal.data.state).toBe("captured");
    expect(terminal.data.terminal).toBe(true);
    expect(typeof terminal.data.frame).toBe("string");

    const end = await readEvent(reader);
    expect(end.name).toBe("end");
    expect(end.data.state).toBe("captured");
    await expect(reader.next(1_000)).rejects.toThrow(/ended before/);
  });

  test("a provider with no pixels streams state only, and that is not an error", async () => {
    const fake = fakeProvider({ providerId: NO_PIXEL_PROVIDER, label: "Device Code", pixels: false });
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const session = await openSession(server, NO_PIXEL_PROVIDER);

    const response = await fetch(url(server, `/v1/control/auth/sessions/${session.id}/stream`), {
      headers: control(),
    });
    expect(response.status).toBe(200);
    const reader = sseReader(response);

    const first = await readEvent(reader);
    expect(first.data.state).toBe("awaiting_input");
    expect(first.data.frame).toBeUndefined();
    expect(first.data.error).toBeUndefined();
    expect(fake.counts().views).toBe(1); // it was asked, refused, and the relay carried on

    expect((await postInput(server, session.id, { type: "type", text: "12345678" })).status).toBe(200);
    const verifying = await readEvent(reader);
    expect(verifying.data.state).toBe("verifying");
    expect(verifying.data.frame).toBeUndefined();
    expect(verifying.data.error).toBeUndefined();

    expect((await postInput(server, session.id, { type: "key", key: "Enter" })).status).toBe(200);
    const terminal = await readEvent(reader);
    expect(terminal.data.state).toBe("captured");
    expect(terminal.data.terminal).toBe(true);
    expect(terminal.data.frame).toBeUndefined();
    await readEvent(reader); // the `end` block
  });

  test("an unknown session is a 404 on the stream, not an empty 200 event stream", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);
    const response = await fetch(url(server, "/v1/control/auth/sessions/nope/stream"), { headers: control() });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

describe("issue #276 slice 2a — input, cancellation and expiry", () => {
  test("a malformed input is refused with 400 and never reaches the provider", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);
    const session = await openSession(server, PIXEL_PROVIDER);

    const malformed: unknown[] = [
      { type: "drag", x: 1, y: 1 },
      { type: "drag", points: [] },
      { type: "drag", points: [{ x: 1, y: 2, atMs: 0 }] },
      { type: "drag", points: [{ x: 1, y: 2, atMs: 20 }, { x: 3, y: 4, atMs: 10 }] },
      { type: "click", x: 1 },
      { type: "click", x: Number.NaN, y: 2 },
      { type: "type", text: "" },
      { type: "key", key: "" },
      { type: "scroll", dy: Number.POSITIVE_INFINITY },
      { type: "navigate", url: "" },
      "click",
      null,
    ];
    for (const input of malformed) {
      const refused = await postInput(server, session.id, input);
      expect(refused.status, JSON.stringify(input)).toBe(400);
      expect(await refused.json()).toMatchObject({ ok: false, code: "invalid_auth_input" });
    }
    expect(fake.counts().inputs).toBe(0);

    const unknown = await postInput(server, "missing-session", { type: "key", key: "Enter" });
    expect(unknown.status).toBe(404);
  });

  test("DELETE cancels idempotently and a cancelled session is expired, not replayable", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);
    const session = await openSession(server, PIXEL_PROVIDER);

    const first = await fetch(url(server, `/v1/control/auth/sessions/${session.id}`), {
      method: "DELETE",
      headers: control(),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, state: "expired", closeReason: "cancelled" });
    expect(fake.counts().cancels).toBe(1);

    const second = await fetch(url(server, `/v1/control/auth/sessions/${session.id}`), {
      method: "DELETE",
      headers: control(),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, state: "expired" });
    expect(fake.counts().cancels).toBe(1);

    // A cancelled session serves no more input.
    expect((await postInput(server, session.id, { type: "key", key: "Enter" })).status).toBe(409);
    expect((await fetch(url(server, "/v1/control/auth/sessions/missing"), { method: "DELETE", headers: control() })).status).toBe(404);
  });

  test("the TTL expires a session and the state view reports it", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    let clock = 1_000_000;
    const server = serve([fake], { session: { now: () => clock, ttlMs: 1_000, sweepIntervalMs: 0 } });
    const session = await openSession(server, PIXEL_PROVIDER);
    expect(session.expiresAt).toBe(1_001_000);

    const live = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    expect((await live.json() as { state: string }).state).toBe("awaiting_input");

    clock = 1_001_000;
    const expired = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    expect(await expired.json()).toMatchObject({ ok: true, state: "expired", closeReason: "expired" });
    expect(fake.counts().cancels).toBe(1);

    // The slot is free again after expiry.
    const restarted = await openSession(server, PIXEL_PROVIDER);
    expect(restarted.id).not.toBe(session.id);
  });
});

describe("issue #276 slice 2a — the capture handoff happens once", () => {
  test("storeCapture is called exactly once with the provider's opaque payload, and it is never echoed", async () => {
    const material: AuthCapture = { kind: "opaque", payload: { secret: OPAQUE_PAYLOAD_SECRET } };
    const fake = fakeProvider({
      providerId: PIXEL_PROVIDER,
      label: "Pixel Web",
      pixels: true,
      capture: material,
      storeResult: { stored: true, location: "profile/session.json" },
    });
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const session = await openSession(server, PIXEL_PROVIDER);

    const response = await fetch(url(server, `/v1/control/auth/sessions/${session.id}/stream`), {
      headers: control(),
    });
    const reader = sseReader(response);
    await readEvent(reader);
    await postInput(server, session.id, { type: "type", text: "user@example.test" });
    await readEvent(reader);
    await postInput(server, session.id, { type: "key", key: "Enter" });

    const terminal = await readEvent(reader);
    expect(terminal.data.state).toBe("captured");
    expect(terminal.data.capture).toEqual({ stored: true, location: "profile/session.json" });

    // Two concurrent observers plus the stream: the handoff still happens exactly once.
    const [first, second] = await Promise.all([
      getJson(server, `/v1/control/auth/sessions/${session.id}`, control()),
      getJson(server, `/v1/control/auth/sessions/${session.id}`, control()),
    ]);
    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    expect(firstBody.capture).toEqual({ stored: true, location: "profile/session.json" });
    expect(secondBody.capture).toEqual({ stored: true, location: "profile/session.json" });
    expect(fake.stores).toHaveLength(1);
    // The provider's own object, forwarded untouched.
    expect(fake.stores[0]).toBe(material);
    expect(fake.captureCalls()).toBe(1);
    expect(JSON.stringify(firstBody)).not.toContain(OPAQUE_PAYLOAD_SECRET);
    expect(JSON.stringify(secondBody)).not.toContain(OPAQUE_PAYLOAD_SECRET);

    // Acknowledging the capture cancels the provider mechanism and leaves the material reported.
    const acknowledged = await fetch(url(server, `/v1/control/auth/sessions/${session.id}`), {
      method: "DELETE",
      headers: control(),
    });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({ ok: true, state: "captured" });
  });

  test("a stored capture's non-secret provider detail reaches the operator-facing view", async () => {
    // The shape a ChatGPT Web sign-in produces when the session stored but the account fingerprint did
    // not: `stored: true` with a non-secret explanation, so the operator learns the next turn fails
    // closed instead of reading a bare success.
    const fake = fakeProvider({
      providerId: PIXEL_PROVIDER,
      label: "Pixel Web",
      pixels: true,
      capture: { kind: "opaque", payload: { opaque: true } },
      storeResult: {
        stored: true,
        location: "profile/session.json",
        detail: "The signed-in account identity could not be read; every turn will fail closed",
      },
    });
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const session = await openSession(server, PIXEL_PROVIDER);
    await postInput(server, session.id, { type: "type", text: "user@example.test" });
    await postInput(server, session.id, { type: "key", key: "Enter" });

    const response = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    const body = await response.json() as { state: string; capture?: unknown };
    expect(body.state).toBe("captured");
    expect(body.capture).toEqual({
      stored: true,
      location: "profile/session.json",
      detail: "The signed-in account identity could not be read; every turn will fail closed",
    });
  });

  test("a capture the provider refuses is reported as a non-secret error, not a failed session", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const broken: ProviderAuthController = {
      async startAuth() {
        const session = await fake.controller.startAuth();
        return { ...session, capture: async () => { throw new Error("no material at all"); } };
      },
      async storeCapture() {
        return { stored: true };
      },
    };
    const server = serve([{ ...fake, controller: broken }]);
    const session = await openSession(server, PIXEL_PROVIDER);
    await postInput(server, session.id, { type: "type", text: "user@example.test" });
    await postInput(server, session.id, { type: "key", key: "Enter" });

    const response = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    const body = await response.json() as Record<string, unknown>;
    expect(body.state).toBe("captured");
    expect(body.error).toBe("no material at all");
    expect(body.capture).toBeUndefined();
  });
});

describe("issue #276 slice 2c — a collected session answers like an unknown id", () => {
  test("a terminal session is kept for the grace period, then every verb is the same 404", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    let clock = 1_000_000;
    const server = serve([fake], {
      session: { now: () => clock, ttlMs: 60_000, terminalGraceMs: 1_000, sweepIntervalMs: 0 },
    });
    const session = await openSession(server, PIXEL_PROVIDER);

    // DELETE terminalizes it; inside the grace period it still reads exactly as it did before.
    const cancelled = await fetch(url(server, `/v1/control/auth/sessions/${session.id}`), {
      method: "DELETE",
      headers: control(),
    });
    expect(cancelled.status).toBe(200);
    expect((await getJson(server, `/v1/control/auth/sessions/${session.id}`, control())).status).toBe(200);

    clock += 1_000;
    const collected = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    const unknown = await getJson(server, "/v1/control/auth/sessions/never-opened", control());
    expect(collected.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Byte-for-byte the same answer an id that never existed gets: collection changes nothing about
    // the state a client observes, it only forgets the session.
    expect(await collected.json()).toEqual(await unknown.json());

    // The relay, the input and the acknowledgement all answer that same 404.
    expect((await fetch(url(server, `/v1/control/auth/sessions/${session.id}/stream`), {
      headers: control(),
    })).status).toBe(404);
    expect((await postInput(server, session.id, { type: "key", key: "Enter" })).status).toBe(404);
    expect((await fetch(url(server, `/v1/control/auth/sessions/${session.id}`), {
      method: "DELETE",
      headers: control(),
    })).status).toBe(404);
  });

  test("a captured session hands its material over exactly once, then is collected like any terminal one", async () => {
    const material: AuthCapture = { kind: "opaque", payload: { secret: OPAQUE_PAYLOAD_SECRET } };
    const fake = fakeProvider({
      providerId: PIXEL_PROVIDER,
      label: "Pixel Web",
      pixels: true,
      capture: material,
      storeResult: { stored: true, location: "profile/session.json" },
    });
    let clock = 2_000_000;
    const server = serve([fake], {
      session: { now: () => clock, ttlMs: 60_000, terminalGraceMs: 1_000, sweepIntervalMs: 0 },
    });
    const session = await openSession(server, PIXEL_PROVIDER);
    await postInput(server, session.id, { type: "type", text: "user@example.test" });

    // The input that captures the sign-in is itself a read: the handoff is stored and reported in
    // that very response, so no sweep can ever get between the capture and the store.
    const captured = await postInput(server, session.id, { type: "key", key: "Enter" });
    expect(captured.status).toBe(200);
    const capturedBody = await captured.json() as Record<string, unknown>;
    expect(capturedBody).toMatchObject({
      state: "captured",
      capture: { stored: true, location: "profile/session.json" },
    });
    expect(fake.stores).toHaveLength(1);
    expect(fake.captureCalls()).toBe(1);
    expect(JSON.stringify(capturedBody)).not.toContain(OPAQUE_PAYLOAD_SECRET);

    // Inside the grace period the session still reads, and the handoff is never taken twice.
    const inside = await getJson(server, `/v1/control/auth/sessions/${session.id}`, control());
    expect(inside.status).toBe(200);
    expect((await inside.json() as Record<string, unknown>).capture)
      .toEqual({ stored: true, location: "profile/session.json" });

    // Past it the session is collected, exactly like a session that never captured — and the
    // material is still stored exactly once. (The captured-but-never-read session, which the sweep
    // must never collect, is proved at the manager level in `issue-276-auth-contract.test.ts`.)
    clock += 10_000_000;
    expect((await getJson(server, `/v1/control/auth/sessions/${session.id}`, control())).status).toBe(404);
    expect(fake.stores).toHaveLength(1);
    expect(fake.captureCalls()).toBe(1);
  });
});

describe("issue #276 slice 2a — the served page", () => {
  test("both documented paths serve the same self-contained document, with no external asset", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake]);

    const root = await fetch(url(server, "/v1/control/auth/"));
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html; charset=utf-8");
    const html = await root.text();

    const explicit = await fetch(url(server, "/v1/control/auth/index.html"));
    expect(explicit.status).toBe(200);
    expect(await explicit.text()).toBe(html);

    // The elements the page needs to work at all.
    expect(html).toContain("<img");
    expect(html).toContain("<form");
    expect(html).toContain("<select");
    expect(html).toContain("viewport");
    // Offline-safe and leak-free by construction: no absolute URL anywhere, so no CDN, no external
    // asset and no place a token could be smuggled into a query string.
    expect(/https?:\/\//.test(html)).toBe(false);
    expect(html).toContain("sessionStorage");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain(CONTROL_TOKEN);
  });

  test("a listener with no registered provider still serves the page and an empty list", async () => {
    const server = serve([]);
    expect((await fetch(url(server, "/v1/control/auth/"))).status).toBe(200);
    const providers = await getJson(server, "/v1/control/auth/providers", control());
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({ ok: true, providers: [] });

    const refused = await fetch(url(server, "/v1/control/auth/sessions"), {
      method: "POST",
      headers: control(),
      body: JSON.stringify({ providerId: PIXEL_PROVIDER }),
    });
    expect(refused.status).toBe(404);
    expect((await refused.json() as { message: string }).message).toContain("none");
  });
});

/**
 * Issue #276 — the keyboard relay (the operator's "I cannot type" report).
 *
 * The page's own JavaScript has no DOM harness in CI, so this suite splits the claim honestly in two:
 *
 * - **Server side, proven here.** The `input` endpoint relays a rapid `type`+`key` sequence to the
 *   provider in exactly the order it was issued (a fake session records every call), which is the
 *   ordering the page's flush-before-Enter rule depends on.
 * - **Page side, the published contract only.** The served document declares the routing marker, the
 *   batch timer and the named-key vocabulary its relay uses, and its script consumes those same three
 *   attributes and posts to the same endpoint the server serves. That proves the agreement between the
 *   page and this server; it does **not** prove what a browser does with a `keydown`. Whether the route
 *   actually moves, whether a keystroke reaches the provider, whether a dead key or an IME composes, and
 *   whether the caret is visible in a relayed frame are all real-browser questions and are listed as
 *   uncovered in the change report.
 */
describe("issue #276 — the keyboard relay: server ordering and the page's published contract", () => {
  test("a rapid type+key sequence reaches the provider in exactly the order the page sent it", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const first = await openSession(server, PIXEL_PROVIDER);

    // Exactly what the relay does for "user@x.com" followed by Enter: the batched text is flushed
    // first, then the named key, back to back and each awaited before the next (the page has one send
    // chain), so the order the operator typed in is the order the provider sees.
    expect((await postInput(server, first.id, { type: "type", text: "user@x.com" })).status).toBe(200);
    expect((await postInput(server, first.id, { type: "key", key: "Enter" })).status).toBe(200);
    expect(inputOrder(fake)).toEqual(["type:user@x.com", "key:Enter"]);

    // A burst of batches interleaved with named keys keeps that same order in both directions: text is
    // never reordered behind, or ahead of, the key it was typed with. (The first session is `captured`,
    // which is terminal, so the provider slot is free again for the second one.)
    const second = await openSession(server, PIXEL_PROVIDER);
    const burst: AuthInput[] = [
      { type: "type", text: "ab" },
      { type: "key", key: "Tab" },
      { type: "type", text: "cd" },
      { type: "key", key: "Backspace" },
      { type: "type", text: "e@f.g" },
    ];
    for (const event of burst) {
      expect((await postInput(server, second.id, event)).status, JSON.stringify(event)).toBe(200);
    }
    expect(inputOrder(fake)).toEqual([
      "type:user@x.com", "key:Enter",
      "type:ab", "key:Tab", "type:cd", "key:Backspace", "type:e@f.g",
    ]);
  });

  test("the served page publishes the routing marker, the batch timer and the named-key vocabulary", async () => {
    const server = serve([]);
    const html = await (await fetch(url(server, "/v1/control/auth/"))).text();

    // 1. The routing state is published rather than hidden: the marker is in the served document before
    // any script runs, and the script paints that same attribute when the route moves.
    expect(html).toContain('data-keyboard-routing="local"');

    // 2. The batch timer is published, and inside the 60-80 ms band the relay must use.
    const flush = /data-keyboard-flush-ms="(\d+)"/.exec(html);
    expect(flush).not.toBeNull();
    const flushMs = Number(flush![1]);
    expect(flushMs).toBeGreaterThanOrEqual(60);
    expect(flushMs).toBeLessThanOrEqual(80);

    // 3. The named keys the relay may map to `{type:"key"}` are published as one vocabulary.
    const named = /data-keyboard-named-keys="([^"]+)"/.exec(html);
    expect(named).not.toBeNull();
    const namedKeys = named![1].split(" ");
    for (const key of ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(namedKeys, `the relay must map ${key} to a key event`).toContain(key);
    }

    // 4. The script reads back the same three attributes the document publishes, and talks to the
    // endpoint this server serves. This is the contract between the two halves; the behaviour behind it
    // is what needs a real browser (see the suite comment).
    const script = html.slice(html.indexOf("<script>"));
    for (const name of ['"data-keyboard-routing"', '"data-keyboard-flush-ms"', '"data-keyboard-named-keys"']) {
      expect(script, `the script must consume ${name}`).toContain(name);
    }
    expect(script).toContain('"sessions/"');
    expect(script).toContain('"/input"');

    // 5. A phone has no hardware keyboard and no hover: nothing in the relay may depend on either, and
    // the text field must be labelled as the fallback rather than as the way to type.
    expect(html).not.toMatch(/:hover|mouseenter|mouseover/);
    expect(html).toContain("Send text");
    expect(html).toMatch(/fallback/i);
  });
});

/**
 * Issue #276 — the pointer relay: a click, or the drag path the operator actually drew.
 *
 * The report that produced this: a provider presented a "drag to complete the puzzle" verification
 * during sign-in, and the page turned every `pointerdown` into a click and nothing else, so the drag
 * could not exist. The split is the same as the keyboard relay's: the server side proves that one
 * ordered path reaches the provider byte-for-byte, and the served page proves that its script is the
 * capture-and-send relay the contract names — that it samples `pointermove`, carries the per-sample
 * offsets, and has no other motion source. Whether a browser's pointer events and a real captcha
 * accept the relayed path is a real-browser question, listed as uncovered in the change report.
 */
describe("issue #276 — the pointer relay: an ordered drag path", () => {
  test("one drag reaches the provider as the same ordered samples, and later clicks still work", async () => {
    const fake = fakeProvider({ providerId: PIXEL_PROVIDER, label: "Pixel Web", pixels: true });
    const server = serve([fake], { frameIntervalMs: 5_000, session: { sweepIntervalMs: 0 } });
    const session = await openSession(server, PIXEL_PROVIDER);

    // A deliberately non-linear, jittery path: y rises, dips and rises again. If any layer collapsed
    // it into the straight line between its endpoints — or re-derived it with interpolation — this
    // equality fails.
    const path = [
      { x: 20, y: 300, atMs: 0 },
      { x: 41, y: 296, atMs: 11 },
      { x: 78, y: 291, atMs: 23 },
      { x: 96, y: 299, atMs: 38 },
      { x: 143, y: 292, atMs: 52 },
      { x: 210, y: 284, atMs: 69 },
    ];
    const relayed = await postInput(server, session.id, { type: "drag", points: path });
    expect(relayed.status).toBe(200);
    expect((await relayed.json() as { state: string }).state).toBe("awaiting_input");
    expect(fake.inputs.at(-1)).toEqual({ type: "drag", points: path });

    // A drag is an ordinary input: it neither ends nor wedges the session, and the gesture that was
    // a tap still arrives as a click right after it.
    expect((await postInput(server, session.id, { type: "click", x: 210, y: 284 })).status).toBe(200);
    expect(inputOrder(fake)).toEqual(["drag", "click"]);
  });

  test("the served page publishes its drag sampling contract and relays pointerdown/move/up", async () => {
    const server = serve([]);
    const html = await (await fetch(url(server, "/v1/control/auth/"))).text();

    // 1. The sampling rate, the sample cap and the tap threshold are the document's, read back by
    // its own script: a drag is sampled on movement at a coarser cadence than the old 12 ms one (so a
    // normal gesture yields a sane count), a long gesture is thinned rather than allowed to grow
    // without bound, and a press that moves less than the threshold stays the click it always was.
    const sample = /data-drag-sample-ms="(\d+)"/.exec(html);
    expect(sample).not.toBeNull();
    expect(Number(sample![1])).toBeGreaterThanOrEqual(24);
    expect(Number(sample![1])).toBeLessThanOrEqual(48);
    const maxPoints = /data-drag-max-points="(\d+)"/.exec(html);
    expect(maxPoints).not.toBeNull();
    expect(Number(maxPoints![1])).toBeGreaterThanOrEqual(32);
    expect(Number(maxPoints![1])).toBeLessThanOrEqual(128);
    const threshold = /data-drag-move-threshold-px="(\d+)"/.exec(html);
    expect(threshold).not.toBeNull();
    expect(Number(threshold![1])).toBeGreaterThanOrEqual(1);

    // 2. The operator can see the gesture being relayed, before and while it happens.
    expect(html).toContain('id="pointer-relay"');
    expect(html).toContain('data-pointer-relay="idle"');
    expect(html).toMatch(/press and <em>drag<\/em>|press and drag/i);

    // 3. The script is a real pointer path capture: it starts on `pointerdown`, samples on
    // `pointermove`, ends on `pointerup`, captures the pointer so a release off the picture is still
    // seen, and sends the samples it collected — with their own offsets — as one `drag` input.
    const script = html.slice(html.indexOf("<script>"));
    for (const handler of ['"pointerdown"', '"pointermove"', '"pointerup"', '"pointercancel"']) {
      expect(script, `the page must listen for ${handler}`).toContain(handler);
    }
    expect(script).toContain("setPointerCapture");
    expect(script).toContain("releasePointerCapture");
    expect(script).toContain('"data-drag-sample-ms"');
    expect(script).toContain('"data-drag-max-points"');
    expect(script).toContain('"data-drag-move-threshold-px"');
    expect(script).toContain("type: \"drag\"");
    expect(script).toContain("points: drag.points");
    expect(script).toContain("atMs");
    // The release is the mapped pointerup, appended unconditionally, not the last throttled move; and
    // the path is thinned when it reaches the cap instead of growing without bound.
    expect(script).toContain("var release = framePoint(event)");
    expect(script).toContain("drag.points.push({ x: release.x, y: release.y");
    expect(script).toContain("drag.sampleMs = drag.sampleMs * 2");

    // 4. Touch must reach the page as pointer events instead of being eaten by a scroll gesture, and
    // no part of this interaction depends on hover.
    expect(html).toMatch(/touch-action:\s*none/);
    expect(html).not.toMatch(/:hover|mouseenter|mouseover/);
  });
});

