/**
 * Issue #193 (P2) — the `webChat` surface of the application configuration.
 *
 * `AppConfig` now carries the WebChat host surface inline (the configuration module must not import
 * the host boundary), it is validated with the same error style as the rest of `parseConfig`, and the
 * effective ChatGPT Web provider configuration is `webChat.providers["chatgpt-web"] ?? chatgptWeb`.
 * The compatibility guarantee under test: without `webChat` the effective configuration is exactly
 * `providerConfig(config)`, so an existing installation behaves as before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, getConfigPath, loadConfig, providerConfig, type AppConfig } from "../src/config";
import {
  effectiveChatGptWebProviderConfig,
} from "../src/adapters/chatgpt-web/llm-adapter";
import {
  CHATGPT_WEB_DRIVER_ID,
  resolveWebChatProviderConfig,
  type WebChatHostConfig,
} from "../src/web-chat/host/dsh-integration";

let home: string;
let previousFreeHome: string | undefined;
let previousWebHome: string | undefined;

beforeEach(() => {
  previousFreeHome = process.env.DSH_CHATGPT_FREE_HOME;
  previousWebHome = process.env.DSH_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "issue-193-config-"));
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

describe("issue #193 — the typed webChat surface round-trips", () => {
  test("a configured provider block and durable location survive a load", () => {
    const storePath = join(home, "runtime", "conversations.json");
    const scoped = { browserInteractionMode: "automatic", chromeExecutablePath: "/opt/chrome" };
    // The typing is part of the proof: this is an AppConfig, and its `webChat` field must exist and
    // accept exactly this shape.
    const config: AppConfig = {
      ...defaultConfig(),
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: scoped }, conversationStorePath: storePath },
    };
    writeRaw(config as unknown as Record<string, unknown>);

    const loaded = loadConfig();
    expect(loaded.webChat?.conversationStorePath).toBe(storePath);
    expect(loaded.webChat?.providers?.[CHATGPT_WEB_DRIVER_ID]).toEqual(scoped);

    // The host boundary accepts the same value structurally: one shape, no adaptation layer.
    const hostConfig: WebChatHostConfig = {
      webChat: loaded.webChat,
      chatgptWeb: providerConfig(loaded).chatgptWeb,
    };
    expect(resolveWebChatProviderConfig(hostConfig, CHATGPT_WEB_DRIVER_ID)).toBe(
      loaded.webChat?.providers?.[CHATGPT_WEB_DRIVER_ID],
    );
  });

  test("without webChat nothing is added and the flat configuration stays effective", () => {
    writeRaw({});
    const loaded = loadConfig();

    expect(loaded.webChat).toBeUndefined();
    expect("webChat" in loaded).toBe(false);

    // Exactly today's behavior: the effective provider configuration is providerConfig(config).
    const bare = defaultConfig();
    expect(effectiveChatGptWebProviderConfig(bare)).toEqual(providerConfig(bare));
    expect(effectiveChatGptWebProviderConfig(bare).chatgptWeb).not.toHaveProperty("webChat");
  });
});

describe("issue #193 — the effective provider configuration", () => {
  test("the provider-scoped block wins; a non-object payload keeps the flat block", () => {
    const scoped = { browserInteractionMode: "manual" as const };
    const scopedConfig: AppConfig = {
      ...defaultConfig(),
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: scoped } },
    };
    const effective = effectiveChatGptWebProviderConfig(scopedConfig);
    // The block is an overlay: the field it states wins, and every value it does not state is the one
    // the flat configuration already produced (see the overlay suite for the derived values).
    expect(effective.chatgptWeb).toMatchObject(scoped);
    expect(effective.chatgptWeb?.browserHost).toBe(providerConfig(scopedConfig).chatgptWeb?.browserHost);
    // The rest of the provider facts are untouched.
    expect(effective.baseUrl).toBe(providerConfig(scopedConfig).baseUrl);
    expect(effective.models).toEqual(providerConfig(scopedConfig).models);

    // A scoped payload that is not a configuration object fails closed onto the flat block instead of
    // producing a provider with an unusable configuration.
    const unusable: AppConfig = {
      ...defaultConfig(),
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: 42 } },
    };
    expect(effectiveChatGptWebProviderConfig(unusable)).toEqual(providerConfig(unusable));

    // Another provider's block is never used for the ChatGPT route.
    const otherProvider: AppConfig = {
      ...defaultConfig(),
      webChat: { providers: { "qwen-web": scoped } },
    };
    expect(effectiveChatGptWebProviderConfig(otherProvider)).toEqual(providerConfig(otherProvider));
  });
});

describe("issue #193 — invalid webChat shapes are refused", () => {
  const rejected: Array<{ readonly label: string; readonly webChat: unknown; readonly message: RegExp }> = [
    { label: "not an object", webChat: "webchat", message: /Invalid webChat in / },
    { label: "an array", webChat: [], message: /Invalid webChat in / },
    { label: "null", webChat: null, message: /Invalid webChat in / },
    { label: "providers that are not an object", webChat: { providers: 3 }, message: /Invalid webChat\.providers in / },
    { label: "providers that are an array", webChat: { providers: [] }, message: /Invalid webChat\.providers in / },
    {
      label: "a null provider entry",
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: null } },
      message: /Invalid webChat\.providers\.chatgpt-web in /,
    },
    {
      label: "an array provider entry",
      webChat: { providers: { [CHATGPT_WEB_DRIVER_ID]: ["x"] } },
      message: /Invalid webChat\.providers\.chatgpt-web in /,
    },
    {
      label: "an empty provider id",
      webChat: { providers: { "  ": {} } },
      message: /Invalid webChat\.providers\./,
    },
    {
      label: "an empty conversationStorePath",
      webChat: { conversationStorePath: "   " },
      message: /Invalid webChat\.conversationStorePath in /,
    },
    {
      label: "a non-string conversationStorePath",
      webChat: { conversationStorePath: 7 },
      message: /Invalid webChat\.conversationStorePath in /,
    },
  ];

  for (const { label, webChat, message } of rejected) {
    test(`${label} is refused`, () => {
      writeRaw({ webChat });
      expect(() => loadConfig()).toThrow(message);
    });
  }
});
