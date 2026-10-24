/**
 * Issue #193 (corrections C1 + C4) — one effective provider configuration, validated in both blocks.
 *
 * Correction C1: the seams that decide ChatGPT Web provider facts (the route authority, the model
 * catalogue behind `/v1/models` and `/v1/responses`) read the *flat* AppConfig
 * while the adapter and driver read `webChat.providers["chatgpt-web"]`. They now all read one resolver,
 * resolved per call, without `webChat` structurally identical to `providerConfig(config)`.
 *
 * Correction C4: `validateChatGptWebTuning` only ever ran on `parsed.tuning`, so a provider-scoped
 * block was accepted by shape and then cast into the driver. The same validator now owns both
 * descriptions of the facts, so a malformed internal value or an incoherent capability combination is
 * refused with its location.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

import {
  createChatGptWebRouteAuthorityFromProvider,
  availableChatGptWebRoutes,
} from "../src/chatgpt-web-authority";
import { effectiveChatGptWebProviderConfig } from "../src/chatgpt-web-provider-config";
import { webChatModelCatalogueEntries } from "../src/web-chat/host/provider-host";
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  providerConfig,
  type AppConfig,
} from "../src/config";
import { buildChatGptWebModelCatalog } from "../src/model-catalog";
import { browserAccountLeaseInput, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { modelsRequest, routeChatGptWebRequest, startServer } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

let home: string;
let savedHome: SavedChatGptWebHome;

beforeEach(() => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-193-effective-", { clearFreeHome: true });
});

afterEach(() => {
  restoreChatGptWebHome(savedHome, home);
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
    // The scoped fields are the ones in force; the block is an overlay, so the fields it does not
    // state keep the flat value (see the partial-block test below).
    expect(effective.chatgptWeb).toMatchObject(LUNA_ONLY_SCOPED);

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
    // The composed catalogue also carries the other providers' rows (DeepSeek Web's measured seeded row
    // needs no configuration), so this asserts the ChatGPT Web routes this configuration produces.
    const published = slugs(await models.json() as { models?: unknown });
    expect(published.filter(slug => slug.startsWith("chatgpt-web/"))).toEqual(expectedSlugs);

    // 5. `/v1/responses` routing: the Luna model resolves under the scoped facts...
    const responsesParsed = parsed();
    expect(routeChatGptWebRequest(responsesParsed, config).slug).toBe("chatgpt-web/luna");
    // ...and would be refused by the flat block alone, which serves only the Sol routes.
    expect(() => routeChatGptWebRequest(parsed(), flatSolConfig())).toThrow();

    // 6. `/v1/responses`: the real listener, with the provider facts the handler built.
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
      const response = await fetch(`http://127.0.0.1:${running.port}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "chatgpt-web/luna", input: "efectivo", stream: false }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.chatgptWeb).toMatchObject(LUNA_ONLY_SCOPED);
    } finally {
      await running.stop(true);
    }
  });

  test("a scoped field wins over a flat field mutated in memory, and resolution is per call", () => {
    const config = scopedLunaConfig({
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
    { label: "a Pro claim contradicting an unsupported flat capability", block: { solAvailable: false, proAvailable: true, capabilityState: undefined }, message: /Pro requires|capability state/ },
    { label: "an invalid browser mode", block: { browserInteractionMode: "sideways" }, message: /Invalid browserInteractionMode/ },
    { label: "a conflicting browser mode", block: { browserInteractionMode: "manual" }, message: /browserInteractionMode conflicts with deployment mode/ },

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

describe("issue #193 — a scoped block is an overlay, not a replacement (review)", () => {
  test("a partial scoped block keeps all undeclared facts, including a real derived fingerprint", () => {
    const flat = { ...flatSolConfig(), tuning: { composerCharLimit: 2_000 } };
    mkdirSync(dirname(flat.storageStatePath), { recursive: true });
    writeFileSync(flat.storageStatePath, JSON.stringify({ cookies: [], origins: [{ origin: "https://chatgpt.com", localStorage: [] }] }));
    const base = providerConfig(flat).chatgptWeb;
    const scopedTuning = { composerCharLimit: 1_000 };
    const config = {
      ...flat,
      webChat: { providers: { "chatgpt-web": { tuning: scopedTuning } } },
    };
    const effective = effectiveChatGptWebProviderConfig(config).chatgptWeb;

    expect(base?.accountIdentityFingerprint).toBeDefined();
    expect(base?.accountIdentityFingerprint).not.toBe("unknown");
    expect(effective).toEqual({ ...base, tuning: scopedTuning });
    expect(effective?.accountIdentityFingerprint).toBe(base?.accountIdentityFingerprint);
  });

  test("a scoped capability state decides the compatibility boolean it implies", () => {
    const effective = effectiveChatGptWebProviderConfig(scopedLunaConfig({
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
    })).chatgptWeb;

    // The block states no boolean for either capability: the state it does state decides, so the
    // facts the adapter reads can no longer contradict the capability the host reports.
    expect(effective?.solAvailable).toBe(false);
    expect(effective?.proAvailable).toBe(false);
  });

  test("a scoped capability state that contradicts an explicit boolean is refused", () => {
    const config = scopedLunaConfig({
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
      solAvailable: true,
    });
    // The merged block is what the shared validator checks, so this is refused with the block's
    // location instead of reaching the driver as an incoherent provider.
    expect(() => effectiveChatGptWebProviderConfig(config)).toThrow(/webChat\.providers\["chatgpt-web"\]/);
  });

  test("unknown scoped capabilities remove inherited legacy assertions", () => {
    const config = scopedLunaConfig({
      capabilityState: { solAvailable: "unknown", proAvailable: "unknown" },
    });
    const effective = effectiveChatGptWebProviderConfig(config).chatgptWeb;
    expect(effective?.capabilityState).toEqual({ solAvailable: "unknown", proAvailable: "unknown" });
    expect(effective).not.toHaveProperty("solAvailable");
    expect(effective).not.toHaveProperty("proAvailable");
  });

  test("an unrelated overlay clears normalized booleans inherited from a flat unknown state", () => {
    writeRaw({
      solAvailable: undefined,
      proAvailable: undefined,
      capabilityState: { solAvailable: "unknown", proAvailable: "unknown" },
      webChat: { providers: { "chatgpt-web": { tuning: { composerCharLimit: 1000 } } } },
    });
    const config = loadConfig();
    const effective = effectiveChatGptWebProviderConfig(config).chatgptWeb;
    expect(effective?.capabilityState).toEqual({ solAvailable: "unknown", proAvailable: "unknown" });
    expect(effective).not.toHaveProperty("solAvailable");
    expect(effective).not.toHaveProperty("proAvailable");
  });

  test("unknown scoped capabilities still reject explicitly contradictory legacy booleans", () => {
    expect(() => effectiveChatGptWebProviderConfig(scopedLunaConfig({
      capabilityState: { solAvailable: "unknown", proAvailable: "unknown" },
      solAvailable: false,
    }))).toThrow(/Invalid Sol capability state/);
  });

  test("inherited supported state rejects a contradictory scoped legacy boolean", () => {
    expect(() => effectiveChatGptWebProviderConfig(scopedLunaConfig({ solAvailable: false })))
      .toThrow(/Invalid solAvailable capability state in webChat\.providers\["chatgpt-web"\]/);
  });

  test("inherited unsupported state rejects a contradictory scoped legacy boolean", () => {
    const config = { ...defaultConfig(), webChat: { providers: { "chatgpt-web": { solAvailable: true } } } };
    expect(() => effectiveChatGptWebProviderConfig(config))
      .toThrow(/Invalid solAvailable capability state in webChat\.providers\["chatgpt-web"\]/);
  });

  test("matching inherited state and legacy booleans remain valid", () => {
    expect(effectiveChatGptWebProviderConfig(scopedLunaConfig({ solAvailable: true })).chatgptWeb?.solAvailable)
      .toBe(true);
    expect(effectiveChatGptWebProviderConfig({
      ...defaultConfig(), webChat: { providers: { "chatgpt-web": { solAvailable: false } } },
    }).chatgptWeb?.solAvailable).toBe(false);
  });

  test("matching browser modes are accepted and conflicting modes name the scoped path", () => {
    const expectedPath = /webChat\.providers\["chatgpt-web"\]/;
    writeRaw({ webChat: { providers: { "chatgpt-web": { browserInteractionMode: "automatic" } } } });
    expect(loadConfig().browserInteractionMode).toBe("automatic");
    expect(effectiveChatGptWebProviderConfig(scopedLunaConfig({ browserInteractionMode: "automatic" }))
      .chatgptWeb?.browserInteractionMode).toBe("automatic");

    const manual = { ...flatSolConfig(), browserInteractionMode: "manual" as const };
    manual.webChat = { providers: { "chatgpt-web": { browserInteractionMode: "manual" } } };
    expect(effectiveChatGptWebProviderConfig(manual).chatgptWeb?.browserInteractionMode).toBe("manual");

    const tunnel = {
      binaryPath: "/bin/true", tunnelId: `tunnel_${"a".repeat(32)}`, runtimeKeyFile: "/tmp/key",
      profileDir: "/tmp/profile", profileName: "manual", alias: "manual",
    };
    writeRaw({
      mode: "full", browserInteractionMode: "manual", browserHost: "launcher",
      browserHostDescriptorPath: "/tmp/browser-host.json", appName: "Codex Zero Risk", tunnel,
      webChat: { providers: { "chatgpt-web": { browserInteractionMode: "manual" } } },
    });
    expect(loadConfig().browserInteractionMode).toBe("manual");

    writeRaw({ webChat: { providers: { "chatgpt-web": { browserInteractionMode: "manual" } } } });
    expect(() => loadConfig()).toThrow(expectedPath);
    expect(() => effectiveChatGptWebProviderConfig(scopedLunaConfig({ browserInteractionMode: "manual" })))
      .toThrow(expectedPath);
  });

  test("loader permits a cross-field descriptor inherited by the scoped overlay", () => {
    writeRaw({
      browserHost: "launcher",
      browserHostDescriptorPath: "/tmp/browser-host.json",
      webChat: { providers: { "chatgpt-web": { browserHost: "launcher" } } },
    });
    expect(() => loadConfig()).not.toThrow();
  });

  test("loader rejects a capability invariant violated only by the effective merge", () => {
    writeRaw({ webChat: { providers: { "chatgpt-web": {
      capabilityState: { solAvailable: "unsupported", proAvailable: "supported" },
    } } } });
    expect(() => loadConfig()).toThrow(/Pro requires supported Sol/);
  });

  test("cross-field invariants are checked against the effective merged provider facts", () => {
    const config = { ...flatSolConfig(), browserInteractionMode: "manual" as const };
    config.webChat = { providers: { "chatgpt-web": { experimentalBiggerContext: true } } };
    expect(() => effectiveChatGptWebProviderConfig(config)).toThrow(/Zero Risk does not support Bigger Context/);
  });
});

describe("issue #193 — catalogue qualifies provider-local descriptor ids", () => {
  test("local ids are qualified once, retained as modelId, and malformed descriptors are filtered", () => {
    const entries = webChatModelCatalogueEntries("chatgpt-web", [
      { id: "luna", label: "Luna", text: true },
      { id: "think", label: "Think", text: true },
      { id: "invalid", label: "Invalid", text: false },
    ] as never);

    expect(entries.map(entry => entry.id)).toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);
    expect(entries.map(entry => entry.modelId)).toEqual(["luna", "think"]);
    expect(entries.every(entry => !entry.id.startsWith("chatgpt-web/chatgpt-web/"))).toBe(true);
  });
});

/**
 * Slice 2: a missing account identity must be distinguishable from a genuine mismatch.
 *
 * `providerConfig` substitutes a storage-state-derived fallback when `accountIdentityFingerprint` was
 * never recorded. That fallback is not an account identity, so the lease's account-binding check can
 * never match it — and reporting the resulting disagreement as a "mismatch" told the operator nothing
 * actionable. The provenance of the fingerprint is decided here, at the one place the fallback is
 * substituted: `accountIdentityRecorded` is true only for a fingerprint a sign-in persisted, or one a
 * provider-scoped block states itself. It describes the identity, so it must not re-key conversations.
 */
