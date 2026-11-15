/**
 * Issue #356 — endpoint profiles with chat visibility.
 *
 * The operator wants two API endpoints from the service's own web surface: one that answers in
 * ChatGPT's hidden Temporary Chats (for Hindsight) and one in normal visible chats. `chatVisibility`
 * (issue #355) is a single global fact today, so this suite pins the host-owned view that turns it
 * into per-endpoint behaviour:
 *
 * - a profile binds a public path (`/p/<name>/v1`), a visibility mode, an optional catalogue-model
 *   allow-list and an optional concurrency budget;
 * - it selects among the **existing** catalogue models and routes — it never becomes a second
 *   provider registry, retry authority or execution engine;
 * - it is persisted in the configuration file and takes effect on the next turn without a restart;
 * - an unhonourable profile (unknown model, unsupported mode) fails closed with a typed refusal, and
 *   a deleted profile's path answers a typed 404 — never a silent fallback to the default endpoint;
 * - the management surface lives behind the control token, the page itself stays anonymous by design,
 *   and no secret appears in a page, URL or log.
 *
 * The end-to-end cases drive the real listener with only the provider adapter simulated, so the
 * visibility a profile produces is observed on the exact provider configuration the ingress handed to
 * the execution seam — not by re-implementing the decision in the test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  providerConfig,
  saveConfig,
  validateEndpointProfiles,
  type AppConfig,
  type EndpointProfile,
} from "../src/config";
import { effectiveChatGptWebProviderConfig } from "../src/chatgpt-web-provider-config";
import { publicModelRouteIds } from "../src/model-catalog";
import { startServer, type RunningServer } from "../src/server";
import {
  ENDPOINT_PROFILE_CONCURRENCY_EXCEEDED_CODE,
  ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE,
  ENDPOINT_PROFILE_NOT_FOUND_CODE,
  ENDPOINT_PROFILE_ROUTE_NOT_FOUND_CODE,
  ENDPOINT_PROFILE_UNAVAILABLE_CODE,
  applyEndpointProfile,
  endpointProfileBasePath,
  endpointProfileModelRefusal,
  matchEndpointProfilePath,
  resolveEndpointProfileRequest,
} from "../src/web-chat/host/endpoint-profiles";
import {
  WEB_CHAT_ENDPOINT_PROFILES_PAGE_HTML,
} from "../src/web-chat/host/endpoint-profiles-page";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "issue-356-endpoint-profiles-control-token-0123456789";
const API_KEY = "issue-356-endpoint-profiles-api-key-0123456789";
const ACCOUNT_FINGERPRINT = "issue-356-account";

let home: string;
let savedHome: SavedChatGptWebHome;
let previousApiKey: string | undefined;
const running: RunningServer[] = [];

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-356-endpoint-profiles-", { clearFreeHome: true });
});

afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    ...overrides,
  };
}

/**
 * A configuration that can be **persisted and loaded back**.
 *
 * `port: 0` asks the listener for an ephemeral port and is not a value the loader accepts, so a
 * fixture that is written to `config.json` and read through `loadConfig` states a real port.
 */
function persistedConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return config({ port: 17_841, ...overrides });
}

