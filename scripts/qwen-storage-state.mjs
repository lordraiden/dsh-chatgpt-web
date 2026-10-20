#!/usr/bin/env node
/**
 * Capture a Qwen Code session from the operator's own Chrome — the alternative sign-in path (issue
 * #299).
 *
 * Why this exists: `coder.qwen.ai` presents an Access Verification slider during sign-in, and its risk
 * engine refuses **relayed** input even when the relay reproduces the exact path the operator drew.
 * The remaining obstacle is synthesised input, not coordinates, so the honest route is to sign in with
 * real input **in a real browser on the operator's own machine** and only import the resulting session.
 * Do not "simplify" this away by making the relayed flow sneakier: no stealth, no user-agent trick.
 *
 * What it does, with zero dependencies (Node's built-in `fetch` and global `WebSocket` are enough, so
 * there is nothing to install):
 *
 * 1. attaches to the Chrome the operator already started with `--remote-debugging-port=9222`;
 * 2. reads that browser's cookies over the DevTools protocol (`Storage.getCookies`, falling back to a
 *    page target's `Network.getAllCookies`);
 * 3. reads the app page's `localStorage` over the same protocol, because this provider's API is **not**
 *    cookie-authenticated: every API call carries `authorization: Bearer <token>` and the app keeps
 *    that token in `localStorage["qwen_access_token_state"]` (see `doc/qwen-code.md` §4). A capture
 *    without it is a capture the import will (correctly) refuse;
 * 4. keeps only the provider's domain family and storage origins, drops third-party-partitioned and
 *    already-expired cookies, and maps everything to Playwright's storage-state shape;
 * 5. writes a `storageState` JSON file with mode 0600 and prints where it is.
 *
 * Safety rules:
 *
 * - **No cookie name or value, and no storage key or value, ever leaves this process except into the
 *   file.** The log prints the destination path, counts and the (non-secret) domains. Every error is
 *   this script's own text.
 * - **Re-running is safe and idempotent:** the file is replaced atomically, so a stale partial write
 *   can never be mistaken for a capture.
 *
 * Usage:
 *
 *   # quit Chrome completely, then (macOS path shown; on Linux `google-chrome` / `chromium`):
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
 *   # sign in at https://coder.qwen.ai in that window, leave it open, then:
 *   node scripts/qwen-storage-state.mjs --out ~/qwen-storage-state.json
 *
 *   # if Chrome answers 403 to the DevTools handshake, restart it with:
 *   #   --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Then, inside the deployment:
 *
 *   docker compose cp ~/qwen-storage-state.json chatgpt-web:/tmp/qwen-storage-state.json
 *   docker compose exec chatgpt-web node lib/cli.js auth import --provider qwen-code --from /tmp/qwen-storage-state.json
 *
 * The full procedure, and what expiry looks like, is in `doc/qwen-code.md`.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The cookie domains the Qwen Code session may legitimately span.
 *
 * Mirrors `QWEN_CODE_COOKIE_DOMAINS` in `src/adapters/qwen-code/session-store.ts`; a test asserts the
 * two lists agree, so the capture and the import cannot silently filter differently.
 */
export const QWEN_COOKIE_DOMAINS = Object.freeze(["qwen.ai", "aliyun.com"]);

/** The storage origins this provider owns; the capture reads the app page's local storage. */
export const QWEN_STORAGE_ORIGINS = Object.freeze(["https://coder.qwen.ai", "https://auth.qwen.ai"]);

/** Where the signed-in app page lives. The token the API checks is in that origin's local storage. */
const APP_ORIGIN = "https://coder.qwen.ai";

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_OUT = "qwen-storage-state.json";
const CDP_TIMEOUT_MS = 15_000;
const USAGE = `Capture a Qwen Code session from a running Chrome (no dependencies).

Usage:
  node scripts/qwen-storage-state.mjs [--out FILE] [--port PORT] [--host HOST]

  --out FILE    where to write the Playwright storageState JSON (default: ./${DEFAULT_OUT})
  --port PORT   Chrome's remote debugging port (default: ${DEFAULT_PORT})
  --host HOST   Chrome's remote debugging host (default: ${DEFAULT_HOST})
  --help        show this text

Start Chrome with --remote-debugging-port=${DEFAULT_PORT}, sign in at https://coder.qwen.ai in that
window, then run this script. It prints where the file is and never prints a cookie value.`;

/**
 * Whether a cookie host belongs to one of the allowed domain families.
 *
 * @param {string} host
 * @param {readonly string[]} [allowed]
 * @returns {boolean}
 */
export function hostAllowed(host, allowed = QWEN_COOKIE_DOMAINS) {
  if (typeof host !== "string") return false;
  const normalized = host.replace(/^\.+/, "").toLowerCase();
  return allowed.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

function cookieList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.cookies)) return payload.cookies;
  throw new Error("Chrome did not return a cookie list; is the DevTools endpoint really the browser?");
}

function finiteExpires(cookie) {
  if (cookie.session === true) return -1;
  const expires = cookie.expires;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return -1;
  return Math.floor(expires);
}

function sameSite(value) {
  return value === "Strict" || value === "Lax" || value === "None" ? value : "Lax";
}

