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
      'tuning.turnTimeoutMs': 'Turn timeout (ms)',
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
      .cwg-advisor-dialog { display: flex; flex-direction: column; gap: 12px; width: min(560px, 100%); padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 8px 28px rgb(0 0 0 / .18); box-sizing: border-box; }
      .cwg-advisor-dialog *, .cwg-advisor-dialog *::before, .cwg-advisor-dialog *::after { box-sizing: border-box; }
      .cwg-advisor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .cwg-advisor-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cwg-advisor-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
      .cwg-advisor-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
      .cwg-advisor-section-label { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
      .cwg-advisor-mode { display: flex; gap: 6px; }
      .cwg-advisor-mode button { flex: 1; font-size: 13px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
      .cwg-advisor-mode button[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
      .cwg-advisor-instructions { width: 100%; min-height: 72px; resize: vertical; font-size: 13px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
      .cwg-advisor-instructions:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-context { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto; }
      .cwg-advisor-context-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
      .cwg-advisor-context pre { margin: 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 8px; }
      .cwg-advisor-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
      .cwg-advisor-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
      .cwg-advisor-foot .cwg-err-msg { margin-right: auto; }
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

    /** Plain-text of a `user` chat node (all text-bearing content blocks). */
    function userNodeText(node) {
      if (!node || !Array.isArray(node.content)) return '';
      return node.content
        .filter((block) => block && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /** Plain-text of a finalized `assistant` chat node (text blocks only). */
    function assistantNodeText(node) {
      if (!node || !Array.isArray(node.blocks)) return '';
      return node.blocks
        .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * The last completed, reviewable turn of the chat: the latest human
     * request and the latest FINAL assistant response after it. Returns null
     * while nothing reviewable exists (no turn yet, empty content, or the
     * response was interrupted).
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
          if (text) user = { seq: node.seq, text };
        }
        if (!assistant && node.kind === 'assistant' && node.interrupted !== true) {
          const text = assistantNodeText(node);
          if (text) assistant = { seq: node.seq, text };
        }
        if (user && assistant) break;
      }
      if (!user || !assistant || !(user.seq < assistant.seq)) return null;
      return { humanRequest: user.text, dshResponse: assistant.text, turn: assistant.seq };
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
    function buildAdvisorFetch({ base, token, sessionId, humanRequest, dshResponse, instructions, mode, project, signal }) {
      const body = { sessionId, humanRequest, dshResponse, instructions, mode };
      if (project) body.project = project;
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
      let state = { open: false, mode: 'normal', instructions: DEFAULT_INSTRUCTIONS, context: null, status: 'idle', error: null };
      let inFlight = false;
      let abortController = null;
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors never break the store */ } } };
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        get inFlight() { return inFlight; },
        openDialog(context, instructions) {
          state = { ...state, open: true, status: 'idle', error: null, context, instructions: typeof instructions === 'string' && instructions.trim() ? instructions : DEFAULT_INSTRUCTIONS };
          notify();
        },
        closeDialog() {
          if (abortController) { try { abortController.abort(); } catch { /* already settled */ } }
          state = { ...state, open: false, status: 'idle', error: null };
          notify();
        },
        setMode(mode) { state = { ...state, mode: mode === 'think' ? 'think' : 'normal' }; notify(); },
        setInstructions(text) { state = { ...state, instructions: typeof text === 'string' ? text : '' }; notify(); },
        fail(message) { state = { ...state, status: 'error', error: message }; notify(); },
        runReview(env) {
          if (inFlight || !state.open || !state.context) return;
          inFlight = true;
          const controller = new AbortController();
          abortController = controller;
          state = { ...state, status: 'loading', error: null };
          notify();
          const finish = () => { inFlight = false; abortController = null; };
          const { url, options } = buildAdvisorFetch({
            base: env.base,
            token: env.token,
            sessionId: env.sessionId,
            humanRequest: state.context.humanRequest,
            dshResponse: state.context.dshResponse,
            instructions: state.instructions,
            mode: state.mode,
            project: env.project,
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
                // The result card (#180) and the handoff to the main chat are
                // separate issues: a successful review closes the dialog.
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
      };
    }

    const advisorStore = createAdvisorStore();

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

    /** Review dialog rendered inside the resident composer card. */
    function AdvisorReviewDialog(t, props, configForm) {
      const { snapshot, inFlight } = useAdvisorState(advisorStore);
      const projection = typeof props.useProjection === 'function' ? props.useProjection(ADVISOR_PROJECTION_KEY) : undefined;
      const workspaceItems = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((s) => s.items) : undefined;

      React.useEffect(() => {
        if (!snapshot.open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') advisorStore.closeDialog(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [snapshot.open]);

      if (!snapshot.open || !snapshot.context) return null;

      const project = selectProjectName(workspaceItems, props.sessionId);

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
          storage: window.localStorage,
          fetch: (url, options) => fetch(url, options),
        });
      }

      return h('div', { className: 'cwg-advisor-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('advisor.dialog.title', 'Review with ChatGPT') },
        h('style', null, CSS),
        h('div', { className: 'cwg-advisor-head' },
          h('span', { className: 'cwg-advisor-title' }, t('advisor.dialog.title', 'Review with ChatGPT')),
          h('button', {
            type: 'button',
            className: 'cwg-advisor-close',
            'aria-label': t('advisor.dialog.cancel', 'Cancel'),
            disabled: snapshot.status === 'loading',
            onClick: () => advisorStore.closeDialog(),
          }, '×'),
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
          }, snapshot.status === 'loading' ? t('advisor.dialog.reviewing', 'Reviewing…') : t('advisor.dialog.review', 'Review')),
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
        }, (props) => AdvisorReviewDialog(t, props, configForm))));
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
        loadLastInstructions,
        saveLastInstructions,
        createAdvisorStore,
      },
    };
  },
});
