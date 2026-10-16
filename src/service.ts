import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir } from "./config";
import {
  assertMacOs,
  launchAgentPlist,
  launchdDomain,
  launchdPlistPath,
  launchdServiceTarget,
  waitForLaunchdServiceUnloaded,
} from "./launchd";
import { runCommand, runChecked } from "./process";

const LABEL = "io.github.codex-chatgpt-web.daemon";
const MACOS_REQUIRED_MESSAGE = "Terminal-managed background services require macOS.";

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  label: string;
  definitionPath?: string;
}

async function bootstrapService(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown launchctl bootstrap failure";
  while (Date.now() < deadline) {
    const result = runCommand("launchctl", ["bootstrap", launchdDomain(), path]);
    if (result.status === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`launchctl bootstrap ${launchdDomain()} ${path} failed after ${timeoutMs}ms: ${lastError}`);
}

function plist(config: AppConfig): string {
  return launchAgentPlist({
    label: LABEL,
    programArguments: [...config.runtimeCommand, "serve"],
    logName: "daemon",
    configDir: getConfigDir(),
  });
}

export function getServiceStatus(): ServiceStatus {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, label: LABEL };
  const path = launchdPlistPath(LABEL);
  const result = runCommand("launchctl", ["print", launchdServiceTarget(LABEL)]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    label: LABEL,
    definitionPath: path,
  };
}

export function installService(config: AppConfig): ServiceStatus {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  assertDurableRuntimeCommand(config.runtimeCommand);
  const path = launchdPlistPath(LABEL);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = plist(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchdDomain(), path]);
  return getServiceStatus();
}

export function startService(): ServiceStatus {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  const path = launchdPlistPath(LABEL);
  if (!existsSync(path)) throw new Error(`Service is not installed: ${path}`);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchdDomain(), path]);
  return getServiceStatus();
}

export interface DrainLease {
  release: () => Promise<void>;
}

async function control(config: AppConfig, action: "drain" | "resume" | "cancel-turns"): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function interruptActiveTurn(
  config: AppConfig,
  identity: { threadId: string; turnId: string },
): Promise<{ cancelledHttpTurns: number; cancelledBrowserTurns: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(identity),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json() as Record<string, unknown>;
    const cancelledHttpTurns = result.cancelled_http_turns;
    const cancelledBrowserTurns = result.cancelled_browser_turns;
    if (result.status !== "ok"
      || !Number.isInteger(cancelledHttpTurns) || (cancelledHttpTurns as number) < 0
      || !Number.isInteger(cancelledBrowserTurns) || (cancelledBrowserTurns as number) < 0) {
      throw new Error("daemon returned an invalid interrupt acknowledgement");
    }
    return {
      cancelledHttpTurns: cancelledHttpTurns as number,
      cancelledBrowserTurns: cancelledBrowserTurns as number,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function cancelActiveTurns(config: AppConfig): Promise<{
  cancelledHttpTurns: number;
  cancelledBrowserTurns: number;
}> {
  const result = await control(config, "cancel-turns");
  const cancelledHttpTurns = result.cancelled_http_turns;
  const cancelledBrowserTurns = result.cancelled_browser_turns;
  if (!Number.isInteger(cancelledHttpTurns) || (cancelledHttpTurns as number) < 0
    || !Number.isInteger(cancelledBrowserTurns) || (cancelledBrowserTurns as number) < 0
    || result.active_http_turns !== 0 || result.active_browser_turns !== 0) {
    throw new Error("daemon did not acknowledge complete active-turn cancellation");
  }
  return {
    cancelledHttpTurns: cancelledHttpTurns as number,
    cancelledBrowserTurns: cancelledBrowserTurns as number,
  };
}

export async function negotiateDrain(
  controlAction: (action: "drain" | "resume") => Promise<Record<string, unknown>>,
): Promise<DrainLease> {
  let drained = false;
  let drainAttempted = false;
  try {
    drainAttempted = true;
    const health = await controlAction("drain");
    drained = true;
    const activeHttp = health.active_http_turns;
    const activeBrowser = health.active_browser_turns;
    if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser) || health.accepting_turns !== false) {
      throw new Error("daemon did not acknowledge the drain contract");
    }
    if ((activeHttp as number) > 0 || (activeBrowser as number) > 0) {
      throw new Error(`daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`);
    }
    return { release: async () => { if (drained) { await controlAction("resume"); drained = false; } } };
  } catch (error) {
    let resumeError: unknown;
    if (drainAttempted) {
      try {
        await controlAction("resume");
        drained = false;
      } catch (caught) {
        resumeError = caught;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const compensation = resumeError
      ? `; compensating resume also failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`
      : "";
    throw new Error(`Refusing to stop or restart because atomic idleness could not be proven: ${message}${compensation}`);
  }
}

async function acquireDrain(config: AppConfig): Promise<DrainLease> {
  if (!getServiceStatus().loaded) return { release: async () => {} };
  return negotiateDrain(action => control(config, action));
}

async function releaseDrainAfterFailure(lease: DrainLease, failure: unknown): Promise<never> {
  try {
    await lease.release();
  } catch (resumeError) {
    const primary = failure instanceof Error ? failure.message : String(failure);
    const compensation = resumeError instanceof Error ? resumeError.message : String(resumeError);
    throw new Error(`${primary}; compensating daemon resume also failed: ${compensation}`);
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

export async function assertServiceIdle(config: AppConfig): Promise<void> {
  const lease = await acquireDrain(config);
  await lease.release();
}

export async function restartService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  if (!getServiceStatus().loaded) return startService();
  const lease = await acquireDrain(config);
  try {
    runChecked("launchctl", ["bootout", launchdServiceTarget(LABEL)]);
    await waitForLaunchdServiceUnloaded({ label: LABEL, isLoaded: () => getServiceStatus().loaded });
    await bootstrapService(launchdPlistPath(LABEL));
  } catch (error) {
    return releaseDrainAfterFailure(lease, error);
  }
  return getServiceStatus();
}

export function removeLegacyRuntimeArtifacts(config: AppConfig): void {
  const legacyWrapper = join(getConfigDir(), "bin", "serve-with-playwright.sh");
  const legacyVendor = join(getConfigDir(), "vendor");
  if (config.runtimeCommand.some(part => part === legacyWrapper || part.startsWith(`${legacyVendor}/`))) {
    throw new Error("Refusing to remove legacy runtime artifacts while the active service still references them");
  }
  rmSync(legacyWrapper, { force: true });
  rmSync(legacyVendor, { recursive: true, force: true });
}

export async function stopService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", launchdServiceTarget(LABEL)]);
      await waitForLaunchdServiceUnloaded({ label: LABEL, isLoaded: () => getServiceStatus().loaded });
    } catch (error) {
      return releaseDrainAfterFailure(lease, error);
    }
  }
  return getServiceStatus();
}

export async function uninstallService(config: AppConfig): Promise<ServiceStatus> {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      runChecked("launchctl", ["bootout", launchdServiceTarget(LABEL)]);
      await waitForLaunchdServiceUnloaded({ label: LABEL, isLoaded: () => getServiceStatus().loaded });
    } catch (error) {
      return releaseDrainAfterFailure(lease, error);
    }
  }
  rmSync(launchdPlistPath(LABEL), { force: true });
  return getServiceStatus();
}
