import type { ChildProcess } from "node:child_process";

export interface SidecarLauncher {
  cmd: string;
  args: string[];
}

export interface SidecarLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface SidecarSupervisorConfig {
  host: string;
  port: number;
  autoStart: boolean;
  readyTimeoutMs: number;
  bunPath?: string;
}

export interface SidecarSupervisorDependencies {
  resolveLauncher: (customBunPath: string | undefined, port: number) => SidecarLauncher;
  spawn: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      stdio: ["ignore", "pipe", "pipe"];
      windowsHide: boolean;
      env: NodeJS.ProcessEnv;
    },
  ) => ChildProcess;
  fetch: typeof globalThis.fetch;
  cwd: string;
  logger: SidecarLogger;
  safeErrorDescriptor: (value: unknown) => string;
  safeTextDescriptor: (value: string) => string;
}

export class SidecarSupervisor {
  private config: SidecarSupervisorConfig;
  private spawnedProcess?: ChildProcess;
  private spawnedPort?: number;
  private generation = 0;
  private startPromise?: Promise<void>;
  private reconfiguration = Promise.resolve();
  private terminationPromises = new WeakMap<ChildProcess, Promise<void>>();
  private closed = false;

  constructor(
    config: SidecarSupervisorConfig,
    private readonly dependencies: SidecarSupervisorDependencies,
  ) {
    this.config = { ...config };
  }

