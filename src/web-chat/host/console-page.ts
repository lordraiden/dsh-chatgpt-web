/**
 * The operator console: one page, one authentication, every surface in one place.
 *
 * It replaces the "three documents and no map" shape — and the per-page token cards — with a single
 * document that authenticates once and then shows, explains and edits everything an operator needs:
 *
 * - **Overview** — version, mode, accepting turns, the live counters and the effective visibility.
 * - **Visibility** — the global default and every profile's override in one table, so the precedence
 *   is visible instead of guessed.
 * - **Profiles** — the endpoint-profile editor (`/p/<name>/v1`), the same API the standalone page uses.
 * - **Tuning** — the transport knobs, grouped by the stage they affect.
 * - **Memory** — the per-operation routing generator for the memory backend.
 * - **Doctor** — the CLI's probe, with its cost stated.
 * - **Reference** — every setting: what, when, affects, default, precedence.
 *
 * It is a **client**: it owns no validator, no routing decision and no probe. Writes go through the
 * existing `PUT /v1/control/config` and `/v1/control/endpoint-profiles*`, and a refusal is shown as
 * the owner returned it.
 *
 * ## One authentication
 *
 * A browser navigation cannot carry an `Authorization` header, so the page asks for the control token
 * once, keeps it in this tab's `sessionStorage` (never `localStorage`, never a cookie, never a URL) and
 * uses it for every call. The token is the same key the standalone pages use, so a token entered here
 * also unlocks them.
 *
 * ## The inline script must compile
 *
 * The document is one TypeScript template literal, so a stray escape resolves into the served script
 * and breaks it at parse time. This page therefore contains **no backslash at all**: newlines are
 * `String.fromCharCode(10)` and the settings catalogue is interpolated at module load. The test compiles
 * the exact served string with `new Function`.
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
  :root { color-scheme: dark; --bg: #0e1117; --card: #171c26; --card2: #1d2330; --line: #2b3445; --ink: #e9edf5; --dim: #9aa6bd; --accent: #4c8dff; --ok: #3fbf7f; --bad: #c4574c; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 16px 48px; background: var(--bg); color: var(--ink);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 1.3rem; margin: 0 0 4px; letter-spacing: -.01em; }
  header p { margin: 0 0 16px; color: var(--dim); font-size: .85rem; max-width: 70ch; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; position: sticky; top: 0;
        background: var(--bg); padding: 8px 0; z-index: 2; }
  nav button { flex: 1 1 auto; min-height: 42px; padding: 8px 12px; font: inherit; font-size: .85rem;
               font-weight: 600; color: var(--ink); background: var(--card); border: 1px solid var(--line);
               border-radius: 10px; cursor: pointer; }
  nav button[aria-current="page"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
            padding: 16px; margin-bottom: 14px; }
  section[hidden] { display: none; }
  h2 { font-size: 1.05rem; margin: 0 0 4px; }
  h3 { font-size: .9rem; margin: 18px 0 8px; color: var(--ink); }
  .lede { color: var(--dim); font-size: .85rem; margin: 0 0 14px; max-width: 75ch; }
  label { display: block; font-size: .8rem; color: var(--dim); margin: 12px 0 6px; }
  input, select, textarea { width: 100%; padding: 11px; font: inherit; color: var(--ink);
                            background: #0a0d13; border: 1px solid var(--line); border-radius: 10px; }
  button.primary { min-height: 46px; padding: 11px 16px; font: inherit; font-weight: 600; color: #fff;
                   background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  button.ghost { min-height: 40px; padding: 8px 12px; font: inherit; color: var(--ink);
                 background: transparent; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
  button.danger { color: var(--bad); border-color: var(--bad); background: transparent; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: center; }
  .hint { color: var(--dim); font-size: .8rem; margin: 8px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: .85rem; }
  dt { color: var(--dim); }
  dd { margin: 0; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: .82rem; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  pre { background: #0a0d13; border: 1px solid var(--line); border-radius: 10px; padding: 12px;
        overflow-x: auto; font-size: .78rem; white-space: pre; }
  code { background: #0a0d13; border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; }
  .card { background: var(--card2); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .card h3 { margin: 0 0 6px; }
  .card p { margin: 0 0 8px; font-size: .82rem; color: var(--ink); }
  .card .meta { color: var(--dim); font-size: .78rem; }
  .badge { display: inline-block; font-size: .7rem; border: 1px solid var(--line); border-radius: 999px;
           padding: 1px 8px; color: var(--dim); }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .badge.bad { color: var(--bad); border-color: var(--bad); }
  .op { border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 12px; background: var(--card2); }
  .op h3 { margin: 0 0 8px; }
  #status { min-height: 1.4em; color: var(--dim); font-size: .82rem; margin: 0 0 12px; }
  .warn { color: var(--bad); font-size: .8rem; margin-top: 8px; }
  .auth { max-width: 520px; }
</style>
</head>
<body>
<header>
  <h1>dsh-chatgpt-web — operator console</h1>
  <p>One page, one token. Every surface, every setting, and how they relate — the controls write through the same APIs the standalone pages use.</p>
</header>

<section id="auth-card" class="auth">
  <h2>Control token</h2>
  <p class="lede">The control token guards every call this console makes. It stays in this tab only: never in a URL, a cookie or localStorage. The API key that clients use is a different credential and will not work here.</p>
  <label for="token">Control token</label>
  <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="paste the control token">
  <div class="row"><button class="primary" id="unlock" type="button">Unlock</button></div>
  <p class="hint" id="auth-status"></p>
</section>

<nav id="nav" aria-label="Console sections" hidden>
  <button type="button" data-section="overview">Overview</button>
  <button type="button" data-section="visibility">Visibility</button>
  <button type="button" data-section="profiles">Profiles</button>
  <button type="button" data-section="tuning">Tuning</button>
  <button type="button" data-section="memory">Memory</button>
  <button type="button" data-section="doctor">Doctor</button>
  <button type="button" data-section="reference">Reference</button>
</nav>

<p id="status"></p>

<section id="overview" hidden>
  <h2>Overview</h2>
  <p class="lede">What this service is doing right now. Read-only.</p>
  <dl id="overview-facts"></dl>
</section>

<section id="visibility" hidden>
  <h2>Visibility</h2>
  <p class="lede">Whether a turn runs in a Temporary Chat (nothing in the account's history) or in a persistent chat the bridge can continue. One default, and one override per profile: the profile's value wins for turns on that profile.</p>
  <div class="card">
    <h3>Default visibility</h3>
    <select id="visibility-select">
      <option value="persistent">persistent — normal, history-visible chats</option>
      <option value="temporary">temporary — hidden Temporary Chats</option>
    </select>
    <p class="meta" id="visibility-effective"></p>
    <div class="row"><button class="primary" id="save-visibility" type="button">Save default</button></div>
  </div>
  <h3>Profiles and their overrides</h3>
  <table id="visibility-table">
    <thead><tr><th>Profile</th><th>Path</th><th>Visibility</th><th>Models</th><th>Concurrent turns</th></tr></thead>
    <tbody></tbody>
  </table>
  <p class="hint">A profile with no override inherits the default. Edit a profile in the Profiles section.</p>
</section>

<section id="profiles" hidden>
  <h2>Profiles</h2>
  <p class="lede">A profile gives a client its own path (<code>/p/&lt;name&gt;/v1</code>) with its own visibility, model allowlist and concurrency. It adds no provider and no model: the rows still come from the public catalogue.</p>
  <table id="profiles-table">
    <thead><tr><th>Name</th><th>Path</th><th>Visibility</th><th>Models</th><th>Concurrent</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  <h3 id="profile-form-title">New profile</h3>
  <div class="grid">
    <div>
      <label for="p-name">Name (the path segment; cannot be renamed)</label>
      <input id="p-name" type="text" placeholder="hidden" autocomplete="off">
    </div>
    <div>
      <label for="p-visibility">Visibility</label>
      <select id="p-visibility">
        <option value="">inherit the default</option>
        <option value="persistent">persistent</option>
        <option value="temporary">temporary</option>
      </select>
    </div>
    <div>
      <label for="p-models">Model allowlist (comma separated; empty = every row)</label>
      <input id="p-models" type="text" placeholder="chatgpt-web/luna, chatgpt-web/think" autocomplete="off">
    </div>
    <div>
      <label for="p-max">Concurrent turns (empty = unlimited)</label>
      <input id="p-max" type="number" min="1" inputmode="numeric">
    </div>
  </div>
  <div class="row">
    <button class="primary" id="save-profile" type="button">Save profile</button>
    <button class="ghost" id="cancel-profile" type="button">Cancel</button>
  </div>
  <p class="hint" id="profile-status"></p>
</section>

<section id="tuning" hidden>
  <h2>Tuning</h2>
  <p class="lede">The transport knobs, grouped by the stage they affect. An empty field keeps the service default shown as its placeholder; the write goes through the configuration owner, so an invalid value is refused with its reason, never clamped.</p>
  <div class="card">
    <h3>Compose</h3>
    <label for="t-composerCharLimit">Largest prompt typed into the composer (characters)</label>
    <input id="t-composerCharLimit" type="number" min="1" inputmode="numeric">
  </div>
  <div class="card">
    <h3>First response</h3>
    <label for="t-responseDomGraceMs">Grace before the first visible token (ms)</label>
    <input id="t-responseDomGraceMs" type="number" min="1" inputmode="numeric">
    <label for="t-responseDomGraceMaxMs">Ceiling for that grace (ms)</label>
    <input id="t-responseDomGraceMaxMs" type="number" min="1" inputmode="numeric">
    <label for="t-responseDomGracePerCharMs">Extra grace per prompt character (ms)</label>
    <input id="t-responseDomGracePerCharMs" type="number" min="1" step="0.1" inputmode="decimal">
  </div>
  <div class="card">
    <h3>Send</h3>
    <label for="t-sendEnableGraceMs">Wait for the send control to become usable (ms)</label>
    <input id="t-sendEnableGraceMs" type="number" min="1" inputmode="numeric">
  </div>
  <div class="card">
    <h3>Generation</h3>
    <label for="t-generationRunningStallMs">Stuck-generator budget for one visible generation (ms)</label>
    <input id="t-generationRunningStallMs" type="number" min="1" inputmode="numeric">
  </div>
  <div class="card">
    <h3>Turn clock</h3>
    <label for="t-turnTimeoutMs">Absolute turn deadline (ms; empty = no deadline)</label>
    <input id="t-turnTimeoutMs" type="number" min="1" inputmode="numeric">
    <p class="hint">Keep it below the memory backend's own timeout so a caller can fail over instead of abandoning a live turn.</p>
  </div>
  <div class="row"><button class="primary" id="save-tuning" type="button">Save tuning</button></div>
</section>

<section id="memory" hidden>
  <h2>Memory</h2>
  <p class="lede">The bridge cannot configure its client. Choose where each memory operation goes and copy the environment block into that service. The block carries placeholders, never a secret, and this page never calls it.</p>
  <div id="memory-ops"></div>
  <div class="row"><button class="primary" id="copy-env" type="button">Copy the block</button></div>
  <pre id="env"></pre>
</section>

<section id="doctor" hidden>
  <h2>Doctor</h2>
  <p class="lede">The CLI's own probe: configuration, session, catalogue, and one real browser turn.</p>
  <p class="warn">It costs one real turn. Run it when a turn fails and you need to know where the problem is.</p>
  <div class="row"><button class="primary" id="run-doctor" type="button">Run the doctor</button></div>
  <div id="doctor-report"></div>
</section>

<section id="reference" hidden>
  <h2>Reference</h2>
  <p class="lede">Every setting: what it does, when to change it, what it affects, its default, and which one wins when two overlap.</p>
  <table id="reference-table">
    <thead><tr><th>Setting</th><th>What / when / affects</th><th>Default</th><th>Precedence / external</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<script>
(function () {
  var TOKEN_KEY = "dsh-chatgpt-web.control-token";
  var SETTINGS = ${JSON.stringify(CONSOLE_SETTINGS)};
  var NL = String.fromCharCode(10);
  var DEFAULT_SCHEME = "http" + "s://";
  var OPS = ["retain", "consolidation", "reflect"];
  var TUNING_KEYS = ["composerCharLimit", "responseDomGraceMs", "responseDomGraceMaxMs", "responseDomGracePerCharMs", "sendEnableGraceMs", "generationRunningStallMs"];
  var state = { token: "", config: {}, status: {}, catalogue: {}, profiles: [], editing: null };

  function el(id) { return document.getElementById(id); }
  function show(id, visible) { el(id).hidden = !visible; }
  function setStatus(text) { el("status").textContent = text; }

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
      var message = payload && (payload.error || payload.message) ? (payload.error || payload.message) : "request failed (" + response.status + ")";
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function fact(dl, name, value) {
    var dt = document.createElement("dt");
    dt.textContent = name;
    var dd = document.createElement("dd");
    dd.textContent = value === undefined || value === null ? "—" : String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderOverview() {
    var dl = el("overview-facts");
    dl.textContent = "";
    fact(dl, "Version", state.status.version);
    fact(dl, "Mode", state.status.mode);
    fact(dl, "Accepting turns", state.status.accepting_turns === true ? "yes" : "no");
    fact(dl, "Active turns", String(state.status.active_browser_turns) + " browser / " + String(state.status.active_http_turns) + " http");
    fact(dl, "Default visibility", state.config.chatVisibility);
    fact(dl, "Effective visibility", state.config.effectiveChatVisibility);
    fact(dl, "Profiles", String(state.profiles.length));
    fact(dl, "Catalogue rows", String((state.catalogue.models || []).length));
  }

  function renderVisibility() {
    var select = el("visibility-select");
    select.value = state.config.chatVisibility || "persistent";
    el("visibility-effective").textContent = "Effective now: " + String(state.config.effectiveChatVisibility || state.config.chatVisibility || "persistent");
    var body = document.querySelector("#visibility-table tbody");
    body.textContent = "";
    for (var i = 0; i < state.profiles.length; i += 1) {
      var profile = state.profiles[i];
      var row = document.createElement("tr");
      var cells = [
        profile.name,
        profile.path,
        profile.chatVisibility,
        profile.models ? profile.models.join(", ") : "every row",
        profile.maxConcurrentTurns === null ? "unlimited" : String(profile.maxConcurrentTurns),
      ];
      for (var c = 0; c < cells.length; c += 1) {
        var cell = document.createElement("td");
        cell.textContent = cells[c];
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    if (state.profiles.length === 0) {
      var empty = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "No profiles: every turn uses the default visibility.";
      empty.appendChild(td);
      body.appendChild(empty);
    }
  }

  function renderProfiles() {
    var body = document.querySelector("#profiles-table tbody");
    body.textContent = "";
    for (var i = 0; i < state.profiles.length; i += 1) {
      var profile = state.profiles[i];
      var row = document.createElement("tr");
      var name = document.createElement("td");
      name.textContent = profile.name;
      row.appendChild(name);
      var path = document.createElement("td");
      path.textContent = profile.path;
      row.appendChild(path);
      var visibility = document.createElement("td");
      visibility.textContent = profile.chatVisibility;
      row.appendChild(visibility);
      var models = document.createElement("td");
      models.textContent = profile.models ? profile.models.join(", ") : "every row";
      row.appendChild(models);
      var concurrent = document.createElement("td");
      concurrent.textContent = profile.maxConcurrentTurns === null ? "unlimited" : String(profile.maxConcurrentTurns);
      row.appendChild(concurrent);
      var actions = document.createElement("td");
      var edit = document.createElement("button");
      edit.className = "ghost";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", (function (target) {
        return function () { startEdit(target); };
      })(profile));
      var remove = document.createElement("button");
      remove.className = "ghost danger";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", (function (target) {
        return function () { deleteProfile(target); };
      })(profile));
      actions.appendChild(edit);
      actions.appendChild(remove);
      row.appendChild(actions);
      body.appendChild(row);
    }
  }

  function startEdit(profile) {
    state.editing = profile.name;
    el("profile-form-title").textContent = "Edit profile " + profile.name;
    el("p-name").value = profile.name;
    el("p-name").disabled = true;
    el("p-visibility").value = profile.chatVisibility === state.config.chatVisibility ? "" : profile.chatVisibility;
    el("p-models").value = profile.models ? profile.models.join(", ") : "";
    el("p-max").value = profile.maxConcurrentTurns === null ? "" : String(profile.maxConcurrentTurns);
    el("profile-status").textContent = "";
  }

  function resetProfileForm() {
    state.editing = null;
    el("profile-form-title").textContent = "New profile";
    el("p-name").value = "";
    el("p-name").disabled = false;
    el("p-visibility").value = "";
    el("p-models").value = "";
    el("p-max").value = "";
    el("profile-status").textContent = "";
  }

  function profileBody() {
    var body = {};
    var visibility = el("p-visibility").value;
    if (visibility) body.chatVisibility = visibility;
    var models = el("p-models").value.trim();
    if (models.length > 0) {
      body.models = models.split(",").map(function (value) { return value.trim(); }).filter(function (value) { return value.length > 0; });
    }
    var max = el("p-max").value.trim();
    if (max.length > 0) body.maxConcurrentTurns = Number(max);
    return body;
  }

  async function saveProfile() {
    var name = el("p-name").value.trim();
    if (!name) { el("profile-status").textContent = "A profile needs a name."; return; }
    try {
      if (state.editing) {
        await api("/v1/control/endpoint-profiles/" + encodeURIComponent(state.editing), "PUT", profileBody());
        el("profile-status").textContent = "Profile saved.";
      } else {
        await api("/v1/control/endpoint-profiles", "POST", Object.assign({ name: name }, profileBody()));
        el("profile-status").textContent = "Profile created.";
      }
      resetProfileForm();
      await loadAll();
    } catch (error) {
      el("profile-status").textContent = "Could not save: " + error.message;
    }
  }

  async function deleteProfile(profile) {
    if (!window.confirm("Delete the profile " + profile.name + "? Its path will answer a typed 404.")) return;
    try {
      await api("/v1/control/endpoint-profiles/" + encodeURIComponent(profile.name), "DELETE");
      el("profile-status").textContent = "Profile deleted.";
      resetProfileForm();
      await loadAll();
    } catch (error) {
      el("profile-status").textContent = "Could not delete: " + error.message;
    }
  }

  function renderTuning() {
    var effective = state.config.effective || {};
    var defaults = state.config.defaults || {};
    for (var i = 0; i < TUNING_KEYS.length; i += 1) {
      var key = TUNING_KEYS[i];
      var input = el("t-" + key);
      input.value = "";
      input.placeholder = defaults[key] !== undefined ? String(defaults[key]) : "";
    }
    el("t-turnTimeoutMs").value = "";
    el("t-turnTimeoutMs").placeholder = effective.turnTimeoutMs !== undefined ? String(effective.turnTimeoutMs) : "no deadline";
  }

  function tuningBody() {
    var tuning = {};
    for (var i = 0; i < TUNING_KEYS.length; i += 1) {
      var key = TUNING_KEYS[i];
      var raw = el("t-" + key).value.trim();
      if (raw.length > 0) tuning[key] = Number(raw);
    }
    var timeout = el("t-turnTimeoutMs").value.trim();
    if (timeout.length > 0) tuning.turnTimeoutMs = Number(timeout);
    var body = {};
    if (Object.keys(tuning).length > 0) body.tuning = tuning;
    return body;
  }

  async function saveTuning() {
    try {
      await api("/v1/control/config", "PUT", tuningBody());
      setStatus("Tuning saved.");
      await loadAll();
    } catch (error) {
      setStatus("Could not save: " + error.message);
    }
  }

  async function saveVisibility() {
    try {
      await api("/v1/control/config", "PUT", { chatVisibility: el("visibility-select").value });
      setStatus("Visibility saved.");
      await loadAll();
    } catch (error) {
      setStatus("Could not save: " + error.message);
    }
  }


  function profileByName(name) {
    for (var i = 0; i < state.profiles.length; i += 1) if (state.profiles[i].name === name) return state.profiles[i];
    return null;
  }

  function targetValue(op) {
    var select = el("target-" + op);
    return select ? select.value : "disabled";
  }

  function externalBase(op) {
    var value = el("external-" + op).value.trim();
    if (value.length === 0) return "";
    if (value.indexOf("://") < 0) value = DEFAULT_SCHEME + value;
    if (value.slice(-3) !== "/v1") value = value + "/v1";
    return value;
  }

  function modelFor(op, kind, profile) {
    var explicit = el("model-" + op).value.trim();
    if (explicit.length > 0) return explicit;
    if (kind === "profile" && profile && profile.models && profile.models.length > 0) return profile.models[0];
    return "chatgpt-web/luna";
  }

  function renderMemoryOps() {
    var container = el("memory-ops");
    container.textContent = "";
    for (var i = 0; i < OPS.length; i += 1) {
      var op = OPS[i];
      var box = document.createElement("div");
      box.className = "op";
      var title = document.createElement("h3");
      title.textContent = op;
      box.appendChild(title);
      var label = document.createElement("label");
      label.textContent = "Target";
      label.setAttribute("for", "target-" + op);
      box.appendChild(label);
      var select = document.createElement("select");
      select.id = "target-" + op;
      var disabled = document.createElement("option");
      disabled.value = "disabled";
      disabled.textContent = "disabled — no per-operation override";
      select.appendChild(disabled);
      for (var p = 0; p < state.profiles.length; p += 1) {
        var option = document.createElement("option");
        option.value = "profile:" + state.profiles[p].name;
        option.textContent = "bridge profile " + state.profiles[p].name;
        select.appendChild(option);
      }
      var external = document.createElement("option");
      external.value = "external";
      external.textContent = "external base URL";
      select.appendChild(external);
      box.appendChild(select);
      var externalWrap = document.createElement("div");
      externalWrap.id = "external-wrap-" + op;
      externalWrap.hidden = true;
      var externalLabel = document.createElement("label");
      externalLabel.textContent = "External base URL (the https scheme is added when omitted; the client appends /chat/completions)";
      externalWrap.appendChild(externalLabel);
      var externalInput = document.createElement("input");
      externalInput.id = "external-" + op;
      externalInput.type = "text";
      externalInput.placeholder = "api.example.com/v1";
      externalWrap.appendChild(externalInput);
      box.appendChild(externalWrap);
      var modelWrap = document.createElement("div");
      modelWrap.id = "model-wrap-" + op;
      modelWrap.hidden = true;
      var modelLabel = document.createElement("label");
      modelLabel.textContent = "Model (empty = the profile's first model, or chatgpt-web/luna)";
      modelWrap.appendChild(modelLabel);
      var modelInput = document.createElement("input");
      modelInput.id = "model-" + op;
      modelInput.type = "text";
      modelInput.placeholder = "chatgpt-web/luna";
      modelWrap.appendChild(modelInput);
      box.appendChild(modelWrap);
      container.appendChild(box);
      select.addEventListener("change", (function (operation) {
        return function () { updateMemoryVisibility(operation); renderEnv(); };
      })(op));
      externalInput.addEventListener("input", renderEnv);
      modelInput.addEventListener("input", renderEnv);
    }
  }

  function updateMemoryVisibility(op) {
    var target = targetValue(op);
    el("external-wrap-" + op).hidden = target !== "external";
    el("model-wrap-" + op).hidden = target === "disabled";
  }

  function renderEnv() {
    var lines = [
      "# Memory-backend per-operation LLM routing, generated by dsh-chatgpt-web.",
      "# No secret is included: replace every placeholder with your own value.",
      "# The base URL ends in /v1 because the client appends /chat/completions.",
      ""
    ];
    for (var i = 0; i < OPS.length; i += 1) {
      var op = OPS[i];
      var target = targetValue(op);
      var prefix = "HINDSIGHT_API_" + op.toUpperCase() + "_LLM_";
      if (target === "external") {
        var base = externalBase(op);
        if (base.length === 0) {
          lines.push("# " + op + " -> external base URL (enter one to complete this operation)");
          lines.push("");
          continue;
        }
        lines.push("# " + op + " -> external base URL");
        lines.push(prefix + "PROVIDER=openai");
        lines.push(prefix + "BASE_URL=" + base);
        lines.push(prefix + "API_KEY=<that provider's API key>");
        lines.push(prefix + "MODEL=" + modelFor(op, "external", null));
        lines.push("");
        continue;
      }
      if (target.slice(0, 8) === "profile:") {
        var profile = profileByName(target.slice(8));
        if (!profile) {
          lines.push("# " + op + " -> disabled (the selected profile no longer exists)");
          lines.push("");
          continue;
        }
        lines.push("# " + op + " -> bridge profile " + profile.name);
        lines.push(prefix + "PROVIDER=openai");
        lines.push(prefix + "BASE_URL=" + location.origin + profile.path + "/v1");
        lines.push(prefix + "API_KEY=<the bridge API key>");
        lines.push(prefix + "MODEL=" + modelFor(op, "profile", profile));
        lines.push("");
        continue;
      }
      lines.push("# " + op + " -> disabled (no per-operation override: the client keeps its global chain)");
      lines.push("");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    el("env").textContent = lines.join(NL);
  }

  function renderDoctor(report) {
    var container = el("doctor-report");
    container.textContent = "";
    var checks = (report && report.checks) || [];
    for (var i = 0; i < checks.length; i += 1) {
      var check = checks[i];
      var box = document.createElement("div");
      box.className = "op";
      var title = document.createElement("h3");
      title.textContent = check.id + " ";
      var badge = document.createElement("span");
      badge.className = "badge " + (check.status === "ok" ? "ok" : check.status === "error" ? "bad" : "");
      badge.textContent = check.status;
      title.appendChild(badge);
      box.appendChild(title);
      var message = document.createElement("p");
      message.textContent = check.message;
      box.appendChild(message);
      container.appendChild(box);
    }
  }

  function renderReference() {
    var body = document.querySelector("#reference-table tbody");
    body.textContent = "";
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

  async function loadAll() {
    try {
      var results = await Promise.all([
        api("/v1/control/config"),
        api("/v1/control/status"),
        api("/v1/control/catalogue"),
        api("/v1/control/endpoint-profiles"),
      ]);
      state.config = results[0] || {};
      state.status = results[1] || {};
      state.catalogue = results[2] || {};
      state.profiles = (results[3] && results[3].profiles) || [];
      show("auth-card", false);
      show("nav", true);
      renderOverview();
      renderVisibility();
      renderProfiles();
      renderTuning();
      renderMemoryOps();
      renderEnv();
      renderReference();
      setStatus("Loaded.");
      showSection(location.hash ? location.hash.slice(1) : "overview");
    } catch (error) {
      if (error.status === 401) {
        setStatus("That control token was refused. The API key is a different credential and will not work here.");
        show("auth-card", true);
        show("nav", false);
      } else {
        setStatus("Could not load: " + error.message);
      }
    }
  }

  function showSection(section) {
    var ids = ["overview", "visibility", "profiles", "tuning", "memory", "doctor", "reference"];
    if (ids.indexOf(section) < 0) section = "overview";
    for (var i = 0; i < ids.length; i += 1) show(ids[i], ids[i] === section);
    var buttons = el("nav").querySelectorAll("button");
    for (var b = 0; b < buttons.length; b += 1) {
      if (buttons[b].getAttribute("data-section") === section) buttons[b].setAttribute("aria-current", "page");
      else buttons[b].removeAttribute("aria-current");
    }
  }

  el("unlock").addEventListener("click", function () {
    var value = el("token").value.trim();
    if (!value) { el("auth-status").textContent = "Paste the control token first."; return; }
    state.token = value;
    sessionStorage.setItem(TOKEN_KEY, value);
    el("token").value = "";
    loadAll();
  });

  el("nav").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-section]");
    if (!button) return;
    var section = button.getAttribute("data-section");
    location.hash = section;
    showSection(section);
  });

  el("save-visibility").addEventListener("click", saveVisibility);
  el("save-tuning").addEventListener("click", saveTuning);
  el("save-profile").addEventListener("click", saveProfile);
  el("cancel-profile").addEventListener("click", resetProfileForm);
  el("copy-env").addEventListener("click", async function () {
    var block = el("env").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(block); setStatus("Environment block copied."); return; } catch (error) { /* fall through */ }
    }
    setStatus("Copy the block from the page manually.");
  });
  el("run-doctor").addEventListener("click", async function () {
    var button = el("run-doctor");
    button.disabled = true;
    setStatus("Running the doctor probe — one real browser turn, up to two minutes.");
    try {
      renderDoctor(await api("/v1/control/doctor", "POST"));
      setStatus("Doctor finished.");
    } catch (error) {
      setStatus("Doctor failed: " + error.message);
    } finally {
      button.disabled = false;
    }
  });

  renderReference();
  state.token = sessionStorage.getItem(TOKEN_KEY) || "";
  if (state.token) loadAll();
  else { show("auth-card", true); show("nav", false); }
})();
</script>
</body>
</html>`;
