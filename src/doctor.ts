import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, isLoopbackHost, loadConfig, resolveApiKey } from "./config";
import { join } from "node:path";
import { createChatGptWebDriver } from "./adapters/chatgpt-web/chatgpt-driver";
import { createQwenCodeDriver } from "./adapters/qwen-code/driver";
import { createMemoryQwenCodeConversationState } from "./adapters/qwen-code/chat-state";
import {
  qwenCodeCatalogueVisible,
  resolveQwenCodeProviderConfig,
} from "./adapters/qwen-code/provider-config";
import { createQwenChatDriver } from "./adapters/qwen-chat/driver";
import { createMemoryQwenChatConversationState } from "./adapters/qwen-chat/chat-state";
import {
  qwenChatCatalogueVisible,
  resolveQwenChatProviderConfig,
} from "./adapters/qwen-chat/provider-config";
import { createDeepSeekDriver } from "./adapters/deepseek-web/driver";
import { createMemoryDeepSeekConversationState } from "./adapters/deepseek-web/chat-state";
import {
  deepSeekCatalogueVisible,
  resolveDeepSeekProviderConfig,
} from "./adapters/deepseek-web/provider-config";
import { effectiveChatGptWebProviderConfig } from "./chatgpt-web-provider-config";
import { safeErrorDescriptor } from "./lib/safe-diagnostics";
import {
  inspectWebChatProvider,
  webChatDoctorCheck,
} from "./web-chat/host/provider-host";
import type { WebChatProviderDriver } from "./web-chat/core";
import { inspectCodexIntegration } from "./codex-integration";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import {
  inspectLauncherBrowserHost,
  inspectLauncherBrowserHostLiveness,
  readLauncherBrowserHostDescriptor,
} from "./launcher-browser-host";
import { processRunning } from "./process";

/**
 * The outcome of one doctor check.
 *
 * `skipped` is not a failure: it says the check had nothing it could prove on this deployment — the
 * structured-output probe (issue #357) is skipped when the deployment has no API key to
 * authenticate with or the service is not listening, and an absent service must never fail a doctor
 * run. It is therefore counted like `ok` by {@link runDoctor}, and it never prints a repair command.
 */
export type CheckStatus = "ok" | "warning" | "error" | "skipped";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