/**
 * Map a DevTools `Storage.getCookies` / `Network.getAllCookies` answer to a Playwright storageState.
 *
 * Pure and network-free: the test feeds it a recorded payload. Partitioned cookies are dropped
 * (Playwright's storage-state cookie shape has no `partitionKey`), foreign domains are dropped, and
 * cookies Chrome itself already considers expired are dropped — a capture should never carry a
 * credential that is known dead.
 *
 * @param {unknown} payload - the CDP answer (`{cookies: [...]}` or the array itself)
 * @param {number} [now] - clock in milliseconds, for the expiry filter
 * @returns {{cookies: Array<{name: string, value: string, domain: string, path: string, expires: number, httpOnly: boolean, secure: boolean, sameSite: "Strict"|"Lax"|"None"}>, origins: []}}
 */
export function cdpCookiesToStorageState(payload, now = Date.now(), storageEntries = []) {
  const cookies = [];
  for (const cookie of cookieList(payload)) {
    if (!cookie || typeof cookie !== "object") continue;
    if (cookie.partitionKey !== undefined) continue;
    if (!hostAllowed(cookie.domain)) continue;
    const expires = finiteExpires(cookie);
    if (expires > 0 && expires * 1000 <= now) continue;
    cookies.push({
      name: String(cookie.name),
      value: String(cookie.value ?? ""),
      domain: String(cookie.domain),
      path: typeof cookie.path === "string" && cookie.path !== "" ? cookie.path : "/",
      expires,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: sameSite(cookie.sameSite),
    });
  }
  return { cookies, origins: localStorageToOrigins(storageEntries) };
}

/**
 * Map the sign-in page's `localStorage` entries to Playwright's storage-state `origins` shape.
 *
 * Pure and network-free. The values (a token among them) go into the capture file and nowhere else:
 * this function never logs, and the caller prints only a count.
 *
 * @param {unknown} entries - `[[name, value], …]` as read from the page
 * @returns {{origin: string, localStorage: {name: string, value: string}[]}[]}
 */
export function localStorageToOrigins(entries) {
  if (!Array.isArray(entries)) return [];
  const storage = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
    storage.push({ name: entry[0], value: entry[1] });
  }
  // An origin with nothing in it is not an origin Playwright needs to seed.
  return storage.length === 0 ? [] : [{ origin: APP_ORIGIN, localStorage: storage }];
}

function writeSecretFile(target, text) {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(target)}.${process.pid}.tmp`);
  try {
    // `mode` only applies on creation, so the temporary file is created private and then made
    // explicitly private again: a re-run can never inherit a permissive mode from an old file.
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Persist one capture and report it without revealing anything secret.
 *
 * @param {object} options
 * @param {unknown} options.payload - the CDP cookie answer
 * @param {string} options.outPath - destination file
 * @param {(line: string) => void} [options.stdout] - log sink (tests capture this)
 * @param {number} [options.now] - clock in milliseconds
 * @param {unknown} [options.storage] - the app page's `localStorage` entries (`[[name, value], …]`)
 * @returns {{path: string, cookies: number, domains: string[], storageKeys: number}}
 */
export function captureToFile(options) {
  const stdout = options.stdout ?? (line => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now();
  const raw = cookieList(options.payload);
  const state = cdpCookiesToStorageState(options.payload, now, options.storage);
  const storageKeys = state.origins.reduce((total, origin) => total + origin.localStorage.length, 0);

  if (state.cookies.length === 0) {
    throw new Error(
      raw.length === 0
        ? "Chrome returned no cookies at all; open https://coder.qwen.ai in that window, sign in, then run this script again"
        : "none of the cookies Chrome returned belong to coder.qwen.ai (or all of them have expired); "
          + "open https://coder.qwen.ai in that window, sign in, then run this script again",
    );
  }

  const target = resolve(options.outPath);
  const replaced = existsSync(target);
  writeSecretFile(target, `${JSON.stringify(state, null, 2)}\n`);

  const domains = [...new Set(state.cookies.map(cookie => cookie.domain))].sort();
  stdout("Qwen Code session captured from Chrome.");
  stdout(`  storage state: ${target} (mode 0600${replaced ? ", replaced the previous capture" : ""})`);
  stdout(`  cookies: ${state.cookies.length} (domains: ${domains.join(", ")})`);
  // A count only: a storage key name is not as sensitive as its value, but the log is the part
  // people paste, and the app's key list is not the operator's business.
  stdout(`  local storage keys: ${storageKeys} (origin: ${APP_ORIGIN})`);
  stdout("");
  stdout("This file contains a live Qwen Code session. Treat it like a password:");
  stdout("do not commit it, paste it into an issue, or leave it in a shared directory.");
  stdout("Delete it after importing it into the deployment. See doc/qwen-code.md for the exact steps.");
  return { path: target, cookies: state.cookies.length, domains, storageKeys };
}

async function getJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    const port = new URL(url).port || String(DEFAULT_PORT);
    throw new Error(
      `no Chrome DevTools endpoint at ${url}; quit Chrome completely, start it with `
      + `--remote-debugging-port=${port}, sign in at https://coder.qwen.ai, and run this script again`,
    );
  }
  if (!response.ok) {
    throw new Error(`Chrome's DevTools endpoint at ${url} answered HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Chrome's DevTools endpoint at ${url} did not answer JSON`);
  }
}

