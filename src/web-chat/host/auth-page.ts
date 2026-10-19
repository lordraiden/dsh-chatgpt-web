/**
 * The operator sign-in page (issue #276, slice 2a).
 *
 * One self-contained document, served verbatim by `GET /v1/control/auth/` (and `/index.html`): no
 * build step, no external asset, no CDN, no absolute URL of any kind — the container may be offline,
 * and a page that fetched anything from somewhere else would be a second, unreviewed trust anchor.
 *
 * It is the *client* of the surface in `auth-surface.ts`; every endpoint it calls is relative to this
 * page's own directory, so the same bytes work at either path:
 *
 * - `providers`                    — the providers offering interactive sign-in
 * - `sessions` (POST)              — open one
 * - `sessions/<id>` (GET, DELETE)  — read it, or cancel (which acknowledges the capture)
 * - `sessions/<id>/input` (POST)   — one relayed input
 * - `sessions/<id>/stream` (GET)   — the frame/state relay, read with `fetch`, not `EventSource`
 *
 * The control token is asked for once, kept in this tab's `sessionStorage` (never `localStorage`,
 * never a URL, never a cookie) and sent as a bearer header. `EventSource` is deliberately not used
 * for the stream: it cannot carry an `Authorization` header, which would force the token into the
 * query string — exactly the leak the token handling exists to avoid.
 *
 * Every pointer coordinate is mapped from the browser's client space into the provider's own frame
 * geometry with the exact, fractional scale the displayed rectangle actually has
 * (`viewport.width / rect.width`, and never an integer-rounded ratio or a coordinate truncated before
 * scaling). A click and a drag use the same mapper, so the same screen point has one answer through
 * both, and the press is the mapped `pointerdown` while the release is the mapped `pointerup` — never
 * the last throttled sample.
 *
 * A pointer that is pressed and moved is a **drag**, and it is relayed as the path the operator
 * actually drew, never as a straight line: `pointerdown` starts the gesture, `pointermove` samples it
 * and `pointerup` sends the whole ordered path as one `drag` input with each sample's own offset.
 * Sampling is throttled by the published `data-drag-sample-ms`; when a gesture reaches
 * `data-drag-max-points` samples the recorded path is thinned to every other real sample and the
 * interval doubles, so a long drag cannot accumulate an unbounded path. The result is a coarser
 * sampled real path, never a synthesized one. The movement threshold
 * `data-drag-move-threshold-px` — the distance from the press, so a jittery tap cannot accumulate its
 * way into a drag — is what keeps a tap a `click`. While the gesture is live the page says so
 * (`#pointer-relay[data-pointer-relay]`), and because the frame captures the pointer, a drag that ends
 * outside the picture is still released instead of leaving the provider's mouse held down.
 *
 * Keyboard input is a relay too, and a stateful one. A click on the frame **routes** the keyboard to
 * the remote browser; while routed, `keydown` on the document posts to the same `input` endpoint —
 * printable characters as `type` (batched on a short timer, and flushed immediately before any named
 * key, so the order the operator typed in is the order the provider sees) and named keys as `key`.
 * The route is *shown* (`#keyboard-route[data-keyboard-routing]`), and it is released the moment any
 * local control holds focus or Escape is pressed, so "if the token field has focus, the keystrokes are
 * the token field's" is a property of the document, not a hope. Focusing a local control flushes the
 * pending batch first, so the tail of a burst is never dropped.
 *
 * The body attributes `data-keyboard-flush-ms`, `data-keyboard-named-keys`, `data-drag-sample-ms`
 * and `data-drag-move-threshold-px` are the relay's published contract: the script reads its batch
 * timer, its named-key vocabulary, its drag sampling interval and its tap threshold from them, so
 * what the document says about its own handling and what it does cannot drift apart. The
 * text field plus *Send text* stays as the paste/long-text path and as the only way to type from a
 * phone, where no hardware keyboard exists.
 *
 * A successful capture is reported as **already in effect** (issue #287, slice 4b): the running
 * service re-derives its provider facts from the sign-in's own completion signal, so the next turn
 * uses the new session without a restart, and the page must not tell the operator to restart anything.
 */

