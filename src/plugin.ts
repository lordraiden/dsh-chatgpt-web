import { spawn } from "node:child_process";
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
import { SidecarSupervisor } from "./sidecar-supervisor";

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

export function apply(ctx: CordisContext, config: ChatGPTWebPluginConfig = {}): void {
  const host = DEFAULT_HOST;
  let port = readPort(config.port);
  const autoStart = readBoolean(config.autoStart, true);
  const readyTimeoutMs = readReadyTimeout(config.readyTimeoutMs);
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;

  const supervisor = new SidecarSupervisor(
    {
      host,
      port,
      autoStart,
      readyTimeoutMs,
      bunPath: config.bunPath,
    },
    {
      resolveLauncher,
      spawn,
      fetch,
      cwd: ROOT_DIR,
      logger,
      safeErrorDescriptor,
      safeTextDescriptor,
    },
  );

  if (typeof ctx.on === "function") {
    ctx.on("loader/volatile-update", () => {
      const nextPort = readPort(config.port);
      const nextAutoStart = readBoolean(config.autoStart, true);
      const nextReadyTimeoutMs = readReadyTimeout(config.readyTimeoutMs);
      port = nextPort;
      void supervisor.reconfigure({
        host,
        port: nextPort,
        autoStart: nextAutoStart,
        readyTimeoutMs: nextReadyTimeoutMs,
        bunPath: config.bunPath,
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
      void supervisor.start();
      return async () => {
        await adapter.shutdown();
        await supervisor.shutdown();
        dispose();
      };
    });
  } else {
    const { adapter, dispose } = registerAdapter();
    void supervisor.start();
    process.once("beforeExit", () => {
      void (async () => {
        await adapter.shutdown();
        await supervisor.shutdown();
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