/**
 * Send one DevTools command over a WebSocket and resolve its result.
 *
 * Deliberately a single command per socket: the script needs one read, and a short-lived socket cannot
 * leak an attached debugger session behind it.
 */
function callCdp(webSocketUrl, method, params, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => finish(new Error(`Chrome did not answer ${method} within ${timeoutMs} ms`)), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) rejectPromise(error);
      else resolvePromise(value);
    }

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ id: 1, method, params }));
      } catch {
        finish(new Error(`could not send ${method} to Chrome`));
      }
    });
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || message.id !== 1) return;
      if (message.error) {
        finish(new Error(`Chrome refused ${method}: ${String(message.error.message ?? "unknown error")}`));
        return;
      }
      finish(undefined, message.result ?? {});
    });
    socket.addEventListener("error", () => {
      finish(new Error(
        `could not attach to Chrome's DevTools endpoint (${webSocketUrl}); if Chrome is running, restart it `
        + "with the same --remote-debugging-port plus --remote-allow-origins=* and try again",
      ));
    });
    socket.addEventListener("close", () => {
      finish(new Error("Chrome closed the DevTools connection before answering"));
    });
  });
}

/**
 * Read every cookie from the running Chrome.
 *
 * `Storage.getCookies` is a browser-level domain, so the browser target can answer it without a page
 * session. Some Chrome builds/version combinations only expose `Network.getAllCookies` on a page
 * target, hence the fallback — still one read, still no DOM.
 */
export async function fetchChromeCookies({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const base = `http://${host}:${port}`;
  const version = await getJson(`${base}/json/version`, timeoutMs);
  const browserSocket = version && typeof version.webSocketDebuggerUrl === "string"
    ? version.webSocketDebuggerUrl
    : undefined;
  if (!browserSocket) throw new Error("Chrome's DevTools endpoint did not report a browser WebSocket URL");

  try {
    const result = await callCdp(browserSocket, "Storage.getCookies", {}, timeoutMs);
    return cookieList(result);
  } catch (browserError) {
    const targets = await getJson(`${base}/json/list`, timeoutMs).catch(() => []);
    const page = Array.isArray(targets)
      ? targets.find(target => target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string")
      : undefined;
    if (!page) throw browserError;
    const result = await callCdp(page.webSocketDebuggerUrl, "Network.getAllCookies", {}, timeoutMs);
    return cookieList(result);
  }
}

/**
 * Read the sign-in page's `localStorage` from the running Chrome.
 *
 * `Runtime.evaluate` runs one expression on a page target at the provider's origin; `returnByValue`
 * hands back the JSON string. Only the page's own storage is read — no DOM, no click, no navigation.
 *
 * @returns {Promise<unknown[]>} `[[name, value], …]`, or an empty list when no provider page is open
 */
export async function fetchChromeLocalStorage({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const base = `http://${host}:${port}`;
  const targets = await getJson(`${base}/json/list`, timeoutMs).catch(() => []);
  const page = Array.isArray(targets)
    ? targets.find(target => target && target.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && hostAllowed(hostOf(target.url), QWEN_COOKIE_DOMAINS))
    : undefined;
  if (!page) {
    throw new Error(
      "no coder.qwen.ai page is open in that Chrome; open https://coder.qwen.ai in the signed-in window, "
      + "then run this script again — the session token the API checks lives in that page's local storage",
    );
  }
  const result = await callCdp(page.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: "JSON.stringify(Object.entries(localStorage))",
    returnByValue: true,
  }, timeoutMs);
  const value = result && result.result ? result.result.value : undefined;
  if (typeof value !== "string") return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** The hostname of a URL, or an empty string; the page target is chosen by it. */
function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  return port;
}

/** Parse the script's own arguments. Kept separate so unknown flags never get ignored silently. */
export function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, host: DEFAULT_HOST, port: DEFAULT_PORT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--out" || argument === "--port" || argument === "--host") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--out") {
        if (value.trim() === "") throw new Error("--out requires a file path");
        options.out = value;
      } else if (argument === "--port") {
        options.port = parsePort(value);
      } else {
        options.host = value;
      }
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(argument)}; run with --help`);
  }
  return options;
}

/**
 * Run the script. Returns a process exit code; errors are the caller's to print.
 *
 * @param {string[]} [argv]
 * @param {{stdout?: (line: string) => void}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const options = parseArgs(argv);
  const stdout = io.stdout ?? (line => process.stdout.write(`${line}\n`));
  if (options.help) {
    stdout(USAGE);
    return 0;
  }
  const cookies = await fetchChromeCookies({ host: options.host, port: options.port });
  const storage = await fetchChromeLocalStorage({ host: options.host, port: options.port });
  captureToFile({ payload: cookies, outPath: options.out, stdout, storage });
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      // This script's own messages never contain a cookie value; the provider's payload is never echoed.
      process.stderr.write(`qwen-storage-state: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}