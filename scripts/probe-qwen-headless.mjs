#!/usr/bin/env node
/**
 * Live headless probe for the Qwen Code provider (issue #299, slice 1) — a manual step.
 *
 * It answers, against the real service, the two questions the slice turns on:
 *
 * 1. Does a **fresh headless profile** get the provider's sign-in surface, or is it refused?
 * 2. With a **captured session**, does one network turn produce text — and which termination signal
 *    fires?
 *
 * It prints no cookie, storage state or token: the session is only ever used, never shown. The
 * authenticated check is the same structural one the controller uses (`GET /coder/api/v2/task/list`,
 * which answers HTTP 200 with `success:false` for an anonymous caller), and it is issued **the way
 * the page issues it**: from inside the page, with the `authorization: Bearer <token>` header the
 * app builds from `localStorage["qwen_access_token_state"]` (see `doc/qwen-code.md` §4). A
 * cookie-only call is exactly the `import_predicate_failed` shape and is not retried as a fallback.
 *
 * Usage:
 *
 *   # 1. sign-in surface: does headless reach it, and what does it offer?
 *   node scripts/probe-qwen-headless.mjs --chrome /path/to/chrome
 *
 *   # 2. one live turn with the session an operator captured from /v1/control/auth/
 *   node scripts/probe-qwen-headless.mjs --chrome /path/to/chrome \
 *     --storage-state "$DSH_CHATGPT_WEB_HOME/providers/qwen-code/storage-state.json"
 *
 * `--chrome` may be omitted when CHROME or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is set. The script
 * exits non-zero when the structural probe fails, so it composes with a shell check.
 */
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://coder.qwen.ai";
const TASK_LIST = `${ORIGIN}/coder/api/v2/task/list?page=1`;
const COMPLETIONS = `${ORIGIN}/coder/api/v2/task/completions`;
const TASK_NEW = `${ORIGIN}/coder/api/v2/task/new`;
const DEFAULT_MODEL = "qwen3-coder-plus";

/** The localStorage keys the app's token manager uses (current and legacy). Provider facts. */
const ACCESS_TOKEN_KEY = "qwen_access_token_state";
const LEGACY_ACCESS_TOKEN_KEY = "token";

/**
 * Read the page's own token and return the `authorization` header the app would send.
 *
 * The token stays inside this process and is never printed: the probe reports only whether the
 * header was sent. No token is hard-coded, defaulted or read from a fixture.
 */
async function authorizationHeader(page) {
  const read = await page.evaluate(({ accessKey, legacyKey }) => {
    const parse = (value) => {
      if (typeof value !== "string" || value.trim() === "") return undefined;
      const trimmed = value.trim();
      if (!trimmed.startsWith("{")) return trimmed;
      try {
        const state = JSON.parse(trimmed);
        if (state && state.loggedOut === true) return undefined;
        return typeof state.token === "string" && state.token.trim() !== "" ? state.token.trim() : undefined;
      } catch {
        return undefined;
      }
    };
    try {
      const state = parse(localStorage.getItem(accessKey));
      if (state !== undefined) return { token: state, source: "state" };
      const legacy = parse(localStorage.getItem(legacyKey));
      return legacy === undefined ? { token: undefined, source: "none" } : { token: legacy, source: "legacy" };
    } catch {
      return { token: undefined, source: "unreadable" };
    }
  }, { accessKey: ACCESS_TOKEN_KEY, legacyKey: LEGACY_ACCESS_TOKEN_KEY });
  return {
    header: read?.token === undefined ? {} : { authorization: `Bearer ${read.token}` },
    source: read?.source ?? "none",
  };
}

/** The API headers the page's own client sends, plus the page's token when it has one. */
function apiHeaders(authorization, extra = {}) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    source: "web",
    version: "0.0.29",
    "bx-v": "2.5.37",
    ...authorization.header,
    ...extra,
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`probe: ${message}`);
  process.exit(2);
}

const chrome = flag("--chrome")
  ?? process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!chrome || !existsSync(chrome)) {
  fail("no Chrome executable: pass --chrome <path> or set CHROME");
}
const storageStatePath = flag("--storage-state");
const prompt = flag("--prompt") ?? "Reply with exactly the word: ready";

const profile = mkdtempSync(join(tmpdir(), "qwen-headless-probe-"));
const summary = {
  chrome,
  headless: true,
  userAgent: undefined,
  navigated: undefined,
  httpStatus: undefined,
  appTitle: undefined,
  signInSurface: undefined,
  captchaMarkers: undefined,
  structuralProbe: undefined,
  turn: undefined,
};

const launchArgs = [
  "--headless=new",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,800",
];

// A fresh profile and a captured session are two different launches on purpose: the first proves the
// temporary-profile path the controller uses, the second opens the captured state on a normal context
// (`launchPersistentContext` has no `storageState` option, which is exactly why `--storage-state` runs
// on its own context instead of being smuggled into the profile).
const browser = storageStatePath === undefined
  ? undefined
  : await chromium.launch({ executablePath: chrome, headless: false, args: launchArgs });
const context = browser === undefined
  ? await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    // The repository's established shape: the flag lives in args, never `headless: true`.
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: launchArgs,
  })
  : await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: JSON.parse(readFileSync(storageStatePath, "utf8")),
  });

