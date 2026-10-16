import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import {
  assertMacOs,
  launchAgentPlist,
  launchdDomain,
  launchdPlistPath,
  launchdServiceTarget,
  waitForLaunchdServiceUnloaded,
} from "./launchd";
import { runCommand, runChecked } from "./process";

const LABEL = "io.github.codex-chatgpt-web.tunnel";
const MACOS_REQUIRED_MESSAGE = "Managed tunnel service installation is currently supported on macOS only";

export interface TunnelServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  definitionPath?: string;
}

function settings(config: AppConfig) {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel service requires full mode");
  return config.tunnel;
}

export function tunnelServiceDefinition(config: AppConfig): string {
  const tunnel = settings(config);
  return launchAgentPlist({
    label: LABEL,
    programArguments: [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName],
    logName: "tunnel",
    configDir: getConfigDir(),
  });
}

export function getTunnelServiceStatus(): TunnelServiceStatus {
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, running: false, label: LABEL };
  }
  const path = launchdPlistPath(LABEL);
  const result = runCommand("launchctl", ["print", launchdServiceTarget(LABEL)]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: LABEL,
    definitionPath: path,
  };
}

export function tunnelServiceDefinitionMatches(config: AppConfig): boolean {
  const path = launchdPlistPath(LABEL);
  return existsSync(path) && readFileSync(path, "utf8") === tunnelServiceDefinition(config);
}

export function installTunnelService(config: AppConfig): TunnelServiceStatus {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  const tunnel = settings(config);
  const profile = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
  if (!existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
  if (!existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
  const current = getTunnelServiceStatus();
  const next = tunnelServiceDefinition(config);
  if (current.loaded && (!current.installed || readFileSync(launchdPlistPath(LABEL), "utf8") !== next)) {
    throw new Error("Refusing to replace a loaded tunnel service definition; stop it before installing the update");
  }
  mkdirSync(dirname(launchdPlistPath(LABEL)), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  if (!current.installed || readFileSync(launchdPlistPath(LABEL), "utf8") !== next) atomicWriteFile(launchdPlistPath(LABEL), next);
  if (!current.loaded) runChecked("launchctl", ["bootstrap", launchdDomain(), launchdPlistPath(LABEL)]);
  return getTunnelServiceStatus();
}

export function startTunnelService(): TunnelServiceStatus {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  if (!existsSync(launchdPlistPath(LABEL))) throw new Error("Tunnel service is not installed; rerun full setup");
  if (!getTunnelServiceStatus().loaded) runChecked("launchctl", ["bootstrap", launchdDomain(), launchdPlistPath(LABEL)]);
  return getTunnelServiceStatus();
}

export async function stopTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  if (getTunnelServiceStatus().loaded) {
    runChecked("launchctl", ["bootout", launchdServiceTarget(LABEL)]);
    await waitForLaunchdServiceUnloaded({ label: LABEL, isLoaded: () => getTunnelServiceStatus().loaded });
  }
  return getTunnelServiceStatus();
}

export async function restartTunnelService(): Promise<TunnelServiceStatus> {
  await stopTunnelService();
  return startTunnelService();
}

export async function uninstallTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs(MACOS_REQUIRED_MESSAGE);
  await stopTunnelService();
  rmSync(launchdPlistPath(LABEL), { force: true });
  return getTunnelServiceStatus();
}