function launcherOwnershipError(config: AppConfig, health: Record<string, unknown>): string | undefined {
  if (config.browserHost !== "launcher") return undefined;
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return `Launcher runtime ownership marker is missing: ${path}`;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `Launcher runtime ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (state.version !== 1
    || !Number.isInteger(state.ownerPid)
    || (state.ownerPid as number) < 1
    || !Number.isInteger(state.daemonPid)
    || (state.daemonPid as number) < 1
    || state.status !== "ready") {
    return "Launcher runtime ownership marker is incomplete or not ready";
  }
  if (!processRunning(state.ownerPid)) {
    return `Launcher owner process is not running (pid ${String(state.ownerPid)})`;
  }
  if (health.pid !== state.daemonPid) {
    return `Responses proxy pid ${String(health.pid)} does not match launcher-owned pid ${String(state.daemonPid)}`;
  }
  return undefined;
}

/**
 * The WebChat providers this deployment composes for diagnostics.
 *
 * The doctor resolves the same effective provider configuration the runtime uses, so what it reports
 * is what a turn would actually see. A provider whose driver cannot be composed at all is reported as
 * an error by {@link webChatProviderChecks} instead of being omitted from the report.
 */
export function webChatDoctorDrivers(config: AppConfig): readonly WebChatProviderDriver[] {
  const drivers: WebChatProviderDriver[] = [
    createChatGptWebDriver({ provider: effectiveChatGptWebProviderConfig(config) }),
  ];
  // A second provider is reported once this deployment can serve it: a configured provider block or
  // a verified session (issue #299, slice 2). A ChatGPT-only deployment keeps exactly the report it
  // had, and a deployment that signed in to Qwen Code sees its account and models without editing
  // anything else. The driver is composed with no session page and no continuity file of its own:
  // `doctor` inspects, it never starts a browser.
  if (qwenCodeCatalogueVisible(config)) {
    drivers.push(createQwenCodeDriver({
      provider: resolveQwenCodeProviderConfig(config),
      state: createMemoryQwenCodeConversationState(),
    }));
  }
  // The Qwen Chat provider is inspected on the same terms: a configured block or a verified session.
  // `doctor` never starts a browser or touches the durable chat file; a memory state is enough for a
  // resolution-only inspection.
  if (qwenChatCatalogueVisible(config)) {
    drivers.push(createQwenChatDriver({
      provider: resolveQwenChatProviderConfig(config),
      state: createMemoryQwenChatConversationState(),
    }));
  }
  // DeepSeek Web is inspected only when it publishes a route (a configured model_type). A deployment
  // that merely stored a capture gets no check here, because `doctor` must not suggest that an
  // unverified capture is an account: the catalogue note and the service log say that instead (a
  // verified session is one the import's own predicate accepted — doc/deepseek-web.md §7).
  if (deepSeekCatalogueVisible(config)) {
    drivers.push(createDeepSeekDriver({
      provider: resolveDeepSeekProviderConfig(config),
      state: createMemoryDeepSeekConversationState(),
    }));
  }
  return drivers;
}

/**
 * One doctor check per WebChat provider: authentication, capabilities and health.
 *
 * The facts come from the driver through the host boundary, never from a credential: the account is
 * described by a shortened fingerprint, a driver that throws is reported unhealthy rather than
 * hidden, and a provider that is reachable but unauthenticated is a warning rather than an error.
 */
export async function webChatProviderChecks(
  drivers: readonly WebChatProviderDriver[],
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const driver of drivers) {
    const check = webChatDoctorCheck(await inspectWebChatProvider(driver));
    checks.push({
      id: `webchat-${check.providerId}`,
      status: check.status,
      message: check.status === "ok"
        ? `WebChat provider "${check.providerId}" is authenticated and healthy`
        : check.status === "warning"
          ? `WebChat provider "${check.providerId}" is reachable but not authenticated: no sign-in has `
            + "been recorded, so no account identity could be verified. Record one at the operator "
            + "sign-in surface /v1/control/auth/ (the running service picks it up on the next turn, no restart)"
          : `WebChat provider "${check.providerId}" is unhealthy`,
      detail: check.detail,
    });
  }
  return checks;
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if ((body.service !== "dsh-chatgpt-web" && body.service !== "codex-chatgpt-web") || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    if (body.accepting_turns !== true) {
      return {
        id: "proxy",
        status: "error",
        message: "Responses proxy is still drained and is not accepting Codex turns",
      };
    }
    const ownershipError = launcherOwnershipError(config, body);
    if (ownershipError) {
      return { id: "proxy", status: "error", message: "Responses proxy ownership could not be verified", detail: ownershipError };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The catalogue model the structured-output probe asks for (issue #357).
 *
 * `chatgpt-web/luna` is the route every account has; the Sol-only and Pro-gated routes would make the
 * probe fail on a deployment that is otherwise wired correctly. A caller that needs another route
 * passes `model` to {@link structuredOutputProbeCheck}.
 */
export const STRUCTURED_OUTPUT_PROBE_MODEL = "chatgpt-web/luna";

/**
 * The conversation identity the probe declares.
 *
 * A stable `user` keeps every probe on one provider conversation instead of creating a new one per
 * `doctor` run, and keeps the probe out of every caller's conversation. It is a public label, not a
 * credential.
 */
export const STRUCTURED_OUTPUT_PROBE_IDENTITY = "dsh-chatgpt-web-doctor";

/**
 * The JSON Schema the probe asks for.
 *
 * Deliberately tiny: the point is the *shape* of the request (a named, strict `json_schema` on
 * `response_format`, exactly the shape an OpenAI-compatible client sends when it asks for a schema),
 * not a long extraction.
 */
const STRUCTURED_OUTPUT_PROBE_SCHEMA = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
} as const;

/**
 * The request body the probe posts: a structured chat completion carrying a named, strict schema.
 *
 * Exported because the request shape *is* the contract this check proves — a test asserts it directly
 * instead of re-deriving it. It carries no credential: the API key travels in the `Authorization`
 * header, never in the body.
 *
 * @param model - the catalogue model id to ask for.
 * @returns the JSON body for `POST /v1/chat/completions`.
 */
export function structuredOutputProbeRequest(model: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: "You are the dsh-chatgpt-web connectivity probe." },
      { role: "user", content: 'Reply with exactly {"status":"ok"} and nothing else.' },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "dsh_doctor_probe", strict: true, schema: STRUCTURED_OUTPUT_PROBE_SCHEMA },
    },
    // The newer OpenAI alias for the output budget, small here because the answer is one short
    // object. This bridge forwards it and cannot enforce it (issue #354), which is exactly what the
    // check reports rather than hides.
    max_completion_tokens: 64,
    stream: false,
    user: STRUCTURED_OUTPUT_PROBE_IDENTITY,
  };
}

/** Where the probe's HTTP call goes and what it authenticates with. */
export interface StructuredOutputProbeOptions {
  /** The service's own base URL without the `/v1` suffix, e.g. `http://127.0.0.1:17841`. */
  readonly baseUrl: string;
  /** The API key the caller authenticates with; absent means none is configured. */
  readonly apiKey?: string;
  /** Why there is no usable key, when the deployment has one it cannot authenticate with. */
  readonly apiKeyProblem?: string;
  /** The catalogue model to ask for; defaults to {@link STRUCTURED_OUTPUT_PROBE_MODEL}. */
  readonly model?: string;
  /** Bound on the whole probe. A browser turn is slow, so the default is generous. */
  readonly timeoutMs?: number;
  /** Injected by tests; the real check uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const STRUCTURED_OUTPUT_PROBE_ID = "structured-output-probe";
const STRUCTURED_OUTPUT_PROBE_TIMEOUT_MS = 120_000;

function probeSkipped(reason: string): DoctorCheck {
  return {
    id: STRUCTURED_OUTPUT_PROBE_ID,
    status: "skipped",
    message: `structured-output probe skipped: ${reason}`,
  };
}

function elapsedLabel(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * The service's own `usage` block, described as the estimate it is.
 *
 * The bridge publishes an estimate, never a measurement (README.md §"The `usage` block is an
 * estimate"), so the label is part of the report rather than a footnote.
 */
function probeTokenEstimate(usage: unknown): string {
  const record = usage && typeof usage === "object" && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : undefined;
  const pick = (key: string): number | undefined => {
    const value = record?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const prompt = pick("prompt_tokens");
  const completion = pick("completion_tokens");
  const total = pick("total_tokens");
  if (prompt === undefined && completion === undefined && total === undefined) {
    return "token usage: the service returned no usage block, so none is estimated";
  }
  const parts = [
    ...(prompt === undefined ? [] : [`prompt ${prompt}`]),
    ...(completion === undefined ? [] : [`completion ${completion}`]),
    ...(total === undefined ? [] : [`total ${total}`]),
  ];
  return `token usage (estimate, not a measurement): ${parts.join(", ")}`;
}

/**
 * The refusal code a JSON error body carries, when it looks like a code.
 *
 * Deliberately narrow, and the caller additionally drops anything that contains the API key: the
 * report must never become a channel for a secret a misbehaving endpoint echoes back.
 */
function safeRefusalCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" && !Array.isArray(error)
    ? (error as Record<string, unknown>).code
    : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

interface ProbeAnswer {
  readonly content?: string;
  readonly errorCode?: string;
  readonly usage?: unknown;
}

/** What a `chat.completion` body actually said, without keeping any of its text. */
function probeAnswer(body: unknown): ProbeAnswer {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const choices = record.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>).message
    : undefined;
  const content = message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>).content
    : undefined;
  const errorCode = safeRefusalCode(record.error);
  return {
    ...(typeof content === "string" ? { content } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
    usage: record.usage,
  };
}

function isJsonValue(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function probeTimedOut(model: string, timeoutMs: number): DoctorCheck {
  return {
    id: STRUCTURED_OUTPUT_PROBE_ID,
    status: "warning",
    message: `structured-output probe did not answer within ${elapsedLabel(timeoutMs)}`,
    detail: `model ${model} · the turn may still be running on the account, and a browser turn has no `
      + "absolute deadline of its own",
  };
}

/**
 * Prove that an OpenAI-compatible client can use this service (issue #357).
 *
 * Such a client sends a `chat/completions` request carrying a `response_format` schema and
 * authenticated with the service's API key. This check sends exactly that shape to the local service
 * — one real browser turn — and reports what came back: the wire body must be a JSON
 * `chat.completion`, and the reply is reported as JSON or not, because this bridge carries a schema
 * as text and cannot enforce it (issue #354).
 *
 * Classification, deliberately:
 *
 * - `skipped` when there is no usable API key, or the service is not listening. An absent service is
 *   not an integration failure, and the `proxy` check already owns reachability, so this check never
 *   fails a doctor run for it;
 * - `warning` when the turn ran but did not answer within the bound, or answered with something that
 *   is not JSON (the soft mode is not enforced, so a validating caller must tolerate that);
 * - `error` when the service answered with a refusal, a body that is not JSON, or no answer at all.
 *
 * It never prints the API key, the control token, the request body or the model's text: the report
 * carries the model id, the HTTP status, the measured latency and the service's own usage estimate.
 *
 * @param options - where to probe, with which credential, and through which `fetch`.
 * @returns the doctor check describing the outcome.
 */
export async function structuredOutputProbeCheck(options: StructuredOutputProbeOptions): Promise<DoctorCheck> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return probeSkipped(options.apiKeyProblem
      ?? "no API key is configured, so the authenticated structured request cannot be proven "
        + "(set DSH_CHATGPT_WEB_API_KEY or <data dir>/api-key)");
  }
  const model = options.model ?? STRUCTURED_OUTPUT_PROBE_MODEL;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? STRUCTURED_OUTPUT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(structuredOutputProbeRequest(model)),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return probeTimedOut(model, timeoutMs);
      // An absent service is not a failure of the integration. The descriptor carries a name and a
      // code, never a message that could quote a URL or a header.
      return probeSkipped(`the service is not reachable at ${options.baseUrl} (${safeErrorDescriptor(error)})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) return probeTimedOut(model, timeoutMs);
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "error",
        message: `structured-output probe: the service answered HTTP ${response.status} with a body that is not JSON`,
        detail: `model ${model}`,
      };
    }
    const latency = elapsedLabel(Date.now() - startedAt);
    if (!response.ok) {
      const code = safeRefusalCode((body as { error?: unknown } | undefined)?.error);
      const safeCode = code !== undefined && !code.includes(apiKey) ? code : undefined;
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "error",
        message: `structured-output probe: the service refused the structured request with HTTP ${response.status}`,
        detail: [
          `model ${model}`,
          ...(safeCode === undefined ? [] : [`error code ${safeCode}`]),
          "a 401 means the key this probe sent is not the one the service accepts; a 400 naming "
            + "`response_format` means the running build predates issue #354",
        ].join(" · "),
      };
    }
    const answer = probeAnswer(body);
    if (answer.errorCode !== undefined && !answer.errorCode.includes(apiKey)) {
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "error",
        message: `structured-output probe: the turn failed with ${answer.errorCode}`,
        detail: `model ${model}`,
      };
    }
    if (answer.content === undefined) {
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "error",
        message: "structured-output probe: the service answered without a chat completion body",
        detail: `model ${model} · HTTP ${response.status}`,
      };
    }
    if (answer.content.trim() === "") {
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "error",
        message: "structured-output probe: the turn returned an empty answer",
        detail: `model ${model}`,
      };
    }
    const detail = [
      `model ${model}`,
      "structured output carried in soft mode (this bridge cannot enforce a JSON schema, issue #354)",
      probeTokenEstimate(answer.usage),
    ].join(" · ");
    if (!isJsonValue(answer.content)) {
      return {
        id: STRUCTURED_OUTPUT_PROBE_ID,
        status: "warning",
        message: `structured-output probe answered in ${latency}, but the reply was not JSON`,
        detail: `${detail} · the request was served, so a caller that validates the reply must tolerate prose`,
      };
    }
    return {
      id: STRUCTURED_OUTPUT_PROBE_ID,
      status: "ok",
      message: `structured-output probe answered in ${latency}: a structured request carrying `
        + "returned a JSON chat completion (one real browser turn)",
      detail,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the doctor offers the structured-output probe: the deployment's API key, or why it has none.
 *
 * A key that is too short never started the service (the server refuses it), so it is reported as a
 * reason rather than thrown: the `proxy` check owns the consequence, and this check must stay
 * skippable.
 */
function probeCredential(): Pick<StructuredOutputProbeOptions, "apiKey" | "apiKeyProblem"> {
  try {
    const apiKey = resolveApiKey();
    return apiKey === undefined ? {} : { apiKey };
  } catch {
    return {
      apiKeyProblem: "the configured API key is unusable (shorter than the minimum the service "
        + "accepts), so nothing can authenticate",
    };
  }
}

/**
 * The host the structured-output probe dials.
 *
 * The service may bind a wildcard inside its namespace (the authenticated Compose stack does), which
 * is not a dialable address, so the probe dials loopback in that case.
 */
function localProbeHost(host: string): string {
  return isLoopbackHost(host) ? host.trim() : "127.0.0.1";
}

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
  /**
   * Run the structured-output probe (issue #357). Default `true`: `doctor` is the operator's
   * proof that the wiring works, and it is skipped by itself when the deployment cannot authenticate.
   *
   * A suite that must not perform a real browser turn — or that runs on a machine where a live
   * service and an API key are both present — passes `false`.
   */
  readonly structuredOutputProbe?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (config.browserHost === "launcher") {
    try {
      const descriptor = config.browserInteractionMode === "manual"
        ? await inspectLauncherBrowserHostLiveness(config.browserHostDescriptorPath!, { timeoutMs: 5_000 })
        : readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
      if (config.browserInteractionMode === "automatic") {
        await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
      }
      checks.push({
        id: "browser-host",
        status: "ok",
        message: config.browserInteractionMode === "manual"
          ? `Embedded launcher browser is reachable for Zero Risk (pid ${descriptor.pid})`
          : `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
      });
    } catch (error) {
      checks.push({
        id: "browser-host",
        status: "error",
        message: "Embedded launcher browser is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({
        id: "login",
        status: "error",
        message: "ChatGPT login state is missing or unverified; run `dsh-chatgpt-web login` or `dsh-chatgpt-web auth import`, "
          + "or sign in at the operator sign-in surface /v1/control/auth/ (the running service picks that up on the next turn, no restart)",
        detail: `provider chatgpt-web · ${config.storageStatePath}`,
      });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}`, detail: "provider chatgpt-web" });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence", detail: `provider chatgpt-web · ${config.storageStatePath}` });
    }
  }

  // Per-provider WebChat status: authentication, capabilities and health, straight from the driver.
  // A provider whose driver cannot be composed is reported here rather than omitted.
  try {
    checks.push(...await webChatProviderChecks(webChatDoctorDrivers(config)));
  } catch (error) {
    checks.push({
      id: "webchat-chatgpt-web",
      status: "error",
      message: "WebChat provider diagnostics could not be assembled",
      detail: safeErrorDescriptor(error),
    });
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({
      id: "codex",
      status: "warning",
      message: "Native Codex model integration is not installed; ChatGPT Web operation does not depend on it",
    });
  } else if (codex.errors.length > 0) {
    checks.push({
      id: "codex",
      status: "warning",
      message: "Native Codex integration is inconsistent; ChatGPT Web checks remain independent",
      detail: codex.errors.join("; "),
    });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Native Codex model route is installed" });
  }

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "Launcher owns the background runtime" });
  } else if (!service.supported) {
    checks.push({ id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "macOS background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  checks.push(await proxyCheck(config));
  // Issue #357: prove an OpenAI-compatible integration end to end. This is the one check that
  // performs a real turn — a single structured request on the default endpoint — so it is
  // skipped, never failed, when the deployment has no API key to authenticate with or the service is
  // not listening.
  if (options.structuredOutputProbe !== false) {
    checks.push(await structuredOutputProbeCheck({
      baseUrl: `http://${localProbeHost(config.host)}:${config.port}`,
      ...probeCredential(),
    }));
  }

  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

