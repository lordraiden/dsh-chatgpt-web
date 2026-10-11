/**
 * Issue #193 (corrections C1 + C4) — one effective provider configuration, validated in both blocks.
 *
 * Correction C1: the seams that decide ChatGPT Web provider facts (the route authority, the model
 * catalogue behind `/v1/models`, `/v1/responses` and `/internal/native-llm`) read the *flat* AppConfig
 * while the adapter and driver read `webChat.providers["chatgpt-web"]`. They now all read one resolver,
 * resolved per call, without `webChat` structurally identical to `providerConfig(config)`.
 *
 * Correction C4: `validateChatGptWebTuning` only ever ran on `parsed.tuning`, so a provider-scoped
 * block was accepted by shape and then cast into the driver. The same validator now owns both
 * descriptions of the facts, so a malformed internal value or an incoherent capability combination is
 * refused with its location.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createChatGptWebRouteAuthorityFromProvider,
  availableChatGptWebRoutes,
} from "../src/chatgpt-web-authority";
import { effectiveChatGptWebProviderConfig } from "../src/chatgpt-web-provider-config";
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  providerConfig,
  type AppConfig,
} from "../src/config";
import { buildChatGptWebModelCatalog } from "../src/model-catalog";
import { modelsRequest, routeChatGptWebRequest, startServer } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(() => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-193-effective-"));
  delete process.env.DSH_CHATGPT_FREE_HOME;
  process.env.DSH_CHATGPT_WEB_HOME = home;
});

afterEach(() => {
  if (previousFreeHome === undefined) delete process.env.DSH_CHATGPT_FREE_HOME;
  else process.env.DSH_CHATGPT_FREE_HOME = previousFreeHome;
  if (previousWebHome === undefined) delete process.env.DSH_CHATGPT_WEB_HOME;
  else process.env.DSH_CHATGPT_WEB_HOME = previousWebHome;
  rmSync(home, { recursive: true, force: true });
});

function writeRaw(overrides: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify({ ...defaultConfig(), ...overrides }, null, 2));
}

/** The flat block that serves the Sol model routes (the contrast for a Luna-only scoped block). */
function flatSolConfig(): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    solAvailable: true,
    proAvailable: false,
    capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
  };
}

/** A scoped block that makes the same deployment Luna-only: it must reach every seam. */
const LUNA_ONLY_SCOPED = {
  browserInteractionMode: "automatic",
  browserHost: "managed-chrome",
  solAvailable: false,
  proAvailable: false,
  capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
} as const;

function scopedLunaConfig(block: Record<string, unknown> = LUNA_ONLY_SCOPED): AppConfig {
  return {
    ...flatSolConfig(),
    webChat: { providers: { "chatgpt-web": block } },
  };
}

function slugs(catalog: { models?: unknown }): string[] {
  return (catalog.models as Array<{ slug: string }>).map(model => model.slug);
}

function parsed(modelId = "chatgpt-web/luna"): CodexParsedRequest {
  return {
    modelId,
    context: { systemPrompt: [], messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }] },
    stream: false,
    options: {},
  } as unknown as CodexParsedRequest;
}

