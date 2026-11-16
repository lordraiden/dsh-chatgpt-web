/**
 * The operator settings page (issue #360).
 *
 * One self-contained document, served verbatim by `GET /v1/control/settings/` (and `/index.html`):
 * no build step, no external asset, no CDN and no absolute URL of any kind, exactly like the
 * endpoint-profiles and sign-in pages it sits beside. It is the *client* of surfaces that already
 * exist — it owns no validator, no routing decision and no probe of its own:
 *
 * - `../status` (GET)       — version, mode, capability flags, `turnQueue`, `turnAccounting`
 * - `../config` (GET)       — the live tuning, the defaults, the chat visibility and the profiles
 * - `../config` (PUT)       — the **existing** write path, with its existing validation owners
 * - `../catalogue` (GET)    — the rows the service serves, from the catalogue owner `/v1/models` uses
 * - `../auth/health` (GET)  — what every stored session does right now
 * - `../doctor` (POST)      — the CLI's own `runDoctor`, including its one real browser turn
 *
 * The page is served anonymously **by design**: a browser navigation cannot carry an `Authorization`
 * header, and the control token must never be put in a URL. Every endpoint the page calls is guarded
 * by the control token, which the page asks for once and keeps in this tab's `sessionStorage` (never
 * `localStorage`, never a cookie, never a URL). The page body carries no data and no secret: status,
 * catalogue and health are fetched only after the token is accepted.
 *
 * ## What it deliberately does not do
 *
 * - **No second validator.** The chat form posts the operator's numbers to `PUT /v1/control/config`
 *   and shows the refusal the configuration owner returns; it never re-implements a rule.
 * - **No second routing authority.** The memory-backend section only *writes an environment block*:
 *   the bridge cannot configure its client, so the page renders the per-operation `HINDSIGHT_API_*`
 *   variables for the operator to copy, with placeholders for every secret. It calls no external
 *   service, and it never sees the API key (it only holds the control token).
 * - **No endpoint-profile management.** Profiles are created and edited at `../endpoints/`; this page
 *   links there and only *selects* among the configured profiles.
 *
 * ## The inline script must compile
 *
 * The document is one TypeScript template literal, so a stray escape (`\n` written as an escape, a
 * `\/` inside a regex) resolves into the served script and breaks it at parse time — every handler
 * silently dies. This page therefore contains **no backslash at all**: newlines are built with
 * `String.fromCharCode(10)` and slashes are trimmed by hand. `tests/settings-page.test.ts` compiles
 * the exact served string with `new Function`, the same regression guard the endpoint-profiles page
 * has.
 */