/**
 * The container CLI as an operator types it on the host (README.md, doc/container.md).
 *
 * The guidance below is written for the supported Compose deployment because that is what ships and
 * what `doctor` diagnoses; an operator running a bare `docker run` can substitute its own invocation.
 */
const COMPOSE_EXEC = "docker compose exec chatgpt-web";

/**
 * The two documented sign-in routes (#249, #276), in the order a first run should try them.
 *
 * The first is the service's own page, which needs no display and is what the sign-in was verified
 * with against a real account. A successful capture there is picked **live** by the running service
 * (issue #287, slice 4b), so it deliberately carries no restart: telling an operator to restart for
 * the half that is already fixed is exactly the misleading guidance this must not print. The second
 * is the `/capture` path `docker/verify-container.sh` and README.md already use: the operator mounts
 * a directory holding a Playwright `storage-state.json` and adopts it. `auth import` runs in its own
 * short-lived process, so it is the route that still needs the running service restarted before that
 * process's write is visible to it.
 *
 * Nothing here prints a cookie, a token or a key — only the command that consumes the capture.
 */
function signInFixCommands(): string[] {
  return [
    `sign in at http://127.0.0.1:17841/v1/control/auth/ (no display needed; the running service `
      + `picks the session up on the next turn, no restart)`,
    `${COMPOSE_EXEC} node lib/cli.js auth import --provider chatgpt-web --from /capture`
      + `   # then: docker compose restart chatgpt-web`,
  ];
}

