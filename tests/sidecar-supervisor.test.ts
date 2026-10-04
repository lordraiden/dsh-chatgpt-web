import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { SidecarSupervisor } from "../src/sidecar-supervisor";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly exitDelayMs = 20) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    setTimeout(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }, this.exitDelayMs);
    return true;
  }
}

function createHarness(options: {
  health: (child: FakeChild | undefined) => boolean;
  readyTimeoutMs?: number;
}) {
  let child: FakeChild | undefined;
  let spawnCount = 0;
  const logs: string[] = [];

  const fetchImpl = async (input: URL | Request | string) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return Response.json({ status: options.health(child) ? "ok" : "down" });
    }
    if (url.endsWith("/admin/shutdown")) {
      return Response.json({ status: "ok" });
    }
    throw new Error("unexpected request " + url);
  };

  const supervisor = new SidecarSupervisor(
    {
      host: "127.0.0.1",
      port: 17841,
      autoStart: true,
      readyTimeoutMs: options.readyTimeoutMs ?? 100,
    },
    {
      resolveLauncher: () => ({ cmd: "fake", args: [] }),
      spawn: () => {
        spawnCount += 1;
        child = new FakeChild();
        return child as unknown as ChildProcess;
      },
      fetch: fetchImpl as typeof fetch,
      cwd: process.cwd(),
      logger: {
        info: message => logs.push("info:" + message),
        warn: message => logs.push("warn:" + message),
        error: message => logs.push("error:" + message),
        debug: message => logs.push("debug:" + message),
      },
      safeErrorDescriptor: value => String(value),
      safeTextDescriptor: value => value,
    },
  );

  return {
    supervisor,
    getChild: () => child,
    getSpawnCount: () => spawnCount,
    logs,
  };
}

describe("SidecarSupervisor", () => {
  test("coalesces concurrent starts and waits for owned process exit on stop", async () => {
    const harness = createHarness({ health: child => Boolean(child && !child.killed) });
    await Promise.all([harness.supervisor.start(), harness.supervisor.start()]);

    assert.equal(harness.getSpawnCount(), 1);
    const child = harness.getChild();
    assert(child);

    const stopStartedAt = Date.now();
    await harness.supervisor.stop();
    expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(15);
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(harness.supervisor.activeProcessPort, undefined);
  });

  test("terminates a child that never becomes healthy instead of leaking it", async () => {
    const harness = createHarness({ health: () => false, readyTimeoutMs: 0 });

    await harness.supervisor.start();

    const child = harness.getChild();
    assert(child);
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(harness.supervisor.activeProcessPort, undefined);
    assert(harness.logs.some(line => line.includes("did not become healthy")));
  });

  test("reconfiguration targets the new port and keeps the provider endpoint current before restart", async () => {
    const harness = createHarness({ health: child => Boolean(child && !child.killed) });

    await harness.supervisor.start();
    assert.equal(harness.getSpawnCount(), 1);

    await harness.supervisor.reconfigure({
      host: "127.0.0.1",
      port: 19001,
      autoStart: true,
      readyTimeoutMs: 100,
    });

    assert.equal(harness.getSpawnCount(), 2);
    assert.equal(harness.supervisor.activeProcessPort, 19001);
  });
  test("shutdown prevents an already-queued reconfiguration from respawning the sidecar", async () => {
    const harness = createHarness({ health: child => Boolean(child && !child.killed) });

    await harness.supervisor.start();
    assert.equal(harness.getSpawnCount(), 1);

    const reconfigure = harness.supervisor.reconfigure({
      host: "127.0.0.1",
      port: 19002,
      autoStart: true,
      readyTimeoutMs: 100,
    });
    const shutdown = harness.supervisor.shutdown();

    await Promise.all([reconfigure, shutdown]);

    assert.equal(harness.getSpawnCount(), 1);
    assert.equal(harness.getChild()?.signalCode, "SIGTERM");
    assert.equal(harness.supervisor.activeProcessPort, undefined);
  });

});
