/**
 * Issue #193 (P4) — the doctor reports every WebChat provider.
 *
 * The host boundary exposed `webChatProviderCheck` but the doctor never consumed it, so an
 * unauthenticated or unhealthy provider was invisible in `dsh-chatgpt-web doctor`. The report now
 * carries one check per provider with its authentication, capabilities and health, read from the
 * driver: a driver that throws is unhealthy rather than hidden, and the detail never carries a
 * credential or a complete account fingerprint.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor, webChatProviderChecks } from "../src/doctor";
import { defaultConfig, saveConfig } from "../src/config";
import {
  CHATGPT_WEB_DRIVER_ID,
  inspectWebChatProvider,
  redactWebChatFingerprint,
  webChatDoctorCheck,
} from "../src/web-chat/host/dsh-integration";
import type { WebChatModelDescriptor, WebChatProviderDriver } from "../src/web-chat/core";

const FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function driver(overrides: Partial<WebChatProviderDriver> = {}): WebChatProviderDriver {
  const models: readonly WebChatModelDescriptor[] = [{ id: "chatgpt-web/luna", label: "Luna", text: true }];
  return {
    id: CHATGPT_WEB_DRIVER_ID,
    inspectAccount: async () => ({
      authenticated: true,
      accountFingerprint: FINGERPRINT,
      capabilities: { sol: "unsupported" as const, pro: "unsupported" as const },
    }),
    listModels: async () => models,
    resolveModel: async model => models.find(candidate => candidate.id === model),
    assessConversation: async () => ({ status: "new" }),
    createConversation: async input => ({
      key: "key",
      providerId: CHATGPT_WEB_DRIVER_ID,
      bindingId: input.affinity.bindingId,
      generation: 1,
      handle: "handle" as never,
      status: "new",
    }),
    resumeConversation: async input => input.conversation,
    replayConversation: async input => input.conversation!,
    health: async () => ({ ok: true, detail: "2 routes available" }),
    shutdown: async () => {},
    ...overrides,
  };
}

describe("issue #193 — the doctor reports one check per provider", () => {
  test("a healthy driver reports authentication, capabilities and health without the full fingerprint", async () => {
    const checks = await webChatProviderChecks([driver()]);
    expect(checks).toHaveLength(1);
    const [check] = checks;
    expect(check?.id).toBe(`webchat-${CHATGPT_WEB_DRIVER_ID}`);
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("authenticated and healthy");
    expect(check?.detail).toContain("authenticated (01234567…)");
    expect(check?.detail).toContain("unsupported: sol, pro");
    expect(check?.detail).toContain("1 model");
    expect(check?.detail).toContain("2 routes available");
    // No credential material and no complete account identifier.
    expect(check?.detail).not.toContain(FINGERPRINT);
    expect(check?.detail).not.toContain("token");
    expect(check?.detail).not.toContain("cookie");
    expect(check?.detail).not.toContain("storageState");
    expect(JSON.stringify(checks)).not.toContain(FINGERPRINT);
  });

  test("an unauthenticated provider is a warning", async () => {
    const checks = await webChatProviderChecks([driver({ inspectAccount: async () => ({ authenticated: false }) })]);
    expect(checks[0]?.status).toBe("warning");
    expect(checks[0]?.message).toContain("not authenticated");
  });

  test("an unhealthy driver is an error carrying its detail", async () => {
    const checks = await webChatProviderChecks([
      driver({ health: async () => ({ ok: false, detail: "no ChatGPT Web route is available for this deployment" }) }),
    ]);
    expect(checks[0]?.status).toBe("error");
    expect(checks[0]?.message).toContain("unhealthy");
    expect(checks[0]?.detail).toContain("no ChatGPT Web route is available");
  });

  test("a driver that throws is reported unhealthy, never hidden and never fatal", async () => {
    const checks = await webChatProviderChecks([
      driver({
        inspectAccount: async () => { throw new Error("the browser session is not authenticated"); },
      }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("error");
    expect(checks[0]?.detail).toContain("the browser session is not authenticated");
    expect(checks[0]?.detail).toContain("not authenticated");
    // The failure did not discard the check: an empty report is exactly what the boundary forbids.
    expect(checks[0]?.detail).not.toContain(FINGERPRINT);

    const listing = await webChatProviderChecks([
      driver({ listModels: async () => { throw new Error("sidecar closed"); } }),
    ]);
    expect(listing[0]?.status).toBe("error");
    expect(listing[0]?.detail).toContain("sidecar closed");
  });
});

describe("issue #193 — the doctor-facing provider check keeps identifiers short", () => {
  test("only a fingerprint prefix is printed, and short identifiers stay readable", async () => {
    expect(redactWebChatFingerprint(FINGERPRINT)).toBe("01234567…");
    expect(redactWebChatFingerprint("short")).toBe("short");
    expect(redactWebChatFingerprint("  padded  ")).toBe("padded");

    const check = webChatDoctorCheck(await inspectWebChatProvider(driver()));
    expect(check.detail).toContain("01234567…");
    expect(check.detail).not.toContain(FINGERPRINT);
  });

  test("runDoctor includes the provider check in the report it prints", async () => {
    const previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
    const previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
    const home = mkdtempSync(join(tmpdir(), "issue-193-doctor-"));
    try {
      delete process.env.DSH_CHATGPT_FREE_HOME;
      process.env.DSH_CHATGPT_WEB_HOME = home;
      saveConfig(defaultConfig());

      const report = await runDoctor();
      const provider = report.checks.filter(check => check.id === `webchat-${CHATGPT_WEB_DRIVER_ID}`);
      expect(provider).toHaveLength(1);
      // The provider facts are in the report; the status itself depends on the account state.
      expect(provider[0]?.detail).toContain("model");
    } finally {
      if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
      else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
      if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
      else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
