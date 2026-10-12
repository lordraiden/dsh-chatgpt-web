import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Volatile } from "@deepseek-ai/cordis";
import { z } from "zod";
import schemastery from "@deepseek-ai/schemastery";
import { ChatGptWebLlmAdapter, CHATGPT_WEB_PROVIDER_ID } from "./adapters/chatgpt-web/llm-adapter";
import { loadConfig } from "./config";
import { createWebChatShutdown, registerableRouteIds } from "./web-chat/host/dsh-integration";
import type { WebChatProviderDriver } from "./web-chat/core";
import type { DshNativeTurnContext } from "./types";
import { safeErrorDescriptor, safeTextDescriptor } from "./lib/safe-diagnostics";
import { VERSION } from "./version";

export interface CordisContext {
  /**
   * Cordis service lookup. The native provider uses this only to consume
   * DSH-owned session and sandbox policy state; it never creates a parallel authority.
   */
  get?: (name: string) => unknown;
  effect?: (cb: () => void | Promise<void> | (() => void) | (() => Promise<void>)) => void;
  on?: (event: string, callback: () => void | Promise<void>) => unknown;
  logger?: (name: string) => {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  /**
   * Native DSH LLM runtime (augmented onto the Cordis context by
   * `@deepseek-ai/dsh-llm`). Structural on purpose: the plugin only needs to
   * register the ChatGPT Web provider and dispose the registration.
   */
  llm: {
    registerAdapter(providers: string[], adapter: ChatGptWebLlmAdapter): { (): void };
  };
  /**
   * Session-projection registry (DSH session-projection capability seam). The
   * plugin registers one immutable unit so the Client UI can receive the
   * sidecar control token through the official `useProjection` hook without
   * any parallel channel. Structural and optional: profiles without the
   * capability simply skip the registration.
   */
  sessionProjections?: {
    register(definition: {
      key: string;
      stateSchema: z.ZodType<unknown>;
      init: (header: unknown, inheritedEventCount: number) => unknown;
      apply: (state: unknown, event: unknown) => unknown;
      wire: { viewSchema: z.ZodType<unknown>; view: (state: unknown) => unknown };
      stateVersion: number;
    }): () => void;
  };
}

export const name = "dsh-chatgpt-web";
export const inject = ["llm", "sessionProjections"];
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 17841;

export interface Config {
  /** Loopback sidecar port. Live because the WebUI may update it without rebuilding the plugin. */
  port: Volatile<number>;
  /** Whether the plugin owns starting/stopping the sidecar. Live configuration. */
  autoStart: Volatile<boolean>;
  /** Maximum time the plugin waits for a newly started sidecar to become healthy. */
  readyTimeoutMs: Volatile<number>;
  /** Advanced runtime override; intentionally not exposed as a live user setting. */
  bunPath?: string;
}

export const Config = schemastery.object({
  port: schemastery.number().step(1).min(1).max(65535).default(DEFAULT_PORT)
    .description("Loopback ChatGPT Web sidecar port.").volatile(),
  autoStart: schemastery.boolean().default(true)
    .description("Start and stop the local ChatGPT Web sidecar automatically.").volatile(),
  readyTimeoutMs: schemastery.number().step(1).min(0).default(30_000)
    .description("Milliseconds to wait for a newly started sidecar to become healthy.").volatile(),
  bunPath: schemastery.string().default(undefined as unknown as string),
});

type ChatGPTWebPluginConfig = {
  port?: number | Volatile<number>;
  autoStart?: boolean | Volatile<boolean>;
  readyTimeoutMs?: number | Volatile<number>;
  bunPath?: string;
};

import { pathToFileURL } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveLauncher(customBunPath: string | undefined, port: number): { cmd: string; args: string[] } {
  const serveArgs = ["serve", "--host", DEFAULT_HOST, "--port", String(port)];
  const libCliPath = resolve(ROOT_DIR, "lib", "cli.js");
  if (existsSync(libCliPath)) {
    return {
      cmd: process.execPath,
      args: [libCliPath, ...serveArgs],
    };
  }

  // Development fallback: check for bun or tsx
  if (customBunPath && existsSync(customBunPath)) {
    return { cmd: customBunPath, args: ["run", "src/cli.ts", ...serveArgs] };
  }

  const winBun = join(homedir(), ".bun", "bin", "bun.exe");
  if (existsSync(winBun)) {
    return { cmd: winBun, args: ["run", "src/cli.ts", ...serveArgs] };
  }

  const tsxPath = resolve(ROOT_DIR, "../deepseek-harness/node_modules/tsx/dist/esm/index.mjs");
  if (existsSync(tsxPath)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(tsxPath).href, "src/cli.ts", ...serveArgs],
    };
  }

  return { cmd: process.execPath, args: ["src/cli.ts", ...serveArgs] };
}

