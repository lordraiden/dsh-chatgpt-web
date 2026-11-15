/**
 * The operator endpoint-profiles page (issue #356).
 *
 * One self-contained document, served verbatim by `GET /v1/control/endpoints/` (and
 * `/index.html`): no build step, no external asset, no CDN and no absolute URL of any kind, exactly
 * like the sign-in page it sits beside. It is the *client* of the profile management surface:
 *
 * - `../endpoint-profiles` (GET)        — the profiles, the resulting base path and the guarding
 *   credential
 * - `../endpoint-profiles` (POST)       — create one
 * - `../endpoint-profiles/<name>` (PUT) — replace one (the name is the endpoint's identity)
 * - `../endpoint-profiles/<name>` (DELETE) — delete one; its path then answers a typed 404
 *
 * The page is served anonymously **by design**, like the sign-in page: a browser navigation cannot
 * carry an `Authorization` header, and the control token must never be put in a URL. Every endpoint
 * the page calls is guarded by the control token, which the page asks for once and keeps in this
 * tab's `sessionStorage` (never `localStorage`, never a cookie, never a URL). The page body carries
 * no data and no secret: the profile list is fetched after the token is accepted.
 *
 * What it shows is what the operator needs to point a client at an endpoint: the profile's public
 * base URL (`<origin>/p/<name>/v1`, computed from the origin the operator is already using, so a
 * reverse proxy needs no extra configuration) and which credential guards it (the service's global
 * API key — profiles mint no key of their own).
 */