  async start(): Promise<void> {
    if (this.closed) return;
    if (this.startPromise) return this.startPromise;
    const promise = this.startGeneration();
    const tracked = promise.finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined;
    });
    this.startPromise = tracked;
    return tracked;
  }

  async stop(): Promise<void> {
    ++this.generation;
    const pendingStart = this.startPromise;
    if (pendingStart) {
      await pendingStart.catch(() => {});
    }
    const child = this.spawnedProcess;
    const childPort = this.spawnedPort;
    if (!child) return;
    await this.terminateChild(child);
  }

  async reconfigure(next: SidecarSupervisorConfig): Promise<void> {
    if (this.closed) return;
    const operation = this.reconfiguration.then(async () => {
      if (this.closed) return;
      const previous = this.config;
        const portChanged = next.port !== previous.port;
        const autoStartChanged = next.autoStart !== previous.autoStart;
        const readyTimeoutChanged = next.readyTimeoutMs !== previous.readyTimeoutMs;

        if (!portChanged && !autoStartChanged && !readyTimeoutChanged) return;

        if (portChanged || (autoStartChanged && !next.autoStart)) {
          await this.stop();
        }

        this.config = { ...next };

        if (next.autoStart && (portChanged || autoStartChanged)) {
          await this.start();
        } else {
          const changes: string[] = [];
          if (portChanged) changes.push(`port=${next.port}`);
          if (autoStartChanged) changes.push(`autoStart=${next.autoStart}`);
          if (readyTimeoutChanged) changes.push(`readyTimeoutMs=${next.readyTimeoutMs}`);
          this.dependencies.logger.info(
            `[dsh-chatgpt-web] Live configuration applied (${changes.join(", ")}).`,
          );
        }
      });
    this.reconfiguration = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    ++this.generation;
    const pendingStart = this.startPromise;
    if (pendingStart) {
      await pendingStart.catch(() => {});
    }
    await this.terminationForCurrentProcess();
  }

  get activeProcessPort(): number | undefined {
    return this.spawnedPort;
  }

  private async startGeneration(): Promise<void> {
    const generation = ++this.generation;
    const targetPort = this.config.port;
    const targetHost = this.config.host;
    const targetAutoStart = this.config.autoStart;
    const targetReadyTimeoutMs = this.config.readyTimeoutMs;
    const targetBunPath = this.config.bunPath;
    const alreadyHealthy = await this.isHealthy(targetHost, targetPort);
    if (generation !== this.generation) return;
    if (alreadyHealthy) {
      this.dependencies.logger.info(
        `[dsh-chatgpt-web] Sidecar already running and healthy at http://${targetHost}:${targetPort}/v1`,
      );
      return;
    }

    if (!targetAutoStart) {
      this.dependencies.logger.warn(
        "[dsh-chatgpt-web] Sidecar is offline and autoStart is false. Start it manually with 'bun run src/cli.ts serve'",
      );
      return;
    }

    const launcher = this.dependencies.resolveLauncher(targetBunPath, targetPort);
    this.dependencies.logger.info(
      `[dsh-chatgpt-web] Starting dsh-chatgpt-web daemon via ${launcher.cmd} at http://${targetHost}:${targetPort}/v1...`,
    );

    const child = this.dependencies.spawn(launcher.cmd, launcher.args, {
      cwd: this.dependencies.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    this.spawnedProcess = child;
    this.spawnedPort = targetPort;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof this.dependencies.logger.debug === "function") {
        this.dependencies.logger.debug(`[sidecar] ${this.dependencies.safeTextDescriptor(text)}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && typeof this.dependencies.logger.debug === "function") {
        this.dependencies.logger.debug(`[sidecar:err] ${this.dependencies.safeTextDescriptor(text)}`);
      }
    });

    let spawnError: unknown;
    child.on("error", (error) => {
      spawnError = error;
      this.dependencies.logger.error(
        `[dsh-chatgpt-web] Failed to launch sidecar process ${this.dependencies.safeErrorDescriptor(error)}`,
      );
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.dependencies.logger.warn(
          `[dsh-chatgpt-web] Sidecar process exited with code ${code} (signal: ${signal})`,
        );
      }
      if (this.spawnedProcess === child) {
        this.spawnedProcess = undefined;
        this.spawnedPort = undefined;
      }
    });

    const exitPromise = this.waitForExit(child);
    const deadline = Date.now() + targetReadyTimeoutMs;
    while (Date.now() < deadline) {
      if (generation !== this.generation) {
        await this.terminateChild(child);
        return;
      }
      if (await this.isHealthy(targetHost, targetPort)) {
        this.dependencies.logger.info(
          `[dsh-chatgpt-web] Sidecar ready and accepting turns at http://${targetHost}:${targetPort}/v1`,
        );
        return;
      }
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
        exitPromise,
      ]);
      if (spawnError) {
        await this.terminateChild(child);
        throw new Error(
          `ChatGPT Web sidecar failed to start: ${this.dependencies.safeErrorDescriptor(spawnError)}`,
          { cause: spawnError },
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        await this.terminateChild(child);
        throw new Error("ChatGPT Web sidecar exited before becoming healthy");
      }
    }

    if (generation !== this.generation) {
      await this.terminateChild(child);
      return;
    }

    this.dependencies.logger.error(
      `[dsh-chatgpt-web] Sidecar did not become healthy within ${targetReadyTimeoutMs}ms`,
    );
    await this.terminateChild(child);
    throw new Error(
      `ChatGPT Web sidecar did not become healthy within ${targetReadyTimeoutMs}ms`,
    );
  }

  private async isHealthy(host: string, port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await this.dependencies.fetch(
          `http://${host}:${port}/healthz`,
          { signal: controller.signal },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { status?: string };
        return body.status === "ok";
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", settle);
      child.once("error", settle);
    });
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    const existing = this.terminationPromises.get(child);
    if (existing) return existing;
    const promise = this.terminateChildOnce(child).finally(() => {
      if (this.terminationPromises.get(child) === promise) this.terminationPromises.delete(child);
    });
    this.terminationPromises.set(child, promise);
    await promise;
  }

  private async terminateChildOnce(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.spawnedProcess === child) {
        this.spawnedProcess = undefined;
        this.spawnedPort = undefined;
      }
      return;
    }

    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill("SIGTERM");
    }

    const exited = this.waitForExit(child);
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);

    if (!graceful && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the check and kill.
      }
      await exited;
    }

    if (this.spawnedProcess === child) {
      this.spawnedProcess = undefined;
      this.spawnedPort = undefined;
    }
  }

  private async terminationForCurrentProcess(): Promise<void> {
    const child = this.spawnedProcess;
    if (!child) return;
    await this.terminateChild(child);
  }
}