interface DshSessionLike {
  readonly header: {
    readonly cwd?: string;
  };
}

interface DshSessionsLike {
  get(id: string): DshSessionLike | undefined;
}

interface DshSandboxPolicyLike {
  resolve(request?: { session?: DshSessionLike }): {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    workspaceRoot: string;
  };
}

/**
 * Resolve trusted native DSH state at the plugin boundary. The provider adapter
 * receives a detached projection; it never reads or mutates DSH services itself.
 */
function resolveNativeDshContext(
  ctx: CordisContext,
  options: import("@deepseek-ai/dsh-llm").GenerateOptions,
  turnId: string,
  threadId: string,
): DshNativeTurnContext {
  const dshSessionId = options.sessionId !== undefined ? String(options.sessionId) : undefined;
  let session: DshSessionLike | undefined;
  if (dshSessionId !== undefined) {
    const sessions = ctx.get?.("sessions") as DshSessionsLike | undefined;
    if (!sessions) {
      throw new Error("DSH session service is unavailable for a session-bound native LLM request");
    }
    session = sessions.get(dshSessionId);
    if (!session) {
      throw new Error(`DSH session "${dshSessionId}" is unavailable for the native LLM request`);
    }
  }

  const base: DshNativeTurnContext = {
    ...(dshSessionId !== undefined ? { dshSessionId } : {}),
    threadId,
    turnId,
    ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
  };

  const sandboxPolicy = ctx.get?.("sandboxPolicy") as DshSandboxPolicyLike | undefined;
  if (!sandboxPolicy) {
    if (options.tools?.length) {
      throw new Error("DSH sandbox policy service is required for native ChatGPT Web tool execution");
    }
    return base;
  }

  const policy = sandboxPolicy.resolve(session ? { session } : {});
  const root = policy.workspaceRoot;
  const writableRoots = policy.mode === "read-only" ? [] : [root];
  return {
    ...base,
    environment: {
      cwd: root,
      roots: [root],
      writableRoots,
      sandboxMode: policy.mode,
      // DSH sandbox-policy intentionally has no network capability bit.
      // Native Web product capabilities remain outside this local-tool authority.
      networkAccess: false,
    },
  };
}

function readPort(value: number | Volatile<number> | undefined): number {
  const raw = typeof value === "number" ? value : value?.get() ?? DEFAULT_PORT;
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 65535 ? raw : DEFAULT_PORT;
}

function readBoolean(value: boolean | Volatile<boolean> | undefined, fallback: boolean): boolean {
  const raw = typeof value === "boolean" ? value : value?.get() ?? fallback;
  return typeof raw === "boolean" ? raw : fallback;
}