describe("issue #193 — the account identity's provenance is decided where the fallback is", () => {
  test("an unrecorded identity is marked derived, a persisted one recorded", () => {
    const unrecorded = providerConfig({ ...flatSolConfig(), accountIdentityFingerprint: undefined });
    // No storage state in this home, so the fallback is the unknown-session placeholder — which is
    // what a deployment that never signed in through the interactive surface looks like.
    expect(unrecorded.chatgptWeb?.accountIdentityFingerprint).toBe("unknown");
    expect(unrecorded.chatgptWeb?.accountIdentityRecorded).toBe(false);

    const recorded = providerConfig({ ...flatSolConfig(), accountIdentityFingerprint: "recorded-fingerprint" });
    expect(recorded.chatgptWeb?.accountIdentityFingerprint).toBe("recorded-fingerprint");
    expect(recorded.chatgptWeb?.accountIdentityRecorded).toBe(true);
  });

  test("a scoped block that states the fingerprint is recorded, whatever the flat block carried", () => {
    const config = scopedLunaConfig({ accountIdentityFingerprint: "scoped-fingerprint" });
    const effective = effectiveChatGptWebProviderConfig(config).chatgptWeb;
    expect(effective?.accountIdentityFingerprint).toBe("scoped-fingerprint");
    expect(effective?.accountIdentityRecorded).toBe(true);

    // A scoped block that states no fingerprint keeps the derived provenance it inherited.
    const inherited = effectiveChatGptWebProviderConfig(scopedLunaConfig()).chatgptWeb;
    expect(inherited?.accountIdentityFingerprint).toBe("unknown");
    expect(inherited?.accountIdentityRecorded).toBe(false);
  });

  test("the provenance is never taken from a block that merely declares it", () => {
    // It describes the effective fingerprint, so a declared value can neither claim a recorded
    // identity a deployment never had, nor deny one it does have.
    const claimed = effectiveChatGptWebProviderConfig(scopedLunaConfig({ accountIdentityRecorded: true })).chatgptWeb;
    expect(claimed?.accountIdentityFingerprint).toBe("unknown");
    expect(claimed?.accountIdentityRecorded).toBe(false);

    const denied = effectiveChatGptWebProviderConfig(scopedLunaConfig({
      accountIdentityFingerprint: "scoped-fingerprint",
      accountIdentityRecorded: false,
    })).chatgptWeb;
    expect(denied?.accountIdentityRecorded).toBe(true);
  });

  test("the lease input carries the resolver's decision, all the way from the effective block", () => {
    // The production hop: the effective provider block decides the provenance, and the adapter's lease
    // input reads it there. The refusal that consumes it is pinned in the concurrency contract suite.
    const derived = browserAccountLeaseInput(
      effectiveChatGptWebProviderConfig({ ...flatSolConfig(), accountIdentityFingerprint: undefined }),
      "trace-1",
    );
    expect(derived.accountIdentity).toBe("unknown");
    expect(derived.accountIdentityRecorded).toBe(false);

    const recorded = browserAccountLeaseInput(
      effectiveChatGptWebProviderConfig({ ...flatSolConfig(), accountIdentityFingerprint: "recorded-fingerprint" }),
      "trace-1",
    );
    expect(recorded.accountIdentity).toBe("recorded-fingerprint");
    expect(recorded.accountIdentityRecorded).toBe(true);
  });

  test("the provenance fact never re-keys an existing conversation", () => {
    // Every conversation key and execution key is derived from this namespace, so a fact that merely
    // *describes* the fingerprint next to it must hash as if it were not there. This is the historical
    // formula, over the block with the fact removed: the namespace of a deployment is byte-identical to
    // what it was before slice 2, so no existing ChatGPT conversation is abandoned on upgrade.
    const provider = providerConfig({ ...flatSolConfig(), accountIdentityFingerprint: "recorded-fingerprint" });
    const { accountIdentityRecorded: provenance, ...blockBefore } = provider.chatgptWeb!;
    expect(provenance).toBe(true);

    const historical = createHash("sha256")
      .update(JSON.stringify({ baseUrl: provider.baseUrl, chatgptWeb: blockBefore }))
      .digest("hex");
    expect(chatGptWebExecutionNamespace(provider)).toBe(historical);
    expect(chatGptWebExecutionNamespace(provider))
      .toBe(chatGptWebExecutionNamespace({ ...provider, chatgptWeb: blockBefore }));
  });
});
