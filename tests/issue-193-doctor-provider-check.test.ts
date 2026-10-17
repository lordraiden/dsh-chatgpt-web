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

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";
import { runDoctor, webChatProviderChecks } from "../src/doctor";
import { defaultConfig, saveConfig } from "../src/config";
import { createChatGptWebDriver } from "../src/adapters/chatgpt-web/chatgpt-driver";
import {
  CHATGPT_WEB_DRIVER_ID,
  inspectWebChatProvider,
  redactWebChatFingerprint,
  webChatDoctorCheck,
} from "../src/web-chat/host/provider-host";
import type { WebChatModelDescriptor, WebChatProviderDriver } from "../src/web-chat/core";
import type { CodexProviderConfig } from "../src/types";

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

  test("an unauthenticated provider is a warning that names the sign-in surface", async () => {
    const checks = await webChatProviderChecks([driver({ inspectAccount: async () => ({ authenticated: false }) })]);
    expect(checks[0]?.status).toBe("warning");
    expect(checks[0]?.message).toContain("not authenticated");
    // A provider reporting not authenticated here has no recorded sign-in. The operator is told what
    // is missing and where to record it, not merely that a boolean is false.
    expect(checks[0]?.message).toContain("no sign-in has been recorded");
    expect(checks[0]?.message).toContain("/v1/control/auth/");
  });

  test("a derived account identity reaches the operator as a missing sign-in, not a healthy account", async () => {
    // The real driver, with the identity `providerConfig` substitutes when nothing was recorded: the
    // doctor must report a warning that names the sign-in surface. The lease's refusal with the same
    // derived identity is pinned, unchanged, in the concurrency contract suite.
    const derived = createChatGptWebDriver({
      provider: {
        baseUrl: "http://127.0.0.1:17841",
        chatgptWeb: {
          accountIdentityFingerprint: "storage-state-derived-fallback",
          accountIdentityRecorded: false,
          // A healthy provider with a derived identity: the only failing fact must be the account.
          solAvailable: true,
          proAvailable: false,
          capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
        },
      } as unknown as CodexProviderConfig,
    });
    const checks = await webChatProviderChecks([derived]);
    expect(checks[0]?.status).toBe("warning");
    expect(checks[0]?.message).toContain("no sign-in has been recorded");
    expect(checks[0]?.message).toContain("/v1/control/auth/");
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
    const savedHome = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("issue-193-doctor-", { clearFreeHome: true });
    try {
      saveConfig(defaultConfig());

      const report = await runDoctor();
      const provider = report.checks.filter(check => check.id === `webchat-${CHATGPT_WEB_DRIVER_ID}`);
      expect(provider).toHaveLength(1);
      // The provider facts are in the report; the status itself depends on the account state.
      expect(provider[0]?.detail).toContain("model");
    } finally {
      restoreChatGptWebHome(savedHome, home);
    }
  });
});
