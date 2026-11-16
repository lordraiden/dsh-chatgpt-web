/**
 * The operator console: one entry point for everything an operator can see and change.
 *
 * It replaces the "three documents and no map" shape with one shell whose navigation names every
 * surface and whose reference explains every setting. It is a **client**, exactly like the pages it
 * links to: it owns no validator, no routing decision and no probe. The controls stay with their
 * owners (`/v1/control/settings/`, `/v1/control/endpoints/`, `/v1/control/auth/`), and this page
 * explains them and points at them — a link, not a second implementation.
 *
 * What it reads (all guarded by the control token, all existing):
 * - `../status` (GET) — version, mode, capability flags, turn queue and accounting
 * - `../config` (GET) — the live chat visibility and tuning
 *
 * Served anonymously **by design** (a browser navigation cannot carry an `Authorization` header) and
 * it carries no data and no secret: everything is fetched after the token is accepted, and the token
 * lives in this tab's `sessionStorage` only.
 *
 * ## The inline script must compile
 *
 * The document is one TypeScript template literal, so a stray escape resolves into the served script
 * and breaks it at parse time. This page therefore contains **no backslash at all**; the settings
 * catalogue is interpolated at module load (`JSON.stringify`), never written by hand. The test compiles
 * the exact served string with `new Function`, the same guard the other operator pages have.
 */
import { CONSOLE_SETTINGS } from "./console-content";

/** The document served at `/v1/control/` (and its aliases). */
export const WEB_CHAT_CONSOLE_PAGE_PATHS: readonly string[] = [
  "/v1/control/",
  "/v1/control/index.html",
  "/v1/control/console/",
  "/v1/control/console/index.html",
];

