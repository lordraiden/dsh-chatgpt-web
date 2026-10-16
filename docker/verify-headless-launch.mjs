#!/usr/bin/env node
/**
 * Verify that the ChatGPT Web worker's browser launch mode works headlessly, with no display.
 *
 * Why this exists (issue #245): a container has no X display and no Xvfb. `ensureManagedBrowser()` in
 * `src/adapters/chatgpt-web/browser-worker.ts` launches with `headless: false` at the Playwright
 * level and passes an explicit `--headless=new` argument (plus the Windows user agent when not
 * headed, because the consumer product reacts to it). If that combination needed a display, the image
 * would fail at the first turn — so this probe runs the *same* call, with `DISPLAY` unset.
 *
 * It is deliberately not part of `bun run test`: it needs a real browser binary and is used by hand,
 * next to `dsh-chatgpt-web browser check` (which covers the app's own `headless: true` engine check).
 *
 * Usage:
 *   CHROME_PATH=/ms-playwright/chromium-<rev>/chrome-linux64/chrome \
 *     node docker/verify-headless-launch.mjs
 *
 * `CHROME_PATH` must be the same path the configuration uses (`defaultChromeExecutable()` →
 * `/usr/bin/google-chrome`, or the computed Playwright path). Get the computed one with:
 *   node -p "require('playwright-core').chromium.executablePath()"
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("playwright-core");

const executablePath = process.env.CHROME_PATH;
if (!executablePath) {
  console.error("set CHROME_PATH to the browser binary the configuration uses");
  process.exit(2);
}
if (!existsSync(executablePath)) {
  console.error(`CHROME_PATH does not exist: ${executablePath}`);
  process.exit(2);
}

// Mirrors the launch arguments in ensureManagedBrowser().
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const args = [
  "--headless=new",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,800",
  `--user-agent=${userAgent}`,
];

console.log("DISPLAY:", process.env.DISPLAY ?? "(unset)");
const browser = await chromium.launch({ executablePath, headless: false, args });
try {
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  await page.goto("about:blank");
  const readyState = await page.evaluate(() => document.readyState);
  const actualUserAgent = await page.evaluate(() => navigator.userAgent);
  console.log("version:", browser.version());
  console.log("readyState:", readyState);
  console.log("userAgent:", actualUserAgent);
  if (readyState !== "complete") throw new Error(`page did not reach complete state (${readyState})`);
  if (actualUserAgent !== userAgent) throw new Error("the configured user agent was not applied");
  console.log("worker-mode launch: OK");
} finally {
  await browser.close();
}
