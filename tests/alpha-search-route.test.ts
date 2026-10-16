import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import type { NativeFetch } from "../src/native-passthrough";

/**
 * `POST /v1/alpha/search` — the native Codex search passthrough.
 *
 * The route has no tests of its own; read `src/server.ts` (it forwards through
 * `nativeSearchRequest` → `forwardNativeCodexRequest(req, "alpha/search")`) and this suite pins what
 * it actually is: a native Codex passthrough behind the public API key — NOT a WebChat route — that
 * requires the incoming Bearer authorization and returns the upstream response unchanged.
 */
const API_KEY = "issue-247-alpha-search-api-key-0123456789";
const CONTROL_TOKEN = "issue-247-alpha-search-control-token-0123456789";
const ACCOUNT = "issue-247-alpha-search-account";

let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
});

const running: RunningServer[] = [];
afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT,
    ...overrides,
  };
}

function serve(fetchUpstream?: NativeFetch, config = makeConfig()): RunningServer {
  const server = startServer(config as never, (fetchUpstream !== undefined ? { fetchUpstream } : {}) as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const search = (server: RunningServer, headers: Record<string, string>, body: unknown = { query: "hola" }) =>
  fetch(url(server, "/v1/alpha/search"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("/v1/alpha/search — it is a native passthrough behind the public API key", () => {
  test("the public API surface admits it: the API key, not the control token", async () => {
    const server = serve(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    expect((await search(server, {})).status).toBe(401);

    const apiKeyRefused = await search(server, { authorization: `Bearer wrong-key-000000000000` });
    expect(apiKeyRefused.status).toBe(401);
    const body = await apiKeyRefused.json() as { error?: { code?: string; type?: string } };
    expect(body.error?.code).toBe("invalid_api_key");
    expect(body.error?.type).toBe("authentication_error");

    // The operator control token is not an API credential.
    expect((await search(server, { authorization: `Bearer ${CONTROL_TOKEN}` })).status).toBe(401);
    // The Bearer API key admits the caller through the public surface to the native passthrough.
    expect((await search(server, { authorization: `Bearer ${API_KEY}` })).status).toBe(200);
    // `x-api-key` also admits the public surface, but it is not a Bearer token for the upstream;
    // that boundary is asserted in full below.
    expect((await search(server, { "x-api-key": API_KEY })).status).toBe(502);
  });

  test("an admitted request forwards to the native Codex search endpoint and returns its response", async () => {
    const seen: Request[] = [];
    const server = serve(async (request: Request) => {
      seen.push(request);
      return new Response(JSON.stringify({ results: [{ title: "upstream" }] }), {
        status: 201,
        headers: { "content-type": "application/json", "x-upstream": "kept" },
      });
    });

    const response = await search(server, { authorization: `Bearer ${API_KEY}`, "x-request-note": "kept" }, {
      query: "hola",
      domains: ["example.com"],
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream")).toBe("kept");
    expect(await response.json()).toEqual({ results: [{ title: "upstream" }] });

    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.method).toBe("POST");
    // The native Codex backend, not a WebChat model route.
    expect(new URL(forwarded.url).origin + new URL(forwarded.url).pathname)
      .toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    // End-to-end headers survive; hop-by-hop headers are not asserted here, the passthrough owns them.
    expect(forwarded.headers.get("x-request-note")).toBe("kept");
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(await forwarded.clone().text())).toEqual({ query: "hola", domains: ["example.com"] });
  });

  test("the native seam still requires the incoming Bearer authorization", async () => {
    const server = serve(async () => new Response("{}", { status: 200 }));
    // `x-api-key` admits the caller to the public surface but is not forwarded as a Bearer token, so
    // the native passthrough fails closed with its own typed upstream error instead of inventing one.
    const response = await search(server, { "x-api-key": API_KEY });
    expect(response.status).toBe(502);
    const body = await response.json() as { error?: { code?: string; type?: string; message?: string } };
    expect(body.error?.code).toBe("upstream_server_error");
    expect(body.error?.type).toBe("server_error");
    expect(body.error?.message).toContain("Bearer");
  });

  test("draining refuses it like every other public route", async () => {
    const server = serve(async () => new Response("{}", { status: 200 }));
    const drained = await fetch(url(server, "/admin/drain"), {
      method: "POST",
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    expect(drained.status).toBe(200);

    const refused = await search(server, { authorization: `Bearer ${API_KEY}` });
    expect(refused.status).toBe(503);
    const body = await refused.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBeTruthy();
    expect(body.error?.message).toContain("draining");
  });
});
