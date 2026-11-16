/**
 * The operator console: one entry point that explains every setting and links to the page that owns
 * each control.
 *
 * The console is a client like the pages it points at, so the properties that matter are the ones a
 * broken document loses silently:
 *
 * - it is served at every alias, anonymously, and carries no data, token, key or external URL;
 * - its inline script **compiles** — the 1.1.1 lesson: a template-literal escape that resolves into the
 *   served script kills every handler at parse time;
 * - the navigation names every surface, and the reference contains **every** setting of the catalogue,
 *   including the precedence notes that explain which value wins when two overlap;
 * - the catalogue is the single source of the words: the console embeds it, so a setting cannot be
 *   explained in one section and forgotten in the reference.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultConfig, type AppConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import { CONSOLE_SETTINGS } from "../src/web-chat/host/console-content";
import {
  WEB_CHAT_CONSOLE_PAGE_HTML,
  WEB_CHAT_CONSOLE_PAGE_PATHS,
} from "../src/web-chat/host/console-page";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

const CONTROL_TOKEN = "operator-console-control-token-0123456789";
const ACCOUNT_FINGERPRINT = "operator-console-account";

let home: string;
let savedHome: SavedChatGptWebHome;
const running: RunningServer[] = [];

beforeEach(() => {
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("operator-console-", { clearFreeHome: true });
});

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function config(): AppConfig {
  return {
    ...defaultConfig(),
    port: 0,
    controlToken: CONTROL_TOKEN,
    accountIdentityFingerprint: ACCOUNT_FINGERPRINT,
  };
}

function serve(): RunningServer {
  const server = startServer(config(), { doctor: async () => ({ ok: true, mode: "browser-only", checks: [] }) });
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string): string => `http://127.0.0.1:${server.port}${path}`;

function scriptOf(html: string): string {
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.indexOf("</script>", start);
  expect(start).toBeGreaterThan(8);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("operator console", () => {
  test("is served at every alias, anonymously, and is one document", async () => {
    const server = serve();
    for (const path of WEB_CHAT_CONSOLE_PAGE_PATHS) {
      const response = await fetch(url(server, path));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toBe(WEB_CHAT_CONSOLE_PAGE_HTML);
    }
  });

  test("its inline script compiles", () => {
    expect(() => new Function(scriptOf(WEB_CHAT_CONSOLE_PAGE_HTML))).not.toThrow();
  });

  test("the navigation names every surface", () => {
    for (const section of ["overview", "visibility", "profiles", "tuning", "memory", "doctor", "reference"]) {
      expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain(`data-section="${section}"`);
      expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain(`id="${section}"`);
    }
  });

  test("the reference contains every setting of the catalogue", () => {
    for (const setting of CONSOLE_SETTINGS) {
      expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain(`"id":"${setting.id}"`);
    }
  });

  test("the overlapping settings say which one wins", () => {
    // The three overlaps an operator cannot guess: visibility, concurrency and the turn clock.
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain("The endpoint profile's value wins");
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain("DSH_CHATGPT_WEB_MAX_INFLIGHT_TURNS still applies");
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain("HINDSIGHT_API_LLM_TIMEOUT");
  });

  test("every data path and link is a same-origin absolute path", () => {
    // The console is served at /v1/control/ AND /v1/control/console/, so a relative "../status" would
    // resolve to /v1/status from the first alias and 401. Absolute same-origin paths are the only
    // shape that works from both.
    const script = scriptOf(WEB_CHAT_CONSOLE_PAGE_HTML);
    for (const path of ["/v1/control/config", "/v1/control/status", "/v1/control/catalogue", "/v1/control/endpoint-profiles", "/v1/control/doctor"]) {
      expect(script).toContain(`"${path}"`);
    }
    expect(script).not.toContain('fetch("../');
    expect(script).not.toContain('api("../');
  });

  test("one authentication for the whole page", () => {
    // One token card, one shared key: a token entered here also unlocks the standalone pages.
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain('id="auth-card"');
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain('dsh-chatgpt-web.control-token');
    expect(WEB_CHAT_CONSOLE_PAGE_HTML.match(/id="token"/g)).toHaveLength(1);
    expect(WEB_CHAT_CONSOLE_PAGE_HTML.match(/id="unlock"/g)).toHaveLength(1);
  });

  test("the unified sections expose the controls that used to live on separate pages", () => {
    for (const marker of ['id="visibility-select"', 'id="profiles-table"', 'id="save-profile"', 'id="tuning"', 'id="memory-ops"', 'id="run-doctor"']) {
      expect(WEB_CHAT_CONSOLE_PAGE_HTML).toContain(marker);
    }
  });

  test("carries no data, secret or absolute URL", () => {
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).not.toContain("http://");
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).not.toContain("https://");
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).not.toContain(CONTROL_TOKEN);
    expect(WEB_CHAT_CONSOLE_PAGE_HTML).not.toContain("api-key");
  });

  test("the catalogue is the single source: every entry has what, when, affects and a default", () => {
    for (const setting of CONSOLE_SETTINGS) {
      expect(setting.what.length).toBeGreaterThan(20);
      expect(setting.when.length).toBeGreaterThan(20);
      expect(setting.affects.length).toBeGreaterThan(10);
      expect(setting.defaultValue.length).toBeGreaterThan(0);
    }
  });
});
