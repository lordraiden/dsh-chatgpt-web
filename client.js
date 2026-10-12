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
      'advisor.recover.action': 'Recover retained answer',
      'advisor.recover.loading': 'Reading the retained answer',
      'advisor.recover.hint': 'Read the answer the provider already produced in this Advisor conversation. Nothing is sent.',
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
      'advisor.btn': 'Review with Advisor',
      'advisor.btnHint': 'Review the last completed turn with the selected WebChat model in a separate Advisor conversation.',
      'advisor.btnBusy': 'Advisor review running…',
      'advisor.activity.open': 'Advisor activity',
      'advisor.activity.title': 'Advisor activity',
      'advisor.activity.empty': 'No Advisor reviews yet.',
      'advisor.activity.close': 'Close',
      'advisor.activity.openResult': 'Open result',
      'advisor.activity.newReview': 'Start a new review',
      'advisor.activity.thisSession': 'this session',
      'advisor.state.queued': 'queued',
      'advisor.state.running': 'running',
      'advisor.state.completed': 'completed',
      'advisor.state.failed': 'failed',
      'advisor.state.interrupted': 'interrupted',
      'advisor.state.unavailable': 'unavailable',
      'advisor.dialog.title': 'Review with Advisor',
      'advisor.dialog.model': 'Model',
      'advisor.dialog.modelLoading': 'Loading available models…',
      'advisor.dialog.modelNone': 'No supported authenticated WebChat model is available.',
      'advisor.dialog.modelFailed': 'The available models could not be loaded.',
      'advisor.dialog.modelRetry': 'Retry',
      'advisor.dialog.modelUnavailable': 'This selection is no longer available. Choose an eligible model.',
      'advisor.dialog.modelUnavailableShort': 'unavailable',
      'advisor.dialog.include': 'Include in the review',
      'advisor.dialog.includeRequest': 'Human request',
      'advisor.dialog.includeResponse': 'DSH response',
      'advisor.dialog.includeProject': 'Project name',
      'advisor.dialog.noSource': 'Select at least one source to review.',
      'advisor.dialog.instructions': 'Review instructions',
      'advisor.dialog.context': 'Context (read-only)',
      'advisor.dialog.humanRequest': 'Last human request',
      'advisor.dialog.dshResponse': 'Last DSH response',
      'advisor.dialog.cancel': 'Cancel',
      'advisor.dialog.review': 'Start review',
      'advisor.dialog.starting': 'Starting…',
      'advisor.dialog.error': 'The review could not be started.',
      'advisor.task.title': 'Advisor review',
      'advisor.errNoEndpoint': 'The sidecar endpoint is not configured.',
      'advisor.errNoToken': 'The sidecar control token is unavailable in this profile.',
      'advisor.card.title': 'Advisor',
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
      .cwg-advisor-model { width: 100%; font-size: 13px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .cwg-advisor-model:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cwg-advisor-includes { display: flex; flex-wrap: wrap; gap: 10px; }
      .cwg-advisor-includes label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); }
      .cwg-advisor-includes input[type="checkbox"] { accent-color: var(--dsw-alias-brand-primary); }
      .cwg-advisor-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
      .cwg-advisor-activity { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; }
      .cwg-advisor-activity-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
      .cwg-advisor-activity-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .cwg-advisor-activity-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cwg-advisor-activity-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cwg-advisor-activity-state { font-size: 11px; font-weight: 600; margin-left: auto; }
      .cwg-advisor-activity-state.cwg-ok { color: var(--dsw-alias-state-success-primary); }
      .cwg-advisor-activity-state.cwg-err { color: var(--dsw-alias-state-error-primary); }
      .cwg-advisor-activity-body { margin: 0; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; color: var(--dsw-alias-label-primary); }
      .cwg-advisor-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .cwg-advisor-busy { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .cwg-advisor-review { display: flex; flex-direction: column; gap: 12px; }
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
    // Advisor (issue #224): composer control + review dialog + tracked activity.
    //
    // The Advisor is provider-neutral. The dialog fills its single model dropdown
    // from GET /v1/control/advisor/models, starts a tracked background task with
    // POST /v1/control/advisor/reviews, and observes that task by its reviewId;
    // closing the dialog never cancels a task. The control token arrives through
    // the official session-projection channel
    // (`useProjection('dsh-chatgpt-web:sidecar')`), the port through the live
    // plugin config form, and the review context through the Chat snapshot
    // selector hooks — no parallel state machinery.
    // ─────────────────────────────────────────────────────────────────────────
    const ADVISOR_PROJECTION_KEY = 'dsh-chatgpt-web:sidecar';
    const LAST_INSTRUCTIONS_KEY = 'dsh-chatgpt-web.advisor.lastInstructions';
    const LAST_SELECTION_KEY = 'dsh-chatgpt-web.advisor.lastSelection';
    const ACTIVITY_KEY = 'dsh-chatgpt-web.advisor.activity';
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
      // The reviewed turn identity the sidecar freezes on the task: the DSH turn
      // number when the target exposes one, otherwise the node's render anchor.
      const reviewedTurnId = dshTurn !== undefined ? `dsh-turn:${dshTurn}` : `anchor:${assistant.anchorSeq}`;
      return { humanRequest: user.text, dshResponse: assistant.text, turn: assistant.anchorSeq, dshTurn, reviewedTurnId };
    }

    /** The composer control needs a reviewable turn and no running generation. */
    function canStartReview({ running, reviewable }) {
      return Boolean(reviewable) && running !== true;
    }

    /** Whether the dialogue has at least one substantive selected source. */
    function hasSelectedSource(context, include) {
      if (!context) return false;
      if (include.request !== false && Boolean(context.humanRequest)) return true;
      if (include.response !== false && Boolean(context.dshResponse)) return true;
      return include.project !== false && Boolean(context.project);
    }

    /** Workspace basename for the optional `project` field (never a path). */
    function selectProjectName(items, sessionId) {
      if (!Array.isArray(items) || !sessionId) return undefined;
      const item = items.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId));
      if (!item || typeof item.path !== 'string') return undefined;
      const segments = item.path.split(/[\\/]+/).filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : undefined;
    }

    /**
     * One eligible choice from the catalogue response, or null when malformed.
     *
     * The provider-qualified identity is mandatory: a choice whose provider or provider-local model
     * is unknown cannot be displayed or submitted, and inventing one is exactly what the dynamic
     * catalogue exists to prevent.
     */
    function advisorChoice(value) {
      if (!value || typeof value !== 'object') return null;
      if (typeof value.route !== 'string' || !value.route.trim()) return null;
      if (typeof value.providerId !== 'string' || !value.providerId.trim()) return null;
      if (typeof value.modelId !== 'string' || !value.modelId.trim()) return null;
      return {
        route: value.route,
        providerId: value.providerId,
        providerLabel: typeof value.providerLabel === 'string' ? value.providerLabel : '',
        modelId: value.modelId,
        modelLabel: typeof value.modelLabel === 'string' ? value.modelLabel : '',
        label: typeof value.label === 'string' && value.label ? value.label : value.route,
        reasoningModes: Array.isArray(value.reasoningModes) ? value.reasoningModes.filter((m) => typeof m === 'string') : [],
      };
    }

    /** Pure request builder for the eligible-model catalogue (testable without fetch). */
    function buildAdvisorModelsFetch({ base, token, signal }) {
      return {
        url: `${base}/v1/control/advisor/models`,
        options: {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        },
      };
    }

    /**
     * Pure request builder for the tracked start endpoint (testable without fetch).
     *
     * The already-selected public route and the explicit inclusion choices travel with the captured
     * source; the request carries no mode and no provider-specific assumption.
     */
    function buildAdvisorStartFetch({ base, token, sessionId, reviewedTurnId, humanRequest, dshResponse, instructions, route, reasoningMode, project, include, signal }) {
      const body = { sessionId, reviewedTurnId, route, instructions };
      if (typeof humanRequest === 'string') body.humanRequest = humanRequest;
      if (typeof dshResponse === 'string') body.dshResponse = dshResponse;
      if (project) body.project = project;
      if (reasoningMode) body.reasoningMode = reasoningMode;
      if (include) {
        body.includeRequest = include.request !== false;
        body.includeResponse = include.response !== false;
        body.includeProject = include.project !== false;
      }
      return {
        url: `${base}/v1/control/advisor/reviews`,
        options: {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      };
    }

    /** Pure request builder for one tracked review status (testable without fetch). */
    function buildAdvisorStatusFetch({ base, token, reviewId, signal }) {
      return {
        url: `${base}/v1/control/advisor/reviews/${encodeURIComponent(reviewId)}`,
        options: {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        },
      };
    }

    /** Pure request builder for the tracked review list (testable without fetch). */
    function buildAdvisorListFetch({ base, token, sessionId, limit, signal }) {
      const query = [];
      if (sessionId) query.push(`sessionId=${encodeURIComponent(sessionId)}`);
      if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) query.push(`limit=${Math.trunc(limit)}`);
      return {
        url: `${base}/v1/control/advisor/reviews${query.length ? `?${query.join('&')}` : ''}`,
        options: {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        },
      };
    }

    /**
     * Pure request builder for the #214 recovery endpoint (testable without fetch). A recovery is
     * read-only: it names the session whose retained Advisor conversation is read and, when one is
     * displayed, the public route that conversation belongs to.
     */
    function buildAdvisorRecoverFetch({ base, token, sessionId, route, timeoutMs, signal }) {
      const body = { sessionId };
      if (route) body.route = route;
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

    /** The last successfully used public route, when one was recorded. */
    function loadLastSelection(storage) {
      try {
        const value = storage ? storage.getItem(LAST_SELECTION_KEY) : null;
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
      } catch {
        return undefined;
      }
    }

    function saveLastSelection(storage, route) {
      try {
        if (storage && typeof route === 'string' && route.trim()) storage.setItem(LAST_SELECTION_KEY, route.trim());
      } catch {
        // Browser storage may be unavailable; the preference is best-effort.
      }
    }

    /**
     * Shared Advisor state, module-scoped so the button slot and the overlay
     * slot (two distinct slot entries) drive one panel. Plain listeners — the
     * framework drives both components to re-render on change.
     *
     * An accepted review is a tracked task: the start call returns its reviewId
     * promptly, the dialog closes by default, and the task keeps running while
     * only its identity/display metadata is kept here (persisted by the caller).
     * Closing the dialog never cancels a task.
     */
    function createAdvisorStore() {
      let state = {
        open: false,
        view: 'review',
        instructions: DEFAULT_INSTRUCTIONS,
        context: null,
        include: { request: true, response: true, project: true },
        models: { status: 'idle', choices: [], error: null },
        selection: null,
        start: { status: 'idle', error: null },
        activity: { status: 'idle', reviews: [], error: null },
        recovery: { status: 'idle', text: '', error: null },
      };
      let inFlight = false;
      let abortController = null;
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* listener errors never break the store */ } } };
      const setState = (patch) => { state = { ...state, ...patch }; notify(); };

      /**
       * Apply one catalogue response. The FIRST load picks the initial selection
       * (the last successfully used route when it is still eligible, otherwise the
       * deterministic first eligible choice). A later load never silently replaces
       * a displayed selection: a choice that became unavailable stays displayed as
       * unavailable until the user selects an eligible one.
       */
      const applyModels = (choices, preferredRoute, options) => {
        let selection = state.selection;
        if (!selection || (options && options.reset === true)) {
          const preferred = typeof preferredRoute === 'string' ? choices.find((c) => c.route === preferredRoute) : undefined;
          selection = preferred || choices[0] || null;
        }
        setState({ models: { status: 'ready', choices, error: null }, selection });
      };

      /** Load the eligible model catalogue; failure is explicit and retryable. */
      const loadModels = (env) => {
        if (inFlight || !env || !env.base || !env.token) return;
        inFlight = true;
        const controller = new AbortController();
        abortController = controller;
        setState({ models: { status: 'loading', choices: state.models.choices, error: null } });
        const finish = () => { inFlight = false; abortController = null; notify(); };
        const { url, options } = buildAdvisorModelsFetch({ base: env.base, token: env.token, signal: controller.signal });
        env.fetch(url, options)
          .then(async (res) => {
            let data = null;
            try { data = await res.json(); } catch { /* non-JSON body */ }
            if (!res.ok || !data || data.ok !== true) {
              const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
              setState({ models: { status: 'error', choices: [], error: message } });
              return;
            }
            const choices = Array.isArray(data.choices) ? data.choices.map(advisorChoice).filter(Boolean) : [];
            applyModels(choices, env.lastRoute);
          })
          .catch((error) => {
            setState({ models: { status: 'error', choices: [], error: error instanceof Error ? error.message : String(error) } });
          })
          .finally(finish);
      };

      /**
       * Accept one review as a tracked background task. The selected route and
       * everything included are frozen by the sidecar; this only records the
       * returned task identity so the activity view can reopen it.
       */
      const startReview = (env) => {
        const context = state.context;
        const selection = state.selection;
        if (inFlight || !context || !selection || !env || !env.base || !env.token) return;
        inFlight = true;
        const controller = new AbortController();
        abortController = controller;
        setState({ start: { status: 'starting', error: null } });
        const finish = () => { inFlight = false; abortController = null; notify(); };
        // A selection that became unavailable is never silently substituted: the catalogue is
        // refreshed and the user must choose an eligible model explicitly.
        let reloadCatalogue = false;
        const { url, options } = buildAdvisorStartFetch({
          base: env.base,
          token: env.token,
          sessionId: env.sessionId,
          reviewedTurnId: context.reviewedTurnId,
          humanRequest: context.humanRequest,
          dshResponse: context.dshResponse,
          instructions: state.instructions,
          route: selection.route,
          reasoningMode: Array.isArray(selection.reasoningModes) && selection.reasoningModes.length === 1 ? selection.reasoningModes[0] : undefined,
          project: env.project,
          include: state.include,
          signal: controller.signal,
        });
        env.fetch(url, options)
          .then(async (res) => {
            let data = null;
            try { data = await res.json(); } catch { /* non-JSON body */ }
            if (!res.ok || !data || data.ok !== true || !data.task) {
              const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
              reloadCatalogue = Boolean(data && data.code === 'advisor_model_unavailable');
              setState({ start: { status: 'error', error: message } });
              return;
            }
            saveLastInstructions(env.storage, state.instructions);
            saveLastSelection(env.storage, selection.route);
            upsertAdvisorActivity(env.storage, advisorTaskEntry(data.task, { dshTurn: context.dshTurn }));
            // Accepted: close the dialog and return focus to DSH. The tracked
            // status entry keeps the review reachable; nothing is cancelled here.
            setState({
              open: false,
              view: 'review',
              start: { status: 'idle', error: null },
              activity: { status: 'ready', reviews: loadAdvisorActivity(env.storage), error: null },
            });
          })
          .catch((error) => {
            const aborted = error && (error.name === 'AbortError' || error.code === 20);
            if (aborted && !state.open) {
              // The dialog closed while the start request was still in flight: the
              // rejection is that cancellation, not a product failure.
              setState({ start: { status: 'idle', error: null } });
              return;
            }
            setState({ start: { status: 'error', error: aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)) } });
          })
          .finally(() => { finish(); if (reloadCatalogue) loadModels(env); });
      };

      /**
       * Reconcile the tracked activity with the sidecar, then persist it.
       *
       * The sidecar is authoritative for the tasks it still knows; a persisted
       * task it no longer knows is shown as unavailable rather than as running.
       * Completed results stay associated with their originating session/turn.
       */
      const refreshActivity = (env) => {
        if (!env || !env.base || !env.token) return;
        const controller = new AbortController();
        // A re-entrant poll must not re-render on a status it already shows.
        if (state.activity.status !== 'loading') {
          setState({ activity: { status: 'loading', reviews: state.activity.reviews, error: null } });
        }
        const { url, options } = buildAdvisorListFetch({ base: env.base, token: env.token, limit: 50, signal: controller.signal });
        env.fetch(url, options)
          .then(async (res) => {
            let data = null;
            try { data = await res.json(); } catch { /* non-JSON body */ }
            if (!res.ok || !data || data.ok !== true || !Array.isArray(data.reviews)) {
              const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
              setState({ activity: { status: 'error', reviews: state.activity.reviews, error: message } });
              return;
            }
            const merged = reconcileAdvisorActivity(loadAdvisorActivity(env.storage), data.reviews);
            saveAdvisorActivity(env.storage, merged);
            recordAdvisorResultsForActivity(env.storage, merged, env.sessionId);
            setState({ activity: { status: 'ready', reviews: merged, error: null } });
          })
          .catch((error) => {
            setState({ activity: { status: 'error', reviews: state.activity.reviews, error: error instanceof Error ? error.message : String(error) } });
          });
      };

      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        get inFlight() { return inFlight; },
        /** Show only what browser storage already knows, before the sidecar answers. */
        hydrateActivity(storage) {
          // Re-running with the same storage is a no-op, so a host that re-runs a mount effect never
          // spins on an unchanged activity list.
          const stored = loadAdvisorActivity(storage);
          if (JSON.stringify(stored) === JSON.stringify(state.activity.reviews)) return;
          setState({ activity: { status: state.activity.status, reviews: stored, error: state.activity.error } });
        },
        openReview(context, instructions) {
          setState({
            open: true,
            view: 'review',
            start: { status: 'idle', error: null },
            recovery: { status: 'idle', text: '', error: null },
            // A new dialog starts from the captured turn with both text sources selected.
            include: { request: true, response: true, project: true },
            context,
            instructions: typeof instructions === 'string' && instructions.trim() ? instructions : DEFAULT_INSTRUCTIONS,
          });
        },
        openActivity() {
          setState({ open: true, view: 'activity' });
        },
        setView(view) {
          setState({ view: view === 'activity' ? 'activity' : 'review' });
        },
        closeDialog() {
          if (abortController) { try { abortController.abort(); } catch { /* already settled */ } }
          inFlight = false;
          abortController = null;
          // Closing is a UI act: an accepted review keeps running and stays
          // reachable from the activity entry.
          setState({ open: false, view: 'review', start: { status: 'idle', error: null }, recovery: { status: 'idle', text: '', error: null } });
        },
        /** Clear a previous recovered answer (a new review or a new recovery starts clean). */
        clearRecovery() { setState({ recovery: { status: 'idle', text: '', error: null } }); },
        /** Fail the recovery itself without replacing the review error beside it. */
        failRecovery(message) {
          setState({ recovery: { status: 'error', text: '', error: typeof message === 'string' ? message : String(message) } });
        },
        setInstructions(text) { setState({ instructions: typeof text === 'string' ? text : '' }); },
        setInclude(field, value) {
          const key = field === 'request' || field === 'response' || field === 'project' ? field : null;
          if (!key) return;
          setState({ include: { ...state.include, [key]: value !== false } });
        },
        /** Explicit user selection: it is authoritative until the user changes it. */
        setSelection(route) {
          const choice = state.models.choices.find((c) => c.route === route);
          if (!choice) return;
          setState({ selection: choice });
        },
        fail(message) { setState({ start: { status: 'error', error: message } }); },
        applyModels,
        loadModels,
        startReview,
        refreshActivity,
        /**
         * Read the finalized answer of this session's retained Advisor conversation
         * (issue #214). Read-only: it never submits, so it can be retried freely, and
         * a successful read is recorded exactly like a produced review.
         *
         * The route of a tracked failure is used when the caller names one (a failed
         * review whose model was not the one currently displayed); otherwise the
         * displayed selection decides.
         */
        recover(env) {
          if (inFlight || !env || !env.base || !env.token) return;
          inFlight = true;
          const controller = new AbortController();
          abortController = controller;
          setState({ recovery: { status: 'loading', text: '', error: null } });
          const finish = () => { inFlight = false; abortController = null; notify(); };
          const route = typeof env.route === 'string' && env.route
            ? env.route
            : (state.selection ? state.selection.route : undefined);
          const { url, options } = buildAdvisorRecoverFetch({
            base: env.base,
            token: env.token,
            sessionId: env.sessionId,
            route,
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
                setState({ recovery: { status: 'error', text: '', error: message } });
                return;
              }
              const context = state.context;
              if (context && typeof context.dshTurn === 'number') {
                recordAdvisorResult(env.storage, {
                  turn: context.dshTurn,
                  reviewId: typeof data.reviewId === 'string' ? data.reviewId : '',
                  route: typeof data.route === 'string' ? data.route : '',
                  providerLabel: typeof data.providerLabel === 'string' ? data.providerLabel : '',
                  modelLabel: typeof data.modelLabel === 'string' ? data.modelLabel : '',
                  recovered: true,
                  text,
                });
              }
              setState({ recovery: { status: 'ready', text, error: null } });
            })
            .catch((error) => {
              const aborted = error && (error.name === 'AbortError' || error.code === 20);
              setState({
                recovery: aborted
                  ? { status: 'idle', text: '', error: null }
                  : { status: 'error', text: '', error: error instanceof Error ? error.message : String(error) },
              });
            })
            .finally(finish);
        },
      };
    }

    const advisorStore = createAdvisorStore();

    // ─────────────────────────────────────────────────────────────────────────
    // Advisor result card + "Send to DSH" handoff (issue #180).
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
          // Provenance of the provider/model the review ran with (issue #224). It
          // replaces the retired Normal/Think pair: the card shows the recorded
          // provider-qualified identity instead of a hardcoded mode.
          route: typeof entry.route === 'string' ? entry.route : '',
          providerLabel: typeof entry.providerLabel === 'string' ? entry.providerLabel : '',
          modelLabel: typeof entry.modelLabel === 'string' ? entry.modelLabel : '',
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
        route: typeof result.route === 'string' ? result.route : '',
        providerLabel: typeof result.providerLabel === 'string' ? result.providerLabel : '',
        modelLabel: typeof result.modelLabel === 'string' ? result.modelLabel : '',
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

    // ─────────────────────────────────────────────────────────────────────────
    // Tracked Advisor activity (issue #224).
    //
    // The client persists task identity/display metadata so observation resumes
    // after the dialog closes, a remount, a session switch or a browser refresh,
    // while the task itself stays owned by the sidecar process. The sidecar is
    // authoritative for the status of the tasks it still knows; a persisted task
    // it no longer knows is shown as unavailable, never as still running.
    // ─────────────────────────────────────────────────────────────────────────
    const TASK_STATES = ['queued', 'running', 'completed', 'failed', 'interrupted'];
    const ADVISOR_TASK_UNAVAILABLE_STATE = 'unavailable';

    /** One task entry from the sidecar's task record (or from storage). */
    function advisorTaskEntry(task, extra) {
      if (!task || typeof task !== 'object') return null;
      if (typeof task.reviewId !== 'string' || !task.reviewId) return null;
      const provenance = task.provenance && typeof task.provenance === 'object' ? task.provenance : {};
      const providerLabel = typeof provenance.providerLabel === 'string' ? provenance.providerLabel : '';
      const modelLabel = typeof provenance.modelLabel === 'string' ? provenance.modelLabel : '';
      const failure = task.failure && typeof task.failure === 'object' ? task.failure : null;
      return {
        reviewId: task.reviewId,
        sessionId: typeof task.sessionId === 'string' ? task.sessionId : '',
        reviewedTurnId: typeof task.reviewedTurnId === 'string' ? task.reviewedTurnId : '',
        state: TASK_STATES.includes(task.state) ? task.state : 'failed',
        route: typeof provenance.route === 'string' ? provenance.route : '',
        providerId: typeof provenance.providerId === 'string' ? provenance.providerId : '',
        providerLabel,
        modelLabel,
        label: [providerLabel, modelLabel].filter(Boolean).join(' \u2014 ') || (typeof provenance.route === 'string' ? provenance.route : ''),
        instructions: task.source && typeof task.source.instructions === 'string' ? task.source.instructions : '',
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
        completedAt: typeof task.completedAt === 'number' ? task.completedAt : undefined,
        text: typeof task.text === 'string' ? task.text : '',
        capturedAt: typeof task.capturedAt === 'number' ? task.capturedAt : undefined,
        failure: failure && typeof failure.message === 'string'
          ? { code: typeof failure.code === 'string' ? failure.code : '', message: failure.message }
          : null,
        dshTurn: extra && typeof extra.dshTurn === 'number' ? extra.dshTurn : undefined,
      };
    }

    /** Validate persisted activity JSON into normalized entries; never throws. */
    function parseAdvisorActivity(raw) {
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
        if (typeof entry.reviewId !== 'string' || !entry.reviewId) continue;
        out.push({
          reviewId: entry.reviewId,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          reviewedTurnId: typeof entry.reviewedTurnId === 'string' ? entry.reviewedTurnId : '',
          state: TASK_STATES.includes(entry.state) ? entry.state : ADVISOR_TASK_UNAVAILABLE_STATE,
          route: typeof entry.route === 'string' ? entry.route : '',
          providerId: typeof entry.providerId === 'string' ? entry.providerId : '',
          providerLabel: typeof entry.providerLabel === 'string' ? entry.providerLabel : '',
          modelLabel: typeof entry.modelLabel === 'string' ? entry.modelLabel : '',
          label: typeof entry.label === 'string' ? entry.label : '',
          instructions: typeof entry.instructions === 'string' ? entry.instructions : '',
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          completedAt: typeof entry.completedAt === 'number' ? entry.completedAt : undefined,
          text: typeof entry.text === 'string' ? entry.text : '',
          capturedAt: typeof entry.capturedAt === 'number' ? entry.capturedAt : undefined,
          failure: entry.failure && typeof entry.failure.message === 'string'
            ? { code: typeof entry.failure.code === 'string' ? entry.failure.code : '', message: entry.failure.message }
            : null,
          dshTurn: typeof entry.dshTurn === 'number' ? entry.dshTurn : undefined,
        });
      }
      return out;
    }

    function loadAdvisorActivity(storage) {
      try {
        return parseAdvisorActivity(storage ? storage.getItem(ACTIVITY_KEY) : null);
      } catch {
        return [];
      }
    }

    function saveAdvisorActivity(storage, entries) {
      try {
        if (storage) storage.setItem(ACTIVITY_KEY, JSON.stringify(entries.slice(0, 50)));
      } catch {
        // Browser storage may be unavailable; the activity stays session-local.
      }
    }

    /** Insert or update one tracked task, newest first. */
    function upsertAdvisorActivity(storage, entry) {
      if (!entry) return loadAdvisorActivity(storage);
      const next = [entry, ...loadAdvisorActivity(storage).filter((item) => item.reviewId !== entry.reviewId)].slice(0, 50);
      saveAdvisorActivity(storage, next);
      return next;
    }

    /**
     * Merge the persisted activity with the sidecar's authoritative answer.
     *
     * A sidecar task always wins. A persisted task the sidecar no longer knows
     * keeps its recorded result when it completed, and becomes `unavailable`
     * when it did not: a review whose owner is gone is never shown as running.
     */
    function reconcileAdvisorActivity(persisted, serverTasks) {
      const fromServer = [];
      for (const task of Array.isArray(serverTasks) ? serverTasks : []) {
        const entry = advisorTaskEntry(task, {});
        if (entry) fromServer.push(entry);
      }
      const known = new Set(fromServer.map((entry) => entry.reviewId));
      const kept = [];
      for (const entry of Array.isArray(persisted) ? persisted : []) {
        if (known.has(entry.reviewId)) continue;
        const terminal = entry.state === 'completed' || entry.state === 'failed' || entry.state === 'interrupted';
        kept.push(
          terminal || entry.state === ADVISOR_TASK_UNAVAILABLE_STATE
            ? entry
            : { ...entry, state: ADVISOR_TASK_UNAVAILABLE_STATE, failure: { code: 'advisor_task_unavailable', message: 'This review is no longer available on this sidecar.' } },
        );
      }
      // Preserve the persisted per-review DSH turn identity: the sidecar does not
      // know which chat turn the client associated a review with.
      const turns = new Map();
      for (const entry of Array.isArray(persisted) ? persisted : []) {
        if (typeof entry.dshTurn === 'number') turns.set(entry.reviewId, entry.dshTurn);
      }
      const withTurns = (entry) => (turns.has(entry.reviewId) ? { ...entry, dshTurn: turns.get(entry.reviewId) } : entry);
      const merged = [...fromServer.map(withTurns), ...kept.map(withTurns)];
      merged.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
      return merged;
    }

    /**
     * Record the result of every newly completed review of the CURRENT session.
     *
     * A completed review of another session is never recorded here: the turn card
     * belongs to the session/turn it was produced for, and writing it into the
     * current chat would be cross-session contamination.
     */
    function recordAdvisorResultsForActivity(storage, reviews, currentSessionId) {
      for (const entry of Array.isArray(reviews) ? reviews : []) {
        if (!entry || entry.state !== 'completed') continue;
        if (!entry.text || typeof entry.dshTurn !== 'number') continue;
        if (!currentSessionId || entry.sessionId !== currentSessionId) continue;
        recordAdvisorResult(storage, {
          turn: entry.dshTurn,
          reviewId: entry.reviewId,
          route: entry.route,
          providerLabel: entry.providerLabel,
          modelLabel: entry.modelLabel,
          recovered: typeof entry.capturedAt === 'number',
          text: entry.text,
        });
      }
    }

    /**
     * The minimum handoff prompt (issue #180): the full review, clearly marked
     * as coming from the Advisor, asking the agent to evaluate it against
     * the current task and apply the relevant recommendations. Excludes Advisor
     * history, internal IDs, HTML/UI markup, bridge details, and transport terms.
     */
    function buildHandoffPrompt(result) {
      const review = result && typeof result.text === 'string' ? result.text.trim() : '';
      if (!review) return '';
      return (
        'Advisor review:\n\n' +
        review +
        '\n\n' +
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
          h('span', { className: 'cwg-advisor-card-title' }, t('advisor.card.title', 'Advisor')),
          h('span', { className: 'cwg-advisor-card-meta' },
            ([result.providerLabel, result.modelLabel].filter(Boolean).join(' \u2014 ') || result.route || '')
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

    /**
     * Composer control: the Advisor launch action for a reviewable turn, plus the
     * persistent activity entry while any tracked review exists.
     */
    function AdvisorReviewButton(t, props) {
      // Two stable-reference selectors (never a fresh object): the selector
      // hooks cache by reference, and order/nodes are stable across snapshots.
      const order = typeof props.useChat === 'function' ? props.useChat((s) => s.order) : undefined;
      const nodes = typeof props.useChat === 'function' ? props.useChat((s) => s.nodes) : undefined;
      const chat = order && nodes ? { order, nodes } : null;
      const running = typeof props.useSession === 'function' ? props.useSession((s) => s.running) : false;
      const { snapshot } = useAdvisorState(advisorStore);
      if (!props.sessionId) return null;
      const reviewable = selectReviewableTurn(chat);
      const reviews = Array.isArray(snapshot.activity.reviews) ? snapshot.activity.reviews : [];
      const active = reviews.filter((entry) => entry.state === 'queued' || entry.state === 'running').length;
      if (!reviewable && reviews.length === 0) return null;
      return h('div', { className: 'cwg-advisor-controls' },
        reviewable
          ? h('button', {
              type: 'button',
              className: 'cwg-advisor-btn',
              disabled: !canStartReview({ running, reviewable }),
              title: t('advisor.btnHint', 'Review the last completed turn with the selected WebChat model in a separate Advisor conversation.'),
              'aria-label': t('advisor.btn', 'Review with Advisor'),
              onClick: () => advisorStore.openReview(reviewable, loadLastInstructions(window.localStorage)),
            }, t('advisor.btn', 'Review with Advisor'))
          : null,
        active > 0
          ? h('span', { className: 'cwg-advisor-busy' }, t('advisor.btnBusy', 'Advisor review running…'))
          : null,
        reviews.length > 0
          ? h('button', {
              type: 'button',
              className: 'cwg-advisor-btn',
              title: t('advisor.activity.open', 'Advisor activity'),
              'aria-label': t('advisor.activity.open', 'Advisor activity'),
              onClick: () => advisorStore.openActivity(),
            }, `${t('advisor.activity.open', 'Advisor activity')} (${reviews.length})`)
          : null,
      );
    }

    /**
     * Review dialog. It is a real modal: the composer slot it is registered in renders its content
     * inside a zero-height absolutely-positioned anchor at the top of the composer card
     * (`conversation.input.overlay`), so dialog content that stays in flow lands on top of the
     * composer's own editable field and, because the composer sits at the bottom of the viewport,
     * reads as a panel under the text box. The dialog therefore leaves that flow explicitly
     * (`position: fixed` backdrop) and centres itself over the composer.
     */
    /**
     * The Advisor panel. It is a real modal over the composer (it leaves the composer's flow with a
     * fixed backdrop, per the slot's zero-height anchor) and has two views:
     *
     * - the **review launcher**: the dynamic, provider-qualified model choice, the inclusion
     *   checkboxes, the editable instructions, and the start action;
     * - the **tracked activity list**: active reviews and recent completed results, including the
     *   ones produced in other DSH sessions.
     *
     * Reading a retained answer (#214) stays available from the launcher.
     */
    function AdvisorReviewDialog(t, props, configForm) {
      const { snapshot, inFlight } = useAdvisorState(advisorStore);
      const projection = typeof props.useProjection === 'function' ? props.useProjection(ADVISOR_PROJECTION_KEY) : undefined;
      const workspaceItems = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((s) => s.items) : undefined;
      // Two stable-reference selectors (never a fresh object), so the activity view can offer a
      // review of the current session's latest turn.
      const order = typeof props.useChat === 'function' ? props.useChat((s) => s.order) : undefined;
      const nodes = typeof props.useChat === 'function' ? props.useChat((s) => s.nodes) : undefined;
      // Transient copy feedback for the recovered answer ('' = nothing to say).
      const [copyState, setCopyState] = React.useState('');

      const open = snapshot.open === true;
      const view = snapshot.view === 'activity' ? 'activity' : 'review';
      const sessionId = props.sessionId;
      const base = resolveSidecarBase(configForm);
      const token = projection && typeof projection.controlToken === 'string' ? projection.controlToken : undefined;
      const available = Boolean(base && token);
      const modelsStatus = snapshot.models.status;
      const choices = Array.isArray(snapshot.models.choices) ? snapshot.models.choices : [];
      const reviews = Array.isArray(snapshot.activity.reviews) ? snapshot.activity.reviews : [];
      const activeReviews = reviews.filter((entry) => entry.state === 'queued' || entry.state === 'running').length;
      const chat = order && nodes ? { order, nodes } : null;

      /** A fresh request environment. The endpoint/token are resolved on every call, never cached. */
      const makeEnv = () => (base && token ? {
        base,
        token,
        sessionId,
        project: selectProjectName(workspaceItems, sessionId),
        storage: window.localStorage,
        lastRoute: loadLastSelection(window.localStorage),
        fetch: (url, options) => fetch(url, options),
      } : null);

      // Show what browser storage already knows, before the sidecar answers.
      React.useEffect(() => { advisorStore.hydrateActivity(window.localStorage); }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') advisorStore.closeDialog(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      // Reconcile the tracked activity with the sidecar. The panel refreshes on open, and while any
      // review is still active it also keeps observing it with the panel closed: a review completes
      // in the background, and its result must reach the turn card without the user reopening
      // anything. Nothing polls once no review is active.
      React.useEffect(() => {
        if (!available) return undefined;
        const current = makeEnv();
        if (!current) return undefined;
        if (open) advisorStore.refreshActivity(current);
        if (activeReviews === 0) return undefined;
        const timer = setInterval(() => advisorStore.refreshActivity(current), open ? 3000 : 5000);
        return () => clearInterval(timer);
      }, [open, available, activeReviews, base, token, sessionId]);

      // The eligible catalogue is loaded when the launcher is shown, and explicitly on retry.
      React.useEffect(() => {
        if (!open || view !== 'review' || !available || modelsStatus !== 'idle') return;
        const current = makeEnv();
        if (current) advisorStore.loadModels(current);
      }, [open, view, available, modelsStatus, base, token, sessionId]);

      if (!open) return null;
      const context = snapshot.context;
      if (view === 'review' && !context) return null;

      const project = selectProjectName(workspaceItems, sessionId);
      const selection = snapshot.selection;
      const selectionEligible = Boolean(selection) && choices.some((choice) => choice.route === selection.route);
      const sourceContext = context
        ? { humanRequest: context.humanRequest, dshResponse: context.dshResponse, project }
        : null;
      const sourceSelected = hasSelectedSource(sourceContext, snapshot.include);
      const starting = snapshot.start.status === 'starting';
      const canSubmit = Boolean(selection) && selectionEligible && sourceSelected && !starting && !inFlight;

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

      function onRetryModels() {
        const current = makeEnv();
        if (current) advisorStore.loadModels(current);
      }

      function onReview() {
        if (!base) { advisorStore.fail(t('advisor.errNoEndpoint', 'The sidecar endpoint is not configured.')); return; }
        if (!token) { advisorStore.fail(t('advisor.errNoToken', 'The sidecar control token is unavailable in this profile.')); return; }
        const current = makeEnv();
        if (current) advisorStore.startReview(current);
      }

      /** Read the answer the provider already produced; read-only, so it can be retried freely. */
      function onRecover() {
        if (!base) { advisorStore.failRecovery(t('advisor.errNoEndpoint', 'The sidecar endpoint is not configured.')); return; }
        if (!token) { advisorStore.failRecovery(t('advisor.errNoToken', 'The sidecar control token is unavailable in this profile.')); return; }
        const current = makeEnv();
        if (current) advisorStore.recover(current);
      }

      /**
       * Read the retained answer of one tracked review. A failed task names its own route, so the
       * recovery reads the conversation the review actually used, not the currently displayed one.
       */
      function onRecoverEntry(entry) {
        if (!base) { advisorStore.failRecovery(t('advisor.errNoEndpoint', 'The sidecar endpoint is not configured.')); return; }
        if (!token) { advisorStore.failRecovery(t('advisor.errNoToken', 'The sidecar control token is unavailable in this profile.')); return; }
        const current = makeEnv();
        if (current) advisorStore.recover({ ...current, ...(entry && entry.route ? { route: entry.route } : {}) });
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

      /** Start a new review explicitly; a failed review is never retried automatically. */
      function onStartNewReview() {
        const reviewable = selectReviewableTurn(chat);
        if (!reviewable) { advisorStore.closeDialog(); return; }
        advisorStore.openReview(reviewable, loadLastInstructions(window.localStorage));
        const current = makeEnv();
        if (current) advisorStore.loadModels(current);
      }

      /** Open one tracked result for the current session's turn card, then close. */
      function onOpenResult(entry) {
        if (entry && entry.text && typeof entry.dshTurn === 'number' && entry.sessionId === sessionId) {
          recordAdvisorResult(window.localStorage, {
            turn: entry.dshTurn,
            reviewId: entry.reviewId,
            route: entry.route,
            providerLabel: entry.providerLabel,
            modelLabel: entry.modelLabel,
            recovered: typeof entry.capturedAt === 'number',
            text: entry.text,
          });
        }
        advisorStore.closeDialog();
      }

      const modelSection = h('div', null,
        h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.model', 'Model')),
        modelsStatus === 'loading' && choices.length === 0
          ? h('div', { className: 'cwg-advisor-note' }, t('advisor.dialog.modelLoading', 'Loading available models…'))
          : null,
        modelsStatus === 'error'
          ? h('div', { className: 'cwg-advisor-recover' },
              h('div', { className: 'cwg-advisor-error', role: 'alert' },
                t('advisor.dialog.modelFailed', 'The available models could not be loaded.'),
                snapshot.models.error ? ` (${snapshot.models.error})` : ''),
              h('div', { className: 'cwg-advisor-recover-actions' },
                h('button', {
                  type: 'button',
                  className: 'cwg-btn cwg-secondary',
                  onClick: onRetryModels,
                }, t('advisor.dialog.modelRetry', 'Retry')),
              ),
            )
          : null,
        modelsStatus === 'ready' && choices.length === 0
          ? h('div', { className: 'cwg-advisor-error', role: 'alert' }, t('advisor.dialog.modelNone', 'No supported authenticated WebChat model is available.'))
          : null,
        choices.length > 0
          ? h('select', {
              className: 'cwg-advisor-model',
              value: selection ? selection.route : '',
              disabled: starting,
              'aria-label': t('advisor.dialog.model', 'Model'),
              onChange: (event) => advisorStore.setSelection(event.target.value),
            },
              selection && !selectionEligible
                ? h('option', { value: selection.route },
                    `${selection.label} (${t('advisor.dialog.modelUnavailableShort', 'unavailable')})`)
                : null,
              ...choices.map((choice) => h('option', { key: choice.route, value: choice.route }, choice.label)),
            )
          : null,
        selection && !selectionEligible
          ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
              t('advisor.dialog.modelUnavailable', 'This selection is no longer available. Choose an eligible model.'))
          : null,
      );

      const includeSection = h('div', null,
        h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.include', 'Include in the review')),
        h('div', { className: 'cwg-advisor-includes' },
          !context ? null : h('label', null,
            h('input', {
              type: 'checkbox',
              checked: snapshot.include.request !== false,
              disabled: !context.humanRequest,
              onChange: (event) => advisorStore.setInclude('request', event.target.checked),
            }),
            t('advisor.dialog.includeRequest', 'Human request'),
          ),
          !context ? null : h('label', null,
            h('input', {
              type: 'checkbox',
              checked: snapshot.include.response !== false,
              disabled: !context.dshResponse,
              onChange: (event) => advisorStore.setInclude('response', event.target.checked),
            }),
            t('advisor.dialog.includeResponse', 'DSH response'),
          ),
          project ? h('label', null,
            h('input', {
              type: 'checkbox',
              checked: snapshot.include.project !== false,
              onChange: (event) => advisorStore.setInclude('project', event.target.checked),
            }),
            t('advisor.dialog.includeProject', 'Project name'),
          ) : null,
        ),
        !sourceSelected
          ? h('div', { className: 'cwg-advisor-error', role: 'alert' }, t('advisor.dialog.noSource', 'Select at least one source to review.'))
          : null,
      );

      const recoverySection = snapshot.recovery.status === 'ready' && snapshot.recovery.text
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
        : null;

      const reviewBody = h('div', { className: 'cwg-advisor-review' },
        modelSection,
        includeSection,
        h('div', null,
          h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.instructions', 'Review instructions')),
          h('textarea', {
            className: 'cwg-advisor-instructions',
            value: snapshot.instructions,
            disabled: starting,
            onChange: (event) => advisorStore.setInstructions(event.target.value),
          }),
        ),
        h('div', null,
          h('div', { className: 'cwg-advisor-section-label' }, t('advisor.dialog.context', 'Context (read-only)')),
          h('div', { className: 'cwg-advisor-context' },
            h('div', null,
              h('div', { className: 'cwg-advisor-context-label' }, t('advisor.dialog.humanRequest', 'Last human request')),
              h('pre', null, context ? context.humanRequest : ''),
            ),
            h('div', null,
              h('div', { className: 'cwg-advisor-context-label' }, t('advisor.dialog.dshResponse', 'Last DSH response')),
              h('pre', null, context ? context.dshResponse : ''),
            ),
          ),
        ),
        snapshot.start.status === 'error' && snapshot.start.error
          ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
              t('advisor.dialog.error', 'The review could not be started.'),
              snapshot.start.error !== 'cancelled' ? ` (${snapshot.start.error})` : '',
            )
          : null,
        // A failed review is not a lost answer: the provider usually finished it in the retained
        // conversation, and the recovery reads it back without sending anything (issue #214).
        snapshot.start.status === 'error' || snapshot.recovery.status !== 'idle'
          ? h('div', { className: 'cwg-advisor-recover' },
              h('div', { className: 'cwg-advisor-recover-actions' },
                h('button', {
                  type: 'button',
                  className: 'cwg-btn cwg-secondary',
                  title: t('advisor.recover.hint', 'Read the answer the provider already produced in this Advisor conversation. Nothing is sent.'),
                  disabled: snapshot.recovery.status === 'loading' || inFlight,
                  onClick: onRecover,
                }, snapshot.recovery.status === 'loading'
                  ? t('advisor.recover.loading', 'Reading the retained answer')
                  : t('advisor.recover.action', 'Recover retained answer')),
              ),
              snapshot.recovery.status === 'error' && snapshot.recovery.error
                ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
                    t('advisor.recover.failed', 'The answer could not be read.'),
                    ` (${snapshot.recovery.error})`)
                : null,
            )
          : null,
        recoverySection,
      );

      const activityBody = h('div', { className: 'cwg-advisor-activity' },
        snapshot.activity.status === 'error' && snapshot.activity.error
          ? h('div', { className: 'cwg-advisor-error', role: 'alert' }, snapshot.activity.error)
          : null,
        reviews.length === 0
          ? h('div', { className: 'cwg-advisor-note' }, t('advisor.activity.empty', 'No Advisor reviews yet.'))
          : null,
        ...reviews.map((entry) => h('div', { key: entry.reviewId, className: 'cwg-advisor-activity-item' },
          h('div', { className: 'cwg-advisor-activity-head' },
            h('span', { className: 'cwg-advisor-activity-label' }, entry.label || entry.route || t('advisor.task.title', 'Advisor review')),
            entry.sessionId === sessionId
              ? h('span', { className: 'cwg-advisor-activity-meta' }, t('advisor.activity.thisSession', 'this session'))
              : null,
            h('span', {
              className: `cwg-advisor-activity-state ${entry.state === 'completed' ? 'cwg-ok' : entry.state === 'failed' || entry.state === 'interrupted' || entry.state === 'unavailable' ? 'cwg-err' : ''}`,
            }, t(`advisor.state.${entry.state}`, entry.state)),
          ),
          h('div', { className: 'cwg-advisor-activity-meta' },
            [entry.reviewedTurnId, entry.createdAt ? new Date(entry.createdAt).toLocaleString() : ''].filter(Boolean).join(' · ')),
          entry.text ? h('pre', { className: 'cwg-advisor-activity-body' }, entry.text) : null,
          entry.failure ? h('div', { className: 'cwg-advisor-error', role: 'alert' }, entry.failure.message) : null,
          entry.text
            ? (entry.sessionId === sessionId && typeof entry.dshTurn === 'number'
                ? h('div', { className: 'cwg-advisor-recover-actions' },
                    h('button', {
                      type: 'button',
                      className: 'cwg-btn cwg-secondary',
                      onClick: () => onOpenResult(entry),
                    }, t('advisor.activity.openResult', 'Open result')),
                  )
                : null)
            // A review that did not produce text keeps the read-only recovery of #214: the provider
            // may have finished the answer even though the task failed.
            : h('div', { className: 'cwg-advisor-recover-actions' },
                h('button', {
                  type: 'button',
                  className: 'cwg-btn cwg-secondary',
                  title: t('advisor.recover.hint', 'Read the answer the provider already produced in this Advisor conversation. Nothing is sent.'),
                  disabled: snapshot.recovery.status === 'loading' || inFlight,
                  onClick: () => onRecoverEntry(entry),
                }, snapshot.recovery.status === 'loading'
                  ? t('advisor.recover.loading', 'Reading the retained answer')
                  : t('advisor.recover.action', 'Recover retained answer')),
              ),
        )),
      );

      const canOfferNewReview = Boolean(selectReviewableTurn(chat));

      return h('div', {
        className: 'cwg-advisor-backdrop',
        onClick: (event) => {
          // Only a click on the backdrop itself dismisses, and never while the start
          // request is still being accepted.
          if (event.target === event.currentTarget && !starting) advisorStore.closeDialog();
        },
        onKeyDown: onDialogKeyDown,
      },
        h('div', {
          className: 'cwg-advisor-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': view === 'activity'
            ? t('advisor.activity.title', 'Advisor activity')
            : t('advisor.dialog.title', 'Review with Advisor'),
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
            h('span', { className: 'cwg-advisor-title' },
              view === 'activity'
                ? t('advisor.activity.title', 'Advisor activity')
                : t('advisor.dialog.title', 'Review with Advisor')),
            view === 'activity'
              ? h('button', {
                  type: 'button',
                  className: 'cwg-advisor-close',
                  'aria-label': t('advisor.activity.close', 'Close'),
                  onClick: () => advisorStore.setView('review'),
                }, '\u00d7')
              : h('button', {
                  type: 'button',
                  className: 'cwg-advisor-close',
                  'aria-label': t('advisor.dialog.cancel', 'Cancel'),
                  disabled: starting,
                  onClick: () => advisorStore.closeDialog(),
                }, '\u00d7'),
          ),
          view === 'activity'
            ? h('div', null,
                h('div', { className: 'cwg-advisor-section-label' }, t('advisor.activity.title', 'Advisor activity')),
                activityBody,
                // A recovery started from a tracked failure renders here too, beside its entry.
                recoverySection,
                snapshot.recovery.status === 'error' && snapshot.recovery.error
                  ? h('div', { className: 'cwg-advisor-error', role: 'alert' },
                      t('advisor.recover.failed', 'The answer could not be read.'),
                      ` (${snapshot.recovery.error})`)
                  : null,
              )
            : reviewBody,
          view === 'activity'
            ? h('div', { className: 'cwg-advisor-foot' },
                canOfferNewReview
                  ? h('button', {
                      type: 'button',
                      className: 'cwg-btn cwg-secondary',
                      onClick: onStartNewReview,
                    }, t('advisor.activity.newReview', 'Start a new review'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'cwg-btn',
                  onClick: () => advisorStore.closeDialog(),
                }, t('advisor.activity.close', 'Close')),
              )
            : h('div', { className: 'cwg-advisor-foot' },
                h('button', {
                  type: 'button',
                  className: 'cwg-btn cwg-secondary',
                  disabled: starting,
                  onClick: () => advisorStore.closeDialog(),
                }, t('advisor.dialog.cancel', 'Cancel')),
                h('button', {
                  type: 'button',
                  className: 'cwg-btn',
                  disabled: !canSubmit,
                  onClick: onReview,
                }, starting ? t('advisor.dialog.starting', 'Starting…') : t('advisor.dialog.review', 'Start review')),
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
        }, (props) => AdvisorReviewDialog(t, props, configForm))));
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
        LAST_SELECTION_KEY,
        ACTIVITY_KEY,
        DEFAULT_INSTRUCTIONS,
        selectReviewableTurn,
        canStartReview,
        hasSelectedSource,
        selectProjectName,
        advisorChoice,
        buildAdvisorModelsFetch,
        buildAdvisorStartFetch,
        buildAdvisorStatusFetch,
        buildAdvisorListFetch,
        buildAdvisorRecoverFetch,
        loadLastInstructions,
        saveLastInstructions,
        loadLastSelection,
        saveLastSelection,
        createAdvisorStore,
        advisorStore,
        RESULTS_KEY,
        parseAdvisorResults,
        loadAdvisorResults,
        saveAdvisorResults,
        recordAdvisorResult,
        selectResultForTurn,
        parseAdvisorActivity,
        loadAdvisorActivity,
        saveAdvisorActivity,
        upsertAdvisorActivity,
        advisorTaskEntry,
        reconcileAdvisorActivity,
        recordAdvisorResultsForActivity,
        buildHandoffPrompt,
        createSendStore,
        AdvisorReviewButton,
        AdvisorResultCard,
        AdvisorReviewDialog,
        ADVISOR_CSS: CSS,
      },
    };
  },
});
