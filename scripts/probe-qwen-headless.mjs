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
 * which answers HTTP 200 with `success:false` for an anonymous caller).
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

  // The structural authenticated check, through the browser context's request facility.
  const probe = await page.request.get(TASK_LIST, { headers: { accept: "application/json" } });
  const probeBody = await probe.json().catch(() => undefined);
  summary.structuralProbe = {
    status: probe.status(),
    authenticated: probeBody?.success === true && Array.isArray(probeBody?.data),
    reason: probeBody?.success === true ? undefined : probeBody?.data?.code,
  };

  // One live turn, only when a captured session was supplied and it passed the structural check.
  if (storageStatePath !== undefined && summary.structuralProbe.authenticated === true) {
    const postJson = async (url, payload) => {
      const result = await page.evaluate(async ({ url, payload }) => {
        const answer = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json", source: "web", version: "0.0.29" },
          body: JSON.stringify(payload),
        });
        const text = await answer.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: answer.status, body };
      }, { url, payload });
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
      const streamed = await page.evaluate(async ({ url, payload }) => {
        const answer = await fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "text/event-stream", "content-type": "application/json", source: "web", version: "0.0.29" },
          body: JSON.stringify(payload),
        });
        const text = await answer.text();
        return { status: answer.status, contentType: answer.headers.get("content-type"), text: text.slice(0, 20_000) };
      }, {
        url: `${COMPLETIONS}?chat_id=${encodeURIComponent(chatId)}`,
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
