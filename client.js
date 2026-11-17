/**
 * Client half of @lordraiden/dsh-chatgpt-web: the plugin's settings page (doc/plugin.md §7).
 *
 * One `settings.section` seat under the plugin's settings namespace (the loader row id
 * `dsh-chatgpt-web`). The Host owns the schema, the defaults and the persistence: this page renders
 * the five fields of `src/plugin/config.ts` from `ctx.configForms` and never keeps a second copy of
 * the configuration. `apiKey` and `controlToken` are `role('secret')`, so the Host redacts them from
 * every descriptor; the page reports only whether one is configured, and holds a value the operator
 * types in component memory until it is saved — never in browser storage, never in a URL.
 *
 * The page never calls the service from the browser. Status, the model catalogue and the sign-in
 * target come from the plugin host's same-origin route
 * `GET /plugins/dsh-chatgpt-web/status`, which proxies the service with the control token on the
 * server. `baseUrl` stays editable and is used only to save the configuration (the host derives the
 * control base and the sign-in URL from it); it is never used for a browser fetch.
 *
 * Plain browser JS, no build step: React comes from the browser module table, text goes through the
 * Client locale service, and styling uses only --dsw-alias-* theme tokens in a component-local
 * <style> element so unmounting removes it.
 */
window.__ModuleLoader__.load({
  // The module-table key is the package name (the boot graph row), not the settings namespace.
  id: '@lordraiden/dsh-chatgpt-web',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Settings namespace == loader row id (`cordis.patch.yml`) == configForms entry id. */
    const NS = 'dsh-chatgpt-web';
    /** Same-origin host route that proxies the service (control token stays on the server). */
    const STATUS_PATH = '/plugins/dsh-chatgpt-web/status';
    /** Catalogue routes this plugin serves (doc/plugin.md §1). */
    const SUPPORTED_MODEL_PREFIXES = ['chatgpt-web/', 'qwen-chat/'];
    /** Bound for the page read when `requestTimeoutMs` is 0 ("no client timeout" is for turns). */
    const STATUS_TIMEOUT_MS = 8000;
    /** A token an older build may have left in browser storage; removed on mount, never written. */
    const LEGACY_TOKEN_KEY = 'dsh-chatgpt-web.controlToken';
    /** Longest diagnostic text rendered; longer answers are truncated, never echoed whole. */
    const MAX_TEXT = 240;

    const DICT_EN = {
      'section.title': 'ChatGPT Web', 'section.nav': 'ChatGPT Web', 'form.title': 'Connection',
      'section.intro': 'Registers the container service as a text-only model provider. The Host owns these values: saving applies them live, without a restart.',
      'form.readOnly': 'This profile does not accept settings writes.',
      'form.loading': 'Waiting for the Host configuration…',
      'form.baseUrl': 'Service base URL',
      'form.baseUrlHint': 'The service root. It may include an endpoint profile: http://host:port/p/<profile>. The plugin host uses it for status and sign-in.',
      'form.model': 'Model', 'form.modelHint': 'Catalogue routes served by the service: chatgpt-web/* and qwen-chat/*.',
      'form.timeout': 'Request timeout (ms)',
      'form.timeoutHint': '0 means no client-side timeout; the service sends keep-alive frames while a turn runs.',
      'form.save': 'Save',
      'secrets.title': 'Secrets',
      'secrets.intro': 'Write-only: the Host never returns these values. The plugin host uses them server-side; the browser never sends them.',
      'secrets.apiKey': 'Service API key', 'secrets.apiKeyHint': 'Used by the plugin host to read the model catalogue.',
      'secrets.controlToken': 'Control token', 'secrets.controlTokenHint': 'Used by the plugin host for status and sign-in reads.',
      'secrets.configured': 'Configured', 'secrets.unconfigured': 'Not configured', 'secrets.clear': 'Clear',
      'secrets.replace': 'Configured — type to replace', 'secrets.enter': 'Not configured — type to set',
      'status.title': 'Service status', 'status.service': 'Service', 'status.version': 'Version',
      'status.controlBase': 'Control base', 'status.configuredBase': 'Configured base',
      'status.catalogue': 'Catalogue', 'status.auth': 'Account',
      'status.reachable': 'reachable', 'status.unreachable': 'unreachable',
      'status.checking': 'checking…', 'status.unknown': 'not checked', 'status.unavailable': 'unavailable',
      'status.authUnconfigured': 'control token required',
      'status.test': 'Test connection', 'status.signIn': 'Sign in…',
      'status.signInHint': 'Opens the service sign-in page in a new tab. The control token is never put in the URL.',
      'status.hostHint': 'Status is read by the plugin host at /plugins/dsh-chatgpt-web/status; the browser never contacts the service directly.',
      'catalogue.supported': 'supported', 'catalogue.idle': 'Catalogue not loaded yet.',
      'test.serviceOk': 'service reachable', 'test.serviceFailed': 'service unreachable',
      'test.catalogue': 'catalogue',
      'notice.saved': 'Saved. The plugin applies the change without a restart.', 'notice.noop': 'No changes to save.',
      'notice.refused': 'The Host refused the change. Reload the page and try again.', 'notice.cleared': 'Cleared.',
      'notice.timeoutInvalid': 'Request timeout must be a whole number of milliseconds, or blank for the default.',
    };

    const CSS = `
      .dcw-root { display: flex; flex-direction: column; gap: 14px; padding: 2px; max-width: 720px; box-sizing: border-box; }
      .dcw-root *, .dcw-root *::before, .dcw-root *::after { box-sizing: border-box; }
      .dcw-head h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dcw-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px; background: var(--dsw-alias-bg-layer-1); }
      .dcw-card h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dcw-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
      .dcw-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
      .dcw-hint { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dcw-muted { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dcw-input { width: 100%; min-width: 0; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dcw-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .dcw-input:disabled { opacity: .6; }
      .dcw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dcw-btn { font: inherit; font-size: 13px; padding: 6px 14px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); cursor: pointer; }
      .dcw-btn:disabled { opacity: .5; cursor: default; }
      .dcw-btn-secondary { background: transparent; color: var(--dsw-alias-brand-primary); }
      .dcw-link { font-size: 13px; color: var(--dsw-alias-brand-primary); text-decoration: none; }
      .dcw-link:hover { text-decoration: underline; }
      .dcw-notice { font-size: 12px; line-height: 1.45; }
      .dcw-notice-ok { color: var(--dsw-alias-state-success-primary); }
      .dcw-notice-err { color: var(--dsw-alias-state-error-primary); }
      .dcw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
      .dcw-cell { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-base); min-width: 0; }
      .dcw-cell-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
      .dcw-cell-value { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dcw-secret-head { display: flex; align-items: center; gap: 8px; }
      .dcw-secret-row { display: flex; align-items: center; gap: 8px; }
      .dcw-secret-row .dcw-input { flex: 1 1 auto; }
      .dcw-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dcw-badge-on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .dcw-auth { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
      .dcw-auth-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-primary); }
      .dcw-auth-state { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dcw-auth-reason { flex-basis: 100%; font-size: 11px; color: var(--dsw-alias-label-secondary); }
    `;

    /** Wrap the bound translate so a missing key never throws and always yields a string. */
    function makeT(translate) {
      return (key, fallback) => {
        try {
          const value = typeof translate === 'function' ? translate(key) : undefined;
          return typeof value === 'string' && value !== '' ? value : fallback;
        } catch {
          return fallback;
        }
      };
    }

    /** A non-empty string, or the fallback. */
    const textOr = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value : fallback);

    /** Sanitize one diagnostic: collapse whitespace, redact bearer-shaped text, truncate. */
    function sanitizeText(value) {
      let text;
      if (typeof value === 'string') text = value;
      else if (value instanceof Error) text = value.message;
      else if (value === undefined || value === null) text = '';
      else text = String(value);
      text = text.replace(/\s+/g, ' ').trim().replace(/(bearer\s+)[^\s,;]+/gi, '$1<redacted>');
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    }

    /** An endpoint for display: origin plus path, with any userinfo removed. */
    function describeEndpoint(raw) {
      try {
        const url = new URL(String(raw).trim());
        url.username = '';
        url.password = '';
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      } catch {
        return '<invalid baseUrl>';
      }
    }

    /**
     * Validate a configured `baseUrl` without deriving anything from it: the browser never calls the
     * service, so the page only needs to know the value is an absolute http(s) URL before saving it.
     * @throws when the value is missing, not absolute, or not http(s).
     */
    function validateBaseUrl(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') throw new Error('The service base URL is not configured.');
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new Error('The service base URL is not a valid absolute URL.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The service base URL must use http or https.');
      return text;
    }

    /** Whether a catalogue id is a route this plugin serves. */
    const isSupportedModel = (id) => typeof id === 'string' && SUPPORTED_MODEL_PREFIXES.some((prefix) => id.indexOf(prefix) === 0);

    /** Read the host status answer's `models` array into the total and the supported subset. */
    function readModels(payload) {
      const ids = [];
      const seen = new Set();
      for (const id of payload && Array.isArray(payload.models) ? payload.models : []) {
        if (typeof id === 'string' && id !== '' && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return { total: ids.length, supported: ids.filter(isSupportedModel) };
    }

    /**
     * Read the host's same-origin status route. The browser sends no credential of its own: the route
     * proxies the service with the control token on the server.
     * @returns `{ok: true, payload}` or `{ok: false, status}` (0 for a transport failure).
     */
    async function fetchStatus(timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = controller !== undefined && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const response = await fetch(STATUS_PATH, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller === undefined ? undefined : controller.signal,
        });
        if (!response.ok) return { ok: false, status: response.status };
        const text = await response.text();
        let payload;
        if (text !== '') {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = undefined;
          }
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, status: response.status };
        return { ok: true, status: response.status, payload };
      } catch {
        return { ok: false, status: 0 };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /** The page read timeout: the configured value when positive, otherwise the bounded status default. */
    function readTimeoutMs(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      const parsed = text === '' ? Number.NaN : Number(text);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : STATUS_TIMEOUT_MS;
    }

    /** The empty draft; every value the form edits starts here. */
    const emptyDraft = () => ({ baseUrl: '', model: '', requestTimeoutMs: '', apiKey: '', controlToken: '' });

    /**
     * The settings page.
     *
     * Props: the shell's `close` (unused here), the registration's `tr` translate wrapper, and the
     * `form`/`describe` faces of `ctx.configForms` supplied by this plugin's inject factory.
     */
    function ChatGptWebSettings(props) {
      const t = props.tr;
      const form = props.form;
      const describe = props.describe;

      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [describeSnapshot, setDescribeSnapshot] = React.useState(() => describe.getSnapshot());
      const [draft, setDraft] = React.useState(emptyDraft);
      const [dirty, setDirty] = React.useState(false);
      const [probe, setProbe] = React.useState({ state: 'idle', payload: null, error: null });
      const [notice, setNotice] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const runId = React.useRef(0);
      const lastSyncedKey = React.useRef(undefined);

      // The Host is the only owner of the values; this page only observes its form.
      React.useEffect(() => {
        const unsubscribeForm = form.subscribe(() => setSnapshot(form.getSnapshot()));
        const unsubscribeDescribe = describe.subscribe(() => setDescribeSnapshot(describe.getSnapshot()));
        if (typeof describe.ensure === 'function') Promise.resolve(describe.ensure()).catch(() => {});
        try {
          // A token an older build may have left behind; this page never writes one.
          window.localStorage.removeItem(LEGACY_TOKEN_KEY);
        } catch {
          // Browser storage may be unavailable; nothing here depends on it.
        }
        return () => {
          unsubscribeForm();
          unsubscribeDescribe();
        };
      }, [form, describe]);

      const value = snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
      const base = snapshot.base && typeof snapshot.base === 'object' ? snapshot.base : {};
      const writable = snapshot.writable === true;
      const ready = snapshot.status === 'ready';
      const persistedBaseUrl = textOr(value.baseUrl, '');

      // Sync the editable draft from the Host value until the operator edits it. The key guard keeps a
      // just-saved draft from being reverted by the pre-save snapshot still held in state.
      const persistedKey = JSON.stringify([
        textOr(value.baseUrl, ''),
        textOr(value.model, ''),
        value.requestTimeoutMs === undefined || value.requestTimeoutMs === null ? null : String(value.requestTimeoutMs),
      ]);
      React.useEffect(() => {
        if (!ready || dirty || lastSyncedKey.current === persistedKey) return;
        lastSyncedKey.current = persistedKey;
        setDraft({
          baseUrl: textOr(value.baseUrl, ''),
          model: textOr(value.model, ''),
          requestTimeoutMs: value.requestTimeoutMs === undefined || value.requestTimeoutMs === null ? '' : String(value.requestTimeoutMs),
          apiKey: '',
          controlToken: '',
        });
      }, [ready, dirty, persistedKey, value.baseUrl, value.model, value.requestTimeoutMs]);

      // Secret configured state lives only in the namespace descriptor: the value itself is redacted.
      const namespaceView = React.useMemo(() => {
        const view = describeSnapshot && describeSnapshot.view;
        if (!view || !Array.isArray(view.namespaces)) return undefined;
        return view.namespaces.find((entry) => entry && entry.ns === NS);
      }, [describeSnapshot]);
      const secretSet = React.useMemo(() => {
        const result = { apiKey: false, controlToken: false };
        for (const secret of namespaceView && Array.isArray(namespaceView.secrets) ? namespaceView.secrets : []) {
          if (!secret || !Array.isArray(secret.path) || secret.path.length !== 1) continue;
          if (secret.path[0] === 'apiKey' || secret.path[0] === 'controlToken') result[secret.path[0]] = secret.set === true;
        }
        return result;
      }, [namespaceView]);

      /**
       * Read the host status route and fold its answer into the page. A failed route (404, transport
       * failure, malformed answer) is reported as "plugin status endpoint unavailable"; the form stays
       * editable, because the configuration does not depend on the probe.
       */
      async function refreshStatus(options) {
        const run = runId.current + 1;
        runId.current = run;
        setProbe({ state: 'loading', payload: null, error: null });
        const result = await fetchStatus(readTimeoutMs(draft.requestTimeoutMs));
        if (runId.current !== run) return;
        if (!result.ok) {
          const message = result.status === 0
            ? 'plugin status endpoint unavailable'
            : `plugin status endpoint unavailable (HTTP ${result.status})`;
          setProbe({ state: 'error', payload: null, error: message });
          if (options && options.summary) setNotice({ kind: 'err', text: message });
          return;
        }
        const payload = result.payload;
        setProbe({ state: 'ready', payload, error: null });
        if (options && options.summary) {
          const service = payload.service && typeof payload.service === 'object' ? payload.service : {};
          const catalogue = readModels(payload);
          const version = typeof service.version === 'string' && service.version !== '' ? ` (v${sanitizeText(service.version)})` : '';
          const serviceText = service.reachable === true
            ? `${t('test.serviceOk', 'service reachable')}${version}`
            : `${t('test.serviceFailed', 'service unreachable')}${typeof service.error === 'string' && service.error !== '' ? `: ${sanitizeText(service.error)}` : ''}`;
          const catalogueText = `${catalogue.supported.length} ${t('catalogue.supported', 'supported')} / ${catalogue.total} ${t('test.catalogue', 'catalogue')}`;
          setNotice({ kind: service.reachable === true ? 'ok' : 'err', text: `${serviceText} · ${catalogueText}` });
        }
      }

      /** Run a probe without letting an unexpected failure become an unhandled rejection. */
      const check = (options) => {
        refreshStatus(options).catch((error) => setNotice({ kind: 'err', text: sanitizeText(error) }));
      };

      // One read when the Host value is first known, and again when the persisted endpoint changes.
      React.useEffect(() => {
        if (!ready) return;
        check({ summary: false });
      }, [ready, persistedBaseUrl]);

      /** Persist the draft through the Host form: one atomic mutation, revision-fenced. */
      async function save() {
        if (!writable) {
          setNotice({ kind: 'err', text: t('form.readOnly', 'This profile does not accept settings writes.') });
          return;
        }
        const baseUrlRaw = draft.baseUrl.trim();
        if (baseUrlRaw !== '') {
          try {
            validateBaseUrl(baseUrlRaw);
          } catch (error) {
            setNotice({ kind: 'err', text: sanitizeText(error) });
            return;
          }
        }
        const timeoutRaw = draft.requestTimeoutMs.trim();
        let timeoutValue;
        if (timeoutRaw !== '') {
          const parsed = Number(timeoutRaw);
          if (!Number.isInteger(parsed) || parsed < 0) {
            setNotice({ kind: 'err', text: t('notice.timeoutInvalid', 'Request timeout must be a whole number of milliseconds, or blank for the default.') });
            return;
          }
          timeoutValue = parsed;
        }
        const ops = [];
        if (baseUrlRaw !== textOr(value.baseUrl, '').trim()) {
          ops.push(baseUrlRaw === '' ? { op: 'unset', path: ['baseUrl'] } : { op: 'set', path: ['baseUrl'], value: baseUrlRaw });
        }
        const model = draft.model.trim();
        if (model !== textOr(value.model, '').trim()) {
          ops.push(model === '' ? { op: 'unset', path: ['model'] } : { op: 'set', path: ['model'], value: model });
        }
        const persistedTimeout = value.requestTimeoutMs === undefined || value.requestTimeoutMs === null ? '' : String(value.requestTimeoutMs);
        if (timeoutRaw !== persistedTimeout) {
          ops.push(timeoutRaw === '' ? { op: 'unset', path: ['requestTimeoutMs'] } : { op: 'set', path: ['requestTimeoutMs'], value: timeoutValue });
        }
        if (draft.apiKey !== '') ops.push({ op: 'set', path: ['apiKey'], value: draft.apiKey });
        if (draft.controlToken !== '') ops.push({ op: 'set', path: ['controlToken'], value: draft.controlToken });
        if (ops.length === 0) {
          setNotice({ kind: 'ok', text: t('notice.noop', 'No changes to save.') });
          return;
        }
        setSaving(true);
        try {
          const accepted = await form.mutate(ops, snapshot.revision);
          if (!accepted) {
            setNotice({ kind: 'err', text: t('notice.refused', 'The Host refused the change. Reload the page and try again.') });
            return;
          }
          setDirty(false);
          setDraft((current) => ({ ...current, apiKey: '', controlToken: '' }));
          setNotice({ kind: 'ok', text: t('notice.saved', 'Saved. The plugin applies the change without a restart.') });
          // The host's proxy reads the saved configuration, so refresh the probe with it.
          check({ summary: false });
        } catch (error) {
          setNotice({ kind: 'err', text: sanitizeText(error) });
        } finally {
          setSaving(false);
        }
      }

      /** Clear one secret through the Host; the page forgets its own copy too. */
      async function clearSecret(field) {
        if (!writable) return;
        setSaving(true);
        try {
          const accepted = await form.unset(field);
          if (!accepted) {
            setNotice({ kind: 'err', text: t('notice.refused', 'The Host refused the change. Reload the page and try again.') });
            return;
          }
          setDraft((current) => ({ ...current, [field]: '' }));
          setNotice({ kind: 'ok', text: t('notice.cleared', 'Cleared.') });
          check({ summary: false });
        } catch (error) {
          setNotice({ kind: 'err', text: sanitizeText(error) });
        } finally {
          setSaving(false);
        }
      }

      /** Edit one draft field and mark the form dirty. */
      const edit = (field, next) => {
        setDirty(true);
        setDraft((current) => ({ ...current, [field]: next }));
      };

      const disabled = !writable || saving;
      const payload = probe.payload && typeof probe.payload === 'object' ? probe.payload : {};
      const service = payload.service && typeof payload.service === 'object' ? payload.service : {};
      const account = payload.auth && typeof payload.auth === 'object' ? payload.auth : null;
      const catalogue = React.useMemo(() => readModels(probe.payload), [probe.payload]);
      const controlBase = textOr(payload.controlBase, '');
      const signInUrl = textOr(payload.authPageUrl, '') || undefined;
      const modelOptions = React.useMemo(() => {
        const ids = catalogue.supported.slice();
        const current = draft.model.trim();
        if (current !== '' && ids.indexOf(current) === -1) ids.unshift(current);
        return ids;
      }, [catalogue, draft.model]);

      const serviceState = probe.state === 'ready'
        ? (service.reachable === true
          ? `${t('status.reachable', 'reachable')}${typeof service.status === 'string' && service.status !== '' ? ` (${sanitizeText(service.status)})` : ''}`
          : t('status.unreachable', 'unreachable'))
        : probe.state === 'loading' ? t('status.checking', 'checking…')
          : probe.state === 'error' ? t('status.unavailable', 'unavailable') : t('status.unknown', 'not checked');
      const catalogueState = probe.state === 'ready'
        ? `${catalogue.supported.length} ${t('catalogue.supported', 'supported')} / ${catalogue.total}`
        : probe.state === 'loading' ? t('status.checking', 'checking…') : t('catalogue.idle', 'Catalogue not loaded yet.');
      const authState = account !== null && account.configured === true
        ? textOr(account.state, t('status.unknown', 'not checked'))
        : (probe.state === 'ready' ? t('status.authUnconfigured', 'control token required') : t('status.unknown', 'not checked'));
      const statusDetail = probe.state === 'error'
        ? probe.error
        : probe.state === 'ready' && service.reachable !== true && typeof service.error === 'string' && service.error !== ''
          ? sanitizeText(service.error)
          : '';

      const rows = [
        [t('status.service', 'Service'), serviceState],
        [t('status.version', 'Version'), probe.state === 'ready' ? textOr(service.version, '—') : '—'],
        [t('status.controlBase', 'Control base'), probe.state === 'ready' ? (controlBase || '—') : '—'],
        [t('status.configuredBase', 'Configured base'), describeEndpoint(draft.baseUrl)],
        [t('status.catalogue', 'Catalogue'), catalogueState],
        [t('status.auth', 'Account'), authState],
      ];

      const field = (label, control, hint) => h('label', { className: 'dcw-field' },
        h('span', { className: 'dcw-label' }, label),
        control,
        hint === undefined ? null : h('span', { className: 'dcw-hint' }, hint));

      const cell = ([label, text]) => h('div', { key: label, className: 'dcw-cell' },
        h('div', { className: 'dcw-cell-label' }, label),
        h('div', { className: 'dcw-cell-value', title: String(text) }, String(text)));

      const secretField = (name, label, hint) => {
        const configured = secretSet[name] === true;
        return h('div', { className: 'dcw-field' },
          h('div', { className: 'dcw-secret-head' },
            h('span', { className: 'dcw-label' }, label),
            h('span', { className: configured ? 'dcw-badge dcw-badge-on' : 'dcw-badge' },
              configured ? t('secrets.configured', 'Configured') : t('secrets.unconfigured', 'Not configured'))),
          h('div', { className: 'dcw-secret-row' },
            h('input', {
              className: 'dcw-input', type: 'password', value: draft[name], autoComplete: 'new-password', spellCheck: false, disabled,
              placeholder: configured ? t('secrets.replace', 'Configured — type to replace') : t('secrets.enter', 'Not configured — type to set'),
              onChange: (event) => edit(name, event.target.value),
            }),
            h('button', {
              type: 'button', className: 'dcw-btn dcw-btn-secondary', disabled: disabled || (!configured && draft[name] === ''),
              onClick: () => { void clearSecret(name); },
            }, t('secrets.clear', 'Clear'))),
          h('span', { className: 'dcw-hint' }, hint));
      };

      return h('div', { className: 'dcw-root' },
        h('style', null, CSS),
        h('header', { className: 'dcw-head' },
          h('h2', null, t('section.title', 'ChatGPT Web')),
          h('p', { className: 'dcw-muted' }, t('section.intro', 'Registers the container service as a text-only model provider.')),
          ready
            ? (writable ? null : h('p', { className: 'dcw-notice dcw-notice-err' }, t('form.readOnly', 'This profile does not accept settings writes.')))
            : h('p', { className: 'dcw-muted' }, t('form.loading', 'Waiting for the Host configuration…'))),

        h('section', { className: 'dcw-card' },
          h('h3', null, t('form.title', 'Connection')),
          field(t('form.baseUrl', 'Service base URL'), h('input', {
            className: 'dcw-input', type: 'url', value: draft.baseUrl, spellCheck: false, autoComplete: 'off', disabled,
            placeholder: textOr(base.baseUrl, 'http://host:port'),
            onChange: (event) => edit('baseUrl', event.target.value),
          }), t('form.baseUrlHint', 'The service root; may include /p/<profile>.')),
          field(t('form.model', 'Model'), h('select', {
            className: 'dcw-input', value: draft.model, disabled: disabled || probe.state === 'loading',
            onChange: (event) => edit('model', event.target.value),
          },
            draft.model === '' ? h('option', { key: '__none', value: '' }, t('catalogue.idle', 'Catalogue not loaded yet.')) : null,
            modelOptions.map((id) => h('option', { key: id, value: id }, id))),
          t('form.modelHint', 'Catalogue routes served by the service: chatgpt-web/* and qwen-chat/*.')),
          field(t('form.timeout', 'Request timeout (ms)'), h('input', {
            className: 'dcw-input', type: 'number', min: 0, step: 1, value: draft.requestTimeoutMs, disabled,
            onChange: (event) => edit('requestTimeoutMs', event.target.value),
          }), t('form.timeoutHint', '0 means no client-side timeout.')),
          h('div', { className: 'dcw-row' },
            h('button', { type: 'button', className: 'dcw-btn', disabled: disabled || !dirty, onClick: () => { void save(); } }, t('form.save', 'Save')),
            notice === null ? null : h('span', { className: `dcw-notice dcw-notice-${notice.kind}` }, notice.text))),

        h('section', { className: 'dcw-card' },
          h('h3', null, t('secrets.title', 'Secrets')),
          h('p', { className: 'dcw-muted' }, t('secrets.intro', 'Write-only: the Host never returns these values.')),
          secretField('apiKey', t('secrets.apiKey', 'Service API key'), t('secrets.apiKeyHint', 'Used by the plugin host to read the model catalogue.')),
          secretField('controlToken', t('secrets.controlToken', 'Control token'), t('secrets.controlTokenHint', 'Used by the plugin host for status and sign-in reads.'))),

        h('section', { className: 'dcw-card' },
          h('h3', null, t('status.title', 'Service status')),
          h('div', { className: 'dcw-grid' }, rows.map(cell)),
          statusDetail === '' ? null : h('p', { className: 'dcw-notice dcw-notice-err', style: { marginTop: '8px' } }, statusDetail),
          h('div', { className: 'dcw-row', style: { marginTop: '10px' } },
            h('button', { type: 'button', className: 'dcw-btn', onClick: () => check({ summary: true }) }, t('status.test', 'Test connection')),
            signInUrl === undefined ? null : h('a', {
              className: 'dcw-link', href: signInUrl, target: '_blank', rel: 'noopener noreferrer',
            }, t('status.signIn', 'Sign in…'))),
          h('p', { className: 'dcw-hint', style: { marginTop: '8px' } }, t('status.signInHint', 'Opens the service sign-in page in a new tab.')),
          h('p', { className: 'dcw-hint' }, t('status.hostHint', 'Status is read by the plugin host; the browser never contacts the service directly.')),
          account === null ? null : h('div', { className: 'dcw-auth' },
            h('div', { className: 'dcw-auth-row' },
              h('span', null, t('status.auth', 'Account')),
              h('span', { className: 'dcw-auth-state' }, authState),
              typeof account.detail === 'string' && account.detail !== ''
                ? h('span', { className: 'dcw-auth-reason' }, sanitizeText(account.detail))
                : null))));
    }

    return {
      // `configForms` owns the Host-side values and writes; `slots` and `locale` are the page's
      // composition and text services. No `remote` namespace is needed: the form writes through the
      // settings provider's own context.
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { en: DICT_EN });
          } catch {
            return () => {};
          }
        }, 'dsh-chatgpt-web: settings dictionaries');

        let translate;
        try {
          translate = ctx.locale.bind(NS);
        } catch {
          translate = undefined;
        }
        const t = makeT(translate);

        const configForms = ctx.configForms;
        if (configForms === undefined || typeof configForms.get !== 'function' || typeof configForms.describe !== 'function') return;
        const form = configForms.get(NS);
        const describe = configForms.describe();

        // One page, one seat: the section id is the settings namespace, so the Host's section
        // navigation and `configForms.get(NS)` address the same entry.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 22,
          label: () => t('section.nav', 'ChatGPT Web'),
          locale: NS,
          inject: () => ({ form, describe, tr: t }),
        }, ChatGptWebSettings));
      },
      // Pure helpers, exported for a deterministic harness: the page itself never calls them.
      __test: { validateBaseUrl, readModels, sanitizeText, readTimeoutMs, isSupportedModel, describeEndpoint },
    };
  },
});
