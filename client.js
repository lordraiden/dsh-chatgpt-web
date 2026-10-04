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

        // DSH 0.2's canonical plugin configuration seat is the bundle detail page.
        // The Host owns schema/defaults/persistence; this page only edits the plugin's
        // volatile Config fields through configForms. No parallel settings namespace or
        // browser-local persistence is created here.
        return ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE_CONFIG_KEY,
          locale: NS,
        }, (props) => props && props.view === 'page' ? ChatGptWebSettings(t, configForm) : null));
      },
    };
  },
});