/**
 * The copy-pasteable command(s) that resolve one failing check.
 *
 * Deliberately a formatter concern, not a `DoctorCheck` field: the `doctor --json` shape is a stable
 * interface, so the guidance lives only in the human-readable report (the login message already
 * names its commands; every other failure now ends the report the same way).
 */
function doctorFixCommands(check: DoctorCheck): string[] {
  // The per-provider check is downstream of the same session the `login` check owns, so a provider
  // that is unhealthy or merely not authenticated is fixed by signing in again.
  if (check.id.startsWith("webchat-")) return signInFixCommands();
  switch (check.id) {
    case "config":
      // The entrypoint bootstraps the default configuration only when the volume has none, so an
      // invalid file is moved aside (kept for diagnosis) and the container restarted; a missing file
      // makes the `mv` a no-op and the restart writes it. `exit 0` keeps the no-op from looking like
      // a failed repair.
      return [
        `${COMPOSE_EXEC} sh -c 'mv /data/config.json /data/config.json.invalid 2>/dev/null; exit 0'`,
        "docker compose restart chatgpt-web   # the entrypoint writes a default config.json again",
      ];
    case "login":
      return signInFixCommands();
    case "chrome":
    case "browser-host":
      // Proves whether Playwright can launch the configured Chrome; a failure here means the image
      // (or the configured path) is wrong, so rebuild: docker compose build && docker compose up -d --wait
      return [`${COMPOSE_EXEC} node lib/cli.js browser check`];
    case "proxy":
      return ["docker compose up -d --wait"];
    case "service":
      return ["dsh-chatgpt-web service install"];
    case "tunnel-binary":
    case "tunnel-key":
      return ["dsh-chatgpt-web setup --full --acknowledge-unofficial"];
    case "tunnel-service":
    case "tunnel-runtime":
      return ["dsh-chatgpt-web tunnel start"];
    case "connector":
      return ["dsh-chatgpt-web open connectors"];
    default:
      return [];
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗", skipped: "–" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");

  // End a failing report with the exact command that fixes it. Errors always qualify; a WebChat
  // provider that is only a warning ("reachable but not authenticated") gets the sign-in route too,
  // because it is the same missing session. Commands are de-duplicated and the last line printed is
  // always one of them, so the report can be read and acted on from the bottom up.
  const fixes: string[] = [];
  for (const check of report.checks) {
    const actionable = check.status === "error"
      || (check.status === "warning" && check.id.startsWith("webchat-"));
    if (!actionable) continue;
    for (const command of doctorFixCommands(check)) {
      if (!fixes.includes(command)) fixes.push(command);
    }
  }
  if (fixes.length > 0) lines.push("", "Next step:", ...fixes.map(command => `  ${command}`));
  return `${lines.join("\n")}\n`;
}