describe("issue #193 — one effective provider configuration", () => {
  test("without webChat the effective configuration is structurally providerConfig(config)", () => {
    const configs: AppConfig[] = [
      defaultConfig(),
      flatSolConfig(),
      { ...flatSolConfig(), tuning: { composerCharLimit: 1_000 } },
      { ...flatSolConfig(), browserInteractionMode: "automatic", zeroRiskProEnabled: false },
    ];
    for (const config of configs) {
      expect(effectiveChatGptWebProviderConfig(config)).toEqual(providerConfig(config));
    }
    // Nothing is added to the flat block either.
    expect(effectiveChatGptWebProviderConfig(defaultConfig()).chatgptWeb).not.toHaveProperty("webChat");
  });

  test("the scoped block reaches the resolver, the authority, the catalogue and both ingress seams", async () => {
    const config = scopedLunaConfig();
    const expectedSlugs = ["chatgpt-web/luna", "chatgpt-web/think"];

    // 1. The resolver: the provider facts every other seam derives from.
    const effective = effectiveChatGptWebProviderConfig(config);
    expect(effective.chatgptWeb).toBe(LUNA_ONLY_SCOPED);

    // 2. Route authority.
    const authority = createChatGptWebRouteAuthorityFromProvider(effective);
    expect(authority.capabilities).toEqual({ solAvailable: "unsupported", proAvailable: "unsupported" });
    const routes = availableChatGptWebRoutes(authority).map(route => route.slug);
    expect([...routes]).toEqual(expectedSlugs);

    // 3. Model catalogue. The flat block alone would advertise the Sol routes, so this is the scoped
    //    block changing the answer rather than an accident of the fixture.
    expect(slugs(buildChatGptWebModelCatalog(config))).toEqual(expectedSlugs);
    expect(slugs(buildChatGptWebModelCatalog(flatSolConfig()))).toContain("chatgpt-web/light");

    // 4. `/v1/models`.
    const models = await modelsRequest(
      new Request("http://127.0.0.1/v1/models"),
      config,
      async () => new Response("native Codex unavailable", { status: 503 }),
    );
    expect(models.status).toBe(200);
    expect(slugs(await models.json() as { models?: unknown })).toEqual(expectedSlugs);

    // 5. `/v1/responses` routing: the Luna model resolves under the scoped facts...
    const responsesParsed = parsed();
    expect(routeChatGptWebRequest(responsesParsed, config).slug).toBe("chatgpt-web/luna");
    // ...and would be refused by the flat block alone, which serves only the Sol routes.
    expect(() => routeChatGptWebRequest(parsed(), flatSolConfig())).toThrow();

    // 6. `/internal/native-llm`: the real listener, with the provider facts the handler built.
    const seen: CodexProviderConfig[] = [];
    const adapter: ProviderAdapter = {
      name: "issue-193-effective-test",
      runTurn: async (_parsed, _incoming, emit) => {
        emit({ type: "text_delta", text: "efectivo", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
    const running = startServer(config, {
      adapterFactory: provider => {
        seen.push(provider);
        return adapter;
      },
    });
    try {
      const nativeParsed = parsed();
      routeChatGptWebRequest(nativeParsed, config);
      nativeParsed._dshContext = {
        dshSessionId: "issue-193-effective-session",
        threadId: "issue-193-effective-thread",
        turnId: "issue-193-effective-turn",
      };
      const response = await fetch(`http://127.0.0.1:${running.port}/internal/native-llm`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "chatgpt-web/luna", request: nativeParsed }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.chatgptWeb).toBe(LUNA_ONLY_SCOPED);
    } finally {
      await running.stop(true);
    }
  });

  test("a scoped field wins over a flat field mutated in memory, and resolution is per call", () => {
    const config = scopedLunaConfig({
      browserInteractionMode: "automatic",
      browserHost: "managed-chrome",
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
      tuning: { composerCharLimit: 111 },
    });
    // The control API mutates the in-memory flat configuration between turns.
    config.tuning = { composerCharLimit: 999 };
    config.solAvailable = true;
    config.capabilityState = { solAvailable: "supported", proAvailable: "unsupported" };

    const effective = effectiveChatGptWebProviderConfig(config);
    expect(effective.chatgptWeb?.tuning?.composerCharLimit).toBe(111);
    expect(effective.chatgptWeb?.capabilityState).toEqual({
      solAvailable: "unsupported",
      proAvailable: "unsupported",
    });

    // The same mutation is honored when no scoped block covers the field: the resolver does not cache.
    const flatOnly = { ...config, webChat: undefined };
    expect(effectiveChatGptWebProviderConfig(flatOnly).chatgptWeb?.tuning?.composerCharLimit).toBe(999);
    flatOnly.tuning = { composerCharLimit: 555 };
    expect(effectiveChatGptWebProviderConfig(flatOnly).chatgptWeb?.tuning?.composerCharLimit).toBe(555);
  });
});

describe("issue #193 — the scoped block is validated by the same owner as the flat block", () => {
  const rejected: Array<{ label: string; block: Record<string, unknown>; message: RegExp }> = [
    { label: "a boolean fact that is not a boolean", block: { solAvailable: "yes" }, message: /Invalid solAvailable in .*webChat\.providers\["chatgpt-web"\]/ },
    { label: "a capability pair where Pro outruns Sol", block: { capabilityState: { solAvailable: "unsupported", proAvailable: "supported" } }, message: /Pro requires supported Sol/ },
    { label: "a Pro claim contradicting an unsupported flat capability", block: { solAvailable: false, proAvailable: true, capabilityState: undefined }, message: /Pro requires/ },
    { label: "Zero Risk with Bigger Context", block: { browserInteractionMode: "manual", experimentalBiggerContext: true }, message: /Zero Risk does not support Bigger Context/ },
    { label: "an unknown browser mode", block: { browserInteractionMode: "sideways" }, message: /Invalid browserInteractionMode/ },
    { label: "a launcher host without its descriptor", block: { browserHost: "launcher" }, message: /Launcher browser host requires browserHostDescriptorPath/ },
    { label: "a non-string storage state path", block: { storageStatePath: 7 }, message: /Invalid storageStatePath/ },
    { label: "malformed tuning", block: { tuning: { notATuningKey: 1 } }, message: /Unknown tuning key notATuningKey/ },
  ];

  for (const { label, block, message } of rejected) {
    test(`${label} is refused when the configuration is loaded`, () => {
      writeRaw({ webChat: { providers: { "chatgpt-web": block } } });
      expect(() => loadConfig()).toThrow(message);
    });

    test(`${label} is refused by the resolver too (an in-memory block bypasses the loader)`, () => {
      const config = scopedLunaConfig(block);
      expect(() => effectiveChatGptWebProviderConfig(config)).toThrow(message);
    });
  }

  test("the flat block keeps today's capability refusals", () => {
    // No capabilityState: the tri-state is derived from the boolean claims, exactly as before.
    writeRaw({ proAvailable: true, capabilityState: undefined });
    expect(() => loadConfig()).toThrow(/Pro requires supported Sol/);

    writeRaw({
      solAvailable: true,
      capabilityState: { solAvailable: "unknown", proAvailable: "unknown" },
    });
    expect(() => loadConfig()).toThrow(/Invalid Sol capability state/);
  });
});
