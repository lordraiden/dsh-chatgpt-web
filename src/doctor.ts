import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { join } from "node:path";
import { createChatGptWebDriver } from "./adapters/chatgpt-web/chatgpt-driver";
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

export type CheckStatus = "ok" | "warning" | "error";

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
  return [createChatGptWebDriver({ provider: effectiveChatGptWebProviderConfig(config) })];
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
          ? `WebChat provider "${check.providerId}" is reachable but not authenticated`
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

export async function runDoctor(): Promise<DoctorReport> {
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
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
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