try {
  const page = context.pages()[0] ?? await context.newPage();
  summary.userAgent = await page.evaluate(() => navigator.userAgent);
  const response = await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch(error => ({ status: () => undefined, error }));
  summary.httpStatus = response.status?.();
  await page.waitForTimeout(3_000);
  summary.navigated = page.url();
  summary.appTitle = await page.title();

  // The sign-in surface, as the operator's relay would see it. Clicking "Log in" is safe and
  // unauthenticated: it only routes the SPA to its own auth page.
  const loginButton = page.getByRole("button", { name: /log ?in|sign ?in|iniciar sesión/i }).first();
  if (await loginButton.count() > 0) {
    await loginButton.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(6_000);
  }
  summary.signInSurface = await page.evaluate(() => ({
    url: location.href,
    fields: [...document.querySelectorAll("input")].map(input => ({
      type: input.type,
      name: input.name,
      placeholder: input.placeholder,
      visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
    })),
    buttons: [...document.querySelectorAll("button")]
      .map(button => (button.innerText || button.getAttribute("aria-label") || "").trim())
      .filter(Boolean)
      .slice(0, 12),
    iframes: document.querySelectorAll("iframe").length,
  }));
  summary.captchaMarkers = await page.evaluate(() => ({
    widget: !!document.querySelector("#nc_1_wrapper, .nc-container, [id*='nocaptcha']"),
    scripts: [...document.querySelectorAll("script[src]")]
      .map(script => script.src)
      .filter(source => /captcha|baxia|awsc|verify/i.test(source))
      .length,
  }));

  // The structural authenticated check, issued from the page with the page's own token.
  const authorization = await authorizationHeader(page);
  const probeAnswer = await page.evaluate(async ({ url, headers }) => {
    const answer = await fetch(url, { credentials: "same-origin", headers });
    const text = await answer.text();
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: answer.status, body, text: text.slice(0, 400) };
  }, { url: TASK_LIST, headers: apiHeaders(authorization) });
  const probeBody = probeAnswer.body;
  summary.structuralProbe = {
    status: probeAnswer.status,
    authenticated: probeBody?.success === true && Array.isArray(probeBody?.data),
    reason: probeBody?.success === true ? undefined : (probeBody?.data?.code ?? probeAnswer.text),
    // Whether the page's own token travelled with the request; never the token itself.
    sentAuthorization: Object.keys(authorization.header).length > 0,
    tokenSource: authorization.source,
  };

  // One live turn, only when a captured session was supplied and it passed the structural check.
  if (storageStatePath !== undefined && summary.structuralProbe.authenticated === true) {
    const postJson = async (url, payload) => {
      const headers = apiHeaders(await authorizationHeader(page));
      const result = await page.evaluate(async ({ url, payload, headers }) => {
        const answer = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify(payload),
        });
        const text = await answer.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: answer.status, body };
      }, { url, payload, headers });
      return result;
    };
    const created = await postJson(TASK_NEW, {
      chatId: "", models: [DEFAULT_MODEL], chat_type: "code", title: "New Chat",
      chat_mode: "normal", timestamp: Date.now(), sub_chat_type: "web_dev",
    });
    const chatId = created.body?.data?.id;
    if (typeof chatId !== "string") {
      summary.turn = { created: created.status, createdSuccess: created.body?.success, chatId: false };
    } else {
      const streamHeaders = apiHeaders(await authorizationHeader(page), {
        accept: "text/event-stream",
        "x-accel-buffering": "no",
      });
      const streamed = await page.evaluate(async ({ url, payload, headers }) => {
        const answer = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify(payload),
        });
        const text = await answer.text();
        return { status: answer.status, contentType: answer.headers.get("content-type"), text: text.slice(0, 20_000) };
      }, {
        url: `${COMPLETIONS}?chat_id=${encodeURIComponent(chatId)}`,
        headers: streamHeaders,
        payload: {
          stream: true, version: "2.1", incremental_output: true, chatId, parentId: "",
          chat_id: chatId, chat_mode: "normal", model: DEFAULT_MODEL, parent_id: null,
          messages: [{
            id: null, fid: crypto.randomUUID(), parentId: null, childrenIds: [crypto.randomUUID()],
            role: "user", content: prompt, user_action: "chat", files: [], timestamp: Math.floor(Date.now() / 1000),
            models: [DEFAULT_MODEL], model: "", chat_type: "code",
            feature_config: { thinking_enabled: false, output_schema: "phase" },
            extra: { meta: { subChatType: "web_dev" } }, sub_chat_type: "web_dev", parent_id: null,
          }],
          timestamp: Math.floor(Date.now() / 1000),
        },
      });
      // Report the frame taxonomy and the termination signal, never the captured prompt content.
      const frames = streamed.text.split("\n\n").filter(part => part.trim().length > 0);
      let statuses = new Set();
      let actions = new Set();
      let text = "";
      let termination = "stream_end";
      for (const frame of frames) {
        const payload = frame.startsWith("data: ") ? frame.slice(6) : frame;
        let decoded;
        try { decoded = JSON.parse(payload); } catch { continue; }
        if (decoded.choices?.[0]?.delta) {
          const delta = decoded.choices[0].delta;
          if (delta.status) statuses.add(delta.status);
          if (delta.role === "assistant" && delta.content) text += delta.content;
          if (delta.role !== "function" && delta.status && delta.status !== "typing") {
            termination = "delta_status";
            break;
          }
        }
        if (decoded["response.info"]) {
          actions.add(decoded["response.info"].action);
          if (decoded["response.info"].action !== "keep_alive") {
            termination = "response_info";
            break;
          }
        }
      }
      summary.turn = {
        created: created.status,
        streamStatus: streamed.status,
        contentType: streamed.contentType,
        frames: frames.length,
        deltaStatuses: [...statuses],
        infoActions: [...actions],
        termination,
        answerChars: text.length,
        answerHead: text.slice(0, 200),
      };
    }
  }
} finally {
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.structuralProbe?.authenticated === true || storageStatePath === undefined ? 0 : 1);
