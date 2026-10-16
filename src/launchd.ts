import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Shared owner of the macOS launchd plumbing used by both managed services:
 * the daemon (`src/service.ts`) and the tunnel client (`src/tunnel-service.ts`).
 *
 * The two services differ only in their label, their program arguments, the log
 * file basename and their operator-facing non-macOS error message. Every other part
 * of the plist/domain/target construction, the macOS gate and the unload wait is
 * identical, so it lives here once.
 */

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** `~/Library/LaunchAgents/<label>.plist`. */
export function launchdPlistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** The per-user launchd domain, for example `gui/501`. */
export function launchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

/** The fully qualified service target, for example `gui/501/<label>`. */
export function launchdServiceTarget(label: string): string {
  return `${launchdDomain()}/${label}`;
}

export interface LaunchAgentPlistOptions {
  label: string;
  programArguments: readonly string[];
  /** Basename stem of the standard out/error logs inside `<configDir>/logs`. */
  logName: string;
  /** Service data directory recorded as `DSH_CHATGPT_FREE_HOME`. */
  configDir: string;
}

export function launchAgentPlist(options: LaunchAgentPlistOptions): string {
  const logDir = join(options.configDir, "logs");
  const args = [...options.programArguments];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${options.label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_CHATGPT_FREE_HOME</key>
    <string>${xmlEscape(options.configDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, `${options.logName}.stdout.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, `${options.logName}.stderr.log`))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** Fail closed on non-macOS hosts with the caller's operator-facing message. */
export function assertMacOs(reason: string): void {
  if (process.platform !== "darwin") {
    throw new Error(reason);
  }
}

export interface WaitForLaunchdUnloadOptions {
  label: string;
  /** Read the service's live `loaded` state; the wait polls this. */
  isLoaded: () => boolean;
  timeoutMs?: number;
}

export async function waitForLaunchdServiceUnloaded(options: WaitForLaunchdUnloadOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  while (options.isLoaded() && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (options.isLoaded()) throw new Error(`launchd did not unload ${options.label} after ${timeoutMs}ms`);
}