function readReadyTimeout(value: number | Volatile<number> | undefined): number {
  const raw = typeof value === "number" ? value : value?.get() ?? 30_000;
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

interface SidecarHealth {
  status?: unknown;
  service?: unknown;
  version?: unknown;
  pid?: unknown;
}

async function inspectSidecar(host: string, port: number): Promise<SidecarHealth | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const body = await res.json() as SidecarHealth;
    return body.status === "ok" ? body : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function isSidecarHealthy(host: string, port: number): Promise<boolean> {
  const body = await inspectSidecar(host, port);
  return body?.service === "dsh-chatgpt-web" && body.version === VERSION;
}

/** Where a remembered sidecar inspection happened, for the message and the log. */
interface SidecarLocation {
  readonly url: string;
  readonly port: number;
}

/**
 * Why a healthy sidecar on the configured port may not be used, or `undefined` when it may.
 *
 * This is the single owner of the "is the daemon on my port mine and current?" comparison and of its
 * wording: the startup log and the turn path must not disagree about it.
 */
export function sidecarRefusal(
  health: SidecarHealth | undefined,
  installedVersion: string,
  where: SidecarLocation,
): string | undefined {
  if (!health) return undefined;
  if (health.service !== "dsh-chatgpt-web") {
    return `Port ${where.port} is occupied by a healthy service (${String(health.service ?? "unknown service")}, version ${String(health.version ?? "unknown")}); refusing to reuse it as the ChatGPT Web sidecar.`;
  }
  if (health.version !== installedVersion) {
    return `Outdated sidecar at ${where.url}: running version ${String(health.version ?? "unknown")} (pid ${String(health.pid ?? "unknown")}), but installed plugin is ${installedVersion}. This plugin will not reuse or terminate a sidecar it does not own. Stop the old 'serve' process and restart DSH so the updated plugin can start the matching daemon.`;
  }
  return undefined;
}

/**
 * The sidecar agreement remembered from the last inspection, asserted on the turn path.
 *
 * A daemon is a long-lived process that a package update does not replace, so the startup decision
 * alone is not enough: refusing to *reuse* an outdated daemon in a log still left turns flowing to
 * it over the port. Recording the decision here lets the turn path fail closed with the same
 * message, and `onRefusal` re-inspects so a daemon the operator has since fixed is accepted again.
 */
export function createSidecarAgreement(
  installedVersion: string,
  options: { onRefusal?: () => void } = {},
): {
    observe(health: SidecarHealth | undefined, where: SidecarLocation): void;
    refusal(): string | undefined;
    assertUsable(): void;
  } {
  let remembered: { health: SidecarHealth | undefined; where: SidecarLocation } | undefined;
  const refusalOf = (): string | undefined =>
    remembered ? sidecarRefusal(remembered.health, installedVersion, remembered.where) : undefined;
  return {
    observe(health, where) {
      remembered = { health, where };
    },
    refusal: refusalOf,
    assertUsable() {
      const refusal = refusalOf();
      if (refusal === undefined) return;
      options.onRefusal?.();
      throw new Error(refusal);
    },
  };
}

/**
 * WebChat drivers this deployment composes.
 *
 * Optional on purpose: a profile without the WebChat host seam keeps exactly today's behavior. When it
 * is supplied, only the routes that really have a driver may be registered, and every driver is shut
 * down with the plugin.
 */
export interface PluginWebChatDeps {
  readonly drivers?: () => readonly WebChatProviderDriver[];
}

export function apply(
  ctx: CordisContext,
  config: ChatGPTWebPluginConfig = {},
  webChat: PluginWebChatDeps = {},
): void {
  const host = DEFAULT_HOST;
  let port = readPort(config.port);
  let autoStart = readBoolean(config.autoStart, true);
  let readyTimeoutMs = readReadyTimeout(config.readyTimeoutMs);
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;

  let spawnedProcess: ChildProcess | undefined;
  let spawnedPort: number | undefined;
  let startGeneration = 0;
  let reconfiguration = Promise.resolve();
  let lastAgreementRefresh = 0;

  const sidecarLocation = (targetPort: number): SidecarLocation => ({
    url: `http://${host}:${targetPort}/v1`,
    port: targetPort,
  });

  const agreement = createSidecarAgreement(VERSION, {
    // Called from the turn path when it refuses: a daemon the operator has since replaced must be
    // accepted again without requiring a DSH restart, and at most one re-inspection per second.
    onRefusal: () => {
      const now = Date.now();
      if (now - lastAgreementRefresh < 1_000) return;
      lastAgreementRefresh = now;
      const targetPort = port;
      void inspectSidecar(host, targetPort).then(
        health => agreement.observe(health, sidecarLocation(targetPort)),
        () => undefined,
      );
    },
  });

  const startDaemon = async () => {
    const generation = ++startGeneration;
    const targetPort = port;
    const existing = await inspectSidecar(host, targetPort);
    // Recorded even when there is no healthy sidecar: a free port clears a stale refusal.
    agreement.observe(existing, sidecarLocation(targetPort));
    if (existing) {
      const refusal = agreement.refusal();
      if (refusal === undefined) {
        logger.info(`[dsh-chatgpt-web] Sidecar already running and healthy at http://${host}:${targetPort}/v1 (version ${VERSION})`);
      } else {
        // The same message the turn path throws, so the log and the failure cannot disagree.
        logger.error(`[dsh-chatgpt-web] ${refusal}`);
      }
      return;
    }

    if (!autoStart) {
      logger.warn(`[dsh-chatgpt-web] Sidecar is offline and autoStart is false. Start it manually with 'bun run src/cli.ts serve'`);
      return;
    }

    const launcher = resolveLauncher(config.bunPath, targetPort);
    logger.info(`[dsh-chatgpt-web] Starting dsh-chatgpt-web daemon via ${launcher.cmd} at http://${host}:${targetPort}/v1...`);

    const child = spawn(launcher.cmd, launcher.args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
      },
    });

    spawnedProcess = child;
    spawnedPort = targetPort;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function") logger.debug(`[sidecar] ${safeTextDescriptor(text)}`);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function") logger.debug(`[sidecar:err] ${safeTextDescriptor(text)}`);
    });

    child.on("error", (err) => {
      logger.error(`[dsh-chatgpt-web] Failed to launch sidecar process ${safeErrorDescriptor(err)}`);
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[dsh-chatgpt-web] Sidecar process exited with code ${code} (signal: ${signal})`);
      }
      if (spawnedProcess === child) {
        spawnedProcess = undefined;
        spawnedPort = undefined;
      }
    });

    // Wait for healthcheck
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (generation !== startGeneration) return;
      if (await isSidecarHealthy(host, targetPort)) {
        logger.info(`[dsh-chatgpt-web] Sidecar ready and accepting turns at http://${host}:${targetPort}/v1`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    logger.error(`[dsh-chatgpt-web] Sidecar did not become healthy within ${readyTimeoutMs}ms`);
  };

  const stopDaemon = async () => {
    ++startGeneration;
    const child = spawnedProcess;
    const childPort = spawnedPort;
    if (!child) return;

    logger.info("[dsh-chatgpt-web] Stopping sidecar daemon...");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://${host}:${childPort ?? port}/admin/shutdown`, {
        method: "POST",
        signal: controller.signal,
      }).catch(() => {});
      clearTimeout(timer);
    } catch {
      // ignore
    }

    if (!child.killed) {
      child.kill("SIGTERM");
    }
    if (spawnedProcess === child) {
      spawnedProcess = undefined;
      spawnedPort = undefined;
    }
  };

  if (typeof ctx.on === "function") {
    ctx.on("loader/volatile-update", () => {
      reconfiguration = reconfiguration
        .then(async () => {
          const nextPort = readPort(config.port);
          const nextAutoStart = readBoolean(config.autoStart, true);
          const nextReadyTimeoutMs = readReadyTimeout(config.readyTimeoutMs);
          const portChanged = nextPort !== port;
          const autoStartChanged = nextAutoStart !== autoStart;
          const readyTimeoutChanged = nextReadyTimeoutMs !== readyTimeoutMs;

          if (!portChanged && !autoStartChanged && !readyTimeoutChanged) return;

          // The plugin only stops processes it spawned itself. A healthy external sidecar is
          // detected on the next start and is left untouched.
          if (portChanged || (autoStartChanged && !nextAutoStart)) {
            await stopDaemon();
          }

          port = nextPort;
          autoStart = nextAutoStart;
          readyTimeoutMs = nextReadyTimeoutMs;

          if (nextAutoStart && (portChanged || autoStartChanged)) {
            await startDaemon();
          } else {
            const changes = [];
            if (portChanged) changes.push(`port=${port}`);
            if (autoStartChanged) changes.push(`autoStart=${autoStart}`);
            if (readyTimeoutChanged) changes.push(`readyTimeoutMs=${readyTimeoutMs}`);
            logger.info(`[dsh-chatgpt-web] Live configuration applied (${changes.join(", ")}).`);
          }
        })
        .catch((error) => {
          logger.error(`[dsh-chatgpt-web] Failed to apply live configuration ${safeErrorDescriptor(error)}`);
        });
    });
  }
  /**
   * The drivers this deployment actually composed, so shutdown releases exactly the list the
   * registration decision was taken from — including the injected list when the route was refused.
   */
  let shutdownWebChatDrivers: (() => Promise<void>) | undefined;

  const registerAdapter = (): { adapter: ChatGptWebLlmAdapter; dispose: () => void } | undefined => {
    const adapter = new ChatGptWebLlmAdapter({
      resolveNativeDshContext: (options, turnId, threadId) =>
        resolveNativeDshContext(ctx, options, turnId, threadId),
      resolveNativeDshTransport: () => {
        // Fail closed on the turn path (issue #236 follow-up): an outdated or foreign daemon that
        // the startup inspection refused must fail the turn with that same message rather than
        // silently serving it. Throwing here becomes a terminal `finish` chunk carrying the text.
        agreement.assertUsable();
        const appConfig = loadConfig();
        return {
          baseUrl: "http://" + host + ":" + port,
          controlToken: appConfig.controlToken,
        };
      },
    });
    // The list is built *here*, after the adapter exists, because the adapter owns the provider
    // configuration: when no driver is injected, the default driver is the one the adapter composes
    // for its own route. `ctx.llm.registerAdapter` stays the only public authority; this only decides
    // which routes may be handed to it, and a route without a driver is refused instead of being
    // registered pretend-complete.
    let drivers: readonly WebChatProviderDriver[];
    try {
      drivers = webChat.drivers?.() ?? [adapter.webChatDriver()];
    } catch (error) {
      // A provider whose own configuration cannot be resolved has no driver yet: the route stays
      // unregistered, exactly like a route this deployment does not implement, and the plugin still
      // loads. The configuration failure still reaches the caller as a typed PROVIDER_CONFIG failure
      // at call time.
      logger.warn(
        `[dsh-chatgpt-web] The WebChat driver for "${CHATGPT_WEB_PROVIDER_ID}" could not be composed: the route is not registered ${safeErrorDescriptor(error)}`,
      );
      return undefined;
    }
    shutdownWebChatDrivers = createWebChatShutdown(
      drivers,
      (error, providerId) => logger.error(
        `[dsh-chatgpt-web] WebChat driver "${providerId}" failed to shut down ${safeErrorDescriptor(error)}`,
      ),
    );
    if (!registerableRouteIds([CHATGPT_WEB_PROVIDER_ID], drivers).includes(CHATGPT_WEB_PROVIDER_ID)) {
      logger.warn(
        `[dsh-chatgpt-web] The WebChat driver for "${CHATGPT_WEB_PROVIDER_ID}" is not composed: the route is not registered`,
      );
      return undefined;
    }
    const dispose = ctx.llm.registerAdapter([CHATGPT_WEB_PROVIDER_ID], adapter);
    logger.info(`[dsh-chatgpt-web] Registered native DSH provider "${CHATGPT_WEB_PROVIDER_ID}"`);
    return { adapter, dispose };
  };

  /**
   * Expose the sidecar control token to the Client UI through the official
   * session-projection seam (`useProjection` on the Client): the token is the
   * single stable value the Advisor dialog (#179) needs to call the loopback
   * control API, and the projection is the framework channel for a
   * session-derived value — no parallel transport. The state is immutable:
   * `apply` always returns the previous reference, so the eager drive does
   * zero downstream work for every session event.
   */
  const registerSidecarProjection = (): (() => void) | undefined => {
    const projections = ctx.sessionProjections;
    if (!projections || typeof projections.register !== "function") return undefined;
    const token = loadConfig().controlToken;
    const state = { controlToken: token };
    const schema = z.object({ controlToken: z.string() });
    return projections.register({
      key: "dsh-chatgpt-web:sidecar",
      stateSchema: schema,
      init: () => state,
      apply: (previous) => previous,
      wire: { viewSchema: schema, view: (s) => s },
      stateVersion: 1,
    });
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const registered = registerAdapter();
      const disposeProjection = registerSidecarProjection();
      void startDaemon();
      return async () => {
        await registered?.adapter.shutdown();
        await shutdownWebChatDrivers?.();
        await stopDaemon();
        registered?.dispose();
        disposeProjection?.();
      };
    });
  } else {
    const registered = registerAdapter();
    const disposeProjection = registerSidecarProjection();
    void startDaemon();
    process.once("beforeExit", () => {
      void (async () => {
        await registered?.adapter.shutdown();
        await shutdownWebChatDrivers?.();
        await stopDaemon();
        registered?.dispose();
        disposeProjection?.();
      })();
    });
  }
}

export default {
  name,
  inject,
  Config,
  apply,
};