function serve(value: AppConfig, dependencies: Parameters<typeof startServer>[1] = {}): RunningServer {
  const server = startServer(value, dependencies);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;
const controlHeaders = { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" };

/** A profile fixture; the visibility is the only field every test states. */
function profile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return { name: "hindsight", chatVisibility: "temporary", ...overrides };
}

/** A page stand-in for the adapter seam: it records the provider facts it was handed. */
function capturingAdapterFactory(): {
  readonly seen: CodexProviderConfig[];
  readonly factory: (provider: CodexProviderConfig) => ProviderAdapter;
} {
  const seen: CodexProviderConfig[] = [];
  return {
    seen,
    factory: (provider: CodexProviderConfig): ProviderAdapter => {
      seen.push(provider);
      return {
        name: "issue-356-stub",
        runTurn: async (
          _parsed: CodexParsedRequest,
          _incoming: unknown,
          emit: (event: AdapterEvent) => void,
        ) => {
          emit({ type: "text_delta", text: "hola", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      };
    },
  };
}

async function postJson(
  server: RunningServer,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url(server, path), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function errorBody(response: Response): Promise<{ message: string; type: string; code: string }> {
  const payload = await response.json() as { error: { message: string; type: string; code: string } };
  return payload.error;
}

/** Poll the listener until a condition holds, so a blocked turn is observed without a fixed sleep. */
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached before the timeout");
}

// ---------------------------------------------------------------------------------------------
// The persisted shape: one owner, validated by the configuration module.
// ---------------------------------------------------------------------------------------------

describe("issue #356 — the endpoint-profile shape is validated by the configuration owner", () => {
  test("a valid set is normalized and the defaults it omits stay absent", () => {
    const profiles = validateEndpointProfiles([
      { name: "hindsight", chatVisibility: "temporary" },
      { name: "normal-chat", chatVisibility: "persistent", models: ["chatgpt-web/luna"], maxConcurrentTurns: 2 },
    ], "config.json");
    expect(profiles).toEqual([
      { name: "hindsight", chatVisibility: "temporary" },
      { name: "normal-chat", chatVisibility: "persistent", models: ["chatgpt-web/luna"], maxConcurrentTurns: 2 },
    ]);
    // A configuration that never authored a profile keeps exactly the surface it had.
    expect(defaultConfig()).not.toHaveProperty("endpointProfiles");
  });

  test("every malformed profile is refused with its location, never silently ignored", () => {
    const rejected: Array<{ value: unknown; message: RegExp }> = [
      { value: {}, message: /Invalid endpointProfiles in config\.json/ },
      { value: [null], message: /Invalid endpoint profile in config\.json \(endpointProfiles\[0\]\)/ },
      { value: [{ name: "Hindsight", chatVisibility: "temporary" }], message: /Invalid endpoint profile name/ },
      { value: [{ name: "-hindsight", chatVisibility: "temporary" }], message: /Invalid endpoint profile name/ },
      { value: [{ name: "a".repeat(33), chatVisibility: "temporary" }], message: /Invalid endpoint profile name/ },
      { value: [{ name: "hindsight", chatVisibility: "hidden" }], message: /Invalid chatVisibility/ },
      { value: [{ name: "hindsight" }], message: /Invalid chatVisibility/ },
      { value: [{ name: "hindsight", chatVisibility: "temporary", extra: true }], message: /Unknown endpoint profile key extra/ },
      { value: [{ name: "hindsight", chatVisibility: "temporary", models: [] }], message: /Invalid endpoint profile models/ },
      { value: [{ name: "hindsight", chatVisibility: "temporary", models: ["chatgpt-web/luna", "chatgpt-web/luna"] }], message: /Duplicate endpoint profile model/ },
      { value: [{ name: "hindsight", chatVisibility: "temporary", maxConcurrentTurns: 0 }], message: /Invalid endpoint profile maxConcurrentTurns/ },
      { value: [{ name: "hindsight", chatVisibility: "temporary", maxConcurrentTurns: 1.5 }], message: /Invalid endpoint profile maxConcurrentTurns/ },
      {
        value: [
          { name: "hindsight", chatVisibility: "temporary" },
          { name: "hindsight", chatVisibility: "persistent" },
        ],
        message: /Duplicate endpoint profile name "hindsight"/,
      },
    ];
    for (const { value, message } of rejected) {
      expect(() => validateEndpointProfiles(value, "config.json")).toThrow(message);
    }
  });

  test("profiles are persisted in the configuration file and survive a reload", () => {
    saveConfig(persistedConfig({ endpointProfiles: [profile()] }));
    const loaded = loadConfig();
    expect(loaded.endpointProfiles).toEqual([profile()]);
    // The same document is what the file states: the format is the operator's to edit.
    const document = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { endpointProfiles?: unknown };
    expect(document.endpointProfiles).toEqual([profile()]);
  });

  test("a temporary profile on the launcher host is refused at load, naming the profile", () => {
    // A launcher deployment is a full-mode Zero Risk configuration, so the fixture states one; the
    // profile is the only incoherent part.
    const tunnel = {
      binaryPath: "/usr/local/bin/tunnel",
      tunnelId: `tunnel_${"a".repeat(32)}`,
      runtimeKeyFile: "/tmp/runtime-key.json",
      profileDir: "/tmp/tunnel-profile",
      profileName: "default",
      alias: "zero-risk",
    };
    saveConfig(persistedConfig({
      mode: "full",
      appName: "Codex Zero Risk",
      browserHost: "launcher",
      browserInteractionMode: "manual",
      browserHostDescriptorPath: "/tmp/browser-host.json",
      tunnel,
      endpointProfiles: [profile()],
    }));
    expect(() => loadConfig()).toThrow(
      /Temporary chat visibility requires the managed-chrome browser host in .*endpointProfiles\["hindsight"\]/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The host view: resolution, the request-scoped configuration and the typed refusals.
// ---------------------------------------------------------------------------------------------

describe("issue #356 — a profile is a view over the catalogue, never a second registry", () => {
  test("the public path is a prefix an OpenAI-compatible base URL can point at", () => {
    expect(endpointProfileBasePath("hindsight")).toBe("/p/hindsight/v1");
    expect(matchEndpointProfilePath("/p/hindsight/v1/chat/completions"))
      .toEqual({ name: "hindsight", path: "/v1/chat/completions" });
    expect(matchEndpointProfilePath("/p/hindsight/v1/models")).toEqual({ name: "hindsight", path: "/v1/models" });
    expect(matchEndpointProfilePath("/p/hindsight")).toEqual({ name: "hindsight", path: "" });
    // A path outside the prefix is the default endpoint's business and must not be touched.
    expect(matchEndpointProfilePath("/v1/models")).toBeUndefined();
    expect(matchEndpointProfilePath("/healthz")).toBeUndefined();
    expect(matchEndpointProfilePath("/p/")).toBeUndefined();
  });

  test("the resolution refuses an unknown profile, an unsupported path and an unhonourable profile", () => {
    const live = config({ endpointProfiles: [profile()] });

    const unknown = resolveEndpointProfileRequest(live, { name: "gone", path: "/v1/models" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe(ENDPOINT_PROFILE_NOT_FOUND_CODE);

    const unsupported = resolveEndpointProfileRequest(live, { name: "hindsight", path: "/v1/responses/compact" });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) throw new Error("unreachable");
    expect(unsupported.status).toBe(404);
    expect(unsupported.code).toBe(ENDPOINT_PROFILE_ROUTE_NOT_FOUND_CODE);

    const valid = resolveEndpointProfileRequest(live, { name: "hindsight", path: "/v1/chat/completions" });
    expect(valid).toEqual({ ok: true, profile: profile(), path: "/v1/chat/completions" });

    // A hand-edited profile that names a model the service no longer serves fails closed.
    const broken = config({ endpointProfiles: [profile({ models: ["chatgpt-web/gone"] })] });
    const unavailable = resolveEndpointProfileRequest(broken, { name: "hindsight", path: "/v1/models" });
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) throw new Error("unreachable");
    expect(unavailable.status).toBe(409);
    expect(unavailable.code).toBe(ENDPOINT_PROFILE_UNAVAILABLE_CODE);
    expect(unavailable.message).toContain("chatgpt-web/gone");
  });

  test("the request-scoped configuration carries the profile's visibility and never mutates the host one", () => {
    const live = config({
      chatVisibility: "persistent",
      // A provider-scoped pin must not silently defeat the profile's explicit statement.
      webChat: { providers: { "chatgpt-web": { chatVisibility: "persistent" } } },
    });
    const scoped = applyEndpointProfile(live, profile());
    expect(scoped.chatVisibility).toBe("temporary");
    expect(effectiveChatGptWebProviderConfig(scoped).chatgptWeb?.chatVisibility).toBe("temporary");
    // The default endpoint keeps the configured behaviour byte-for-byte.
    expect(live.chatVisibility).toBe("persistent");
    expect(effectiveChatGptWebProviderConfig(live).chatgptWeb?.chatVisibility).toBe("persistent");
    expect(providerConfig(live).chatgptWeb?.chatVisibility).toBe("persistent");

    // A persistent profile overrides a temporary flat fact for its own endpoint only.
    const hiddenDefault = config({ chatVisibility: "temporary" });
    const visible = applyEndpointProfile(hiddenDefault, profile({ name: "normal-chat", chatVisibility: "persistent" }));
    expect(effectiveChatGptWebProviderConfig(visible).chatgptWeb?.chatVisibility).toBe("persistent");
    expect(effectiveChatGptWebProviderConfig(hiddenDefault).chatgptWeb?.chatVisibility).toBe("temporary");
  });

  test("the model refusal keeps a profile inside the catalogue and inside its visibility mode", () => {
    const live = config({ endpointProfiles: [profile({ models: ["chatgpt-web/luna"] })] });
    expect(endpointProfileModelRefusal(live, profile({ models: ["chatgpt-web/luna"] }), "chatgpt-web/luna")).toBeUndefined();

    const notAllowed = endpointProfileModelRefusal(
      live,
      profile({ models: ["chatgpt-web/luna"] }),
      "chatgpt-web/think",
    );
    expect(notAllowed?.status).toBe(400);
    expect(notAllowed?.code).toBe(ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE);

    // Without an allow-list every catalogue model is served, but a native Codex model is not.
    const openProfile = profile({ name: "open", chatVisibility: "persistent" });
    expect(endpointProfileModelRefusal(live, openProfile, "deepseek-web/default")).toBeUndefined();
    expect(endpointProfileModelRefusal(live, openProfile, "gpt-5.6-codex")?.code)
      .toBe(ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE);

    // A temporary profile can only be honoured by a ChatGPT Web route (issue #355's fact).
    const temporaryRefusal = endpointProfileModelRefusal(live, profile(), "deepseek-web/default");
    expect(temporaryRefusal?.status).toBe(409);
    expect(temporaryRefusal?.code).toBe(ENDPOINT_PROFILE_UNAVAILABLE_CODE);
    expect(temporaryRefusal?.message).toContain("temporary chat visibility");
  });
});

// ---------------------------------------------------------------------------------------------
// The real listener: a temporary profile and the default endpoint side by side.
// ---------------------------------------------------------------------------------------------

describe("issue #356 — a temporary profile runs temporary while the default endpoint stays persistent", () => {
  test("the ingress hands the adapter the profile's visibility fact, per endpoint", async () => {
    const live = config({
      endpointProfiles: [
        profile({ models: ["chatgpt-web/luna"] }),
        profile({ name: "normal-chat", chatVisibility: "persistent" }),
      ],
    });
    const capture = capturingAdapterFactory();
    const server = serve(live, { adapterFactory: capture.factory });

    const hidden = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(hidden.status).toBe(200);
    expect(capture.seen).toHaveLength(1);
    expect(capture.seen[0]?.chatgptWeb?.chatVisibility).toBe("temporary");

    const visible = await postJson(server, "/p/normal-chat/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(visible.status).toBe(200);
    expect(capture.seen).toHaveLength(2);
    expect(capture.seen[1]?.chatgptWeb?.chatVisibility).toBe("persistent");

    // The default endpoint is untouched: it keeps the configured (absent) fact.
    const defaultEndpoint = await postJson(server, "/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(defaultEndpoint.status).toBe(200);
    expect(capture.seen).toHaveLength(3);
    expect(capture.seen[2]?.chatgptWeb?.chatVisibility).toBeUndefined();

    // The Responses contract is served through the same profile view.
    const responses = await postJson(server, "/p/hindsight/v1/responses", {
      model: "chatgpt-web/luna",
      input: "hola",
      stream: false,
    });
    expect(responses.status).toBe(200);
    expect(capture.seen[3]?.chatgptWeb?.chatVisibility).toBe("temporary");
  });

  test("the profile's /v1/models advertises exactly what it serves", async () => {
    const live = config({
      endpointProfiles: [
        profile({ models: ["chatgpt-web/luna"] }),
        profile({ name: "open", chatVisibility: "persistent" }),
      ],
    });
    const server = serve(live);

    const profileModels = await fetch(url(server, "/p/hindsight/v1/models"));
    expect(profileModels.status).toBe(200);
    const profileCatalog = await profileModels.json() as {
      models: Array<{ slug: string }>;
      data: Array<{ id: string }>;
    };
    expect(profileCatalog.models.map(row => row.slug)).toEqual(["chatgpt-web/luna"]);
    expect(profileCatalog.data.map(row => row.id)).toEqual(["chatgpt-web/luna"]);

    // A profile that states no allow-list serves the whole Web catalogue — never the native Codex
    // catalogue a profile cannot route.
    const openModels = await fetch(url(server, "/p/open/v1/models"));
    expect(openModels.status).toBe(200);
    const openCatalog = await openModels.json() as {
      models: Array<{ slug: string }>;
      data: Array<{ id: string }>;
    };
    expect(openCatalog.models.map(row => row.slug)).toEqual([...publicModelRouteIds(live)]);
    expect(openCatalog.data.map(row => row.id)).toEqual([...publicModelRouteIds(live)]);

    // The default catalogue is unchanged: every route the deployment serves.
    const defaultModels = await fetch(url(server, "/v1/models"));
    const defaultCatalog = await defaultModels.json() as { models: Array<{ slug: string }> };
    expect(defaultCatalog.models.map(row => row.slug)).toEqual([...publicModelRouteIds(live)]);
  });

  test("a disallowed model, an unknown profile and an unsupported path are typed refusals, not fallbacks", async () => {
    const live = config({
      endpointProfiles: [
        profile({ models: ["chatgpt-web/luna"] }),
        // No allow-list: every catalogue model is selectable, but the temporary mode still only
        // applies to the ChatGPT Web routes.
        profile({ name: "open-hidden" }),
      ],
    });
    const capture = capturingAdapterFactory();
    const server = serve(live, { adapterFactory: capture.factory });

    const disallowed = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/think",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(disallowed.status).toBe(400);
    expect((await errorBody(disallowed)).code).toBe(ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE);

    // A temporary profile cannot honour a route whose provider has no Temporary Chat surface.
    const unsupportedMode = await postJson(server, "/p/open-hidden/v1/chat/completions", {
      model: "deepseek-web/default",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(unsupportedMode.status).toBe(409);
    expect((await errorBody(unsupportedMode)).code).toBe(ENDPOINT_PROFILE_UNAVAILABLE_CODE);

    // A profile never forwards to the native Codex passthrough.
    const native = await postJson(server, "/p/hindsight/v1/responses", {
      model: "gpt-5.6-codex",
      input: "hola",
    });
    expect(native.status).toBe(400);
    expect((await errorBody(native)).code).toBe(ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE);

    const unknown = await fetch(url(server, "/p/deleted/v1/models"));
    expect(unknown.status).toBe(404);
    expect((await errorBody(unknown)).code).toBe(ENDPOINT_PROFILE_NOT_FOUND_CODE);

    const unsupportedPath = await fetch(url(server, "/p/hindsight/v1/responses/compact"), { method: "POST" });
    expect(unsupportedPath.status).toBe(404);
    expect((await errorBody(unsupportedPath)).code).toBe(ENDPOINT_PROFILE_ROUTE_NOT_FOUND_CODE);

    // None of the refusals started a turn.
    expect(capture.seen).toHaveLength(0);
  });

  test("a hand-edited profile with an unknown model fails closed on its path", async () => {
    const live = config({ endpointProfiles: [profile({ models: ["chatgpt-web/gone"] })] });
    const server = serve(live);
    const response = await fetch(url(server, "/p/hindsight/v1/models"));
    expect(response.status).toBe(409);
    const body = await errorBody(response);
    expect(body.code).toBe(ENDPOINT_PROFILE_UNAVAILABLE_CODE);
    expect(body.message).toContain("chatgpt-web/gone");
  });
});

// ---------------------------------------------------------------------------------------------
// Persistence and live reload: the same pattern as `tuning`.
// ---------------------------------------------------------------------------------------------

describe("issue #356 — profiles persist and take effect on the next turn without a restart", () => {
  test("create, edit live, restart, delete and restart again", async () => {
    saveConfig(persistedConfig());
    const capture = capturingAdapterFactory();
    let live = loadConfig();
    let server = serve(live, { adapterFactory: capture.factory });

    // Create through the management surface.
    const created = await postJson(server, "/v1/control/endpoint-profiles", profile(), controlHeaders);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { status: string; profile: { path: string; chatVisibility: string } };
    expect(createdBody.status).toBe("ok");
    expect(createdBody.profile).toMatchObject({ path: "/p/hindsight/v1", chatVisibility: "temporary" });
    // Persisted: the document the next process loads states the profile.
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).endpointProfiles).toEqual([profile()]);
    // In memory: the very next turn is served by the profile without a restart.
    expect(live.endpointProfiles).toEqual([profile()]);

    const turn = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(turn.status).toBe(200);
    expect(capture.seen.at(-1)?.chatgptWeb?.chatVisibility).toBe("temporary");

    // Edit it live: the same path now resolves the new visibility on the next turn.
    const edited = await fetch(url(server, "/v1/control/endpoint-profiles/hindsight"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ chatVisibility: "persistent" }),
    });
    expect(edited.status).toBe(200);
    const editedTurn = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(editedTurn.status).toBe(200);
    expect(capture.seen.at(-1)?.chatgptWeb?.chatVisibility).toBe("persistent");

    // Restart: the profile is read back from the configuration file.
    await server.stop(true);
    running.pop();
    live = loadConfig();
    expect(live.endpointProfiles).toEqual([profile({ chatVisibility: "persistent" })]);
    server = serve(live, { adapterFactory: capture.factory });
    const afterRestart = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(afterRestart.status).toBe(200);
    expect(capture.seen.at(-1)?.chatgptWeb?.chatVisibility).toBe("persistent");

    // Delete it: the path answers a typed 404 immediately, never the default endpoint's behaviour.
    const deleted = await fetch(url(server, "/v1/control/endpoint-profiles/hindsight"), {
      method: "DELETE",
      headers: controlHeaders,
    });
    expect(deleted.status).toBe(200);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).endpointProfiles).toEqual([]);
    const gone = await fetch(url(server, "/p/hindsight/v1/models"));
    expect(gone.status).toBe(404);
    expect((await errorBody(gone)).code).toBe(ENDPOINT_PROFILE_NOT_FOUND_CODE);

    // And it stays gone across a restart: a deleted profile never comes back as a fallback.
    await server.stop(true);
    running.pop();
    const reloaded = loadConfig();
    expect(reloaded.endpointProfiles).toEqual([]);
    server = serve(reloaded);
    expect((await fetch(url(server, "/p/hindsight/v1/models"))).status).toBe(404);
  });

  test("PUT /v1/control/config writes the profile set with the same validation and live effect", async () => {
    saveConfig(persistedConfig());
    const live = loadConfig();
    const capture = capturingAdapterFactory();
    const server = serve(live, { adapterFactory: capture.factory });

    const written = await fetch(url(server, "/v1/control/config"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ endpointProfiles: [profile()] }),
    });
    expect(written.status).toBe(200);
    const body = await written.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.endpointProfiles).toEqual([{
      name: "hindsight",
      path: "/p/hindsight/v1",
      chatVisibility: "temporary",
      models: null,
      maxConcurrentTurns: null,
    }]);
    expect(live.endpointProfiles).toEqual([profile()]);
    expect(loadConfig().endpointProfiles).toEqual([profile()]);

    const turn = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "hola" }],
    });
    expect(turn.status).toBe(200);
    expect(capture.seen.at(-1)?.chatgptWeb?.chatVisibility).toBe("temporary");

    // The same owner refuses an unknown model before anything is written.
    const refused = await fetch(url(server, "/v1/control/config"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ endpointProfiles: [profile({ models: ["chatgpt-web/gone"] })] }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toContain("Unknown model");
    expect(live.endpointProfiles).toEqual([profile()]);
  });

  test("a profile's concurrency budget refuses the turn that would exceed it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapterFactory = (): ProviderAdapter => ({
      name: "issue-356-blocking",
      runTurn: async (
        _parsed: CodexParsedRequest,
        _incoming: unknown,
        emit: (event: AdapterEvent) => void,
      ) => {
        await gate;
        emit({ type: "text_delta", text: "hola", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    });
    const live = config({
      endpointProfiles: [profile({ maxConcurrentTurns: 1 })],
    });
    const server = serve(live, { adapterFactory });

    const first = postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "primero" }],
    });
    await waitFor(async () => {
      const health = await fetch(url(server, "/healthz"));
      const body = await health.json() as { active_http_turns: number };
      return body.active_http_turns === 1;
    });

    const refused = await postJson(server, "/p/hindsight/v1/chat/completions", {
      model: "chatgpt-web/luna",
      messages: [{ role: "user", content: "segundo" }],
    });
    expect(refused.status).toBe(429);
    expect((await errorBody(refused)).code).toBe(ENDPOINT_PROFILE_CONCURRENCY_EXCEEDED_CODE);

    // The default endpoint is not governed by the profile's budget.
    release();
    expect((await first).status).toBe(200);
    await waitFor(async () => {
      const health = await fetch(url(server, "/healthz"));
      const body = await health.json() as { active_http_turns: number };
      return body.active_http_turns === 0;
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The management surface: control-token authority, the anonymous page and the API-key guard.
// ---------------------------------------------------------------------------------------------

describe("issue #356 — the management surface keeps the control-token authority boundary", () => {
  test("every data-carrying profile endpoint is control-token only", async () => {
    const server = serve(config());
    const routes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/v1/control/endpoint-profiles" },
      { method: "POST", path: "/v1/control/endpoint-profiles", body: profile() },
      { method: "PUT", path: "/v1/control/endpoint-profiles/hindsight", body: profile() },
      { method: "DELETE", path: "/v1/control/endpoint-profiles/hindsight" },
    ];
    const credentialVariants: Array<Record<string, string>> = [
      {},
      { authorization: `Bearer ${API_KEY}` },
      { authorization: "Bearer wrong-token-000000000000" },
    ];
    for (const route of routes) {
      for (const headers of credentialVariants) {
        const response = await fetch(url(server, route.path), {
          method: route.method,
          headers: { "content-type": "application/json", ...headers },
          ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        });
        expect(response.status, `${route.method} ${route.path} with ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    // The control token reaches the handler (an empty profile set is a 200).
    const authorized = await fetch(url(server, "/v1/control/endpoint-profiles"), { headers: controlHeaders });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      profiles: [],
      credential: { scheme: "api-key", required: false, header: "Authorization: Bearer <api key>" },
    });
  });

  test("the page is anonymous by design, carries no data and no secret, and points at the API", async () => {
    const server = serve(config());
    const root = await fetch(url(server, "/v1/control/endpoints/"));
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html; charset=utf-8");
    const html = await root.text();
    expect(html).toBe(WEB_CHAT_ENDPOINT_PROFILES_PAGE_HTML);
    const explicit = await fetch(url(server, "/v1/control/endpoints/index.html"));
    expect(await explicit.text()).toBe(html);
    // Offline-safe and leak-free by construction: no absolute URL, no baked-in token or key.
    expect(/https?:\/\//.test(html)).toBe(false);
    expect(html).toContain("sessionStorage");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain(CONTROL_TOKEN);
    expect(html).not.toContain(API_KEY);
    expect(html).toContain("../endpoint-profiles");
    // The sign-in page links here, and this page links back.
    const authPage = await (await fetch(url(server, "/v1/control/auth/"))).text();
    expect(authPage).toContain("../endpoints/");
    expect(html).toContain("../auth/");
  });

  test("creating, editing and deleting is validated at the management boundary", async () => {
    // The management surface persists into the configuration file, so the deployment has one: `serve`
    // always starts from a loaded document in production.
    saveConfig(persistedConfig());
    const server = serve(loadConfig());

    const created = await postJson(server, "/v1/control/endpoint-profiles", {
      name: "hindsight",
      chatVisibility: "temporary",
      models: ["chatgpt-web/luna"],
      maxConcurrentTurns: 2,
    }, controlHeaders);
    expect(created.status).toBe(201);

    const duplicate = await postJson(server, "/v1/control/endpoint-profiles", profile(), controlHeaders);
    expect(duplicate.status).toBe(409);

    const unknownModel = await postJson(server, "/v1/control/endpoint-profiles", {
      name: "broken",
      chatVisibility: "persistent",
      models: ["chatgpt-web/gone"],
    }, controlHeaders);
    expect(unknownModel.status).toBe(400);
    expect((await unknownModel.json() as { error: string }).error).toContain("Unknown model");

    const badVisibility = await postJson(server, "/v1/control/endpoint-profiles", {
      name: "broken",
      chatVisibility: "hidden",
    }, controlHeaders);
    expect(badVisibility.status).toBe(400);
    expect((await badVisibility.json() as { error: string }).error).toContain("Invalid chatVisibility");

    const unknownUpdate = await fetch(url(server, "/v1/control/endpoint-profiles/gone"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ chatVisibility: "persistent" }),
    });
    expect(unknownUpdate.status).toBe(404);

    const rename = await fetch(url(server, "/v1/control/endpoint-profiles/hindsight"), {
      method: "PUT",
      headers: controlHeaders,
      body: JSON.stringify({ name: "renamed", chatVisibility: "persistent" }),
    });
    expect(rename.status).toBe(400);

    // The list view reports the resulting base path and the credential that guards it.
    const listed = await fetch(url(server, "/v1/control/endpoint-profiles"), { headers: controlHeaders });
    const expectedView = {
      name: "hindsight",
      path: "/p/hindsight/v1",
      chatVisibility: "temporary",
      models: ["chatgpt-web/luna"],
      maxConcurrentTurns: 2,
    };
    expect(await listed.json()).toEqual({
      profiles: [expectedView],
      credential: { scheme: "api-key", required: false, header: "Authorization: Bearer <api key>" },
    });
    // The same view is readable through the general configuration endpoint.
    const configView = await fetch(url(server, "/v1/control/config"), { headers: controlHeaders });
    expect((await configView.json() as { endpointProfiles: unknown }).endpointProfiles).toEqual([expectedView]);

    const deleted = await fetch(url(server, "/v1/control/endpoint-profiles/hindsight"), {
      method: "DELETE",
      headers: controlHeaders,
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json())).toEqual({ status: "ok", name: "hindsight" });
    const gone = await fetch(url(server, "/v1/control/endpoint-profiles/hindsight"), {
      method: "DELETE",
      headers: controlHeaders,
    });
    expect(gone.status).toBe(404);
  });

  test("an in-process listener with no configuration file still persists the profile set", async () => {
    // `serve` always starts from a loaded document in production; an in-process harness may not. The
    // write then creates the only document there is, exactly like `PUT /v1/control/config`.
    const server = serve(config());
    const created = await postJson(server, "/v1/control/endpoint-profiles", profile(), controlHeaders);
    expect(created.status).toBe(201);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).endpointProfiles).toEqual([profile()]);
  });

  test("the profile endpoints are guarded by the global API key, never by the control token", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const live = config({ endpointProfiles: [profile()] });
    const server = serve(live);

    expect((await fetch(url(server, "/p/hindsight/v1/models"))).status).toBe(401);
    expect((await fetch(url(server, "/p/hindsight/v1/models"), {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })).status).toBe(401);
    expect((await fetch(url(server, "/p/hindsight/v1/models"), {
      headers: { authorization: `Bearer ${API_KEY}` },
    })).status).toBe(200);
    // The management surface still refuses the API key.
    expect((await fetch(url(server, "/v1/control/endpoint-profiles"), {
      headers: { authorization: `Bearer ${API_KEY}` },
    })).status).toBe(401);
    // The credential view reports the required scheme without a value.
    const listed = await fetch(url(server, "/v1/control/endpoint-profiles"), { headers: controlHeaders });
    const body = await listed.json() as { credential: { required: boolean; header: string } };
    expect(body.credential.required).toBe(true);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });
});