export const WEB_CHAT_CONSOLE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>dsh-chatgpt-web — console</title>
<style>
  :root { color-scheme: dark; --bg: #10131a; --card: #1a1f2b; --line: #2c3446; --ink: #e8ecf4; --dim: #9aa6bd; --accent: #4c8dff; --ok: #3fbf7f; --bad: #b4453c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink);
         font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 1.25rem; margin: 0 0 4px; }
  header p { margin: 0 0 14px; color: var(--dim); font-size: .85rem; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  nav button { flex: 1 1 auto; min-height: 44px; padding: 10px 12px; font: inherit; font-weight: 600;
               color: var(--ink); background: var(--card); border: 1px solid var(--line);
               border-radius: 10px; cursor: pointer; }
  nav button[aria-current="page"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 14px; margin-bottom: 14px; }
  section[hidden] { display: none; }
  h2 { font-size: 1rem; margin: 0 0 10px; }
  h3 { font-size: .9rem; margin: 14px 0 6px; color: var(--dim); }
  label { display: block; font-size: .85rem; color: var(--dim); margin: 10px 0 6px; }
  input { width: 100%; padding: 12px; font: inherit; color: var(--ink); background: #0c0f16;
          border: 1px solid var(--line); border-radius: 10px; }
  button.primary { min-height: 48px; padding: 12px 16px; font: inherit; font-weight: 600; color: #fff;
                   background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .hint { color: var(--dim); font-size: .8rem; margin: 8px 0 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: .85rem; }
  dt { color: var(--dim); }
  dd { margin: 0; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; margin-top: 6px; }
  th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .card h3 { margin: 0 0 6px; color: var(--ink); }
  .card p { margin: 0 0 8px; font-size: .85rem; }
  .card a { color: var(--accent); font-weight: 600; }
  .tag { display: inline-block; font-size: .7rem; color: var(--dim); border: 1px solid var(--line);
         border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
  .warn { color: var(--bad); font-size: .8rem; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>dsh-chatgpt-web — operator console</h1>
  <p>One map for every surface. The controls live on their own pages; this console explains each setting and links to the page that owns it.</p>
</header>

<nav id="nav" aria-label="Console sections">
  <button type="button" data-section="overview">Overview</button>
  <button type="button" data-section="chat">Chat</button>
  <button type="button" data-section="endpoints">Endpoints</button>
  <button type="button" data-section="memory">Memory</button>
  <button type="button" data-section="signin">Sign-in</button>
  <button type="button" data-section="doctor">Doctor</button>
  <button type="button" data-section="reference">Reference</button>
</nav>

<section id="token-card">
  <h2>Control token</h2>
  <p class="hint">The control token guards every endpoint this page and the linked pages call. It is kept in this tab only, never in a URL, a cookie or localStorage.</p>
  <label for="token">Control token</label>
  <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="paste the control token">
  <div class="row"><button class="primary" id="unlock" type="button">Unlock</button></div>
  <p class="hint" id="token-status"></p>
</section>

<section id="overview" hidden>
  <h2>Overview</h2>
  <dl id="overview-facts"></dl>
  <h3>What this service is</h3>
  <p class="hint">A text-only bridge in front of an authenticated consumer web chat. Clients call the OpenAI-compatible API; the bridge drives one browser turn per request. It is not a provider registry and it does not execute tools.</p>
</section>

<section id="chat" hidden>
  <h2>Chat</h2>
  <p class="hint">Visibility and the transport tuning. The controls are on the settings page; every field is explained in the reference below.</p>
  <div id="chat-cards"></div>
  <div class="row"><a href="../settings/"><button class="primary" type="button">Open the chat controls</button></a></div>
</section>

<section id="endpoints" hidden>
  <h2>Endpoints</h2>
  <p class="hint">Profiles give a client its own path (<code>/p/&lt;name&gt;/v1</code>) with its own visibility, model allowlist and concurrency. They add no provider and no model: the rows still come from the public catalogue.</p>
  <div id="endpoint-cards"></div>
  <div class="row"><a href="../endpoints/"><button class="primary" type="button">Open the profile editor</button></a></div>
</section>

<section id="memory" hidden>
  <h2>Memory</h2>
  <p class="hint">The bridge cannot configure its client. This section renders the environment block the client (Hindsight) needs, per operation, with placeholders for every secret.</p>
  <div id="memory-cards"></div>
  <div class="row"><a href="../settings/"><button class="primary" type="button">Open the routing generator</button></a></div>
</section>

<section id="signin" hidden>
  <h2>Sign-in</h2>
  <p class="hint">The sign-in surface drives the provider's own browser from this page. It is a live session surface with its own stream, so it stays a separate page: open it in a tab and keep it open until the session is captured.</p>
  <div class="row"><a href="../auth/"><button class="primary" type="button">Open the sign-in surface</button></a></div>
</section>

<section id="doctor" hidden>
  <h2>Doctor</h2>
  <p class="hint">The CLI's own doctor: it checks the configuration, the session and the catalogue, and performs one real browser turn.</p>
  <p class="warn">It costs one real turn. Run it when a turn fails and you need to know where the problem is.</p>
  <div class="row"><a href="../settings/"><button class="primary" type="button">Run the doctor</button></a></div>
</section>

<section id="reference" hidden>
  <h2>Reference</h2>
  <p class="hint">Every setting, what it does, when to change it, what it affects, its default, and which one wins when two overlap.</p>
  <table id="reference-table">
    <thead><tr><th>Setting</th><th>What / when / affects</th><th>Default</th><th>Precedence / external</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<script>
(function () {
  var TOKEN_KEY = "dsh-chatgpt-web.control-token";
  var SETTINGS = ${JSON.stringify(CONSOLE_SETTINGS)};
  var state = { token: "" };

  var nav = document.getElementById("nav");
  var tokenCard = document.getElementById("token-card");
  var tokenInput = document.getElementById("token");
  var tokenStatus = document.getElementById("token-status");

  function show(section) {
    var sections = document.querySelectorAll("section[id]");
    for (var i = 0; i < sections.length; i += 1) {
      var node = sections[i];
      if (node.id === "token-card") continue;
      node.hidden = node.id !== section;
    }
    var buttons = nav.querySelectorAll("button");
    for (var j = 0; j < buttons.length; j += 1) {
      var button = buttons[j];
      if (button.getAttribute("data-section") === section) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (section !== "overview") tokenCard.hidden = true;
    if (state.token) load();
  }

  function text(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function fact(dl, name, value) {
    var dt = document.createElement("dt");
    dt.textContent = name;
    var dd = document.createElement("dd");
    dd.textContent = text(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function card(container, setting) {
    var box = document.createElement("div");
    box.className = "card";
    var title = document.createElement("h3");
    title.textContent = setting.label;
    box.appendChild(title);
    var what = document.createElement("p");
    what.textContent = setting.what;
    box.appendChild(what);
    var when = document.createElement("p");
    when.textContent = "When: " + setting.when;
    box.appendChild(when);
    var affects = document.createElement("p");
    affects.textContent = "Affects: " + setting.affects;
    box.appendChild(affects);
    var note = setting.precedence || setting.external;
    if (note) {
      var extra = document.createElement("p");
      extra.className = "hint";
      extra.textContent = note;
      box.appendChild(extra);
    }
    container.appendChild(box);
  }

  function renderCards() {
    var bySection = { chat: [], endpoints: [], memory: [], security: [] };
    for (var i = 0; i < SETTINGS.length; i += 1) {
      var setting = SETTINGS[i];
      if (bySection[setting.section]) bySection[setting.section].push(setting);
    }
    var chat = document.getElementById("chat-cards");
    var endpoints = document.getElementById("endpoint-cards");
    var memory = document.getElementById("memory-cards");
    for (var c = 0; c < bySection.chat.length; c += 1) card(chat, bySection.chat[c]);
    for (var e = 0; e < bySection.endpoints.length; e += 1) card(endpoints, bySection.endpoints[e]);
    for (var m = 0; m < bySection.memory.length; m += 1) card(memory, bySection.memory[m]);
  }

  function renderReference() {
    var body = document.querySelector("#reference-table tbody");
    for (var i = 0; i < SETTINGS.length; i += 1) {
      var setting = SETTINGS[i];
      var row = document.createElement("tr");
      var name = document.createElement("td");
      name.textContent = setting.label;
      var detail = document.createElement("td");
      detail.textContent = setting.what + " When: " + setting.when + " Affects: " + setting.affects;
      var def = document.createElement("td");
      def.textContent = setting.defaultValue;
      var prec = document.createElement("td");
      prec.textContent = setting.precedence || setting.external || "";
      row.appendChild(name);
      row.appendChild(detail);
      row.appendChild(def);
      row.appendChild(prec);
      body.appendChild(row);
    }
  }

  function load() {
    var headers = { authorization: "Bearer " + state.token };
    var facts = document.getElementById("overview-facts");
    facts.textContent = "";
    fetch("../status", { headers: headers }).then(function (response) {
      if (!response.ok) throw new Error("status " + response.status);
      return response.json();
    }).then(function (status) {
      tokenCard.hidden = true;
      fact(facts, "Version", status.version);
      fact(facts, "Mode", status.mode);
      fact(facts, "Accepting turns", status.accepting_turns === true ? "yes" : "no");
      fact(facts, "Active turns", text(status.active_browser_turns) + " browser, " + text(status.active_http_turns) + " http");
      return fetch("../config", { headers: headers });
    }).then(function (response) {
      if (!response.ok) throw new Error("config " + response.status);
      return response.json();
    }).then(function (config) {
      fact(facts, "Chat visibility", config.chatVisibility);
      fact(facts, "Effective visibility", config.effectiveChatVisibility);
      tokenStatus.textContent = "";
    }).catch(function (error) {
      tokenCard.hidden = false;
      tokenStatus.textContent = "Could not load: " + error.message;
    });
  }

  document.getElementById("unlock").addEventListener("click", function () {
    var value = tokenInput.value.trim();
    if (!value) {
      tokenStatus.textContent = "Paste the control token first.";
      return;
    }
    state.token = value;
    sessionStorage.setItem(TOKEN_KEY, value);
    tokenInput.value = "";
    load();
  });

  nav.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-section]");
    if (!button) return;
    var section = button.getAttribute("data-section");
    location.hash = section;
    show(section);
  });

  state.token = sessionStorage.getItem(TOKEN_KEY) || "";
  renderCards();
  renderReference();
  var initial = (location.hash || "").replace("#", "");
  show(initial && document.getElementById(initial) ? initial : "overview");
  if (state.token) load();
})();
</script>
</body>
</html>`;