/** The document served at `/v1/control/settings/`. Static; nothing is interpolated into it. */
export const WEB_CHAT_SETTINGS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>dsh-chatgpt-web — settings</title>
<style>
  :root { color-scheme: dark; --bg: #10131a; --card: #1a1f2b; --line: #2c3446; --ink: #e8ecf4; --dim: #9aa6bd; --accent: #4c8dff; --ok: #3fbf7f; --bad: #b4453c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink);
         font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 1.25rem; margin: 0 0 4px; }
  #status { margin: 0 0 16px; color: var(--dim); min-height: 1.5em; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 14px; margin-bottom: 14px; }
  h2 { font-size: 1rem; margin: 0 0 10px; }
  h3 { font-size: .9rem; margin: 14px 0 6px; color: var(--dim); }
  label { display: block; font-size: .85rem; color: var(--dim); margin: 10px 0 6px; }
  input, select { width: 100%; padding: 12px; font: inherit; color: var(--ink); background: #0c0f16;
                  border: 1px solid var(--line); border-radius: 10px; }
  button { min-height: 48px; padding: 12px 16px; font: inherit; font-weight: 600; color: #fff;
           background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  button.secondary { background: #2c3446; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .row button { flex: 1 1 30%; }
  .hint { color: var(--dim); font-size: .8rem; margin: 8px 0 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: .85rem; }
  dt { color: var(--dim); }
  dd { margin: 0; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; margin-top: 6px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  pre { background: #0c0f16; border: 1px solid var(--line); border-radius: 10px; padding: 12px;
        overflow-x: auto; font-size: .8rem; white-space: pre; }
  code { background: #0c0f16; border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; }
  .op { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .op h3 { margin: 0 0 6px; color: var(--ink); }
  .warning { color: #f0c674; }
</style>
</head>
<body>
<header>
  <h1>Settings</h1>
  <p id="status" role="status" aria-live="polite">Enter the operator control token.</p>
  <p class="hint">This page configures the bridge. It never writes the memory backend's environment:
    the routing section generates a block for you to copy. <a href="../endpoints/">API endpoints
    &rarr;</a> &middot; <a href="../auth/">Interactive sign-in &rarr;</a></p>
</header>

<section id="token-card">
  <form id="token-form">
    <label for="token">Control token</label>
    <input id="token" name="token" type="password" autocomplete="off" autocapitalize="off"
           spellcheck="false" placeholder="Operator control token">
    <button type="submit">Use token</button>
  </form>
  <p class="hint">Kept in this tab's session storage only: never in the URL, never in local storage.
    The API key that clients use is a different credential and will not work here.</p>
</section>

<section id="status-card" hidden>
  <h2>Status</h2>
  <dl id="status-list"></dl>
  <h3>Session health</h3>
  <div id="health"></div>
  <h3>Catalogue</h3>
  <div id="catalogue"></div>
  <h3>Turn queue</h3>
  <pre id="queue"></pre>
  <h3>Turn accounting</h3>
  <div id="accounting"></div>
</section>

<section id="chat-card" hidden>
  <h2>Chat</h2>
  <form id="chat-form">
    <label for="visibility">Chat visibility</label>
    <select id="visibility" name="visibility">
      <option value="persistent">persistent — normal, history-visible chats</option>
      <option value="temporary">temporary — hidden Temporary Chats</option>
    </select>
    <p class="hint" id="visibility-effective"></p>
    <h3>Tuning</h3>
    <label for="t-composerCharLimit">Composer character limit</label>
    <input id="t-composerCharLimit" type="number" min="1" inputmode="numeric">
    <label for="t-responseDomGraceMs">First-token grace (ms)</label>
    <input id="t-responseDomGraceMs" type="number" min="1" inputmode="numeric">
    <label for="t-responseDomGraceMaxMs">First-token grace ceiling (ms)</label>
    <input id="t-responseDomGraceMaxMs" type="number" min="1" inputmode="numeric">
    <label for="t-responseDomGracePerCharMs">Grace growth per prompt character (ms)</label>
    <input id="t-responseDomGracePerCharMs" type="number" min="1" step="0.1" inputmode="decimal">
    <label for="t-sendEnableGraceMs">Send-enable grace (ms)</label>
    <input id="t-sendEnableGraceMs" type="number" min="1" inputmode="numeric">
    <label for="t-generationRunningStallMs">Stuck-generator budget (ms)</label>
    <input id="t-generationRunningStallMs" type="number" min="1" inputmode="numeric">
    <label for="t-turnTimeoutMs">Absolute turn deadline (ms; empty = no deadline)</label>
    <input id="t-turnTimeoutMs" type="number" min="1" inputmode="numeric">
    <div class="row">
      <button type="submit" id="save-chat">Save chat settings</button>
    </div>
  </form>
  <p class="hint">An empty field keeps the service default shown as its placeholder. The write goes
    through <code>PUT /v1/control/config</code>, which validates every value: an invalid number is
    refused with the reason, never silently clamped.</p>
</section>

<section id="routing-card" hidden>
  <h2>Memory backend routing</h2>
  <p class="hint">Choose where each memory operation goes. The block below is for the memory
    backend's own environment: it contains placeholders, never a secret, and this page never calls
    it. Bridge profiles are created and edited at <a href="../endpoints/">API endpoints</a>.</p>
  <div class="op">
    <h3>retain</h3>
    <label for="target-retain">Target</label>
    <select id="target-retain"></select>
    <div id="external-wrap-retain" hidden>
      <label for="external-retain">External base URL (the https scheme is added when omitted; Hindsight appends /chat/completions)</label>
      <input id="external-retain" type="text" placeholder="api.example.com/v1">
    </div>
    <div id="model-wrap-retain" hidden>
      <label for="model-retain">Model (empty = the profile's first model, or chatgpt-web/luna)</label>
      <input id="model-retain" type="text" placeholder="chatgpt-web/luna">
    </div>
  </div>
  <div class="op">
    <h3>consolidation</h3>
    <label for="target-consolidation">Target</label>
    <select id="target-consolidation"></select>
    <div id="external-wrap-consolidation" hidden>
      <label for="external-consolidation">External base URL (the https scheme is added when omitted; Hindsight appends /chat/completions)</label>
      <input id="external-consolidation" type="text" placeholder="api.example.com/v1">
    </div>
    <div id="model-wrap-consolidation" hidden>
      <label for="model-consolidation">Model (empty = the profile's first model, or chatgpt-web/luna)</label>
      <input id="model-consolidation" type="text" placeholder="chatgpt-web/luna">
    </div>
  </div>
  <div class="op">
    <h3>reflect</h3>
    <label for="target-reflect">Target</label>
    <select id="target-reflect"></select>
    <div id="external-wrap-reflect" hidden>
      <label for="external-reflect">External base URL (the https scheme is added when omitted; Hindsight appends /chat/completions)</label>
      <input id="external-reflect" type="text" placeholder="api.example.com/v1">
    </div>
    <div id="model-wrap-reflect" hidden>
      <label for="model-reflect">Model (empty = the profile's first model, or chatgpt-web/luna)</label>
      <input id="model-reflect" type="text" placeholder="chatgpt-web/luna">
    </div>
  </div>
  <p class="hint">Environment block (copy into the memory backend)</p>
  <pre id="env"></pre>
  <div class="row">
    <button type="button" class="secondary" id="copy-env">Copy block</button>
  </div>
</section>

<section id="doctor-card" hidden>
  <h2>Doctor</h2>
  <p class="hint">Runs the service's own doctor probe. <strong class="warning">Warning: it performs
    one real browser turn</strong> on the default endpoint, so it consumes a turn of the account's
    quota and can take up to two minutes.</p>
  <div class="row">
    <button type="button" id="run-doctor">Run doctor</button>
  </div>
  <div id="doctor-report"></div>
</section>

<script>
(function () {
  "use strict";
  var TOKEN_KEY = "dsh-chatgpt-web.control-token";
  // A real newline, built without a template-literal escape: this document is one TypeScript
  // template literal, so a backslash written here would be consumed before the browser sees it.
  var NL = String.fromCharCode(10);
  var OPS = [
    { id: "retain", label: "retain" },
    { id: "consolidation", label: "consolidation" },
    { id: "reflect", label: "reflect" }
  ];
  var TUNING_KEYS = [
    "composerCharLimit",
    "responseDomGraceMs",
    "responseDomGraceMaxMs",
    "responseDomGracePerCharMs",
    "sendEnableGraceMs",
    "generationRunningStallMs"
  ];
  var DEFAULT_BRIDGE_MODEL = "chatgpt-web/luna";
  // Built from parts so the document contains no absolute URL of any kind: this page is offline-safe
  // by construction and never points at another origin.
  var DEFAULT_SCHEME = "http" + "s://";
  var state = { token: "", config: null, status: null, health: null, catalogue: [] };

  function el(id) { return document.getElementById(id); }
  function show(id, visible) { var node = el(id); if (node) node.hidden = !visible; }
  function setStatus(value) { el("status").textContent = value; }
  function text(value) { return value === null || value === undefined ? "" : String(value); }

  async function api(path, method, body) {
    var init = { method: method || "GET", headers: { "Authorization": "Bearer " + state.token } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var response = await fetch(path, init);
    var payload = null;
    try { payload = await response.json(); } catch (error) { payload = null; }
    if (!response.ok) {
      var message = payload && (payload.error || payload.message)
        ? (payload.error || payload.message)
        : "request failed (" + response.status + ")";
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function clear(node) { node.textContent = ""; }

  function row(host, label, value) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    host.appendChild(dt);
    host.appendChild(dd);
  }

  function table(headers, rows) {
    var node = document.createElement("table");
    var head = document.createElement("tr");
    headers.forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    });
    node.appendChild(head);
    rows.forEach(function (values) {
      var tr = document.createElement("tr");
      values.forEach(function (value) {
        var td = document.createElement("td");
        td.textContent = text(value);
        tr.appendChild(td);
      });
      node.appendChild(tr);
    });
    return node;
  }

  function replace(hostId, node) {
    var host = el(hostId);
    clear(host);
    host.appendChild(node);
  }

  function onEdit(node, handler) {
    node.addEventListener("input", handler);
    node.addEventListener("change", handler);
  }

  function capabilityLabel(status) {
    if (status && status.solAvailable === true) return "Sol";
    if (status && status.proAvailable === true) return "Pro";
    return "Free";
  }

  function renderStatus() {
    var status = state.status || {};
    var list = el("status-list");
    clear(list);
    row(list, "Version", text(status.version));
    row(list, "Mode", text(status.mode));
    row(list, "Accepting turns", status.accepting_turns === true ? "yes" : "no");
    row(list, "Account capability", capabilityLabel(status)
      + " (solAvailable " + text(status.solAvailable)
      + ", proAvailable " + text(status.proAvailable) + ")");
    row(list, "Uptime", Math.round(Number(status.uptime) || 0) + " s");
    show("status-card", true);
  }

  function renderHealth() {
    var payload = state.health || {};
    if (payload.ok !== true) {
      replace("health", table(["Provider", "State", "Verified", "Reason"], [
        ["(unavailable)", "unknown", "", text(payload.error || "the session check could not be produced")]
      ]));
      return;
    }
    var providers = Array.isArray(payload.providers) ? payload.providers : [];
    var rows = providers.map(function (provider) {
      return [
        text(provider.label || provider.providerId),
        text(provider.state),
        text(provider.verifiedAt || "never"),
        text(provider.reason || "")
      ];
    });
    replace("health", table(["Provider", "State", "Verified", "Reason"], rows));
  }

  function renderCatalogue() {
    var rows = state.catalogue.map(function (model) {
      return [text(model.slug), text(model.display_name), text(model.default_reasoning_level)];
    });
    replace("catalogue", table(["Model", "Name", "Reasoning"], rows));
  }

  function renderQueue() {
    var queue = (state.status && state.status.turnQueue) || {};
    el("queue").textContent = [
      "capacity " + text(queue.capacity) + " · waiting " + text(queue.depth)
        + " · grants " + text(queue.grants) + " · active " + text(queue.active)
        + " · active leases " + text(queue.activeLeases),
      "granted " + text(queue.granted) + " · refused " + text(queue.refused)
        + " · max wait " + text(queue.waitMsMax) + " ms"
        + " · wait budget " + text(queue.waitBudgetMs) + " ms"
    ].join(NL);
  }

  function renderAccounting() {
    var accounting = (state.status && state.status.turnAccounting) || {};
    var operations = Array.isArray(accounting.operations) ? accounting.operations : [];
    var host = el("accounting");
    clear(host);
    var summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = "requests " + text(accounting.requests)
      + " · browser turns " + text(accounting.browserTurns)
      + " · replay turns " + text(accounting.replayTurns)
      + " · continuations " + text(accounting.continuationTurns)
      + " · replayed " + text(accounting.replayMessages) + " messages / "
      + text(accounting.replayChars) + " chars"
      + " · max turn " + text(accounting.turnMsMax) + " ms";
    host.appendChild(summary);
    host.appendChild(table(
      ["Operation", "Requests", "Turns", "Replays", "Continuations", "Max wait ms", "Max turn ms"],
      operations.map(function (operation) {
        return [
          text(operation.operation), text(operation.requests), text(operation.browserTurns),
          text(operation.replayTurns), text(operation.continuationTurns),
          text(operation.waitMsMax), text(operation.turnMsMax)
        ];
      })
    ));
  }

  function renderChat() {
    var config = state.config || {};
    var tuning = config.tuning || {};
    var defaults = config.defaults || {};
    var effective = config.effective || {};
    el("visibility").value = text(config.chatVisibility || "persistent");
    el("visibility-effective").textContent = "Effective now: "
      + text(config.effectiveChatVisibility || "persistent")
      + ". A provider-scoped configuration block can still override this field.";
    TUNING_KEYS.forEach(function (key) {
      var input = el("t-" + key);
      var configured = tuning[key];
      input.value = configured === undefined || configured === null ? "" : String(configured);
      input.placeholder = "default " + text(defaults[key]);
    });
    var timeout = el("t-turnTimeoutMs");
    timeout.value = tuning.turnTimeoutMs === undefined || tuning.turnTimeoutMs === null
      ? ""
      : String(tuning.turnTimeoutMs);
    timeout.placeholder = effective.turnTimeoutMs === undefined
      ? "no absolute deadline"
      : "effective " + text(effective.turnTimeoutMs);
    show("chat-card", true);
  }

  function hasStoredTuning() {
    var tuning = (state.config && state.config.tuning) || {};
    var keys = Object.keys(tuning);
    return keys.length > 0;
  }

  /**
   * The body for PUT /v1/control/config.
   *
   * Only the fields the operator filled in are sent, so an untouched field keeps following the
   * service default instead of being pinned. The configuration owner refuses an empty tuning block,
   * so "the operator cleared every field while the deployment had overrides" is sent as the
   * effective values (the defaults) — the behaviour the form shows, expressed in the only shape the
   * write path accepts. Validation itself stays entirely server-side.
   */
  function chatBody() {
    var tuning = {};
    TUNING_KEYS.forEach(function (key) {
      var raw = el("t-" + key).value.trim();
      if (raw.length > 0) tuning[key] = Number(raw);
    });
    var timeout = el("t-turnTimeoutMs").value.trim();
    if (timeout.length > 0) tuning.turnTimeoutMs = Number(timeout);
    var body = { chatVisibility: el("visibility").value };
    if (Object.keys(tuning).length > 0) {
      body.tuning = tuning;
    } else if (hasStoredTuning()) {
      var effective = (state.config && state.config.effective) || {};
      var defaults = (state.config && state.config.defaults) || {};
      TUNING_KEYS.forEach(function (key) {
        if (defaults[key] !== undefined) tuning[key] = defaults[key];
      });
      if (effective.turnTimeoutMs !== undefined) tuning.turnTimeoutMs = effective.turnTimeoutMs;
      body.tuning = tuning;
    }
    return body;
  }

  function profiles() {
    var config = state.config || {};
    return Array.isArray(config.endpointProfiles) ? config.endpointProfiles : [];
  }

  function profileByName(name) {
    var list = profiles();
    for (var index = 0; index < list.length; index += 1) {
      if (list[index].name === name) return list[index];
    }
    return null;
  }

  function trimTrailingSlashes(value) {
    var out = String(value || "").trim();
    while (out.length > 0 && out.charAt(out.length - 1) === "/") out = out.slice(0, -1);
    return out;
  }

  function bridgeBase(profile) { return location.origin + profile.path + "/v1"; }

  function externalBase(operation) {
    var base = trimTrailingSlashes(el("external-" + operation.id).value);
    if (base.length === 0) return "";
    // Hindsight needs a full base URL; an operator typing "host/v1" means the usual https origin.
    if (base.indexOf("://") < 0) base = DEFAULT_SCHEME + base;
    return base.slice(-3) === "/v1" ? base : base + "/v1";
  }

  function modelFor(operation, target, profile) {
    var typed = el("model-" + operation.id).value.trim();
    if (typed.length > 0) return typed;
    if (target === "profile" && profile && Array.isArray(profile.models) && profile.models.length > 0) {
      return profile.models[0];
    }
    return target === "profile" ? DEFAULT_BRIDGE_MODEL : "<model id>";
  }

  function targetValue(operation) { return el("target-" + operation.id).value; }

  function updateRoutingVisibility() {
    OPS.forEach(function (operation) {
      var target = targetValue(operation);
      show("external-wrap-" + operation.id, target === "external");
      show("model-wrap-" + operation.id, target !== "");
    });
  }

  function renderEnv() {
    var lines = [
      "# Hindsight per-operation LLM routing, generated by dsh-chatgpt-web.",
      "# No secret is included: replace every placeholder with your own value.",
      "# The base URL ends in /v1 because Hindsight appends /chat/completions.",
      ""
    ];
    OPS.forEach(function (operation) {
      var target = targetValue(operation);
      var prefix = "HINDSIGHT_API_" + operation.id.toUpperCase() + "_LLM_";
      if (target === "external") {
        var base = externalBase(operation);
        if (base.length === 0) {
          lines.push("# " + operation.id + " → external base URL (enter one to complete this operation)");
          lines.push("");
          return;
        }
        lines.push("# " + operation.id + " → external base URL");
        lines.push(prefix + "PROVIDER=openai");
        lines.push(prefix + "BASE_URL=" + base);
        lines.push(prefix + "API_KEY=<that provider's API key>");
        lines.push(prefix + "MODEL=" + modelFor(operation, "external", null));
        lines.push("");
        return;
      }
      if (target.slice(0, 8) === "profile:") {
        var profile = profileByName(target.slice(8));
        if (!profile) {
          lines.push("# " + operation.id + " → disabled (the selected bridge profile no longer exists)");
          lines.push("");
          return;
        }
        lines.push("# " + operation.id + " → bridge profile " + profile.name);
        lines.push(prefix + "PROVIDER=openai");
        lines.push(prefix + "BASE_URL=" + bridgeBase(profile));
        lines.push(prefix + "API_KEY=<the bridge API key>");
        lines.push(prefix + "MODEL=" + modelFor(operation, "profile", profile));
        lines.push("");
        return;
      }
      lines.push("# " + operation.id
        + " → disabled (no per-operation override: Hindsight keeps its global chain)");
      lines.push("");
    });
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    el("env").textContent = lines.join(NL);
  }

  function renderRouting() {
    OPS.forEach(function (operation) {
      var select = el("target-" + operation.id);
      var previous = select.value;
      clear(select);
      var values = [""];
      var disabled = document.createElement("option");
      disabled.value = "";
      disabled.textContent = "disabled — leave this operation on the backend's own chain";
      select.appendChild(disabled);
      profiles().forEach(function (profile) {
        var option = document.createElement("option");
        option.value = "profile:" + profile.name;
        option.textContent = "bridge profile: " + profile.name + " (" + profile.chatVisibility + ")";
        select.appendChild(option);
        values.push(option.value);
      });
      var external = document.createElement("option");
      external.value = "external";
      external.textContent = "external base URL";
      select.appendChild(external);
      values.push("external");
      select.value = values.indexOf(previous) >= 0 ? previous : "";
    });
    updateRoutingVisibility();
    renderEnv();
  }

  function renderDoctor(report) {
    var checks = report && Array.isArray(report.checks) ? report.checks : [];
    var host = el("doctor-report");
    clear(host);
    var headline = document.createElement("p");
    headline.textContent = report && report.ok === true ? "Doctor result: ready" : "Doctor result: not ready";
    host.appendChild(headline);
    host.appendChild(table(
      ["Status", "Check", "Message", "Detail"],
      checks.map(function (check) {
        return [text(check.status), text(check.id), text(check.message), text(check.detail || "")];
      })
    ));
  }

  async function loadAll() {
    try {
      var results = await Promise.all([api("../config"), api("../status"), api("../catalogue")]);
      state.config = results[0] || {};
      state.status = results[1] || {};
      state.catalogue = results[2] && Array.isArray(results[2].models) ? results[2].models : [];
      try {
        state.health = await api("../auth/health");
      } catch (healthError) {
        state.health = { ok: false, providers: [], error: healthError.message };
      }
      show("token-card", false);
      renderStatus();
      renderHealth();
      renderCatalogue();
      renderQueue();
      renderAccounting();
      renderChat();
      renderRouting();
      show("routing-card", true);
      show("doctor-card", true);
      setStatus("Settings loaded.");
    } catch (error) {
      show("status-card", false);
      show("chat-card", false);
      show("routing-card", false);
      show("doctor-card", false);
      show("token-card", true);
      setStatus(error.status === 401
        ? "That control token was refused."
        : "Could not reach the service: " + error.message);
    }
  }

  el("token-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var value = el("token").value.trim();
    if (!value) return;
    state.token = value;
    sessionStorage.setItem(TOKEN_KEY, value);
    el("token").value = "";
    await loadAll();
  });

  el("chat-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    try {
      await api("../config", "PUT", chatBody());
      await loadAll();
      setStatus("Chat settings saved.");
    } catch (error) {
      setStatus("Could not save: " + error.message);
    }
  });

  OPS.forEach(function (operation) {
    el("target-" + operation.id).addEventListener("change", function () {
      updateRoutingVisibility();
      renderEnv();
    });
    onEdit(el("external-" + operation.id), renderEnv);
    onEdit(el("model-" + operation.id), renderEnv);
  });

  el("copy-env").addEventListener("click", async function () {
    var block = el("env").textContent;
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(block);
        setStatus("Environment block copied.");
        return;
      } catch (error) {
        // fall through to the manual instruction
      }
    }
    setStatus("Copy the block from the page manually.");
  });

  el("run-doctor").addEventListener("click", async function () {
    var button = el("run-doctor");
    button.disabled = true;
    setStatus("Running the doctor probe — this performs one real browser turn and can take up to two minutes.");
    try {
      var report = await api("../doctor", "POST");
      renderDoctor(report);
      setStatus(report && report.ok === true ? "Doctor: ready." : "Doctor: not ready.");
    } catch (error) {
      setStatus("Doctor failed: " + error.message);
    } finally {
      button.disabled = false;
    }
  });

  state.token = sessionStorage.getItem(TOKEN_KEY) || "";
  if (state.token) loadAll();
})();
</script>
</body>
</html>
`;

/** The two paths that serve {@link WEB_CHAT_SETTINGS_PAGE_HTML}. */
export const WEB_CHAT_SETTINGS_PAGE_PATHS: readonly string[] = [
  "/v1/control/settings/",
  "/v1/control/settings/index.html",
];
