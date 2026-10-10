/**
 * Client half of @lordraiden/dsh-chatgpt-web: a "ChatGPT Web" configuration page on the DSH
 * 0.2 Plugins surface. DSH-owned runtime settings are edited through configForms; the page also
 * reads the loopback sidecar control API for diagnostics and advanced browser-transport tuning.
 *
 * Plain JS (no build step): React comes from the browser module table, text goes through the
 * Client locale service, and styling uses only --dsw-alias-* theme tokens rendered as a
 * component-local <style> element so unmounting removes it.
 */
window.__ModuleLoader__.load({
  id: '@lordraiden/dsh-chatgpt-web',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CONFIG_ID = 'dsh-chatgpt-web';
    const LEGACY_TOKEN_KEY = 'dsh-chatgpt-web.controlToken';
    const LOOPBACK_HOST = '127.0.0.1';

    const DICT_EN = {
      'section.title': 'ChatGPT Web',
      'conn.title': 'Connection',
      'conn.token': 'Control token',
      'conn.tokenHint': 'The sidecar control token. Held only in this page and never persisted in browser storage.',
      'conn.reload': 'Reload',
      'status.title': 'Sidecar status',
      'status.offline': 'Sidecar offline',
      'status.offlineHint': 'No chatgpt-web sidecar answered on the configured local endpoint.',
      'tuning.title': 'Transport limits',
      'tuning.hint': 'Applied from the next browser turn; no sidecar restart needed. Blank = default.',
      'tuning.save': 'Save',
      'tuning.restore': 'Restore defaults',
      'tuning.composerCharLimit': 'Composer character limit',
      'tuning.responseDomGraceMs': 'First-token grace floor (ms)',
      'tuning.responseDomGraceMaxMs': 'First-token grace ceiling (ms)',
      'tuning.responseDomGracePerCharMs': 'Grace growth per prompt char (ms)',
      'tuning.sendEnableGraceMs': 'Send-button grace (ms)',
      'tuning.generationRunningStallMs': 'Generation stall budget (ms)',
      'tuning.turnTimeoutMs': 'Turn timeout (ms)',
      'advisor.dialog.preset': 'DSH agent preset',
      'advisor.dialog.presetNone': 'No preset',
      'advisor.dialog.presetUnavailable': 'No DSH agent presets are available in this deployment.',
      'advisor.dialog.presetError': 'The DSH agent presets could not be read.',
      'advisor.dialog.presetRetry': 'Retry',
      'advisor.recover.action': 'Recover answer from ChatGPT',
      'advisor.recover.loading': 'Reading the answer from ChatGPT',
      'advisor.recover.hint': 'Read the answer ChatGPT already produced in this Advisor conversation. Nothing is sent.',
      'advisor.recover.failed': 'The answer could not be read.',
      'advisor.result.title': 'Recovered review',
      'advisor.result.copy': 'Copy',
      'advisor.result.copied': 'Copied.',
      'advisor.result.copyFailed': 'Select the text and copy it manually.',
      'advisor.result.recorded': 'Recorded for this turn: it also appears in the turn card and can be sent to DSH.',
      'advisor.card.recovered': 'recovered',
      'turns.title': 'Recent browser turns',
      'turns.empty': 'No recorded turns yet.',
      'turns.time': 'Time',
      'turns.result': 'Result',
      'turns.turns': 'User / Assistant turns',
      'turns.error': 'Error',
      'notice.saved': 'Saved. New limits apply from the next turn.',
      'notice.reloaded': 'Reloaded.',
      'notice.runtimeSaved': 'Runtime configuration saved.',
      'notice.runtimeRestored': 'Runtime defaults restored.',
      'notice.runtimeNoop': 'No runtime changes to save.',
      'runtime.title': 'Runtime',
      'runtime.hint': 'Live DSH plugin configuration. Changes are applied without remounting the plugin.',
      'runtime.port': 'Sidecar port',
      'runtime.autoStart': 'Start sidecar automatically',
      'runtime.readyTimeoutMs': 'Sidecar ready timeout (ms)',
      'runtime.save': 'Save',
      'runtime.restore': 'Restore defaults',
      'runtime.readOnly': 'Runtime configuration is not writable in this profile.',
      'runtime.portInvalid': 'Port must be an integer between 1 and 65535.',
      'runtime.timeoutInvalid': 'Ready timeout must be zero or a positive number of milliseconds.',
      'advisor.btn': 'Review with ChatGPT',
      'advisor.btnHint': 'Review the last completed turn with ChatGPT in a separate Advisor conversation.',
      'advisor.dialog.title': 'Review with ChatGPT',
      'advisor.dialog.mode': 'Model',
      'advisor.dialog.modeNormal': 'Normal',
      'advisor.dialog.modeThink': 'Think',
      'advisor.dialog.instructions': 'Review instructions',
      'advisor.dialog.context': 'Context (read-only)',
      'advisor.dialog.humanRequest': 'Last human request',
      'advisor.dialog.dshResponse': 'Last DSH response',
      'advisor.dialog.cancel': 'Cancel',
      'advisor.dialog.review': 'Review',
      'advisor.dialog.reviewing': 'Reviewing…',
      'advisor.dialog.error': 'The review failed. You can retry.',
      'advisor.errNoEndpoint': 'The sidecar endpoint is not configured.',
      'advisor.errNoToken': 'The sidecar control token is unavailable in this profile.',
      'advisor.card.title': 'ChatGPT Advisor',
      'advisor.card.modeNormal': 'Normal',
      'advisor.card.modeThink': 'Think',
      'advisor.card.send': 'Send to DSH',
      'advisor.card.sending': 'Sending…',
      'advisor.card.sendingStatus': 'Submitting through the normal DSH prompt flow…',
      'advisor.card.sent': 'Sent to DSH as a new prompt.',
      'advisor.card.sendError': 'Send failed — the text remains in the composer; you can retry.',
    };

    const CSS = `
      .cwg-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px; box-sizing: border-box; max-width: 720px; }
      .cwg-root *, .cwg-root *::before, .cwg-root *::after { box-sizing: border-box; }
      .cwg-root h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cwg-root h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); text-transform: uppercase; }
      .cwg-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px; background: var(--dsw-alias-bg-layer-1); }
      .cwg-offline { border-color: var(--dsw-alias-border-l2); }
      .cwg-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
      .cwg-check { display: flex; align-items: center; gap: 8px; margin: 10px 0; cursor: pointer; }
      .cwg-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
      .cwg-actions { justify-content: flex-start; }
      .cwg-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.4; }
      .cwg-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
      .cwg-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
      .cwg-input { font-size: 13px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); min-width: 0; }
      .cwg-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-btn { font-size: 13px; padding: 6px 14px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); cursor: pointer; }
      .cwg-btn:disabled { opacity: .5; cursor: default; }
      .cwg-btn.cwg-secondary { background: transparent; color: var(--dsw-alias-brand-primary); }
      .cwg-notice { font-size: 12px; }
      .cwg-notice.cwg-ok { color: var(--dsw-alias-state-success-primary); }
      .cwg-notice.cwg-err { color: var(--dsw-alias-state-error-primary); }
      .cwg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
      .cwg-cell { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-base); }
      .cwg-cell-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
      .cwg-cell-value { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cwg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .cwg-table th { text-align: left; padding: 6px 8px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); font-weight: 600; }
      .cwg-table td { padding: 6px 8px; color: var(--dsw-alias-label-primary); border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .cwg-table .cwg-err { color: var(--dsw-alias-state-error-primary); }
      .cwg-table .cwg-ok { color: var(--dsw-alias-state-success-primary); }
      .cwg-advisor-btn { font-size: 12px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
      .cwg-advisor-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-btn:disabled { opacity: .5; cursor: default; }
      /* The composer overlay slot renders its content in a zero-height absolutely-positioned
         anchor at the top of the composer card, so an in-flow dialog would sit over the
         composer's own editable field and read as a panel under the text box. A fixed backdrop
         with a centred card takes the dialog out of that flow and over the composer. */
      .cwg-advisor-backdrop { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgb(0 0 0 / .28); overflow: auto; }
      .cwg-advisor-dialog { display: flex; flex-direction: column; gap: 12px; width: min(560px, 100%); max-height: min(84vh, 720px); overflow-y: auto; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 8px 28px rgb(0 0 0 / .18); box-sizing: border-box; }
      .cwg-advisor-dialog:focus { outline: none; }
      .cwg-advisor-dialog:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .cwg-advisor-dialog *, .cwg-advisor-dialog *::before, .cwg-advisor-dialog *::after { box-sizing: border-box; }
      .cwg-advisor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .cwg-advisor-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cwg-advisor-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
      .cwg-advisor-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
      .cwg-advisor-section-label { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
      .cwg-advisor-mode { display: flex; gap: 6px; }
      .cwg-advisor-mode button { flex: 1; font-size: 13px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
      .cwg-advisor-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
      .cwg-advisor-preset { width: 100%; font-size: 13px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
      .cwg-advisor-preset:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-instructions { width: 100%; min-height: 72px; resize: vertical; font-size: 13px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
      .cwg-advisor-instructions:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-context { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto; }
      .cwg-advisor-context-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
      .cwg-advisor-context pre { margin: 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 8px; }
      .cwg-advisor-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
      .cwg-advisor-recover { display: flex; flex-direction: column; gap: 6px; }
      .cwg-advisor-recover-actions { display: flex; align-items: center; gap: 8px; }
      .cwg-advisor-result { display: flex; flex-direction: column; gap: 8px; }
      .cwg-advisor-result-body { width: 100%; min-height: 140px; max-height: 320px; resize: vertical; overflow-y: auto; font-family: var(--ds-font-family-code, monospace); font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 8px; }
      .cwg-advisor-result-body:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-result-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cwg-advisor-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
      .cwg-advisor-foot .cwg-err-msg { margin-right: auto; }
      .cwg-advisor-card { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 2px; padding: 10px 12px; border: 1px solid var(--dsw-alias-brand-primary); border-left: 3px solid var(--dsw-alias-brand-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
      .cwg-advisor-card *, .cwg-advisor-card *::before, .cwg-advisor-card *::after { box-sizing: border-box; }
      .cwg-advisor-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .cwg-advisor-card-title { font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-card-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cwg-advisor-card-body { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; }
      .cwg-advisor-card-foot { display: flex; align-items: center; gap: 8px; }
      .cwg-advisor-card-status { font-size: 12px; margin-right: auto; }
      .cwg-advisor-card-status.cwg-ok { color: var(--dsw-alias-state-success-primary); }
      .cwg-advisor-card-status.cwg-err { color: var(--dsw-alias-state-error-primary); }
    `;

    const NS = 'dsh-chatgpt-web';
    const BUNDLE_CONFIG_KEY = '@lordraiden/dsh-chatgpt-web';
    const RUNTIME_DEFAULTS = {
      port: 17841,
      autoStart: true,
      readyTimeoutMs: 30000,
    };

    /** Wrap the bound translate so a missing key never throws and always yields a string. */
    function makeT(translate) {
      return (key, fallback) => {
        try {
          const value = typeof translate === 'function' ? translate(key) : undefined;
          return typeof value === 'string' && value ? value : fallback;
        } catch {
          return fallback;
        }
      };
    }

    function getConfiguredPort(configForm) {
      try {
        const value = configForm && typeof configForm.getSnapshot === 'function'
          ? configForm.getSnapshot().value
          : undefined;
        const port = value && value.port;
        return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
      } catch {
        return null;
      }
    }

    function resolveSidecarBase(configForm) {
      const port = getConfiguredPort(configForm);
      return port === null ? null : `http://${LOOPBACK_HOST}:${port}`;
    }

    function formatEndpoint(base) {
      return base ? base.replace(/^https?:\/\//, '') : 'configured local endpoint';
    }

    async function api(base, token, path, options) {
      if (!base) throw new Error('Sidecar endpoint configuration is unavailable.');
      const headers = { Authorization: `Bearer ${token}` };
      if (options && options.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, { ...options, headers });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data && typeof data.error === 'string') message = data.error;
        } catch { /* keep status message */ }
        throw new Error(message);
      }
      if (res.status === 204) return null;
      return res.json();
    }

    const TUNING_FIELDS = [
      ['composerCharLimit', 'tuning.composerCharLimit'],
      ['responseDomGraceMs', 'tuning.responseDomGraceMs'],
      ['responseDomGraceMaxMs', 'tuning.responseDomGraceMaxMs'],
      ['responseDomGracePerCharMs', 'tuning.responseDomGracePerCharMs'],
      ['sendEnableGraceMs', 'tuning.sendEnableGraceMs'],
      ['generationRunningStallMs', 'tuning.generationRunningStallMs'],
      ['turnTimeoutMs', 'tuning.turnTimeoutMs'],
    ];

    function getRuntimeSnapshot(configForm) {
      try {
        const snapshot = configForm && typeof configForm.getSnapshot === 'function'
          ? configForm.getSnapshot()
          : undefined;
        const value = snapshot && snapshot.value ? snapshot.value : {};
        return {
          port: Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65535
            ? value.port
            : RUNTIME_DEFAULTS.port,
          autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : RUNTIME_DEFAULTS.autoStart,
          readyTimeoutMs: typeof value.readyTimeoutMs === 'number' && Number.isFinite(value.readyTimeoutMs) && value.readyTimeoutMs >= 0
            ? value.readyTimeoutMs
            : RUNTIME_DEFAULTS.readyTimeoutMs,
          ready: Boolean(snapshot && snapshot.status === 'ready'),
          writable: Boolean(snapshot && snapshot.writable === true),
          revision: snapshot && Number.isInteger(snapshot.revision) ? snapshot.revision : undefined,
        };
      } catch {
        return { ...RUNTIME_DEFAULTS, ready: false, writable: false, revision: undefined };
      }
    }

    function ChatGptWebSettings(t, configForm) {
      const [token, setToken] = React.useState('');
      const [base, setBase] = React.useState(() => resolveSidecarBase(configForm));
      const [status, setStatus] = React.useState(null);
      const [configInfo, setConfigInfo] = React.useState(null);
      const [turns, setTurns] = React.useState([]);
      const [form, setForm] = React.useState({});
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [runtimeDraft, setRuntimeDraft] = React.useState(() => getRuntimeSnapshot(configForm));
      const [runtimeDirty, setRuntimeDirty] = React.useState(false);
      const [runtimeSaving, setRuntimeSaving] = React.useState(false);

      React.useEffect(() => {
        try {
          window.localStorage.removeItem(LEGACY_TOKEN_KEY);
        } catch {
          // Browser storage may be unavailable; the token remains page-local.
        }

        const refreshEndpoint = () => {
          const runtime = getRuntimeSnapshot(configForm);
          setBase(resolveSidecarBase(configForm));
          if (!runtimeDirty) setRuntimeDraft(runtime);
        };
        refreshEndpoint();
        if (!configForm || typeof configForm.subscribe !== 'function') return undefined;
        return configForm.subscribe(refreshEndpoint);
      }, [configForm, runtimeDirty]);

      async function saveRuntimeConfig() {
        if (!configForm || typeof configForm.mutate !== 'function') return;
        const snapshot = configForm.getSnapshot();
        if (snapshot.status !== 'ready' || snapshot.writable !== true) {
          setNotice({ kind: 'err', text: t('runtime.readOnly', 'Runtime configuration is not writable in this profile.') });
          return;
        }
        if (!Number.isSafeInteger(runtimeDraft.port) || runtimeDraft.port < 1 || runtimeDraft.port > 65535) {
          setNotice({ kind: 'err', text: t('runtime.portInvalid', 'Port must be an integer between 1 and 65535.') });
          return;
        }
        if (!Number.isFinite(runtimeDraft.readyTimeoutMs) || runtimeDraft.readyTimeoutMs < 0) {
          setNotice({ kind: 'err', text: t('runtime.timeoutInvalid', 'Ready timeout must be zero or a positive number of milliseconds.') });
          return;
        }
        const current = snapshot.value || {};
        const ops = [];
        if (runtimeDraft.port !== current.port) ops.push({ op: 'set', path: ['port'], value: runtimeDraft.port });
        if (runtimeDraft.autoStart !== current.autoStart) ops.push({ op: 'set', path: ['autoStart'], value: runtimeDraft.autoStart });
        if (runtimeDraft.readyTimeoutMs !== current.readyTimeoutMs) ops.push({ op: 'set', path: ['readyTimeoutMs'], value: runtimeDraft.readyTimeoutMs });
        if (ops.length === 0) {
          setRuntimeDirty(false);
          setNotice({ kind: 'ok', text: t('notice.runtimeNoop', 'No runtime changes to save.') });
          return;
        }
        setRuntimeSaving(true);
        try {
          const accepted = await configForm.mutate(ops, snapshot.revision);
          if (!accepted) throw new Error('DSH refused the runtime configuration update.');
          setRuntimeDirty(false);
          setNotice({ kind: 'ok', text: t('notice.runtimeSaved', 'Runtime configuration saved.') });
        } catch (error) {
          setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
        } finally {
          setRuntimeSaving(false);
        }
      }

      async function restoreRuntimeDefaults() {
        if (!configForm || typeof configForm.mutate !== 'function') return;
        const snapshot = configForm.getSnapshot();
        if (snapshot.status !== 'ready' || snapshot.writable !== true) return;
        const user = snapshot.user && typeof snapshot.user === 'object' ? snapshot.user : {};
        const ops = ['port', 'autoStart', 'readyTimeoutMs']
          .filter((field) => Object.prototype.hasOwnProperty.call(user, field))
          .map((field) => ({ op: 'unset', path: [field] }));
        if (ops.length === 0) {
          setRuntimeDirty(false);
          setNotice({ kind: 'ok', text: t('notice.runtimeNoop', 'No runtime overrides to clear.') });
          return;
        }
        setRuntimeSaving(true);
        try {
          const accepted = await configForm.mutate(ops, snapshot.revision);
          if (!accepted) throw new Error('DSH refused the runtime reset.');
          setRuntimeDirty(false);
          setNotice({ kind: 'ok', text: t('notice.runtimeRestored', 'Runtime defaults restored.') });
        } catch (error) {
          setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
        } finally {
          setRuntimeSaving(false);
        }
      }

            async function loadAll(currentToken, currentBase) {
        if (!currentToken) { setStatus(null); return; }
        if (!currentBase) {
          setStatus(null);
          setNotice({ kind: 'err', text: 'Sidecar endpoint configuration is unavailable.' });
          return;
        }
        setBusy(true);
        try {
          const [st, cfg, rt] = await Promise.all([
            api(currentBase, currentToken, '/v1/control/status'),
            api(currentBase, currentToken, '/v1/control/config'),
            api(currentBase, currentToken, '/v1/control/recent-turns?limit=10'),
          ]);
          setStatus(st);
          setConfigInfo(cfg);
          setTurns(rt.turns || []);
          const next = {};
          for (const [field] of TUNING_FIELDS) {
            next[field] = cfg.tuning && cfg.tuning[field] !== undefined ? String(cfg.tuning[field]) : '';
          }
          setForm(next);
        } catch (error) {
          setStatus(null);
          setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy(false);
        }
      }

      React.useEffect(() => { loadAll(token, base); }, [token, base]);

      async function save(tuning) {
        setBusy(true);
        try {
          await api(base, token, '/v1/control/config', { method: 'PUT', body: JSON.stringify({ tuning }) });
          setNotice({ kind: 'ok', text: t('notice.saved', 'Saved. New limits apply from the next turn.') });
          await loadAll(token, base);
        } catch (error) {
          setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy(false);
        }
      }

      function onSave() {
        const tuning = {};
        for (const [field] of TUNING_FIELDS) {
          const raw = (form[field] || '').trim();
          if (raw) tuning[field] = Number(raw);
        }
        if (Object.keys(tuning).length === 0) {
          setNotice({ kind: 'err', text: 'Enter at least one limit to save.' });
          return;
        }
        save(tuning);
      }

      function onRestore() {
        if (configInfo && configInfo.defaults) save({ ...configInfo.defaults });
      }

      const fmtUptime = (seconds) => {
        const s = Math.floor(seconds);
        const hr = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return hr > 0 ? `${hr}h ${m}m` : `${m}m ${s % 60}s`;
      };

      const rows = status ? [
        ['Version', status.version],
        ['PID', String(status.pid)],
        ['Uptime', fmtUptime(status.uptime)],
        ['Accepting turns', status.accepting_turns ? 'yes' : 'no'],
        ['Active HTTP / browser turns', `${status.active_http_turns} / ${status.active_browser_turns}`],
        ['Login state', status.storageStatePresent ? 'verified' : 'missing'],
        ['Storage dir', status.storageDir],
        ['Chrome', status.chromeExecutablePath],
        ['Headed', status.headed ? 'yes' : 'no'],
        ['Sol / Pro', `${status.solAvailable ? 'yes' : 'no'} / ${status.proAvailable ? 'yes' : 'no'}`],
      ] : [];

      return h('div', { className: 'cwg-root' },
        h('style', null, CSS),

        h('section', { className: 'cwg-card' },
          h('h3', null, t('runtime.title', 'Runtime')),
          h('p', { className: 'cwg-muted' }, t('runtime.hint', 'These fields use DSH live plugin configuration. Changes are applied without remounting the plugin.')),
          h('label', { className: 'cwg-field' },
            h('span', { className: 'cwg-label' }, t('runtime.port', 'Sidecar port')),
            h('input', {
              className: 'cwg-input',
              type: 'number',
              min: 1,
              max: 65535,
              step: 1,
              disabled: runtimeSaving || !getRuntimeSnapshot(configForm).writable,
              value: runtimeDraft.port,
              onChange: (e) => {
                setRuntimeDirty(true);
                setRuntimeDraft({ ...runtimeDraft, port: Number(e.target.value) });
              },
            }),
          ),
          h('label', { className: 'cwg-check' },
            h('input', {
              type: 'checkbox',
              disabled: runtimeSaving || !getRuntimeSnapshot(configForm).writable,
              checked: runtimeDraft.autoStart,
              onChange: (e) => {
                setRuntimeDirty(true);
                setRuntimeDraft({ ...runtimeDraft, autoStart: e.target.checked });
              },
            }),
            h('span', { className: 'cwg-label' }, t('runtime.autoStart', 'Start sidecar automatically')),
          ),
          h('label', { className: 'cwg-field' },
            h('span', { className: 'cwg-label' }, t('runtime.readyTimeoutMs', 'Sidecar ready timeout (ms)')),
            h('input', {
              className: 'cwg-input',
              type: 'number',
              min: 0,
              step: 100,
              disabled: runtimeSaving || !getRuntimeSnapshot(configForm).writable,
              value: runtimeDraft.readyTimeoutMs,
              onChange: (e) => {
                setRuntimeDirty(true);
                setRuntimeDraft({ ...runtimeDraft, readyTimeoutMs: Number(e.target.value) });
              },
            }),
          ),
          h('div', { className: 'cwg-row cwg-actions' },
            h('button', {
              className: 'cwg-btn',
              disabled: runtimeSaving || !runtimeDirty || !getRuntimeSnapshot(configForm).writable,
              onClick: saveRuntimeConfig,
            }, t('runtime.save', 'Save')),
            h('button', {
              className: 'cwg-btn cwg-secondary',
              disabled: runtimeSaving || !getRuntimeSnapshot(configForm).writable,
              onClick: restoreRuntimeDefaults,
            }, t('runtime.restore', 'Restore defaults')),
          ),
        ),

        h('section', { className: 'cwg-card' },
          h('h3', null, t('conn.title', 'Connection')),
          h('label', { className: 'cwg-field' },
            h('span', { className: 'cwg-label' }, t('conn.token', 'Control token')),
            h('input', {
              className: 'cwg-input',
              type: 'password',
              value: token,
              placeholder: 'FJ86_…',
              onChange: (e) => { setToken(e.target.value); },
            }),
          ),
          h('div', { className: 'cwg-row' },
            h('span', { className: 'cwg-muted' }, t('conn.tokenHint', 'The sidecar control token. Held only in this page and never persisted in browser storage.')),
          ),
          h('div', { className: 'cwg-row cwg-actions' },
            h('button', {
              className: 'cwg-btn',
              disabled: busy || !token,
              onClick: () => { loadAll(token, base); setNotice({ kind: 'ok', text: t('notice.reloaded', 'Reloaded.') }); },
            }, t('conn.reload', 'Reload')),
            notice ? h('span', { className: `cwg-notice cwg-${notice.kind}` }, notice.text) : null,
          ),
        ),

        status
          ? h('section', { className: 'cwg-card' },
              h('h3', null, t('status.title', 'Sidecar status')),
              h('div', { className: 'cwg-grid' },
                rows.map(([label, value]) => h('div', { key: label, className: 'cwg-cell' },
                  h('div', { className: 'cwg-cell-label' }, label),
                  h('div', { className: 'cwg-cell-value', title: String(value) }, String(value)),
                )),
              ),
            )
          : h('section', { className: 'cwg-card cwg-offline' },
              h('h3', null, t('status.offline', 'Sidecar offline')),
              h('p', { className: 'cwg-muted' },
                t('status.offlineHint', 'No chatgpt-web sidecar answered on the configured local endpoint.'),
                ` (${formatEndpoint(base)})`,
              ),
            ),

        configInfo
          ? h('section', { className: 'cwg-card' },
              h('h3', null, t('tuning.title', 'Transport limits')),
              h('p', { className: 'cwg-muted' }, t('tuning.hint', 'Applied from the next browser turn; no sidecar restart needed. Blank = default.')),
              h('div', null,
                TUNING_FIELDS.map(([field, key]) => h('label', { key: field, className: 'cwg-field' },
                  h('span', { className: 'cwg-label' },
                    t(key, field),
                    configInfo.effective && configInfo.effective[field] !== undefined
                      ? h('span', { className: 'cwg-muted' }, ` (effective ${configInfo.effective[field]})`)
                      : null,
                  ),
                  h('input', {
                    className: 'cwg-input',
                    type: 'number',
                    value: form[field] || '',
                    placeholder: configInfo.effective && configInfo.effective[field] !== undefined ? String(configInfo.effective[field]) : '',
                    onChange: (e) => setForm({ ...form, [field]: e.target.value }),
                  }),
                )),
              ),
              h('div', { className: 'cwg-row cwg-actions' },
                h('button', { className: 'cwg-btn', disabled: busy, onClick: onSave }, t('tuning.save', 'Save')),
                h('button', { className: 'cwg-btn cwg-secondary', disabled: busy, onClick: onRestore }, t('tuning.restore', 'Restore defaults')),
              ),
            )
          : null,

        h('section', { className: 'cwg-card' },
          h('h3', null, t('turns.title', 'Recent browser turns')),
          turns.length === 0
            ? h('p', { className: 'cwg-muted' }, t('turns.empty', 'No recorded turns yet.'))
            : h('table', { className: 'cwg-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('turns.time', 'Time')),
                  h('th', null, t('turns.result', 'Result')),
                  h('th', null, t('turns.turns', 'User / Assistant turns')),
                  h('th', null, t('turns.error', 'Error')),
                )),
                h('tbody', null, turns.map((turn) => h('tr', { key: turn.traceId },
                  h('td', null, turn.capturedAt ? new Date(turn.capturedAt).toLocaleString() : '—'),
                  h('td', { className: turn.error ? 'cwg-err' : 'cwg-ok' }, turn.checkpoint || '—'),
                  h('td', null, `${turn.userTurns} / ${turn.assistantTurns}`),
                  h('td', { className: 'cwg-muted', title: turn.error || '' }, turn.error ? (turn.error.length > 80 ? `${turn.error.slice(0, 80)}…` : turn.error) : '—'),
                ))),
              ),
        ),
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ChatGPT Advisor (issue #179): composer button + review dialog. The dialog
    // calls the #178 sidecar endpoint POST /v1/control/advisor/review; the
    // control token arrives through the official session-projection channel
    // (`useProjection('dsh-chatgpt-web:sidecar')`), the port through the live
    // plugin config form, and the review context through the Chat snapshot
    // selector hooks — no parallel state machinery.
    // ─────────────────────────────────────────────────────────────────────────
    const ADVISOR_PROJECTION_KEY = 'dsh-chatgpt-web:sidecar';
    const LAST_INSTRUCTIONS_KEY = 'dsh-chatgpt-web.advisor.lastInstructions';
    const DEFAULT_INSTRUCTIONS =
      'Review this development step as a senior software engineer.\n' +
      'Identify correctness problems, missed requirements, risks, and concrete improvements.\n' +
      'Focus on issues that should be addressed before continuing.';

    /**
     * Plain-text of a `user` chat node. Per the `ui-chat` contract the message
     * content lives on the Node data (`data.content`), mirroring the target's
     * own prompt projection.
     */
    function userNodeText(node) {
      const content = node && node.data ? node.data.content : undefined;
      if (!Array.isArray(content)) return '';
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * Plain-text of an `assistant-step` chat node. The blocks live on the Node
     * data (`data.blocks`) and only `text` blocks are reviewable material.
     */
    function assistantNodeText(node) {
      const blocks = node && node.data ? node.data.blocks : undefined;
      if (!Array.isArray(blocks)) return '';
      return blocks
        .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * The last completed, reviewable turn of the chat: the latest human
     * request and the latest settled `assistant-step` rendered after it, per
     * the current `ui-chat` Node contract (`user` data carries `content`,
     * `assistant-step` data carries `status`/`turn`/`blocks`). `data.status`
     * IS the target's own completion discriminator (derived there from
     * `finalNode` plus its `interrupted` marker), so a settled status is the
     * reviewable one. Render order is the snapshot's own `order`. Returns null
     * while nothing reviewable exists (no turn yet, a still-running or
     * interrupted response, or empty content).
     */
    function selectReviewableTurn(chat) {
      if (!chat || !Array.isArray(chat.order) || typeof chat.nodes?.get !== 'function') return null;
      let user = null;
      let assistant = null;
      for (let i = chat.order.length - 1; i >= 0; i -= 1) {
        const node = chat.nodes.get(chat.order[i]);
        if (!node) continue;
        if (!user && node.kind === 'user') {
          const text = userNodeText(node);
          if (text) user = { index: i, text };
        }
        if (!assistant && node.kind === 'assistant-step' && node.data?.status === 'settled') {
          const text = assistantNodeText(node);
          if (text) assistant = { index: i, text, data: node.data, anchorSeq: node.anchorSeq };
        }
        if (user && assistant) break;
      }
      if (!user || !assistant || !(user.index < assistant.index)) return null;
      // `AssistantChatData.turn` IS the DSH turn number the chat turnTail card
      // associates results with; `anchorSeq` is only the node's render
      // position (the #179 `turn` field), never a turn number.
      const dshTurn = typeof assistant.data.turn === 'number' ? assistant.data.turn : undefined;
      return { humanRequest: user.text, dshResponse: assistant.text, turn: assistant.anchorSeq, dshTurn };
    }

    /** The button is actionable only with a reviewable turn, no generation, and no in-flight review. */
    function canStartReview({ running, inFlight, reviewable }) {
      return Boolean(reviewable) && running !== true && inFlight !== true;
    }

    /** Workspace basename for the optional `project` field (never a path). */
    function selectProjectName(items, sessionId) {
      if (!Array.isArray(items) || !sessionId) return undefined;
      const item = items.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId));
      if (!item || typeof item.path !== 'string') return undefined;
      const segments = item.path.split(/[\\/]+/).filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : undefined;
    }

    /** Pure request builder for the #178 endpoint (testable without fetch). */
    function buildAdvisorFetch({ base, token, sessionId, humanRequest, dshResponse, instructions, mode, project, preset, signal }) {
      const body = { sessionId, humanRequest, dshResponse, instructions, mode };
      if (project) body.project = project;
      // The agent-preset label is review context only: the sidecar carries it into the review
      // content and never composes a DSH session from it.
      if (preset) body.preset = preset;
      return {
        url: `${base}/v1/control/advisor/review`,
        options: {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      };
    }

    /**
     * Pure request builder for the #214 recovery endpoint (testable without fetch). A recovery is
     * read-only: it identifies the session whose retained Advisor conversation is read, and
     * nothing else.
     */
    function buildAdvisorRecoverFetch({ base, token, sessionId, mode, timeoutMs, signal }) {
      const body = { sessionId };
      if (mode === 'think' || mode === 'normal') body.mode = mode;
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) body.timeoutMs = timeoutMs;
      return {
        url: `${base}/v1/control/advisor/recover`,
        options: {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      };
    }

    function loadLastInstructions(storage) {
      try {
        const value = storage ? storage.getItem(LAST_INSTRUCTIONS_KEY) : null;
        return typeof value === 'string' && value.trim() ? value : DEFAULT_INSTRUCTIONS;
      } catch {
        return DEFAULT_INSTRUCTIONS;
      }
    }

    function saveLastInstructions(storage, value) {
      try {
        if (storage && typeof value === 'string' && value.trim()) storage.setItem(LAST_INSTRUCTIONS_KEY, value);
      } catch {
        // Browser storage may be unavailable; the preference is best-effort.
      }
    }

    /**
     * Shared dialog state, module-scoped so the button slot and the overlay
     * slot (two distinct slot entries) drive one dialog. Plain listeners —
     * the framework drives both components to re-render on change.
     */
    function createAdvisorStore() {
      let state = { open: false, mode: 'normal', instructions: DEFAULT_INSTRUCTIONS, preset: '', context: null, status: 'idle', error: null, recovery: { status: 'idle', text: '', error: null } };
      let inFlight = false;
      let abortController = null;
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors never break the store */ } } };
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        get inFlight() { return inFlight; },
        openDialog(context, instructions, preset) {
          state = {
            ...state,
            open: true,
            status: 'idle',
            error: null,
            recovery: { status: 'idle', text: '', error: null },
            context,
            // `null` defers to the dialog default (the preset the session runs, else the
            // deployment default); `''` is an explicit "no preset" choice.
            preset: typeof preset === 'string' ? preset : null,
            instructions: typeof instructions === 'string' && instructions.trim() ? instructions : DEFAULT_INSTRUCTIONS,
          };
          notify();
        },
        closeDialog() {
          if (abortController) { try { abortController.abort(); } catch { /* already settled */ } }
          state = { ...state, open: false, status: 'idle', error: null, recovery: { status: 'idle', text: '', error: null } };
          notify();
        },
        /** Clear a previous recovered answer (a new review or a new recovery starts clean). */
        clearRecovery() { state = { ...state, recovery: { status: 'idle', text: '', error: null } }; notify(); },
        /** Fail the recovery itself without replacing the review error beside it. */
        failRecovery(message) {
          state = { ...state, recovery: { status: 'error', text: '', error: typeof message === 'string' ? message : String(message) } };
          notify();
        },
        setMode(mode) { state = { ...state, mode: mode === 'think' ? 'think' : 'normal' }; notify(); },
        setInstructions(text) { state = { ...state, instructions: typeof text === 'string' ? text : '' }; notify(); },
        setPreset(preset) { state = { ...state, preset: typeof preset === 'string' ? preset : '' }; notify(); },
        fail(message) { state = { ...state, status: 'error', error: message }; notify(); },
        runReview(env) {
          if (inFlight || !state.open || !state.context) return;
          inFlight = true;
          const controller = new AbortController();
          abortController = controller;
          state = { ...state, status: 'loading', error: null };
          notify();
          const finish = () => { inFlight = false; abortController = null; };
          const preset = typeof env.preset === 'string'
            ? env.preset.trim()
            : (typeof state.preset === 'string' ? state.preset.trim() : '');
          const { url, options } = buildAdvisorFetch({
            base: env.base,
            token: env.token,
            sessionId: env.sessionId,
            humanRequest: state.context.humanRequest,
            dshResponse: state.context.dshResponse,
            instructions: state.instructions,
            mode: state.mode,
            project: env.project,
            preset,
            signal: controller.signal,
          });
          env.fetch(url, options)
            .then(async (res) => {
              let data = null;
              try { data = await res.json(); } catch { /* non-JSON body */ }
              if (!res.ok || !data || data.ok !== true) {
                const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
                state = { ...state, status: 'error', error: message };
              } else {
                saveLastInstructions(env.storage, state.instructions);
                // Issue #180: record the result for the reviewed DSH turn so
                // the chat turnTail card can show it. This is browser-storage
                // state, NOT a Session event — the review never enters model
                // history. A reviewable turn without a resolvable DSH turn
                // number (dshTurn) is not recordable and skips the card.
                if (typeof state.context.dshTurn === 'number') {
                  recordAdvisorResult(env.storage, {
                    turn: state.context.dshTurn,
                    reviewId: data.reviewId,
                    mode: state.mode,
                    model: data.model,
                    preset,
                    text: data.text,
                  });
                }
                state = { ...state, open: false, status: 'idle', error: null };
              }
            })
            .catch((error) => {
              const aborted = error && (error.name === 'AbortError' || error.code === 20);
              if (aborted && !state.open) {
                state = { ...state, status: 'idle', error: null };
              } else if (aborted) {
                // The dialog stayed open while the request was cancelled
                // externally: surface it as a retryable error.
                state = { ...state, status: 'error', error: 'cancelled' };
              } else {
                state = { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) };
              }
            })
            .finally(() => { finish(); notify(); });
        },
        /**
         * Read the finalized answer of this session's retained Advisor conversation (issue #214).
         * This is the recovery path behind a review the browser turn already gave up on: it never
         * submits anything, so it can be retried freely, and a successful read is recorded exactly
         * like a produced review (turn card + "Send to DSH").
         */
        recover(env) {
          if (inFlight || !state.open || !state.context) return;
          inFlight = true;
          const controller = new AbortController();
          abortController = controller;
          state = { ...state, recovery: { status: 'loading', text: '', error: null } };
          notify();
          const finish = () => { inFlight = false; abortController = null; };
          const preset = typeof env.preset === 'string' ? env.preset.trim() : '';
          const { url, options } = buildAdvisorRecoverFetch({
            base: env.base,
            token: env.token,
            sessionId: env.sessionId,
            mode: state.mode,
            ...(env.timeoutMs !== undefined ? { timeoutMs: env.timeoutMs } : {}),
            signal: controller.signal,
          });
          env.fetch(url, options)
            .then(async (res) => {
              let data = null;
              try { data = await res.json(); } catch { /* non-JSON body */ }
              const text = data && typeof data.text === 'string' ? data.text.trim() : '';
              if (!res.ok || !data || data.ok !== true || !text) {
                const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
                state = { ...state, recovery: { status: 'error', text: '', error: message } };
                return;
              }
              if (typeof state.context.dshTurn === 'number') {
                recordAdvisorResult(env.storage, {
                  turn: state.context.dshTurn,
                  reviewId: typeof data.reviewId === 'string' ? data.reviewId : '',
                  mode: state.mode,
                  model: typeof data.model === 'string' ? data.model : '',
                  preset,
                  recovered: true,
                  text,
                });
              }
              state = { ...state, recovery: { status: 'ready', text, error: null } };
            })
            .catch((error) => {
              const aborted = error && (error.name === 'AbortError' || error.code === 20);
              if (aborted) {
                state = { ...state, recovery: { status: 'idle', text: '', error: null } };
              } else {
                state = { ...state, recovery: { status: 'error', text: '', error: error instanceof Error ? error.message : String(error) } };
              }
            })
            .finally(() => { finish(); notify(); });
        },
      };
    }

    const advisorStore = createAdvisorStore();

    /**
     * DSH agent-preset roster for the Advisor dialog (issue #208).
     *
     * Options come from the host service through the typed client gateway
     * (`ctx.remote.agentPresets.list()`), the call DSH's own agent-preset surfaces make. The read is
     * defensive: `gateway/invocation-unavailable` means the deployment composes no agent-preset
     * registry, which is a valid deployment rather than a failure, so the dialog then offers only
     * the "no preset" option. A plugin that cannot list presets must never lose its own UI.
     */
    function createAdvisorPresetStore() {
      let state = { status: 'idle', options: [], error: null };
      let loading = null;
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors never break the store */ } } };
      const set = (next) => { state = next; notify(); };
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        /** Read once; concurrent dialog opens share the in-flight read. */
        load(read) {
          if (loading) return loading;
          set({ ...state, status: 'loading', error: null });
          loading = Promise.resolve()
            .then(() => read())
            .then((options) => { set({ status: options.length > 0 ? 'ready' : 'unavailable', options, error: null }); })
            // A refused read is not an empty deployment: the dialog shows the reason and offers a
            // retry, while "unavailable" stays reserved for a deployment that composes no presets.
            .catch((error) => { set({ status: 'error', options: [], error: error instanceof Error ? error.message : String(error) }); })
            .finally(() => { loading = null; });
          return loading;
        },
      };
    }

    const advisorPresetStore = createAdvisorPresetStore();

    /**
     * Read the DSH agent-preset roster through the client gateway. Mirrors DSH's own
     * `readRoster`: an unavailable invocation is an empty roster, any other refusal is an error.
     * @returns normalized selectable options; never the broken presets.
     */
    function loadAdvisorPresetOptions(remote) {
      const api = remote && remote.agentPresets;
      if (!api || typeof api.list !== 'function') return Promise.resolve([]);
      return Promise.resolve(api.list()).then((result) => {
        if (!result || result.ok !== true) {
          const code = result && result.error ? result.error.code : undefined;
          if (code === 'gateway/invocation-unavailable') return [];
          const message = result && result.error && result.error.message ? result.error.message : 'agent preset roster unavailable';
          throw new Error(message);
        }
        const roster = result.value || {};
        const rows = Array.isArray(roster.presets) ? roster.presets : [];
        return advisorPresetOptions(rows);
      });
    }

    /** Normalize roster rows into selectable options, in roster order; broken rows are skipped. */
    function advisorPresetOptions(rows) {
      const options = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        // A broken preset cannot compose a session, so offering it would only defer that fact.
        if (!id || typeof row.broken === 'string' && row.broken.length > 0) continue;
        const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
        const description = typeof row.description === 'string' ? row.description.trim() : '';
        options.push({ id, name, description, isDefault: row.isDefault === true });
      }
      return options;
    }

    /**
     * The roster option the dialog preselects: the preset the session already runs (the DSH
     * `agentPreset` session projection), else the deployment default, else nothing.
     */
    function defaultAdvisorPreset(options, sessionPreset) {
      const list = Array.isArray(options) ? options : [];
      const running = typeof sessionPreset === 'string' ? list.find((option) => option.id === sessionPreset) : undefined;
      if (running) return running.id;
      const fallback = list.find((option) => option.isDefault) || list[0];
      return fallback ? fallback.id : '';
    }

    /** The label the reviewer reads for one option: its display name. */
    function advisorPresetLabel(options, presetId) {
      if (typeof presetId !== 'string' || !presetId) return '';
      const option = (Array.isArray(options) ? options : []).find((candidate) => candidate.id === presetId);
      return option ? option.name : presetId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ChatGPT Advisor result card + "Send to DSH" handoff (issue #180).
    //
    // The result is recorded in browser storage keyed by the reviewed DSH turn
    // (latest result per turn). It is NOT written to the Session log, so it
    // never enters model history: in this harness `Session.append()` cannot
    // mark external plugin events `ignorable: true`, and the persistence
    // reader refuses a log containing an unknown non-ignorable type on
    // restore. Browser storage + a chat turnTail slot card follows the DSH
    // UI/state patterns already used by this plugin (#179 instructions).
    //
    // "Send to DSH" goes through the official input actions of the normal
    // prompt flow (`inputActions.setDraft` + `inputActions.submit`) — no
    // direct Session writes from React, no plugin-executed recommendations.
    // ─────────────────────────────────────────────────────────────────────────
    const RESULTS_KEY = 'dsh-chatgpt-web.advisor.results';

    /** Validate persisted JSON into normalized result entries; never throws. */
    function parseAdvisorResults(raw) {
      if (!raw) return [];
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.turn !== 'number' || !Number.isFinite(entry.turn)) continue;
        if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
        out.push({
          turn: entry.turn,
          reviewId: typeof entry.reviewId === 'string' ? entry.reviewId : '',
          mode: entry.mode === 'think' ? 'think' : 'normal',
          model: typeof entry.model === 'string' ? entry.model : '',
          preset: typeof entry.preset === 'string' ? entry.preset : '',
          recovered: entry.recovered === true,
          text: entry.text,
          at: typeof entry.at === 'number' ? entry.at : 0,
        });
      }
      return out;
    }

    function loadAdvisorResults(storage) {
      try {
        return parseAdvisorResults(storage ? storage.getItem(RESULTS_KEY) : null);
      } catch {
        return [];
      }
    }

    function saveAdvisorResults(storage, results) {
      try {
        if (storage) storage.setItem(RESULTS_KEY, JSON.stringify(results));
      } catch {
        // Browser storage may be unavailable; the result stays session-local.
      }
    }

    /**
     * Record one successful review, keeping only the LATEST result per turn
     * (no history accumulation — the card shows one review per turn).
     * @returns the normalized result, or null when the input is unusable.
     */
    function recordAdvisorResult(storage, result) {
      if (!result || typeof result.turn !== 'number' || !Number.isFinite(result.turn)) return null;
      if (typeof result.text !== 'string' || !result.text.trim()) return null;
      const entry = {
        turn: result.turn,
        reviewId: typeof result.reviewId === 'string' ? result.reviewId : '',
        mode: result.mode === 'think' ? 'think' : 'normal',
        model: typeof result.model === 'string' ? result.model : '',
        preset: typeof result.preset === 'string' ? result.preset.trim() : '',
        recovered: result.recovered === true,
        text: result.text,
        at: Date.now(),
      };
      const next = [...loadAdvisorResults(storage).filter((item) => item.turn !== entry.turn), entry];
      saveAdvisorResults(storage, next);
      return entry;
    }

    /** The result associated with one DSH turn, or null. */
    function selectResultForTurn(results, turn) {
      if (!Array.isArray(results) || typeof turn !== 'number') return null;
      return results.find((entry) => entry && entry.turn === turn) || null;
    }

    /**
     * The minimum handoff prompt (issue #180): the full review, clearly marked
     * as coming from ChatGPT Advisor, asking the agent to evaluate it against
     * the current task and apply the relevant recommendations. Excludes Advisor
     * history, internal IDs, HTML/UI markup, bridge details, and transport terms.
     */
    function buildHandoffPrompt(result) {
      const review = result && typeof result.text === 'string' ? result.text.trim() : '';
      if (!review) return '';
      const preset = result && typeof result.preset === 'string' ? result.preset.trim() : '';
      return (
        'ChatGPT Advisor review:\n\n' +
        review +
        '\n\n' +
        (preset ? `Reviewed DSH agent preset: "${preset}"\n\n` : '') +
        'Evaluate this review against the current task and apply the relevant recommendations.\n' +
        'Do not blindly follow recommendations that are incorrect or inconsistent with the current task.'
      );
    }

    /**
     * Per-turn send states for "Send to DSH" (sending / sent / send-error) with
     * a single-flight dedup guard: one submission in progress at a time, so a
     * double activation of the button never produces two prompts.
     */
    function createSendStore() {
      let sending = new Set();
      let sent = new Set();
      let errors = new Map();
      let activeTurn = null;
      const listeners = new Set();
      const notify = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* listener errors never break the store */
          }
        }
      };
      const snapshot = () => ({ sending: new Set(sending), sent: new Set(sent), errors: new Map(errors) });
      return {
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        get activeTurn() {
          return activeTurn;
        },
        /**
         * Deliver the handoff prompt through the normal DSH prompt flow.
         * @returns 'sent-requested' | 'busy' | 'empty' | 'unavailable' | 'error'.
         */
        send({ turn, prompt, inputActions }) {
          if (activeTurn !== null) return 'busy';
          if (typeof prompt !== 'string' || !prompt.trim()) return 'empty';
          if (!inputActions || typeof inputActions.setDraft !== 'function' || typeof inputActions.submit !== 'function') return 'unavailable';
          activeTurn = turn;
          sending = new Set(sending).add(turn);
          sent.delete(turn);
          errors.delete(turn);
          notify();
          try {
            inputActions.setDraft(prompt);
            inputActions.submit();
            return 'sent-requested';
          } catch (error) {
            sending.delete(turn);
            errors.set(turn, error instanceof Error ? error.message : String(error));
            activeTurn = null;
            notify();
            return 'error';
          }
        },
        /** Called by the card when the official flow consumed the draft. */
        markSent(turn) {
          sending.delete(turn);
          sent.add(turn);
          errors.delete(turn);
          if (activeTurn === turn) activeTurn = null;
          notify();
        },
      };
    }

    const advisorSendStore = createSendStore();

    function useAdvisorSendState(store) {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
      return { snapshot };
    }

    /**
     * Advisor result card for one finalized turn (chat turnTail slot). Renders
     * only when a recorded result is associated with this turn — a fresh slot
     * entry whose component returns null leaves the tail unchanged.
     */
    function AdvisorResultCard(t, props) {
      const turn = props && props.turn && typeof props.turn.turn === 'number' ? props.turn.turn : undefined;
      // Re-render whenever a review completes (advisor store) or send states
      // change; results themselves come from browser storage.
      const { snapshot } = useAdvisorState(advisorStore);
      const { snapshot: sendSnapshot } = useAdvisorSendState(advisorSendStore);
      const phase = typeof props.useInput === 'function' ? props.useInput((s) => s.phase) : 'plain';
      const draft = typeof props.useInput === 'function' ? props.useInput((s) => s.draft) : '';
      const results = React.useMemo(() => loadAdvisorResults(window.localStorage), [snapshot]);
      const sending = sendSnapshot.sending.has(turn);
      const sent = sendSnapshot.sent.has(turn);
      const error = sendSnapshot.errors.get(turn);

      // Hooks stay above every early return: the card mounts with no result
      // (null) and later re-renders with one, so the hook count must not change.
      React.useEffect(() => {
        // The prompt flow consumed the draft (phase back to plain, draft
        // cleared): the handoff became a normal DSH prompt.
        if (turn !== undefined && sending && phase === 'plain' && draft === '') advisorSendStore.markSent(turn);
      }, [turn, sending, phase, draft]);

      if (turn === undefined) return null;
      const result = selectResultForTurn(results, turn);
      if (!result) return null;

      function onSend() {
        advisorSendStore.send({
          turn,
          prompt: buildHandoffPrompt(result),
          inputActions: props.inputActions,
        });
      }

      return h('div', { className: 'cwg-advisor-card', 'data-advisor-turn': String(turn) },
        h('div', { className: 'cwg-advisor-card-head' },
          h('span', { className: 'cwg-advisor-card-title' }, t('advisor.card.title', 'ChatGPT Advisor')),
          h('span', { className: 'cwg-advisor-card-meta' },
            t(result.mode === 'think' ? 'advisor.card.modeThink' : 'advisor.card.modeNormal', result.mode === 'think' ? 'Think' : 'Normal')
            + (result.model ? ` · ${result.model}` : '')
            + (result.preset ? ` · ${result.preset}` : '')
            + (result.recovered ? ` · ${t('advisor.card.recovered', 'recovered')}` : '')),
        ),
        h('pre', { className: 'cwg-advisor-card-body' }, result.text),
        h('div', { className: 'cwg-advisor-card-foot' },
          sent
            ? h('span', { className: 'cwg-advisor-card-status cwg-ok' }, t('advisor.card.sent', 'Sent to DSH as a new prompt.'))
            : sending
              ? h('span', { className: 'cwg-advisor-card-status' }, t('advisor.card.sendingStatus', 'Submitting through the normal DSH prompt flow…'))
              : error
                ? h('span', { className: 'cwg-advisor-card-status cwg-err', role: 'alert' }, t('advisor.card.sendError', 'Send failed — the text remains in the composer; you can retry.'))
                : null,
          !sent && h('button', {
            type: 'button',
            className: 'cwg-btn',
            disabled: sending,
            onClick: onSend,
          }, sending ? t('advisor.card.sending', 'Sending…') : t('advisor.card.send', 'Send to DSH')),
        ),
      );
    }

    function useAdvisorState(store) {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
      return { snapshot, inFlight: store.inFlight };
    }

    /** Composer control: visible only with a reviewable turn; disabled while DSH generates or a review is in flight. */
    function AdvisorReviewButton(t, props) {
      // Two stable-reference selectors (never a fresh object): the selector
      // hooks cache by reference, and order/nodes are stable across snapshots.
      const order = typeof props.useChat === 'function' ? props.useChat((s) => s.order) : undefined;
      const nodes = typeof props.useChat === 'function' ? props.useChat((s) => s.nodes) : undefined;
      const chat = order && nodes ? { order, nodes } : null;
      const running = typeof props.useSession === 'function' ? props.useSession((s) => s.running) : false;
      const { snapshot, inFlight } = useAdvisorState(advisorStore);
      if (!props.sessionId) return null;
      const reviewable = selectReviewableTurn(chat);
      if (!reviewable) return null;
      return h('button', {
        type: 'button',
        className: 'cwg-advisor-btn',
        disabled: !canStartReview({ running, inFlight, reviewable }),
        title: t('advisor.btnHint', 'Review the last completed turn with ChatGPT in a separate Advisor conversation.'),
        'aria-label': t('advisor.btn', 'Review with ChatGPT'),
        onClick: () => advisorStore.openDialog(reviewable, loadLastInstructions(window.localStorage)),
      }, t('advisor.btn', 'Review with ChatGPT'));
    }

    /**
     * The DSH session-projection key carrying the preset a session already runs (`agentPreset`
     * from the agent-preset registry). Read defensively: a deployment without the registry simply
     * answers `null`.
     */
    const SESSION_PRESET_PROJECTION_KEY = 'agentPreset';

    /**
     * Review dialog. It is a real modal: the composer slot it is registered in renders its content
     * inside a zero-height absolutely-positioned anchor at the top of the composer card
     * (`conversation.input.overlay`), so dialog content that stays in flow lands on top of the
     * composer's own editable field and, because the composer sits at the bottom of the viewport,
     * reads as a panel under the text box. The dialog therefore leaves that flow explicitly
     * (`position: fixed` backdrop) and centres itself over the composer.
     */
    function AdvisorReviewDialog(t, props, configForm, presets) {
      const { snapshot, inFlight } = useAdvisorState(advisorStore);
      // The roster store is injected (the plugin's own store, or a test double): the dialog never
      // reads a second, module-global owner for the same state.
      const { snapshot: presetState } = useAdvisorState(presets.store);
      const projection = typeof props.useProjection === 'function' ? props.useProjection(ADVISOR_PROJECTION_KEY) : undefined;
      const sessionPreset = typeof props.useProjection === 'function' ? props.useProjection(SESSION_PRESET_PROJECTION_KEY) : undefined;
      const workspaceItems = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((s) => s.items) : undefined;
      // Transient copy feedback for the recovered answer ('' = nothing to say).
      const [copyState, setCopyState] = React.useState('');

      const open = snapshot.open === true;
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') advisorStore.closeDialog(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      React.useEffect(() => {
        // The roster is deployment state: read it when the dialog opens, never at plugin load.
        if (open) void presets.store.load(presets.read);
      }, [open]);

      if (!snapshot.open || !snapshot.context) return null;

      const project = selectProjectName(workspaceItems, props.sessionId);
      const presetOptions = presetState.options;
      // `null` means "not chosen yet": follow the preset the session runs, else the deployment
      // default. An explicit '' is the user's "no preset" choice and is never overridden.
      const selectedPreset = snapshot.preset === null
        ? defaultAdvisorPreset(presetOptions, sessionPreset)
        : snapshot.preset;
      const presetLabel = advisorPresetLabel(presetOptions, selectedPreset);

      /** Modal keyboard contract: Tab cycles inside the dialog, never into the composer behind it. */
      function onDialogKeyDown(event) {
        if (event.key !== 'Tab') return;
        const host = event.currentTarget;
        if (!host || typeof host.querySelectorAll !== 'function') return;
        const focusable = Array.from(host.querySelectorAll(
          'button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = host.ownerDocument ? host.ownerDocument.activeElement : null;
        const inside = active && host.contains(active);
        if (event.shiftKey && (!inside || active === first)) { event.preventDefault(); last.focus(); return; }
        if (!event.shiftKey && (!inside || active === last)) { event.preventDefault(); first.focus(); }
      }

      function onReview() {
        const base = resolveSidecarBase(configForm);
        const token = projection && typeof projection.controlToken === 'string' ? projection.controlToken : undefined;
        if (!base) { advisorStore.fail(t('advisor.errNoEndpoint', 'The sidecar endpoint is not configured.')); return; }
        if (!token) { advisorStore.fail(t('advisor.errNoToken', 'The sidecar control token is unavailable in this profile.')); return; }
        advisorStore.runReview({
          base,
          token,
          sessionId: props.sessionId,
          project,
          preset: presetLabel,
          storage: window.localStorage,
          fetch: (url, options) => fetch(url, options),
        });
      }

      /** Read the answer ChatGPT already produced; read-only, so it can be retried freely. */
      function onRecover() {
        const base = resolveSidecarBase(configForm);
        const token = projection && typeof projection.controlToken === 'string' ? projection.controlToken : undefined;
        if (!base) { advisorStore.failRecovery(t('advisor.errNoEndpoint', 'The sidecar endpoint is not configured.')); return; }
        if (!token) { advisorStore.failRecovery(t('advisor.errNoToken', 'The sidecar control token is unavailable in this profile.')); return; }
        advisorStore.recover({
          base,
          token,
          sessionId: props.sessionId,
          preset: presetLabel,
          storage: window.localStorage,
          fetch: (url, options) => fetch(url, options),
        });
      }

      /** Copy the recovered answer, falling back to telling the user to select it. */
      function onCopyRecovered() {
        const text = snapshot.recovery.text;
        if (!text) return;
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          setCopyState(t('advisor.result.copyFailed', 'Select the text and copy it manually.'));
          return;
        }
        clipboard.writeText(text).then(
          () => setCopyState(t('advisor.result.copied', 'Copied.')),
          () => setCopyState(t('advisor.result.copyFailed', 'Select the text and copy it manually.')),
        );
      }

      return h('div', {
        className: 'cwg-advisor-backdrop',
        onClick: (event) => {
          // Only a click on the backdrop itself dismisses, and never mid-review: the request is
          // tied to this dialog and cancelling it by an outside click would lose the review.
          if (event.target === event.currentTarget && snapshot.status !== 'loading') advisorStore.closeDialog();
        },
        onKeyDown: onDialogKeyDown,
      },
        h('div', {
          className: 'cwg-advisor-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('advisor.dialog.title', 'Review with ChatGPT'),
          tabIndex: -1,
          ref: (node) => {
            // Move focus into the modal once, on mount, so Escape/Tab act inside it instead of on
            // the composer the dialog covers.
            if (!node || node.dataset.cwgAdvisorFocused === '1') return;
            node.dataset.cwgAdvisorFocused = '1';
            if (typeof node.focus === 'function') node.focus();
          },
        },
          h('style', null, CSS),
          h('div', { className: 'cwg-advisor-head' },
            h('span', { className: 'cwg-advisor-title' }, t('advisor.dialog.title', 'Review with ChatGPT')),
            h('button', {
              type: 'button',
              className: 'cwg-advisor-close',
              'aria-label': t('advisor.dialog.cancel', 'Cancel'),
              disabled: snapshot.status === 'loading',
              onClick: () => advisorStore.closeDialog(),
            }, '\u00d7'),
          ),
          h('div', null,
            h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.mode', 'Model')),
            h('div', { className: 'cwg-advisor-mode' },
              h('button', {
                type: 'button',
                'aria-pressed': String(snapshot.mode === 'normal'),
                disabled: snapshot.status === 'loading',
                onClick: () => advisorStore.setMode('normal'),
              }, t('advisor.dialog.modeNormal', 'Normal')),
              h('button', {
                type: 'button',
                'aria-pressed': String(snapshot.mode === 'think'),
                disabled: snapshot.status === 'loading',
                onClick: () => advisorStore.setMode('think'),
              }, t('advisor.dialog.modeThink', 'Think')),
            ),
          ),
          h('div', null,
            h('label', { className: 'cwg-advisor-section-label', htmlFor: 'cwg-advisor-preset' },
              t('advisor.dialog.preset', 'DSH agent preset')),
            h('select', {
              id: 'cwg-advisor-preset',
              className: 'cwg-advisor-preset',
              value: selectedPreset,
              disabled: snapshot.status === 'loading' || presetState.status === 'loading' || presetOptions.length === 0,
              onChange: (event) => advisorStore.setPreset(event.target.value),
            },
              h('option', { value: '' }, t('advisor.dialog.presetNone', 'No preset')),
              ...presetOptions.map((option) => h('option', {
                key: option.id,
                value: option.id,
                ...(option.description ? { title: option.description } : {}),
              }, option.name)),
            ),
            presetState.status === 'unavailable'
              ? h('div', { className: 'cwg-advisor-context-label' },
                  t('advisor.dialog.presetUnavailable', 'No DSH agent presets are available in this deployment.'))
              : null,
            presetState.status === 'error'
              ? h('div', { className: 'cwg-advisor-recover-actions' },
                  h('span', { className: 'cwg-advisor-error', role: 'alert' },
                    t('advisor.dialog.presetError', 'The DSH agent presets could not be read.'),
                    presetState.error ? ` (${presetState.error})` : ''),
                  h('button', {
                    type: 'button',
                    className: 'cwg-btn cwg-secondary',
                    disabled: snapshot.status === 'loading',
                    onClick: () => { void presets.store.load(presets.read); },
                  }, t('advisor.dialog.presetRetry', 'Retry')),
                )
              : null,
          ),
          h('div', null,
            h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.instructions', 'Review instructions')),
            h('textarea', {
              className: 'cwg-advisor-instructions',
              value: snapshot.instructions,
              disabled: snapshot.status === 'loading',
              onChange: (event) => advisorStore.setInstructions(event.target.value),
            }),
          ),
          h('div', null,
            h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.context', 'Context (read-only)')),
            h('div', { className: 'cwg-advisor-context' },
              h('div', null,
                h('div', { className: 'cwg-advisor-context-label' }, t('advisor.dialog.humanRequest', 'Last human request')),
                h('pre', null, snapshot.context.humanRequest),
              ),
              h('div', null,
                h('div', { className: 'cwg-advisor-context-label' }, t('advisor.dialog.dshResponse', 'Last DSH response')),
                h('pre', null, snapshot.context.dshResponse),
              ),
            ),
          ),
          snapshot.status === 'error' && snapshot.error
            ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
                t('advisor.dialog.error', 'The review failed. You can retry.'),
                snapshot.error !== 'cancelled' ? ` (${snapshot.error})` : '',
              )
            : null,
          // A failed turn is not a lost answer: ChatGPT usually finished it in the retained
          // conversation, and the recovery reads it back without sending anything (issue #214).
          snapshot.status === 'error' && snapshot.recovery.status !== 'ready'
            ? h('div', { className: 'cwg-advisor-recover' },
                h('div', { className: 'cwg-advisor-recover-actions' },
                  h('button', {
                    type: 'button',
                    className: 'cwg-btn cwg-secondary',
                    title: t('advisor.recover.hint', 'Read the answer ChatGPT already produced in this Advisor conversation. Nothing is sent.'),
                    disabled: snapshot.recovery.status === 'loading' || inFlight,
                    onClick: onRecover,
                  }, snapshot.recovery.status === 'loading'
                    ? t('advisor.recover.loading', 'Reading the answer from ChatGPT')
                    : t('advisor.recover.action', 'Recover answer from ChatGPT')),
                ),
                snapshot.recovery.status === 'error' && snapshot.recovery.error
                  ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
                      t('advisor.recover.failed', 'The answer could not be read.'),
                      ` (${snapshot.recovery.error})`)
                  : null,
              )
            : null,
          snapshot.recovery.status === 'ready' && snapshot.recovery.text
            ? h('div', { className: 'cwg-advisor-result' },
                h('div', { className: 'cwg-advisor-section-label' }, t('advisor.result.title', 'Recovered review')),
                h('textarea', {
                  className: 'cwg-advisor-result-body',
                  readOnly: true,
                  spellCheck: false,
                  value: snapshot.recovery.text,
                  'aria-label': t('advisor.result.title', 'Recovered review'),
                  onFocus: (event) => { if (typeof event.target.select === 'function') event.target.select(); },
                }),
                h('div', { className: 'cwg-advisor-result-note' },
                  t('advisor.result.recorded', 'Recorded for this turn: it also appears in the turn card and can be sent to DSH.')),
                h('div', { className: 'cwg-advisor-recover-actions' },
                  h('button', {
                    type: 'button',
                    className: 'cwg-btn cwg-secondary',
                    onClick: onCopyRecovered,
                  }, t('advisor.result.copy', 'Copy')),
                  copyState ? h('span', { className: 'cwg-advisor-context-label' }, copyState) : null,
                ),
              )
            : null,
          h('div', { className: 'cwg-advisor-foot' },
            h('button', {
              type: 'button',
              className: 'cwg-btn cwg-secondary',
              disabled: snapshot.status === 'loading',
              onClick: () => advisorStore.closeDialog(),
            }, t('advisor.dialog.cancel', 'Cancel')),
            h('button', {
              type: 'button',
              className: 'cwg-btn',
              disabled: snapshot.status === 'loading' || inFlight,
              onClick: onReview,
            }, snapshot.status === 'loading' ? t('advisor.dialog.reviewing', 'Reviewing\u2026') : t('advisor.dialog.review', 'Review')),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { en: DICT_EN });
          } catch {
            return () => {};
          }
        }, 'dsh-chatgpt-web: dictionaries');

        let translate;
        try {
          translate = ctx.locale.bind(NS);
        } catch {
          translate = undefined;
        }
        const t = makeT(translate);
        const configForm = ctx.configForms.get(CONFIG_ID);

        // Three slot seats, all owned by this plugin's context: the bundle
        // configuration page (DSH 0.2's canonical plugin settings seat — the
        // Host owns schema/defaults/persistence, this page only edits the
        // volatile Config fields through configForms), and the two Advisor
        // seats (issue #179): the composer control in conversation.input.right
        // and the review dialog in conversation.input.overlay (inside the
        // resident composer card, per-session scope like message-feedback).
        const disposers = [];
        disposers.push(ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE_CONFIG_KEY,
          locale: NS,
        }, (props) => props && props.view === 'page' ? ChatGptWebSettings(t, configForm) : null)));
        disposers.push(ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-chatgpt-web-advisor-review',
          locale: NS,
        }, (props) => AdvisorReviewButton(t, props))));
        disposers.push(ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-chatgpt-web-advisor-dialog',
          order: 2,
          locale: NS,
        }, (props) => AdvisorReviewDialog(t, props, configForm, {
          store: advisorPresetStore,
          // Read through the typed client gateway; never a plugin-local registry.
          read: () => loadAdvisorPresetOptions(ctx.remote),
        }))));
        // Issue #180: the Advisor result card in the per-turn tail slot
        // (session-scoped list; entries without content return null).
        disposers.push(ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-chatgpt-web-advisor-card',
          order: 1,
          locale: NS,
        }, (props) => AdvisorResultCard(t, props))));
        return () => {
          for (const dispose of disposers) {
            try { dispose(); } catch { /* a seat may already be collapsed */ }
          }
        };
      },
      __test: {
        ADVISOR_PROJECTION_KEY,
        LAST_INSTRUCTIONS_KEY,
        DEFAULT_INSTRUCTIONS,
        selectReviewableTurn,
        canStartReview,
        selectProjectName,
        buildAdvisorFetch,
        buildAdvisorRecoverFetch,
        loadLastInstructions,
        saveLastInstructions,
        createAdvisorStore,
        RESULTS_KEY,
        parseAdvisorResults,
        loadAdvisorResults,
        saveAdvisorResults,
        recordAdvisorResult,
        selectResultForTurn,
        buildHandoffPrompt,
        createSendStore,
        AdvisorReviewButton,
        AdvisorResultCard,
        AdvisorReviewDialog,
        SESSION_PRESET_PROJECTION_KEY,
        ADVISOR_CSS: CSS,
        createAdvisorPresetStore,
        advisorPresetOptions,
        defaultAdvisorPreset,
        advisorPresetLabel,
        loadAdvisorPresetOptions,
      },
    };
  },
});
