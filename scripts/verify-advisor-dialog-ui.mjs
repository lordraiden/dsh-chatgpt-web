#!/usr/bin/env node
/**
 * Real-browser layout verification for the Advisor review dialog (issue #214).
 *
 * The centred-modal repair was previously asserted only structurally (element tree + CSS text).
 * This script loads the *real* `client.js` into real Chromium, mounts the real
 * `AdvisorReviewDialog` inside a faithful reproduction of the DSH composer slot it is registered
 * in, and measures the resulting layout with `getBoundingClientRect()`/`getComputedStyle()`.
 *
 * The reproduction copies the host rules that produced the reported defect (read from the
 * installed `@deepseek-ai/dsh-client-ui-conversation` client bundle):
 *
 *   InputBar card:  position: relative; display: flex; flex-direction: column; gap: 12px; padding-top: 8px
 *   overlay slot:   height: 0; position: absolute; inset: 0 0 auto      <- conversation.input.overlay
 *   shell:          the composer host is pinned under the transcript, so the card sits at the
 *                   bottom of the viewport and an in-flow dialog reads as a panel below it.
 *
 * What it proves: in a real layout engine, with the real component code, the dialog is
 * viewport-centred, does not intersect the composer's editable field, keeps focus and Tab inside
 * itself, and is dismissed by Escape, the close control and a backdrop click.
 * What it does not prove: the authenticated DSH GUI's own mount path (that needs the operator's
 * session) or the rendered pixels of a specific DSH build.
 *
 * Usage: node scripts/verify-advisor-dialog-ui.mjs [--chrome PATH] [--artifacts DIR]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
/** First existing Chromium-based browser: the explicit flag, the environment, then the usual paths. */
function resolveChromePath() {
  const candidates = [
    argValue("--chrome", undefined),
    process.env.DSH_CHATGPT_WEB_CHROME,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    console.error(`No Chromium-based browser found. Set --chrome or DSH_CHATGPT_WEB_CHROME. Tried: ${candidates.join(", ")}`);
    process.exit(1);
  }
  return found;
}
const chromePath = resolveChromePath();
const artifactsDir = resolve(argValue("--artifacts", resolve(repoRoot, "artifacts", "advisor-dialog-ui")));
const clientSource = readFileSync(resolve(repoRoot, "client.js"), "utf8");

