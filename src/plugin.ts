import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ChatGptWebLlmAdapter, CHATGPT_WEB_PROVIDER_ID } from "./adapters/chatgpt-web/llm-adapter";

export interface CordisContext {
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
  host: string;
  port: Volatile<number>;
  autoStart: boolean;
  readyTimeoutMs: number;
  bunPath?: string;
}

export const Config: z<Config> = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT).description("Local ChatGPT Web sidecar port.").volatile(),
  autoStart: z.boolean().default(true),
  readyTimeoutMs: z.number().step(1).min(0).default(30_000),
  bunPath: z.string().optional(),
});

type ChatGPTWebPluginConfig = Partial<Omit<Config, "port">> & { port?: number | Volatile<number> };
  /** Host to bind or check for health (default: 127.0.0.1). */
  host?: string;
  /** Port the sidecar listens on (default: 17841). */
  port?: number;
  /** Automatically start the sidecar daemon if not running (default: true). */
  autoStart?: boolean;
  /** Maximum milliseconds to wait for the sidecar to report ready (default: 30000). */
  readyTimeoutMs?: number;
  /** Explicit path to the bun executable (optional). */
  bunPath?: string;
}

import { pathToFileURL } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveLauncher(customBunPath: string | undefined, host: string, port: number): { cmd: string; args: string[] } {
  const serveArgs = ["serve", "--host", host, "--port", String(port)];
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

function readPort(value: number | Volatile<number> | undefined): number {
  const port = value && typeof value === "object" && "get" in value && typeof value.get === "function"
    ? value.get()
    : value ?? DEFAULT_PORT;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
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
  const host = config.host || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error("The ChatGPT Web sidecar must remain loopback-only");
  let port = readPort(config.port);
  const autoStart = config.autoStart !== false;
  const readyTimeoutMs = config.readyTimeoutMs ?? 30_000;
  const logger = typeof ctx.logger === "function" ? ctx.logger("chatgpt-web") : console;

  let spawnedProcess: ChildProcess | undefined;
  let reconfiguration = Promise.resolve();

  const startDaemon = async () => {
    const alreadyHealthy = await isSidecarHealthy(host, port);
    if (alreadyHealthy) {
      logger.info(`[dsh-chatgpt-web] Sidecar already running and healthy at http://${host}:${port}/v1`);
      return;
    }

    if (!autoStart) {
      logger.warn(`[dsh-chatgpt-web] Sidecar is offline and autoStart is false. Start it manually with 'bun run src/cli.ts serve'`);
      return;
    }

    const launcher = resolveLauncher(config.bunPath, host, port);
    logger.info(`[dsh-chatgpt-web] Starting dsh-chatgpt-web daemon via ${launcher.cmd} at http://${host}:${port}/v1...`);

    const child = spawn(launcher.cmd, launcher.args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
      },
    });

    spawnedProcess = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function") logger.debug(`[sidecar] ${text}`);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof logger.debug === "function") logger.debug(`[sidecar:err] ${text}`);
    });

    child.on("error", (err) => {
      logger.error(`[dsh-chatgpt-web] Failed to launch sidecar process: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`[dsh-chatgpt-web] Sidecar process exited with code ${code} (signal: ${signal})`);
      }
      spawnedProcess = undefined;
    });

    // Wait for healthcheck
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await isSidecarHealthy(host, port)) {
        logger.info(`[dsh-chatgpt-web] Sidecar ready and accepting turns at http://${host}:${port}/v1`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    logger.error(`[dsh-chatgpt-web] Sidecar did not become healthy within ${readyTimeoutMs}ms`);
  };

  const stopDaemon = async () => {
    if (!spawnedProcess) return;

    logger.info("[dsh-chatgpt-web] Stopping sidecar daemon...");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(`http://${host}:${port}/admin/shutdown`, {
        method: "POST",
        signal: controller.signal,
      }).catch(() => {});
      clearTimeout(timer);
    } catch {
      // ignore
    }

    if (spawnedProcess && !spawnedProcess.killed) {
      spawnedProcess.kill("SIGTERM");
    }
    spawnedProcess = undefined;
  };

  if (typeof ctx.on === "function") {
    ctx.on("loader/volatile-update", () => {
      reconfiguration = reconfiguration
        .then(async () => {
          const nextPort = readPort(config.port);
          if (nextPort === port) return;
          await stopDaemon();
          port = nextPort;
          if (autoStart) {
            await startDaemon();
          } else {
            logger.info(`[dsh-chatgpt-web] Sidecar endpoint reconfigured to http://${host}:${port}/v1; autoStart is false.`);
          }
        })
        .catch((error) => {
          logger.error(`[dsh-chatgpt-web] Failed to apply live sidecar port change: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }
  const registerAdapter = (): (() => void) => {
    const disposeAdapter = ctx.llm.registerAdapter([CHATGPT_WEB_PROVIDER_ID], new ChatGptWebLlmAdapter());
    logger.info(`[dsh-chatgpt-web] Registered native DSH provider "${CHATGPT_WEB_PROVIDER_ID}"`);
    return disposeAdapter;
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const disposeAdapter = registerAdapter();
      void startDaemon();
      return () => {
        void stopDaemon();
        disposeAdapter();
      };
    });
  } else {
    const disposeAdapter = registerAdapter();
    void startDaemon();
    process.once("beforeExit", () => {
      void stopDaemon();
      disposeAdapter();
    });
  }
}

export default {
  name,
  inject,
  Config,
  apply,
};
