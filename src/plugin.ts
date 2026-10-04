import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Volatile } from "@deepseek-ai/cordis";
import schemastery from "@deepseek-ai/schemastery";
import { ChatGptWebLlmAdapter, CHATGPT_WEB_PROVIDER_ID } from "./adapters/chatgpt-web/llm-adapter";
import { loadConfig } from "./config";
import type { DshNativeTurnContext } from "./types";
import { safeErrorDescriptor, safeTextDescriptor } from "./lib/safe-diagnostics";
import { selfDevelopmentPolicyFromDshEnvironment } from "./self-development-contract";
import {
  registerWorkspaceTools,
  type WorkspaceToolConfig,
  type WorkspaceToolsContext,
} from "./workspace-tools";

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
  tools?: WorkspaceToolsContext["tools"];
}

export const name = "dsh-chatgpt-web";
export const inject = ["llm"];
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
  /** Enable the bounded self-development workspace tools. */
  workspaceEnabled: boolean;
  /** Single explicit root authorized for workspace tools. */
  workspaceRoot: string;
  /** Expose workspace read/search tools. */
  workspaceRead: boolean;
  /** Expose workspace write/edit tools. */
  workspaceWrite: boolean;
  /** Maximum UTF-8 bytes read by one workspace operation. */
  workspaceMaxReadBytes: number;
  /** Maximum UTF-8 bytes written by one workspace operation. */
  workspaceMaxWriteBytes: number;
}

export const Config = schemastery.object({
  port: schemastery.number().step(1).min(1).max(65535).default(DEFAULT_PORT)
    .description("Loopback ChatGPT Web sidecar port.").volatile(),
  autoStart: schemastery.boolean().default(true)
    .description("Start and stop the local ChatGPT Web sidecar automatically.").volatile(),
  readyTimeoutMs: schemastery.number().step(1).min(0).default(30_000)
    .description("Milliseconds to wait for a newly started sidecar to become healthy.").volatile(),
  bunPath: schemastery.string().default(undefined as unknown as string),
  workspaceEnabled: schemastery.boolean().default(false)
    .description("Enable bounded filesystem tools for the configured self-development workspace."),
  workspaceRoot: schemastery.string().default("")
    .description("Single explicit workspace root available to self-development filesystem tools."),
  workspaceRead: schemastery.boolean().default(true)
    .description("Expose bounded workspace read/search tools."),
  workspaceWrite: schemastery.boolean().default(false)
    .description("Expose workspace write/edit tools. Disabled by default."),
  workspaceMaxReadBytes: schemastery.number().step(1).min(1).max(16 * 1024 * 1024)
    .default(1_048_576)
    .description("Maximum UTF-8 bytes readable by one workspace tool call."),
  workspaceMaxWriteBytes: schemastery.number().step(1).min(1).max(16 * 1024 * 1024)
    .default(1_048_576)
    .description("Maximum UTF-8 bytes writable by one workspace tool call."),
});

type ChatGPTWebPluginConfig = {
  port?: number | Volatile<number>;
  autoStart?: boolean | Volatile<boolean>;
  readyTimeoutMs?: number | Volatile<number>;
  bunPath?: string;
  workspaceEnabled?: boolean;
  workspaceRoot?: string;
  workspaceRead?: boolean;
  workspaceWrite?: boolean;
  workspaceMaxReadBytes?: number;
  workspaceMaxWriteBytes?: number;
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
  const selfDevelopment = selfDevelopmentPolicyFromDshEnvironment({
    workspaceRoot: root,
    sandboxMode: policy.mode,
    networkAccess: false,
    approvalPolicy: policy.mode === "danger-full-access" ? "never" : "ask",
    availableTools: options.tools?.map(tool => tool.name),
  });
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
    selfDevelopment: {
      workspaceRoot: selfDevelopment.workspaceRoot,
      sandboxMode: selfDevelopment.sandboxMode,
      networkAccess: selfDevelopment.networkAccess,
      approvalPolicy: selfDevelopment.approvalPolicy,
      capabilities: [...selfDevelopment.capabilities],
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

function readWorkspaceToolConfig(config: ChatGPTWebPluginConfig): WorkspaceToolConfig {
  return {
    enabled: config.workspaceEnabled ?? false,
    root: typeof config.workspaceRoot === "string" ? config.workspaceRoot : "",
    read: config.workspaceRead ?? true,
    write: config.workspaceWrite ?? false,
    maxReadBytes: Number.isSafeInteger(config.workspaceMaxReadBytes)
      ? Number(config.workspaceMaxReadBytes)
      : 1_048_576,
    maxWriteBytes: Number.isSafeInteger(config.workspaceMaxWriteBytes)
      ? Number(config.workspaceMaxWriteBytes)
      : 1_048_576,
  };
}

async function isSidecarHealthy(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

export function apply(ctx: CordisContext, config: ChatGPTWebPluginConfig = {}): void {
  const host = DEFAULT_HOST;
  let port = readPort(config.port);
  let autoStart = readBoolean(config.autoStart, true);
  let readyTimeoutMs = readReadyTimeout(config.readyTimeoutMs);
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;

  const workspaceTools = readWorkspaceToolConfig(config);
  if (workspaceTools.enabled) {
    const toolsContext = ctx.tools;
    if (!toolsContext) {
      throw new Error("DSH tools service is required when workspace tools are enabled");
    }
    const registered = registerWorkspaceTools({ tools: toolsContext }, workspaceTools);
    logger.info(`[dsh-chatgpt-web] Registered bounded workspace tools: ${registered.join(", ")}`);
  }

  let spawnedProcess: ChildProcess | undefined;
  let spawnedPort: number | undefined;
  let startGeneration = 0;
  let reconfiguration = Promise.resolve();

  const startDaemon = async () => {
    const generation = ++startGeneration;
    const targetPort = port;
    const alreadyHealthy = await isSidecarHealthy(host, targetPort);
    if (alreadyHealthy) {
      logger.info(`[dsh-chatgpt-web] Sidecar already running and healthy at http://${host}:${targetPort}/v1`);
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
  const registerAdapter = (): { adapter: ChatGptWebLlmAdapter; dispose: () => void } => {
    const adapter = new ChatGptWebLlmAdapter({
      resolveNativeDshContext: (options, turnId, threadId) =>
        resolveNativeDshContext(ctx, options, turnId, threadId),
      resolveNativeDshTransport: () => {
        const appConfig = loadConfig();
        return {
          baseUrl: "http://" + host + ":" + port,
          controlToken: appConfig.controlToken,
        };
      },
    });
    const dispose = ctx.llm.registerAdapter([CHATGPT_WEB_PROVIDER_ID], adapter);
    logger.info(`[dsh-chatgpt-web] Registered native DSH provider "${CHATGPT_WEB_PROVIDER_ID}"`);
    return { adapter, dispose };
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const { adapter, dispose } = registerAdapter();
      void startDaemon();
      return async () => {
        await adapter.shutdown();
        await stopDaemon();
        dispose();
      };
    });
  } else {
    const { adapter, dispose } = registerAdapter();
    void startDaemon();
    process.once("beforeExit", () => {
      void (async () => {
        await adapter.shutdown();
        await stopDaemon();
        dispose();
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