/** The document served at `/v1/control/auth/`. Static; nothing is interpolated into it. */
export const WEB_CHAT_AUTH_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>dsh-chatgpt-web — interactive sign-in</title>
<style>
  :root { color-scheme: dark; --bg: #10131a; --card: #1a1f2b; --line: #2c3446; --ink: #e8ecf4; --dim: #9aa6bd; --accent: #4c8dff; --ok: #3fbf7f; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink);
         font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 1.25rem; margin: 0 0 4px; }
  #status { margin: 0 0 16px; color: var(--dim); min-height: 1.5em; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 14px; margin-bottom: 14px; }
  label { display: block; font-size: .85rem; color: var(--dim); margin-bottom: 6px; }
  input, select { width: 100%; padding: 12px; font: inherit; color: var(--ink); background: #0c0f16;
                  border: 1px solid var(--line); border-radius: 10px; }
  button { min-height: 48px; padding: 12px 16px; font: inherit; font-weight: 600; color: #fff;
           background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  button.secondary { background: #2c3446; }
  button.danger { background: #b4453c; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .row button { flex: 1 1 30%; }
  form { display: grid; gap: 10px; }
  .hint { color: var(--dim); font-size: .8rem; margin: 8px 0 0; }
  #screen { margin: 12px 0; background: #05070b; border: 1px solid var(--line); border-radius: 10px;
            overflow: hidden; }
  #frame { display: block; width: 100%; height: auto; touch-action: none; cursor: crosshair;
           user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  #no-frames { margin: 0; padding: 14px; color: var(--dim); }
  #stored { margin: 12px 0 0; padding: 12px; border-radius: 10px; background: rgba(63,191,127,.12);
            border: 1px solid var(--ok); color: var(--ok); }
  .state { font-weight: 700; }
  #keyboard-route { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; font-size: .85rem;
                    font-weight: 600; border: 1px solid var(--line); background: #0c0f16; color: var(--dim); }
  #keyboard-route[data-keyboard-routing="remote"] { border-color: var(--ok); color: var(--ok); }
  #pointer-relay { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; font-size: .85rem;
                   font-weight: 600; border: 1px solid var(--line); background: #0c0f16; color: var(--dim); }
  #pointer-relay[data-pointer-relay="drag"] { border-color: var(--accent); color: var(--ink); }
</style>
</head>
<body data-keyboard-flush-ms="70"
      data-keyboard-named-keys="Enter Tab Backspace Delete Escape ArrowUp ArrowDown ArrowLeft ArrowRight Home End"
      data-drag-sample-ms="32"
      data-drag-max-points="64"
      data-drag-move-threshold-px="8">
<header>
  <h1>Interactive sign-in</h1>
  <p id="status" role="status" aria-live="polite">Enter the operator control token.</p>
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

<section id="provider-card" hidden>
  <form id="provider-form">
    <label for="provider">Provider</label>
    <select id="provider" name="provider"></select>
    <button type="submit">Start sign-in</button>
  </form>
</section>

<section id="session-card" hidden>
  <p>State: <span class="state" id="session-state">starting</span> <span class="hint" id="session-expiry"></span></p>
  <div id="screen">
    <img id="frame" alt="Provider sign-in screen" width="1" height="1" tabindex="0" hidden>
    <p id="no-frames" hidden>This provider relays no screen. Follow the provider's own sign-in steps; the state above is authoritative.</p>
  </div>
  <p class="hint">Click the screen once, then type on your keyboard: your keys go to the remote
    sign-in page for as long as the indicator below says so. Press Escape (or click any field on this
    page) to type here again. On a phone, which has no hardware keyboard, use <em>Send text</em> below.
    To use a slider or puzzle, press and <em>drag</em> directly on the screen: the path you draw is
    relayed sample by sample, so drag the way you would with a mouse.</p>
  <p id="keyboard-route" data-keyboard-routing="local" role="status" aria-live="polite">Keyboard → this page. Click the sign-in screen, then type on your keyboard.</p>
  <p id="pointer-relay" data-pointer-relay="idle" role="status" aria-live="polite">Pointer → this page. Click the sign-in screen, or press and drag on it to relay that drag.</p>
  <form id="text-form">
    <label for="text">Paste text or send a long text (fallback — normally you just type on the screen above)</label>
    <input id="text" name="text" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
           placeholder="e-mail, one-time code, …">
    <button type="submit">Send text</button>
  </form>
  <div class="row">
    <button type="button" class="secondary" data-key="Enter">Enter</button>
    <button type="button" class="secondary" data-key="Tab">Tab</button>
    <button type="button" class="secondary" data-key="Backspace">Backspace</button>
  </div>
  <div class="row">
    <button type="button" class="secondary" data-key="Escape">Esc</button>
    <button type="button" class="secondary" data-scroll="-240">Scroll up</button>
    <button type="button" class="secondary" data-scroll="240">Scroll down</button>
    <button type="button" class="danger" id="cancel">Cancel</button>
  </div>
  <p id="stored" hidden></p>
</section>

<script>
(function () {
  "use strict";
  var TOKEN_KEY = "dsh-chatgpt-web.control-token";
  // The keyboard relay's published contract, all of it read back from the document it is served in:
  // the routing marker on the indicator, and the batch timer plus named-key vocabulary on the body.
  // What the document declares about its own keyboard handling and what the script does cannot drift.
  var ROUTE_ATTR = "data-keyboard-routing";
  var FLUSH_MS_ATTR = "data-keyboard-flush-ms";
  var NAMED_KEYS_ATTR = "data-keyboard-named-keys";
  // The pointer relay's published contract, read back the same way: how often a drag is sampled, how
  // many samples it may accumulate, and how far the pointer must move before a press counts as a
  // drag rather than a click.
  var DRAG_SAMPLE_ATTR = "data-drag-sample-ms";
  var DRAG_MAX_POINTS_ATTR = "data-drag-max-points";
  var DRAG_THRESHOLD_ATTR = "data-drag-move-threshold-px";
  var ROUTE_LOCAL = "local";
  var ROUTE_REMOTE = "remote";
  var DEFAULT_FLUSH_MS = 70;
  var DEFAULT_DRAG_SAMPLE_MS = 32;
  var DEFAULT_DRAG_MAX_POINTS = 64;
  var DEFAULT_DRAG_THRESHOLD_PX = 8;
  var NAMED_KEYS = {};
  var state = {
    token: "", id: null, viewport: null, seq: 0, sawFrame: false, reader: null,
    routing: ROUTE_LOCAL, pending: "", flushTimer: null, flushMs: DEFAULT_FLUSH_MS,
    dragSampleMs: DEFAULT_DRAG_SAMPLE_MS, dragMaxPoints: DEFAULT_DRAG_MAX_POINTS,
    dragThresholdPx: DEFAULT_DRAG_THRESHOLD_PX,
    drag: null, ended: false, sendChain: Promise.resolve()
  };

  function el(id) { return document.getElementById(id); }
  function show(id, visible) { el(id).hidden = !visible; }
  function setStatus(text) { el("status").textContent = text; }

  // The relay's vocabulary is the document's, not a second copy in here: an empty named-key list
  // simply means only printable text is relayed, and a missing batch timer falls back to the default.
  function readKeyboardContract() {
    var names = document.body.getAttribute(NAMED_KEYS_ATTR) || "";
    names.split(" ").forEach(function (name) { if (name) NAMED_KEYS[name] = true; });
    var declared = Number(document.body.getAttribute(FLUSH_MS_ATTR));
    state.flushMs = Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_FLUSH_MS;
    var sample = Number(document.body.getAttribute(DRAG_SAMPLE_ATTR));
    state.dragSampleMs = Number.isFinite(sample) && sample > 0 ? sample : DEFAULT_DRAG_SAMPLE_MS;
    var maxPoints = Number(document.body.getAttribute(DRAG_MAX_POINTS_ATTR));
    state.dragMaxPoints = Number.isFinite(maxPoints) && maxPoints >= 2
      ? Math.floor(maxPoints) : DEFAULT_DRAG_MAX_POINTS;
    var threshold = Number(document.body.getAttribute(DRAG_THRESHOLD_ATTR));
    state.dragThresholdPx = Number.isFinite(threshold) && threshold >= 0
      ? threshold : DEFAULT_DRAG_THRESHOLD_PX;
  }

  function isNamedKey(key) {
    return Object.prototype.hasOwnProperty.call(NAMED_KEYS, key);
  }

  // One pending batch at a time, flushed on a short timer. A named key flushes first and is enqueued
  // immediately, so "user@x.com" is always on the wire before the Enter that follows it; and every
  // send goes through one chain, so a batch can never overtake the key enqueued after it.
  function enqueue(event) {
    state.sendChain = state.sendChain.then(function () { return send(event); });
  }

  function flushPendingText() {
    if (state.flushTimer !== null) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    if (!state.pending) return;
    var text = state.pending;
    state.pending = "";
    enqueue({ type: "type", text: text });
  }

  function queueText(text) {
    state.pending += text;
    if (state.flushTimer === null) {
      state.flushTimer = setTimeout(function () { state.flushTimer = null; flushPendingText(); }, state.flushMs);
    }
  }

  function queueKey(key) {
    flushPendingText();
    enqueue({ type: "key", key: key });
  }

  // The route is the whole state machine: "remote" means the document owns the keys, "local" means the
  // page's own controls do. It is painted, never inferred, so the operator never has to guess.
  function paintRoute() {
    var indicator = el("keyboard-route");
    indicator.setAttribute(ROUTE_ATTR, state.routing);
    indicator.textContent = state.routing === ROUTE_REMOTE
      ? "Keyboard → remote sign-in screen. Press Escape, or click a field below, to type here again."
      : "Keyboard → this page. Click the sign-in screen, then type on your keyboard.";
  }

  function setRouting(route) {
    if (state.routing === route) return;
    state.routing = route;
    paintRoute();
  }

  /** Hand the keyboard back to this page, without ever dropping the tail of what was being typed. */
  function releaseToLocal() {
    flushPendingText();
    setRouting(ROUTE_LOCAL);
  }

  /** Give the keyboard to the remote browser; whatever was pending belongs before the click. */
  function routeToRemote() {
    flushPendingText();
    setRouting(ROUTE_REMOTE);
  }

  function isLocalControl(target) {
    if (!target || typeof target.tagName !== "string") return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A";
  }

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
      var message = payload && payload.message ? payload.message : "request failed (" + response.status + ")";
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function expiryText(expiresAt) {
    if (typeof expiresAt !== "number") return "";
    var remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    return "· expires in " + remaining + "s";
  }

  function showStored(capture) {
    var text = capture.stored
      ? "Session stored" + (capture.location ? " at " + capture.location : "") + "."
      : "The provider stored no session material.";
    // Issue #287 slice 4b: a captured interactive sign-in is picked up by the running service on the
    // next request, so the operator is told not to restart anything. A stored capture whose
    // provider-side side effect did not complete still carries its own detail below — that detail is
    // the one thing that can keep the next turn failing closed, and this line never swallows it.
    if (capture.stored) {
      text += " The running service has already picked this session up: the next turn uses it,"
        + " with no restart.";
    }
    el("stored").textContent = text;
    show("stored", true);
    setStatus(text);
  }

  function applyEvent(payload) {
    if (typeof payload.seq === "number") state.seq = payload.seq;
    if (typeof payload.state === "string") el("session-state").textContent = payload.state;
    if (payload.viewport && payload.viewport.width) state.viewport = payload.viewport;

    var frame = el("frame");
    if (typeof payload.frame === "string" && payload.frame.length > 0) {
      state.sawFrame = true;
      frame.src = "data:image/png;base64," + payload.frame;
      show("frame", true);
      show("no-frames", false);
    } else if (!state.sawFrame) {
      // A provider whose sign-in needs no display is streamed as state only; that is not an error.
      show("frame", false);
      show("no-frames", payload.state === "starting" ? false : true);
    }

    if (payload.terminal) {
      // The session ends here, so a still-pending burst is flushed and the keyboard comes home: the
      // tail typed just before the end is never silently dropped, and no key stays aimed at a dead
      // session. A refusal for that last tail must not overwrite the terminal status, hence "ended".
      state.ended = true;
      releaseToLocal();
    }
    if (payload.terminal && !payload.error) {
      setStatus(payload.state === "captured" ? "Sign-in captured." : "Sign-in ended: " + payload.state + ".");
      if (!payload.capture) show("stored", false);
    }
    if (payload.capture) showStored(payload.capture);
    if (payload.error) setStatus("Provider error: " + payload.error);
  }

  function handleBlock(raw) {
    var name = "message";
    var data = [];
    raw.split("\\n").forEach(function (line) {
      if (line.indexOf("event:") === 0) name = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data.push(line.slice(5).trim());
    });
    if (name === "end") { state.ended = true; releaseToLocal(); setStatus("Sign-in stream closed."); return; }
    if (data.length === 0) return;
    var payload = null;
    try { payload = JSON.parse(data.join("\\n")); } catch (error) { return; }
    if (payload) applyEvent(payload);
  }

  async function readStream(sessionId) {
    var response = await fetch("sessions/" + sessionId + "/stream", {
      headers: { "Authorization": "Bearer " + state.token }
    });
    if (!response.ok || !response.body) {
      setStatus("The sign-in stream is unavailable (" + response.status + ").");
      return;
    }
    var reader = response.body.getReader();
    state.reader = reader;
    var decoder = new TextDecoder();
    var buffer = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var index = buffer.indexOf("\\n\\n");
      while (index >= 0) {
        handleBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\\n\\n");
      }
    }
    state.reader = null;
  }

  function stopStream() {
    if (!state.reader) return;
    var reader = state.reader;
    state.reader = null;
    try { reader.cancel(); } catch (error) { /* the stream is already gone */ }
  }

  async function send(event) {
    if (!state.id) return;
    try {
      var view = await api("sessions/" + state.id + "/input", "POST", event);
      if (view && view.state) el("session-state").textContent = view.state;
    } catch (error) {
      // A refused tail after the session already ended says nothing useful and would replace the
      // terminal status the operator needs to read. Every refusal before that is reported as before.
      if (!state.ended) setStatus("Input refused: " + error.message);
    }
  }

  async function openSession(providerId) {
    try {
      var session = await api("sessions", "POST", { providerId: providerId });
      stopStream();
      state.id = session.id;
      state.viewport = session.viewport || null;
      state.seq = 0;
      state.sawFrame = false;
      state.pending = "";
      state.ended = false;
      state.drag = null;
      if (state.flushTimer !== null) { clearTimeout(state.flushTimer); state.flushTimer = null; }
      setRouting(ROUTE_LOCAL);
      paintRoute();
      paintPointer("idle");
      el("session-state").textContent = session.state;
      el("session-expiry").textContent = expiryText(session.expiresAt);
      show("stored", false);
      show("frame", false);
      show("no-frames", false);
      show("session-card", true);
      setStatus("Sign-in open for " + session.providerId + ".");
      await readStream(session.id);
    } catch (error) {
      setStatus("Could not open a sign-in session: " + error.message);
    }
  }

  async function loadProviders() {
    try {
      var payload = await api("providers");
      var list = payload && Array.isArray(payload.providers) ? payload.providers : [];
      var select = el("provider");
      select.textContent = "";
      list.forEach(function (provider) {
        var option = document.createElement("option");
        option.value = provider.providerId;
        option.textContent = provider.label
          ? provider.label + " (" + provider.providerId + ")"
          : provider.providerId;
        select.appendChild(option);
      });
      show("token-card", false);
      show("provider-card", true);
      setStatus(list.length === 0
        ? "No provider on this service offers interactive sign-in."
        : "Choose a provider to sign in.");
    } catch (error) {
      show("provider-card", false);
      show("token-card", true);
      setStatus(error.status === 401
        ? "That control token was refused."
        : "Could not reach the service: " + error.message);
    }
  }

  async function cancelSession() {
    releaseToLocal();
    if (!state.id) return;
    // Nothing is delivered after a cancel by design, so a refusal for the flushed tail (or for the
    // DELETE itself) must not be dressed up as a refused keystroke.
    state.ended = true;
    try {
      await api("sessions/" + state.id, "DELETE");
      setStatus("Sign-in cancelled.");
    } catch (error) {
      setStatus("Could not cancel: " + error.message);
    }
  }

  el("token-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var value = el("token").value.trim();
    if (!value) return;
    state.token = value;
    sessionStorage.setItem(TOKEN_KEY, value);
    el("token").value = "";
    await loadProviders();
  });

  el("provider-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var providerId = el("provider").value;
    if (!providerId) return;
    await openSession(providerId);
  });

  el("text-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var text = el("text").value;
    if (!text) return;
    el("text").value = "";
    // The fallback path shares the relay's order: anything typed on the screen goes first, then this
    // text, through the same one-at-a-time chain.
    flushPendingText();
    enqueue({ type: "type", text: text });
  });

  document.querySelectorAll("[data-key]").forEach(function (button) {
    button.addEventListener("click", function () {
      // An explicit key button is always a remote key, wherever the routing currently points: the
      // operator clicked it on purpose. Queueing (rather than sending) keeps a pending text batch ahead
      // of it, and this is the one way a phone can send Enter/Tab/Backspace/Esc to the remote.
      queueKey(button.getAttribute("data-key"));
    });
  });

  document.querySelectorAll("[data-scroll]").forEach(function (button) {
    button.addEventListener("click", function () {
      enqueue({ type: "scroll", dy: Number(button.getAttribute("data-scroll")) });
    });
  });

  el("cancel").addEventListener("click", cancelSession);

  // While the route is remote the *document* owns the keydown: printable keys become remote text and
  // named keys become remote key presses. The route is state, not a guess — if any local control holds
  // focus, the keys belong to it and this handler does nothing at all.
  document.addEventListener("keydown", function (event) {
    if (state.routing !== ROUTE_REMOTE) return;
    if (isLocalControl(document.activeElement)) { releaseToLocal(); return; }
    if (event.key === "Escape") {
      // Escape is the release gesture and is deliberately consumed here instead of relayed: the
      // operator gets the keyboard back with the key they expect to do it, and no surprise Escape can
      // reach the provider's form. The Esc button sends a remote Escape when one is actually wanted.
      event.preventDefault();
      releaseToLocal();
      return;
    }
    // A shortcut (Ctrl without Alt, or Cmd) is left to the local page. AltGr — the '@' on a Spanish
    // layout — arrives as ctrlKey+altKey with a length-1 key, so it is text, not a shortcut.
    if (event.metaKey || (event.ctrlKey && !event.altKey)) return;
    if (event.isComposing) return; // an IME composition is not relayed; see the module comment
    if (event.key.length === 1) {
      // event.key, never event.code: the layout already applied Shift and AltGr, so a capital or a
      // symbol needs no separate modifier event. A bare modifier key is length > 1 and matches nothing.
      event.preventDefault();
      queueText(event.key);
      return;
    }
    if (isNamedKey(event.key)) {
      event.preventDefault();
      queueKey(event.key);
    }
  }, true);

  // Focus anywhere that is not the remote view hands the keyboard straight back, flushing the pending
  // burst first. This is what makes "if the token field has focus, the keys are the token field's" a
  // property of the document rather than a convention.
  document.addEventListener("focusin", function (event) {
    if (isLocalControl(event.target)) releaseToLocal();
  });

  // Losing the tab or the page must not lose the tail either.
  window.addEventListener("blur", flushPendingText);
  window.addEventListener("pagehide", flushPendingText);

  // ---- the pointer relay: a click, or the drag path the operator actually drew ----
  // A press is not a click until the pointer is released, because the very same gesture may be a
  // drag and the provider must never receive both. The press routes the keyboard either way.
  var POINTER_IDLE = "Pointer → this page. Click the sign-in screen, or press and drag on it to relay that drag.";
  var POINTER_PRESS = "Pointer down on the sign-in screen. Keep holding and drag to relay a drag; release without moving to click.";
  var POINTER_DRAGGING = "Relaying your drag… keep holding and move as you normally would; release to send the path.";

  function paintPointer(kind, text) {
    var indicator = el("pointer-relay");
    var previous = indicator.getAttribute("data-pointer-relay");
    indicator.setAttribute("data-pointer-relay", kind);
    if (kind === "press") { indicator.textContent = POINTER_PRESS; return; }
    if (kind === "drag") {
      // Painted once per gesture, not once per sample: the announcement must say "this is being
      // relayed" without turning the live region into a stream of position updates.
      if (previous !== "drag") indicator.textContent = text || POINTER_DRAGGING;
      return;
    }
    if (kind === "sent-drag" || kind === "sent-click") {
      indicator.textContent = text || "";
      return;
    }
    indicator.textContent = POINTER_IDLE;
  }

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : Date.now();
  }

  // Map a pointer into the provider's own frame geometry. The displayed size is whatever CSS made it,
  // and it may be fractional; the real viewport is what the relay reported, so the ratio is measured
  // exactly, never guessed and never rounded before it is applied. The result keeps its fractional
  // part: the provider's input space is not integer-quantized, and rounding here would move a point by
  // up to half a pixel for no reason. A point outside the frame is reported as no point — never
  // clamped, because a clamped sample would be a gesture the operator did not draw.
  function framePoint(event) {
    var viewport = state.viewport;
    if (!viewport || !viewport.width || !viewport.height) return null;
    var rect = el("frame").getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var x = (event.clientX - rect.left) * (viewport.width / rect.width);
    var y = (event.clientY - rect.top) * (viewport.height / rect.height);
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return null;
    return { x: x, y: y };
  }

  function finishDrag(event, cancelled) {
    var drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    state.drag = null;
    try { el("frame").releasePointerCapture(event.pointerId); } catch (error) { /* never captured */ }
    if (cancelled) {
      // An interrupted gesture is neither a click nor a drag: relay nothing rather than invent one.
      // No remote button was ever pressed — the path is sent once, at the release.
      paintPointer("idle");
      setStatus("That gesture was interrupted, so nothing was relayed. Try again.");
      return;
    }
    var elapsed = Math.max(0, Math.round(nowMs() - drag.startedAt));
    var release = framePoint(event);
    if (release) {
      // The release is the mapped "pointerup" position and it is always the last point. The last
      // throttled "pointermove" is an older position — the pointer may have travelled since it was
      // sampled — so collapsing the release onto it is exactly how a slider stops a few pixels short.
      // Timestamps only have to be non-decreasing, so a release in the same millisecond as the last
      // sample is still delivered instead of being conditionally dropped.
      var atMs = Math.max(elapsed, drag.lastAtMs);
      drag.points.push({ x: release.x, y: release.y, atMs: atMs });
      drag.lastAtMs = atMs;
    }
    // If the pointer was released outside the picture there is no in-frame release to map; the last
    // frame-local sample is the last position the provider could legitimately receive.
    if (drag.points.length < 2 || drag.movedPx < state.dragThresholdPx) {
      // A press that did not travel is still exactly the click this page has always relayed.
      var start = drag.points[0];
      if (start) {
        enqueue({ type: "click", x: start.x, y: start.y });
        paintPointer("sent-click", "Click relayed at (" + start.x + ", " + start.y + ").");
      }
      return;
    }
    // The whole sampled path goes as one input, with each sample's own offset: nothing is
    // interpolated here, and the straight line a click-and-drag synthesizer would send cannot be
    // expressed by this relay because it only ever forwards points the browser reported.
    enqueue({ type: "drag", points: drag.points });
    paintPointer("sent-drag", "Your drag was relayed as " + drag.points.length
      + " sampled points, in the order you drew them.");
  }

  el("frame").addEventListener("pointerdown", function (event) {
    if (!state.id) return;
    var point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    // A click on the remote view is the one gesture that routes the keyboard to the remote, so it is
    // also where the routing state moves. The frame (tabindex="0") takes focus, so a local field that
    // held it cannot keep it while the indicator says the keys are remote.
    routeToRemote();
    try { el("frame").focus({ preventScroll: true }); } catch (error) { el("frame").focus(); }
    state.drag = {
      pointerId: event.pointerId, startedAt: nowMs(),
      points: [{ x: point.x, y: point.y, atMs: 0 }],
      lastAtMs: 0, sampleMs: state.dragSampleMs,
      lastClientX: event.clientX, lastClientY: event.clientY,
      startClientX: event.clientX, startClientY: event.clientY, movedPx: 0
    };
    // Capture the pointer so the release still arrives when the operator drags off the picture;
    // without it a drag that ends elsewhere would leave the provider's mouse button held down.
    try { el("frame").setPointerCapture(event.pointerId); } catch (error) { /* older event model */ }
    paintPointer("press");
  });

  el("frame").addEventListener("pointermove", function (event) {
    var drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    var dx = event.clientX - drag.lastClientX;
    var dy = event.clientY - drag.lastClientY;
    if (dx === 0 && dy === 0) return;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    // Distance from the press, not a sum of per-event deltas: finger jitter must not add up into a
    // drag, and a real drag is measured by how far it actually travelled.
    drag.movedPx = Math.max(
      drag.movedPx,
      Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY)
    );
    event.preventDefault();
    var elapsed = nowMs() - drag.startedAt;
    // Sampled on real movement, throttled by the interval this gesture is currently using. When the
    // path reaches the published maximum, it is thinned to the press, every other real sample and the
    // newest one, and the interval doubles: a long drag stays bounded while still covering the whole
    // gesture with positions the browser actually reported. Nothing is interpolated.
    if (elapsed - drag.lastAtMs < drag.sampleMs) return;
    var point = framePoint(event);
    if (!point) return;
    drag.lastAtMs = elapsed;
    drag.points.push({ x: point.x, y: point.y, atMs: Math.round(elapsed) });
    if (drag.points.length >= state.dragMaxPoints) {
      var kept = [drag.points[0]];
      for (var index = 1; index < drag.points.length; index += 2) kept.push(drag.points[index]);
      if (kept[kept.length - 1] !== drag.points[drag.points.length - 1]) {
        kept.push(drag.points[drag.points.length - 1]);
      }
      drag.points = kept;
      drag.sampleMs = drag.sampleMs * 2;
    }
    paintPointer("drag");
  });

  el("frame").addEventListener("pointerup", function (event) { finishDrag(event, false); });
  el("frame").addEventListener("pointercancel", function (event) { finishDrag(event, true); });

  readKeyboardContract();
  paintRoute();
  state.token = sessionStorage.getItem(TOKEN_KEY) || "";
  if (state.token) loadProviders();
})();
</script>
</body>
</html>
`;

/** The two paths that serve {@link WEB_CHAT_AUTH_PAGE_HTML}. */
export const WEB_CHAT_AUTH_PAGE_PATHS: readonly string[] = [
  "/v1/control/auth/",
  "/v1/control/auth/index.html",
];
