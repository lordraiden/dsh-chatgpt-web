/**
 * Issue #699 (T3.1) / D1.2 — publish the budget a ChatGPT Web turn is actually measured against.
 *
 * The nominal window (1,050,000 tokens) and the 128,000-token pre-compaction budget are not the bound
 * that refuses a turn: the measured composer character limit (120,000 characters, ≈41.5k tokens at
 * the ratio this transport was measured at) is. An agent that sizes prompts from the token budget
 * produces payloads the composer refuses before the browser turn starts — the 2026-11-19 evidence
 * showed 145,725–313,442-character prompts against a 120,000-character wall.
 *
 * The bound now travels with the response (`x-dsh-chatgpt-web-context-budget`), with the catalogue row
 * and with the operator control surface, so a caller can compact to it instead of learning it from a
 * 400.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig, type AppConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import { buildChatGptWebModelCatalog, publicModelRouteIds } from "../src/model-catalog";
import {
  CHATGPT_WEB_CONTEXT_BUDGET_HEADER,
  CHATGPT_WEB_OBSERVED_CHARS_PER_TOKEN,
  chatGptWebContextBudgetHeaderValue,
  chatGptWebContextBudgetReport,
} from "../src/adapters/chatgpt-web/context-budget";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "issue-699-context-budget-control-token-0123456789";
const ACCOUNT_FINGERPRINT = "issue-699-account";

let home: string;
let savedHome: SavedChatGptWebHome;
let previousApiKey: string | undefined;
const running: RunningServer[] = [];

beforeEach(() => {
  previousApiKey = process.env.DSH_CHATGPT_WEB_API_KEY;
  delete process.env.DSH_CHATGPT_WEB_API_KEY;
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-699-context-budget-", { clearFreeHome: true });
});

afterEach(async () => {
  if (previousApiKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
  else process.env.DSH_CHATGPT_WEB_API_KEY = previousApiKey;
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
    ...overrides,
  };
}

function serve(value: AppConfig, dependencies: Parameters<typeof startServer>[1] = {}): RunningServer {
  const server = startServer(value, dependencies);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;

/** A provider stub: the ChatGPT Web adapter seam is simulated, the listener and routing are real. */
function stubAdapterFactory(): (provider: import("../src/types").CodexProviderConfig) => ProviderAdapter {
  return (): ProviderAdapter => ({
    name: "issue-699-stub",
    runTurn: async (
      _parsed: CodexParsedRequest,
      _incoming: unknown,
      emit: (event: AdapterEvent) => void,
    ) => {
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
}

const parseHeader = (response: Response): Record<string, unknown> | undefined => {
  const raw = response.headers.get(CHATGPT_WEB_CONTEXT_BUDGET_HEADER);
  return raw === null ? undefined : JSON.parse(raw) as Record<string, unknown>;
};

describe("issue #699 — the budget report states the bound that actually refuses the turn", () => {
  test("the Luna route publishes the composer wall and the token figure derived from it", () => {
    const report = chatGptWebContextBudgetReport("gpt-5.6-luna", 120_000);
    expect(report).toEqual({
      model: "gpt-5.6-luna",
      composer_char_limit: 120_000,
      effective_input_tokens: Math.floor(120_000 / CHATGPT_WEB_OBSERVED_CHARS_PER_TOKEN),
      pre_compaction_input_tokens: 128_000,
      theoretical_context_window: 1_050_000,
      chars_per_token: CHATGPT_WEB_OBSERVED_CHARS_PER_TOKEN,
      next_action: "compact",
    });
    // The advisory token figure is far below the nominal 128k budget: that gap is the whole point.
    expect(report!.effective_input_tokens).toBe(41_522);
    expect(report!.effective_input_tokens).toBeLessThan(report!.pre_compaction_input_tokens);
  });

  test("a deployment or profile override of the composer limit moves the effective bound", () => {
    const report = chatGptWebContextBudgetReport("gpt-5.6-luna", 60_000);
    expect(report!.composer_char_limit).toBe(60_000);
    expect(report!.effective_input_tokens).toBe(Math.floor(60_000 / CHATGPT_WEB_OBSERVED_CHARS_PER_TOKEN));
  });

  test("a model this module does not budget gets no ChatGPT-shaped report", () => {
    expect(chatGptWebContextBudgetReport("qwen-chat/qwen3", 120_000)).toBeUndefined();
    expect(chatGptWebContextBudgetReport("deepseek-web/default", 120_000)).toBeUndefined();
  });

  test("the header value is compact JSON of the report", () => {
    const report = chatGptWebContextBudgetReport("gpt-5.6-luna", 120_000)!;
    expect(JSON.parse(chatGptWebContextBudgetHeaderValue(report))).toEqual(report);
    expect(chatGptWebContextBudgetHeaderValue(report)).toBe(JSON.stringify(report));
  });
});

describe("issue #699 — the catalogue row carries the composer wall", () => {
  test("every ChatGPT Web row states the char limit and the derived token figure", () => {
    const catalog = buildChatGptWebModelCatalog(defaultConfig());
    const rows = catalog.models as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.composer_char_limit).toBe(120_000);
      expect(row.effective_input_tokens).toBe(41_522);
      expect(row.chars_per_token).toBe(CHATGPT_WEB_OBSERVED_CHARS_PER_TOKEN);
      // The model's own window is untouched: the composer wall is a transport bound beside it.
      expect(row.context_window).toBe(1_050_000);
    }
  });
});

describe("issue #699 — the public ingresses publish the budget header", () => {
  test("a chat-completions turn on a ChatGPT Web route carries it", async () => {
    const server = serve(config(), { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        messages: [{ role: "user", content: "hola" }],
      }),
    });
    expect(response.status).toBe(200);
    const budget = parseHeader(response);
    expect(budget).toBeDefined();
    expect(budget!.model).toBe("gpt-5.6-luna");
    expect(budget!.composer_char_limit).toBe(120_000);
    expect(budget!.effective_input_tokens).toBe(41_522);
    expect(budget!.next_action).toBe("compact");
  });

  test("a responses turn on a ChatGPT Web route carries it", async () => {
    const server = serve(config(), { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        input: [{ role: "user", content: "hola" }],
        stream: false,
      }),
    });
    expect(response.status).toBe(200);
    const budget = parseHeader(response);
    expect(budget).toBeDefined();
    expect(budget!.composer_char_limit).toBe(120_000);
  });

  test("a refusal that names no ChatGPT Web route carries no budget header", async () => {
    const server = serve(config(), { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-model", messages: [{ role: "user", content: "hola" }] }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get(CHATGPT_WEB_CONTEXT_BUDGET_HEADER)).toBeNull();
    // The accepted catalogue still names the routes, so the caller can find the budget afterwards.
    expect(publicModelRouteIds(defaultConfig())).toContain("chatgpt-web/luna");
  });

  test("the control surface publishes the same budget", async () => {
    const server = serve(config(), { adapterFactory: stubAdapterFactory() });
    const response = await fetch(url(server, "/v1/control/status"), {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const status = await response.json() as { contextBudget?: Record<string, unknown> };
    expect(status.contextBudget).toBeDefined();
    expect(status.contextBudget!.composer_char_limit).toBe(120_000);
    expect(status.contextBudget!.effective_input_tokens).toBe(41_522);
    expect(status.contextBudget!.model).toBe("gpt-5.6-luna");
  });
});