const checks = [];
const check = (ok, name, detail) => {
  checks.push({ ok: Boolean(ok), name, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
};

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><title>advisor dialog layout</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0f14; color: #e6edf3; font: 14px/22px system-ui, sans-serif; }
  #shell { position: fixed; inset: 0; display: flex; flex-direction: column; }
  #transcript { flex: 1 1 auto; overflow: auto; padding: 24px; }
  /* DSH composer host: bottom-pinned, centred card. */
  #composer { padding: 0 16px 4px; display: flex; flex-direction: column; align-items: center; }
  /* DSH InputBar card. */
  #card { position: relative; display: flex; flex-direction: column; gap: 12px; padding-top: 8px;
          width: min(748px, 100%); background: #10161d; border: 1px solid #22303c; border-radius: 16px; }
  /* DSH conversation.input.overlay anchor: zero height, absolutely positioned at the card top. */
  #overlay { height: 0; position: absolute; inset: 0 0 auto; }
  #editable { min-height: 36px; padding: 4px 8px 0 14px; color: #e6edf3; }
  #row { display: flex; align-items: center; gap: 12px; padding: 2px 8px 6px; }
  #row button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #22303c; background: transparent; color: inherit; }
</style></head>
<body>
  <div id="shell">
    <div id="transcript"><p>turno completado de ejemplo</p></div>
    <div id="composer">
      <div id="card">
        <div id="overlay"></div>
        <div id="editable" contenteditable="true">escribe aquí…</div>
        <div id="row"><button type="button">Think</button><button type="button">Send</button></div>
      </div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  // The system Chromium runs confined in this environment; the renderer sandbox is not required
  // for a local layout measurement.
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route("http://advisor-verify.local/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SHELL });
  });
  await page.goto("http://advisor-verify.local/", { waitUntil: "load" });

  const report = await page.evaluate(async ({ source }) => {
    // ------------------------------------------------------------------ minimal React-compatible
    // renderer. The shipped client module expects React from the host module table; this harness
    // supplies just enough of it to mount and re-render the real component tree as real DOM. It is
    // part of the verification harness, not a React implementation.
    const roots = [];
    const pendingRefs = [];
    const handlers = new WeakMap();
    const current = { hooks: null, index: 0 };
    const scheduled = new Set();

    function createElement(type, props, ...children) {
      if (typeof type === "function") {
        const owner = current.hooks;
        const previousIndex = current.hooks;
        const previousCursor = current.index;
        const hooks = [];
        current.hooks = hooks;
        current.index = 0;
        let node;
        try {
          node = type({ ...(props || {}), children: children.length <= 1 ? children[0] : children });
        } finally {
          current.hooks = previousIndex;
          current.index = previousCursor;
        }
        if (owner) hooks.__owner = owner;
        return node;
      }
      const element = document.createElement(type);
      for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "key" || key === "children") continue;
        if (key === "ref") { if (typeof value === "function") pendingRefs.push([value, element]); continue; }
        if (key.startsWith("on") && typeof value === "function") {
          element.addEventListener(key.slice(2).toLowerCase(), value);
          handlers.set(element, value);
          continue;
        }
        if (key === "className") { element.setAttribute("class", String(value)); continue; }
        if (key === "htmlFor") { element.setAttribute("for", String(value)); continue; }
        if (key === "value" && (type === "textarea" || type === "input" || type === "select")) { element.value = String(value); continue; }
        if (key === "readOnly" || key === "disabled" || key === "spellCheck") {
          if (value) element.setAttribute(key.toLowerCase(), "");
          if (key === "readOnly") element.readOnly = Boolean(value);
          if (key === "disabled") element.disabled = Boolean(value);
          continue;
        }
        if (key === "tabIndex") { element.tabIndex = Number(value); continue; }
        element.setAttribute(key, String(value));
      }
      const append = (child) => {
        if (child === null || child === undefined || child === false || child === true) return;
        if (Array.isArray(child)) { child.forEach(append); return; }
        element.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
      };
      children.forEach(append);
      return element;
    }

    const useState = (init) => {
      const hooks = current.hooks ?? (current.hooks = []);
      const slot = current.index++;
      if (!(slot in hooks)) {
        hooks[slot] = { value: typeof init === "function" ? init() : init, effects: [] };
      }
      const state = hooks[slot];
      return [state.value, (next) => {
        state.value = typeof next === "function" ? next(state.value) : next;
        for (const rerender of roots) rerender();
      }];
    };
    const useEffect = (fn, deps) => {
      const hooks = current.hooks ?? (current.hooks = []);
      const slot = current.index++;
      const previous = hooks[slot];
      const changed = !previous || !deps || !previous.deps || deps.some((value, index) => value !== previous.deps[index]);
      if (changed) {
        if (previous && typeof previous.cleanup === "function") previous.cleanup();
        hooks[slot] = { deps, cleanup: undefined };
        const hooksRef = hooks;
        const cursor = slot;
        // Effects run after the tree is attached: defer through a microtask queue drain below.
        roots.__pendingEffects.push(() => { hooksRef[cursor].cleanup = fn() ?? undefined; });
      }
    };
    const useMemo = (fn) => fn();
    const useCallback = (fn) => fn;

    globalThis.window.__ModuleLoader__ = { load: (descriptor) => { globalThis.__advisorDescriptor = descriptor; } };
    // The page's own localStorage, window listeners and event dispatch are real: the plugin uses
    // browser storage for the last instructions, and the harness dispatches real events.
    globalThis.window.React = { createElement, useState, useEffect, useMemo, useCallback };

    // eslint-disable-next-line no-new-func
    new Function(source)();
    const descriptor = globalThis.__advisorDescriptor;
    if (!descriptor) throw new Error("client.js did not register its module descriptor");
    const mod = descriptor.factory((id) => {
      if (id === "react") return globalThis.window.React;
      throw new Error(`unexpected require: ${id}`);
    });

    // ------------------------------------------------------------------ mount the real dialog
    const overlay = document.getElementById("overlay");
    const flushRefs = () => {
      const refs = pendingRefs.splice(0);
      for (const [callback, node] of refs) callback(node);
    };
    const mount = (element) => {
      overlay.replaceChildren();
      if (element) overlay.appendChild(element);
      // Refs commit after attachment, exactly like the host renderer.
      flushRefs();
    };

    function renderDialog() {
      return mod.__test.AdvisorReviewDialog(
        (key, fallback) => fallback,
        {
          sessionId: "sess-verify",
          useProjection: (key) => (key === mod.__test.ADVISOR_PROJECTION_KEY ? { controlToken: "token" } : undefined),
          useWorkspaces: (selector) => selector({ items: [] }),
        },
        { getSnapshot: () => ({ value: { port: 17841 } }) },
        { store: mod.__test.createAdvisorPresetStore(), read: async () => [] },
      );
    }

    const rerender = () => mount(renderDialog());
    roots.push(rerender);
    roots.__pendingEffects = [];

    const chat = {
      order: ["k1", "k2"],
      nodes: {
        get: (key) => (key === "k1"
          ? { key: "k1", kind: "user", anchorSeq: 1, visibility: "visible", location: { kind: "turn", turn: { turn: 1 } }, data: { kind: "user", seq: 1, content: [{ type: "text", text: "arregla el bug" }] } }
          : { key: "k2", kind: "assistant-step", anchorSeq: 2, visibility: "visible", location: { kind: "step", turn: { turn: 1 }, step: { turn: 1, step: 1 } }, data: { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text: "hecho" }], finalNode: { kind: "assistant", seq: 2 } } }),
      },
    };
    const button = mod.__test.AdvisorReviewButton((key, fallback) => fallback, {
      sessionId: "sess-verify",
      useChat: (selector) => selector(chat),
      useSession: (selector) => selector({ running: false }),
    });
    // The composer control is a real element in this harness; activate its listener the way the
    // renderer would, without depending on a detached-node click.
    const activateButton = () => { handlers.get(button)(); };
    activateButton();
    rerender();
    const drain = () => { flushRefs(); const pending = roots.__pendingEffects.splice(0); pending.forEach((run) => run()); };
    drain();

    const measure = () => {
      const backdrop = document.querySelector(".cwg-advisor-backdrop");
      const dialogNode = document.querySelector(".cwg-advisor-dialog");
      const editable = document.getElementById("editable");
      if (!backdrop || !dialogNode) {
        return { missing: true, diagnostics: { overlayChildren: overlay.childElementCount, roots: roots.length, html: overlay.innerHTML.slice(0, 400) } };
      }
      const backdropRect = backdrop.getBoundingClientRect();
      const dialogRect = dialogNode.getBoundingClientRect();
      const editableRect = editable.getBoundingClientRect();
      const intersects = !(
        dialogRect.right <= editableRect.left || dialogRect.left >= editableRect.right
        || dialogRect.bottom <= editableRect.top || dialogRect.top >= editableRect.bottom
      );
      return {
        missing: false,
        diagnostics: { overlayChildren: overlay.childElementCount, roots: roots.length },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        backdrop: { position: getComputedStyle(backdrop).position, zIndex: getComputedStyle(backdrop).zIndex, rect: { x: backdropRect.x, y: backdropRect.y, width: backdropRect.width, height: backdropRect.height } },
        dialog: { position: getComputedStyle(dialogNode).position, rect: { x: dialogRect.x, y: dialogRect.y, width: dialogRect.width, height: dialogRect.height, centerX: dialogRect.x + dialogRect.width / 2, centerY: dialogRect.y + dialogRect.height / 2 } },
        editable: { rect: { x: editableRect.x, y: editableRect.y, width: editableRect.width, height: editableRect.height } },
        intersectsEditable: intersects,
        focusInside: dialogNode.contains(document.activeElement),
        focusTag: document.activeElement ? document.activeElement.className || document.activeElement.tagName : null,
      };
    };

    const interact = {
      measure,
      pressTab({ shift }) {
        const dialogNode = document.querySelector(".cwg-advisor-dialog");
        const focusable = [...dialogNode.querySelectorAll("button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
        focusable[focusable.length - 1].focus();
        dialogNode.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: Boolean(shift), bubbles: true }));
        const active = document.activeElement;
        return { focusables: focusable.length, firstIsActive: active === focusable[0], activeClass: active ? active.className : null };
      },
      pressEscape() {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        drain();
        return { closed: document.querySelector(".cwg-advisor-backdrop") === null };
      },
      clickBackdrop() {
        const backdrop = document.querySelector(".cwg-advisor-backdrop");
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        drain();
        return { closed: document.querySelector(".cwg-advisor-backdrop") === null };
      },
      clickInside() {
        const dialogNode = document.querySelector(".cwg-advisor-dialog");
        dialogNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        drain();
        return { stillOpen: document.querySelector(".cwg-advisor-backdrop") !== null };
      },
      reopen() { activateButton(); rerender(); drain(); return { open: document.querySelector(".cwg-advisor-backdrop") !== null }; },
    };
    globalThis.__advisorInteract = interact;
    return measure();
  }, { source: clientSource });

  const centerTolerance = 2;
  check(!report.missing, "the dialog mounts inside the DSH composer overlay anchor", report.missing ? report.diagnostics : undefined);
  if (report.missing) {
    console.error(`\nThe dialog did not mount; diagnostics: ${JSON.stringify(report.diagnostics)}`);
    process.exitCode = 1;
  } else {
  check(report.backdrop?.position === "fixed", "the backdrop leaves the composer flow (position: fixed)", report.backdrop?.position);
  check(Number(report.backdrop?.zIndex) >= 1100, "the backdrop layers above the host panels", report.backdrop?.zIndex);
  const backdropRect = report.backdrop?.rect;
  const dialogRect = report.dialog?.rect;
  check(
    Math.abs(backdropRect.width - report.viewport.width) <= 1 && Math.abs(backdropRect.height - report.viewport.height) <= 1,
    "the backdrop covers the viewport",
    { width: backdropRect.width, height: backdropRect.height, viewport: report.viewport },
  );
  check(Math.abs(dialogRect.centerX - report.viewport.width / 2) <= centerTolerance, "the dialog is horizontally centred", { centerX: dialogRect.centerX, expected: report.viewport.width / 2 });
  check(Math.abs(dialogRect.centerY - report.viewport.height / 2) <= centerTolerance, "the dialog is vertically centred", { centerY: dialogRect.centerY, expected: report.viewport.height / 2 });
  check(report.intersectsEditable === false, "the dialog never overlaps the composer's editable field", { dialog: report.dialog.rect, editable: report.editable.rect });
  check(report.dialog.rect.y < report.editable.rect.y, "the dialog sits above the composer's text field", { dialogTop: report.dialog.rect.y, editableTop: report.editable.rect.y });
  check(report.focusInside === true, "focus moves into the dialog on mount", { focusTag: report.focusTag });

  const tab = await page.evaluate(() => globalThis.__advisorInteract.pressTab({ shift: false }));
  check(tab.firstIsActive === true, "Tab is trapped inside the dialog", tab);

  await page.screenshot({ path: resolve(artifactsDir, "advisor-dialog-open.png") });
  const escape = await page.evaluate(() => globalThis.__advisorInteract.pressEscape());
  check(escape.closed === true, "Escape dismisses the dialog", escape);

  const reopened = await page.evaluate(() => globalThis.__advisorInteract.reopen());
  check(reopened.open === true, "the dialog reopens from the composer control", reopened);
  const insideClick = await page.evaluate(() => globalThis.__advisorInteract.clickInside());
  check(insideClick.stillOpen === true, "a click inside the dialog does not dismiss it", insideClick);
  const backdropClick = await page.evaluate(() => globalThis.__advisorInteract.clickBackdrop());
  check(backdropClick.closed === true, "a click on the backdrop dismisses the dialog", backdropClick);

  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(resolve(artifactsDir, "advisor-dialog-layout.json"), `${JSON.stringify({ chromePath, checks, report, tab, escape, reopened, insideClick, backdropClick }, null, 2)}\n`);
  console.log(`\nEvidence: ${resolve(artifactsDir, "advisor-dialog-layout.json")}`);
  console.log(`Screenshot: ${resolve(artifactsDir, "advisor-dialog-open.png")}`);

  }
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    console.error(`\nAdvisor dialog layout verification FAILED (${failed.length} check(s)): ${failed.map((entry) => entry.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAdvisor dialog layout verification passed (${checks.length} checks).`);
  }
} finally {
  await browser.close();
}