/** The document served at `/v1/control/endpoints/`. Static; nothing is interpolated into it. */
export const WEB_CHAT_ENDPOINT_PROFILES_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>dsh-chatgpt-web — API endpoints</title>
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
  label { display: block; font-size: .85rem; color: var(--dim); margin: 10px 0 6px; }
  input, select { width: 100%; padding: 12px; font: inherit; color: var(--ink); background: #0c0f16;
                  border: 1px solid var(--line); border-radius: 10px; }
  button { min-height: 48px; padding: 12px 16px; font: inherit; font-weight: 600; color: #fff;
           background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  button.secondary { background: #2c3446; }
  button.danger { background: var(--bad); }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .row button { flex: 1 1 30%; }
  .hint { color: var(--dim); font-size: .8rem; margin: 8px 0 0; }
  .profile { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .profile h3 { font-size: .95rem; margin: 0 0 6px; }
  .profile dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: .85rem; }
  .profile dt { color: var(--dim); }
  .profile dd { margin: 0; word-break: break-all; }
  code { background: #0c0f16; border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; }
  .empty { color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>API endpoints</h1>
  <p id="status" role="status" aria-live="polite">Enter the operator control token.</p>
  <p class="hint">Each profile is a public endpoint under <code>/p/&lt;name&gt;/v1</code>. The
    default <code>/v1</code> endpoint keeps its configured behaviour. <a href="../auth/">Interactive
    sign-in &rarr;</a></p>
</header>

<section id="token-card">
  <form id="token-form">
    <label for="token">Control token</label>
    <input id="token" name="token" type="password" autocomplete="off" autocapitalize="off"
           spellcheck="false" placeholder="Operator control token">
    <button type="submit">Use token</button>
  </form>
  <p class="hint">Kept in this tab's session storage only: never in the URL, never in local storage.</p>
</section>

<section id="list-card" hidden>
  <h2>Endpoint profiles</h2>
  <div id="profiles"></div>
  <p class="hint" id="credential"></p>
</section>

<section id="edit-card" hidden>
  <h2 id="form-title">New profile</h2>
  <form id="profile-form">
    <label for="name">Name (URL segment; immutable once created)</label>
    <input id="name" name="name" type="text" autocomplete="off" autocapitalize="off"
           spellcheck="false" placeholder="hidden">
    <label for="visibility">Chat visibility</label>
    <select id="visibility" name="visibility">
      <option value="persistent">persistent — normal, history-visible chats</option>
      <option value="temporary">temporary — hidden Temporary Chats</option>
    </select>
    <label for="models">Allowed models (comma separated; empty = every catalogue model)</label>
    <input id="models" name="models" type="text" autocomplete="off" autocapitalize="off"
           spellcheck="false" placeholder="chatgpt-web/luna, chatgpt-web/think">
    <label for="max-turns">Concurrent turn budget (empty = the service default)</label>
    <input id="max-turns" name="max-turns" type="number" min="1" max="1024" inputmode="numeric">
    <div class="row">
      <button type="submit" id="save">Create profile</button>
      <button type="button" class="secondary" id="reset">New profile</button>
    </div>
  </form>
  <p class="hint">A profile selects among the models this service already serves. A model that is
    not in the catalogue, or a visibility mode this deployment cannot honour, is refused instead of
    silently served.</p>
</section>

<script>
(function () {
  "use strict";
  var TOKEN_KEY = "dsh-chatgpt-web.control-token";
  var API = "../endpoint-profiles";
  var state = { token: "", editing: null, profiles: [] };

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

  function text(value) { return value === null || value === undefined ? "" : String(value); }

  function profileUrl(name) { return API + "/" + encodeURIComponent(name); }

  function renderProfiles(payload) {
    var list = payload && Array.isArray(payload.profiles) ? payload.profiles : [];
    state.profiles = list;
    var host = el("profiles");
    host.textContent = "";
    if (list.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No endpoint profiles yet. Create one below.";
      host.appendChild(empty);
    }
    list.forEach(function (profile) {
      var card = document.createElement("div");
      card.className = "profile";
      var title = document.createElement("h3");
      title.textContent = profile.name;
      card.appendChild(title);
      var dl = document.createElement("dl");
      function row(label, value) {
        var dt = document.createElement("dt");
        dt.textContent = label;
        var dd = document.createElement("dd");
        dd.textContent = value;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      row("Base URL", location.origin + profile.path);
      row("Visibility", profile.chatVisibility);
      row("Models", profile.models && profile.models.length ? profile.models.join(", ") : "every catalogue model");
      row("Turn budget", profile.maxConcurrentTurns === null ? "service default" : String(profile.maxConcurrentTurns));
      card.appendChild(dl);
      var actions = document.createElement("div");
      actions.className = "row";
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary";
      edit.textContent = "Edit";
      edit.addEventListener("click", function () { beginEdit(profile); });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", function () { deleteProfile(profile); });
      actions.appendChild(edit);
      actions.appendChild(remove);
      card.appendChild(actions);
      host.appendChild(card);
    });
    var credential = payload && payload.credential ? payload.credential : null;
    el("credential").textContent = !credential
      ? ""
      : credential.required
        ? "Guarded by the service API key: send " + credential.header + " (or x-api-key). Profiles mint no key of their own."
        : "This loopback-only service has no API key configured, so its endpoints accept unauthenticated calls. Profiles mint no key of their own.";
    show("list-card", true);
    show("edit-card", true);
  }

  async function loadProfiles() {
    try {
      var payload = await api(API);
      show("token-card", false);
      renderProfiles(payload);
      setStatus("Endpoint profiles loaded.");
    } catch (error) {
      show("list-card", false);
      show("edit-card", false);
      show("token-card", true);
      setStatus(error.status === 401
        ? "That control token was refused."
        : "Could not reach the service: " + error.message);
    }
  }

  function resetForm() {
    state.editing = null;
    el("name").value = "";
    el("name").disabled = false;
    el("visibility").value = "persistent";
    el("models").value = "";
    el("max-turns").value = "";
    el("form-title").textContent = "New profile";
    el("save").textContent = "Create profile";
  }

  function beginEdit(profile) {
    state.editing = profile.name;
    el("name").value = profile.name;
    el("name").disabled = true;
    el("visibility").value = profile.chatVisibility;
    el("models").value = profile.models ? profile.models.join(", ") : "";
    el("max-turns").value = profile.maxConcurrentTurns === null ? "" : String(profile.maxConcurrentTurns);
    el("form-title").textContent = "Edit " + profile.name;
    el("save").textContent = "Save profile";
    el("edit-card").scrollIntoView({ block: "nearest" });
  }

  function profileBody() {
    var body = {
      name: el("name").value.trim(),
      chatVisibility: el("visibility").value
    };
    var models = el("models").value.split(",").map(function (value) { return value.trim(); })
      .filter(function (value) { return value.length > 0; });
    if (models.length > 0) body.models = models;
    var turns = el("max-turns").value.trim();
    if (turns.length > 0) body.maxConcurrentTurns = Number(turns);
    return body;
  }

  async function deleteProfile(profile) {
    if (!confirm('Delete endpoint profile "' + profile.name + '"? Its path will answer 404."')) return;
    try {
      await api(profileUrl(profile.name), "DELETE");
      setStatus("Deleted " + profile.name + ".");
      if (state.editing === profile.name) resetForm();
      await loadProfiles();
    } catch (error) {
      setStatus("Could not delete: " + error.message);
    }
  }

  el("token-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var value = el("token").value.trim();
    if (!value) return;
    state.token = value;
    sessionStorage.setItem(TOKEN_KEY, value);
    el("token").value = "";
    await loadProfiles();
  });

  el("profile-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var body = profileBody();
    if (!body.name) { setStatus("A profile name is required."); return; }
    try {
      if (state.editing === null) {
        await api(API, "POST", body);
        setStatus("Created " + body.name + ".");
      } else {
        await api(profileUrl(state.editing), "PUT", body);
        setStatus("Saved " + state.editing + ".");
      }
      resetForm();
      await loadProfiles();
    } catch (error) {
      setStatus("Could not save: " + error.message);
    }
  });

  el("reset").addEventListener("click", function () { resetForm(); });

  resetForm();
  state.token = sessionStorage.getItem(TOKEN_KEY) || "";
  if (state.token) loadProfiles();
})();
</script>
</body>
</html>
`;

/** The two paths that serve {@link WEB_CHAT_ENDPOINT_PROFILES_PAGE_HTML}. */
export const WEB_CHAT_ENDPOINT_PROFILES_PAGE_PATHS: readonly string[] = [
  "/v1/control/endpoints/",
  "/v1/control/endpoints/index.html",
];
