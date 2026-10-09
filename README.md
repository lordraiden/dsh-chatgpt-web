# dsh-chatgpt-web

[English](./README.md) | [中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Cordis%20Plugin-0078d4?style=flat)](https://github.com/deepseek-ai/deepseek-harness)

> **DeepSeek Harness Cordis plugin that bridges authenticated consumer-web chat into DSH. Today the production provider is ChatGPT Web; the codebase is being evolved toward a shared text-only WebChat architecture for additional web providers.**

<p align="center">
  <img src="./assets/hero-demo.png" alt="dsh-chatgpt-web in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="dsh-chatgpt-web Interactive Demo" width="100%">
</p>

---

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [ChatGPT Advisor](#chatgpt-advisor)
- [Diagnostics & Health Check](#diagnostics--health-check)
- [Troubleshooting](#troubleshooting)
- [Notes & Limitations](#notes--limitations)
- [Related Documentation](#related-documentation)

---

## Overview

**dsh-chatgpt-web** currently exposes an authenticated ChatGPT Web session to DeepSeek Harness (DSH) as a native `ctx.llm` provider. The local `/v1/responses` endpoint remains a compatibility ingress for clients that need it; it is not the native DSH provider boundary.

The repository is being refactored toward a provider-neutral **WebChat Core** for authenticated, text-only consumer-web chat providers. ChatGPT Web is the current production implementation. Qwen Chat and DeepSeek Chat are planned provider implementations under the architecture and roadmap; they are **not yet available features in the current release**.

### Current provider status

| Provider | Status | Scope |
| --- | --- | --- |
| ChatGPT Web | **Available** | Current production provider. Authenticated consumer-web text chat, streaming, reasoning/mode handling, continuity, cancellation and existing ChatGPT-specific compatibility surfaces. |
| Qwen Chat | **Planned** | Text-only WebChat provider. Architecture and implementation work are tracked separately; no Qwen route is advertised as available yet. |
| DeepSeek Chat | **Planned** | Text-only WebChat provider. Architecture and implementation work are tracked separately; no DeepSeek Web route is advertised as available yet. |

### Architecture and capability boundaries

The architecture has an explicit ownership model:

- **DSH remains authoritative for provider routing and DSH lifecycle.** WebChat must not create a competing public provider-selection authority.
- **The DSH session/history remains canonical.** A provider conversation is a continuity handle, not a replacement transcript.
- **WebChat Core owns provider-neutral conversation affinity, exchange lifecycle, continuation/recovery semantics, cancellation, retry classification and normalized text events.**
- **Each provider owns authentication/session behavior, model mapping, provider conversation identifiers/cursors, transport mechanics and provider-specific recovery.**
- **Browser automation is a transport mechanism, not the universal architecture.** A provider may use DOM, browser-network or hybrid exchange.
- **The common WebChat scope is text-only.** Files, images, MCP, DSH tools, computer-use and provider-native agent loops are not shared WebChat features.
- **Native Codex passthrough remains separate.** It is not part of the ChatGPT Web provider nor the future text-only WebChat contract.
- **The local `/v1/responses` compatibility ingress converges on the normal ChatGPT Web execution path rather than owning a second browser execution engine.**

The definitive ownership and recovery rules live in [`doc/architecture.md`](./doc/architecture.md). The multi-provider implementation roadmap is tracked in issues [#189](https://github.com/lordraiden/dsh-chatgpt-web/issues/189) through [#199](https://github.com/lordraiden/dsh-chatgpt-web/issues/199).

### Key Features

- **Native DSH provider:** Registers `chatgpt-web` through DSH's `ctx.llm` runtime and reuses the authenticated browser-backed route without an OpenAI API key.
- **Cordis Plugin-First Lifecycle:** Managed by DSH via `ctx.effect`. DeepSeek Harness starts the background sidecar automatically on launch and shuts it down on exit.
- **Runtime model/account discovery:** Detects the ChatGPT Web account/model surface available to the authenticated session.
- **Streaming and provider semantics:** Exposes streamed text, reasoning, usage, errors, and cancellation through the DSH-facing transport.
- **ChatGPT Advisor:** Reviews the last completed turn in a separate retained ChatGPT Web conversation and hands the review back to DSH on request.
- **Control and diagnostics surfaces:** Includes setup/login/doctor tooling plus a local control surface for transport status and tuning.
- **Portable, Validated Artifacts:** The published tarball is validated by CI (clean install, runtime smoke test, dependency resolution, no build-environment path contamination) before it can reach the registries.

---

## Requirements

- **Runtime:** Node.js `>=22.19.0` **or** Bun `>=1.3.0` (both are supported; the CLI runs on either).
- **DeepSeek Harness:** `>=0.2.0-rc.2`.
- **Browser:** Chrome or Chromium on your machine (used for the one-time sign-in and for serving).

---

## Quick Start

### 1. Installation

Install the plugin directly from this GitHub repository:

```bash
dsh plugin --profile <profile> add github:lordraiden/dsh-chatgpt-web
```

The package is distributed only through the repository's private GitHub Packages npm registry; it is not published to npmjs.com.

Configure the `@lordraiden` scope for the profile before installing or updating the package:

```ini
@lordraiden:registry=https://npm.pkg.github.com
```

Authenticate separately with a GitHub personal access token (classic) that has `read:packages` access. Store the token in the user's `~/.npmrc` or the environment used to start DSH; never commit it.

For example:

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then install or update normally:

```bash
dsh plugin --profile <profile> add @lordraiden/dsh-chatgpt-web
dsh plugin --profile <profile> update @lordraiden/dsh-chatgpt-web
```

The package is versioned with SemVer tags such as `v1.0.17`; the exact available version is always determined by the matching tag/package release. A release is considered available only after the matching private GitHub Packages version has been published.

This registers the plugin in the profile's `package.json` bundles, so its Cordis entries are composed automatically — no manual `insert` is needed.

### 2. One-Time Browser Sign-In

Authenticate your ChatGPT account once. The plugin binary lives in the profile's `node_modules/.bin`:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup
```

A dedicated Chrome/Chromium window will open. Log into your OpenAI / ChatGPT account. Once the ChatGPT composer is visible, the setup captures the session and writes the config and browser state to the plugin's storage directory (default `~/.dsh/storages/chatgpt-web/`).

If your browser is not at the default path, pass it explicitly:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --chrome /path/to/chrome
```

#### Using a snap-confined browser (e.g. snap Chromium)

Snap-confined browsers can only write to **non-hidden** paths in `$HOME`. The plugin's default storage directory (`~/.dsh/storages/chatgpt-web/`) is hidden, so a snap browser cannot create its profile lock there and setup fails with:

```text
Failed to create .../login-profile-XXXX/SingletonLock: Permission denied (13)
```

The fix is to point the plugin's storage home at a **non-hidden** directory using the `DSH_CHATGPT_WEB_HOME` environment variable.

**How the variable works:** `VAR=value command` is standard shell syntax — it sets the environment variable *only for that one command* and does not persist it. The plugin reads `DSH_CHATGPT_WEB_HOME` on startup; when set, every file it owns (config, browser profile, storage state) lives under that directory instead of `~/.dsh/storages/chatgpt-web/`.

**Step by step:**

1. **Run the one-time setup with the variable applied to the command:**

   ```bash
   DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web" \
     ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --chrome /snap/bin/chromium
   ```

   The browser window opens; log in to ChatGPT. The session is saved under `~/dsh-chatgpt-web/`.

2. **Persist the variable for the shell that starts DSH.** The background sidecar is started by DeepSeek Harness and inherits DSH's environment — it does *not* inherit a one-off `VAR=value` prefix from your terminal. So export the variable in your shell (e.g. `~/.bashrc`), then start DSH from that shell:

   ```bash
   # add to ~/.bashrc (or ~/.zshrc):
   export DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web"

   # reload, then start DSH in that shell:
   source ~/.bashrc
   dsh --profile <profile> web
   ```

   The sidecar now finds the same `config.json` and browser state that setup created.

3. **Verify with the doctor** (run it in the same environment):

   ```bash
   ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
   ```

> **Important:** every command that touches the plugin state — `setup`, `login`, `doctor`, and the DSH process that runs the sidecar — must see the **same** `DSH_CHATGPT_WEB_HOME`. If some of them use the hidden default path and others use the non-hidden one, the sidecar will report `Configuration is missing`.

### 3. Select the native DSH provider

The plugin registers the `chatgpt-web` provider directly through DSH's `ctx.llm` runtime. Native DSH calls do **not** require an `llm-pi-ai` provider entry, an OpenAI Responses URL, or a second provider configuration.

To make ChatGPT Web the default model for newly created agents, configure the standard DSH default-model entry:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    # Choose one route currently exposed by the authenticated ChatGPT Web catalog, for example:
    # model: chatgpt-web/light       # accounts with the Sol model-selector route
    # model: chatgpt-web/luna        # Luna-only accounts
```

Available ChatGPT Web model routes are resolved from the authenticated product capability state. The plugin supports normal ChatGPT Web usage on supported Free and paid accounts. For Luna-only accounts, `chatgpt-web/luna` and `chatgpt-web/think` use the same GPT-5.6 Luna backend; Think selects Luna's higher-reasoning mode through the ChatGPT Web control. Routes whose usage belongs to the Codex/Work allocation are outside this provider and remain unavailable through `chatgpt-web`.

Start DeepSeek Harness with the profile:

```bash
dsh --profile <profile> web
```

The plugin registers the provider, starts its local browser sidecar, and connects it to the authenticated ChatGPT Web session.


## Configuration Reference

This section is the user-facing configuration reference for the current integration/staging runtime. The native DSH path is the primary configuration. The local /v1/responses endpoint remains a compatibility ingress and does not need a separate provider configuration for native ctx.llm calls.

### Native DSH provider configuration

The plugin registers the provider through DSH's ctx.llm runtime. For a normal DSH installation, do not add an OpenAI API key, an openai-responses provider entry, or a second ChatGPT provider just to use the native integration.

To make ChatGPT Web the default model for new agents, use DSH's normal default-model configuration:

~~~
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    # Pick a route that the authenticated account currently exposes.
    # model: chatgpt-web/light
~~~

The old localhost /v1/responses provider snippet printed by older plugin releases is not the native DSH configuration. On current staging, ctx.llm is the canonical boundary.

### WebUI configuration

On DSH 0.2, the plugin's supported configuration UI is exposed on the **Plugins** page, in the `@lordraiden/dsh-chatgpt-web` bundle details. The page is backed by the plugin's exported DSH `Config` schema and `configForms`; it does not create a second settings namespace or persist values in browser storage.

The live runtime fields exposed there are:

| Setting | Default | Meaning |
| --- | --- | --- |
| Sidecar port | `17841` | Loopback-only port used by the plugin's local sidecar. |
| Start sidecar automatically | `true` | Whether the plugin starts/stops the sidecar automatically with the DSH plugin lifecycle. |
| Sidecar ready timeout | `30000` ms | Maximum time the plugin waits for a newly started sidecar to become healthy. |

These are DSH volatile configuration fields, so edits apply without remounting the plugin. Resetting the fields removes the profile-level override and returns to the schema defaults. Runtime tuning such as browser composer and DOM grace limits remains a sidecar-owned advanced setting and is available from the plugin configuration page only after authenticating to the loopback control API with the ephemeral control token.

The WebUI does **not** expose Tunnel IDs, runtime keys, browser ownership, login state, connector identities, or model-route selection as ordinary switches. Those remain setup/Launcher/security boundaries, while model selection remains DSH's native Models surface.

### Setup modes

There are two main runtime modes, plus an explicit Zero Risk browser interaction mode.

| Mode | Use case | Browser control | Tunnel required |
| --- | --- | --- | --- |
| browser-only | Native DSH + local authenticated ChatGPT Web | Plugin-managed Chrome/Chromium | No |
| full | Browser mode plus the optional Codex/Tunnel integration surface | Plugin-managed Chrome/Chromium or Launcher | Yes |
| full + zero-risk-browser-interaction | Manual model selection and prompt submission through the Launcher | Launcher-owned browser; ChatGPT DOM automation disabled | Yes, with a separate Zero Risk tunnel |

For the native DSH provider, browser-only is the simplest configuration. full is only needed when the additional tunnel/Codex integration is required.

### setup options

Run:

~~~
dsh-chatgpt-web setup [options]
~~~

| Option | Description |
| --- | --- |
| --browser-only | Select the local browser-only runtime. This is the normal choice when using native ctx.llm. |
| --full | Enable the full runtime, including the OpenAI MCP Tunnel/Codex integration surface. Full mode requires a Tunnel ID and runtime key. |
| --preflight-only | Validate browser/runtime/Tunnel prerequisites and Codex integration state without committing a new setup. |
| --port PORT | Sidecar port. Default: 17841. The sidecar remains loopback-only. |
| --chrome PATH | Explicit Chrome/Chromium executable path. Use this when the browser is not at the detected default path. |
| --login | Perform an interactive ChatGPT login as part of setup. |
| --acknowledge-unofficial | Store the required acknowledgement that the browser automation is unofficial software. Interactive setup can ask for the acknowledgement when it is not already stored. |
| --automatic-browser-interaction | Select automatic browser interaction. This is the default unless Zero Risk is explicitly selected. |
| --zero-risk-browser-interaction | Select Zero Risk/manual interaction. Requires --full and a Launcher browser-host descriptor. ChatGPT model selection and prompt submission remain under user control. |
| --browser-host-descriptor PATH | Use a running DSH/Codex Launcher browser host instead of a plugin-managed browser. This selects Launcher ownership. |
| --refresh-account-capabilities | Re-inspect the authenticated account's Web capability state instead of relying on the existing stored capability snapshot. Not available in Zero Risk mode. |
| --app-name NAME | Set the automatic ChatGPT connector name. The reserved Codex Zero Risk name is not accepted here. |
| --tunnel-id ID | Supply the OpenAI MCP Tunnel ID for the selected interaction mode. Automatic and Zero Risk modes require separate Tunnel IDs. |
| --runtime-key-file PATH | Supply the runtime key file for the selected Tunnel. |
| --auto-approve-tool-calls | Enable automatic approval of browser-bridge tool calls. This reduces approval friction and weakens the normal interactive approval boundary; use only when that trade-off is intentional. |
| --bigger-context | Enable the experimental larger-context profile for automatic browser interaction. The exact effective capacity is still bounded by the account/model transport limits. Incompatible with Zero Risk. |
| --standard-context | Disable the experimental larger-context profile and return to the standard profile. |
| --zero-risk-pro | In Zero Risk mode, expose the additional Pro-sized manual route. It does not verify that the user selected Pro; it only enables the Pro-sized profile. |
| --zero-risk-default | In Zero Risk mode, keep the default manual Zero Risk profile and disable the additional Pro-sized route. |
| --subagent-protocol compatibility-v1 or native | Select the Codex subagent protocol used by the separate Codex integration surface. This does not change the native ctx.llm provider boundary. |
| --replace-codex-route | Allow setup to replace an existing Codex route during integration setup. This affects the separate first-party Codex integration, not native ChatGPT Web model accounting. |
| --restart-service | Restart the installed sidecar/service after setup. When reconfiguring an existing installation, the runtime control token is rotated. |

The flags --browser-only and --full are mutually exclusive. The two browser-interaction flags are mutually exclusive. The two Zero Risk model-profile flags are mutually exclusive.

For full mode, setup can prompt interactively for the Tunnel ID and runtime key when they are not already stored. Runtime keys are stored privately by the plugin; do not put them in a repository or shell history.

### Global and runtime commands

The plugin CLI also exposes the following operational configuration surfaces.

| Command | Syntax | Purpose |
| --- | --- | --- |
| doctor | dsh-chatgpt-web doctor [--json] | Validate configuration, browser availability, authentication evidence, and sidecar health. --json emits machine-readable diagnostics. |
| login | dsh-chatgpt-web login | Re-authenticate the configured browser session. Launcher-owned authentication must be performed through the Launcher. |
| browser check | dsh-chatgpt-web browser check | Verify that the configured browser can be reached/launched. |
| serve | dsh-chatgpt-web serve [--host 127.0.0.1] [--port PORT] | Run the local compatibility sidecar manually. The host is intentionally restricted to 127.0.0.1. |
| route | dsh-chatgpt-web route status or connect or disconnect | Inspect or control the separate Codex route integration. It is not the native ctx.llm provider. |
| subagents | dsh-chatgpt-web subagents status or compatibility-v1 or native | Inspect or select the separate Codex subagent protocol. |
| service | dsh-chatgpt-web service status or install or start or restart or stop or cancel-turns | Inspect or control the installed background service and cancel active browser turns when necessary. |
| tunnel | dsh-chatgpt-web tunnel status or start or restart or stop or key-import | Inspect/control the full-mode MCP Tunnel and import a runtime key securely. |
| open | dsh-chatgpt-web open tunnels or runtime-keys or connectors | Print/open the relevant OpenAI or ChatGPT management page. |
| uninstall | dsh-chatgpt-web uninstall --yes [--keep-data] | Remove the integration, restore managed Codex configuration where applicable, and optionally preserve private plugin data. |

--home, --help, and --version are global options:

~~~
dsh-chatgpt-web --home PATH doctor
dsh-chatgpt-web --help
dsh-chatgpt-web --version
~~~

The dev, mcp, and hook interrupt commands are integration/development plumbing rather than normal end-user configuration interfaces. Their exact contracts may change independently of the supported installation path.

### Storage and environment variables

By default, plugin state is stored under:

~~~
~/.dsh/storages/chatgpt-web/
~~~

The main configuration file is:

~~~
~/.dsh/storages/chatgpt-web/config.json
~~~

The browser authentication state is kept in the same private storage tree. Do not commit this directory or copy its contents into a repository.

For environments where the default hidden directory cannot be used by the browser, set:

~~~
export DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web"
~~~

DSH_CHATGPT_FREE_HOME is retained as a compatibility alias for the plugin home. Prefer DSH_CHATGPT_WEB_HOME in new configurations.

Advanced runtime selection variables also exist for managed Bun/Launcher execution:

- DSH_CHATGPT_WEB_BUN / DSH_CHATGPT_FREE_BUN can provide an explicit durable Bun executable.
- DSH_CHATGPT_FREE_LAUNCHER can provide an explicit launcher executable.
- DSH_CHATGPT_FREE_BROWSER_HOST_DESCRIPTOR and DSH_CHATGPT_FREE_LAUNCHER_CONTROL_TOKEN are Launcher-controlled plumbing variables. Users should not set or persist these manually; the active Launcher supplies them for authorized operations.

The plugin also uses internal/generated environment and control values. Those are not configuration knobs and should not be copied into service files or shell profiles unless a documented integration explicitly requires them.

### Persisted config.json

The plugin writes a versioned JSON configuration. Most installations should be configured with setup; direct editing is mainly useful for advanced tuning or controlled recovery.

User-relevant persisted settings include:

| Field | Meaning |
| --- | --- |
| mode | browser-only or full. |
| browserInteractionMode | automatic or manual (Zero Risk). |
| subagentProtocol | compatibility-v1 or native for the separate Codex subagent surface. |
| port | Loopback sidecar port. Default: 17841. |
| chromeExecutablePath | Browser executable path for plugin-managed Chrome/Chromium. |
| experimentalBiggerContext | Whether the automatic larger-context profile is enabled. |
| zeroRiskProEnabled | Whether the additional Pro-sized Zero Risk route is exposed. |
| autoApproveToolCalls | Whether browser-bridge tool approvals are automatically accepted. |
| stallTimeoutSec | Optional advanced watchdog timeout for the Responses compatibility surface. It is independent of native DSH model selection. |
| tuning | Optional browser transport tuning described below. |
| appName / automaticAppName | Connector identity used by the full integration. |
| browserHostDescriptorPath | Launcher browser-host descriptor when Launcher ownership is active. |

Generated/private fields such as controlToken, storageStatePath, brokerSocketPath, account capability state, runtime command, and Tunnel credentials should normally be managed by the plugin rather than hand-edited.

Do not manually set `contextWindow` to override the effective ChatGPT model capacity. New configurations no longer write this legacy field. The provider derives its compatibility context value from the selected ChatGPT Web route and authenticated capability state; a local number cannot create upstream capacity that the account/product does not expose.

### Browser transport tuning

The optional tuning object controls transport timing and the visible composer boundary. Defaults are applied per field when a key is absent.

Example:

~~~
{
  "tuning": {
    "composerCharLimit": 120000,
    "responseDomGraceMs": 60000,
    "responseDomGraceMaxMs": 240000,
    "responseDomGracePerCharMs": 2.5,
    "sendEnableGraceMs": 5000
  }
}
~~~

| Key | Default | Meaning |
| --- | ---: | --- |
| composerCharLimit | 120000 | Maximum visible composer characters accepted by the Luna browser transport. |
| responseDomGraceMs | 60000 | Minimum grace period for the first assistant token. |
| responseDomGraceMaxMs | 240000 | Maximum first-token DOM grace period. Must not be lower than responseDomGraceMs. |
| responseDomGracePerCharMs | 2.5 | Additional first-token grace, in milliseconds per visible prompt character, clamped to the floor/ceiling above. |
| sendEnableGraceMs | 5000 | Time allowed for the send control to become enabled after the complete prompt is attached. |
| turnTimeoutMs | unset | Optional absolute ceiling for a browser turn. When absent, there is no tuning-level absolute deadline. |

All tuning values must be finite positive numbers. Unknown tuning keys are rejected. turnTimeoutMs is optional; the other defaults are always available.

Tuning does not override account/model transport limits. For example, a larger composerCharLimit does not make the ChatGPT Web composer accept a larger payload if the selected product route cannot transport it safely.

### Model and account configuration

Model availability is determined from the authenticated ChatGPT Web product capability state, not from a hard-coded assumption about Free vs paid.

Automatic routes currently exposed by the provider are:

| Route | Product surface |
| --- | --- |
| chatgpt-web/luna | Luna-only accounts without the Sol model selector |
| chatgpt-web/think | Luna-only accounts using Luna's Think reasoning mode |
| chatgpt-web/light | Sol/Instant |
| chatgpt-web/medium | Sol/Medium |
| chatgpt-web/high | Sol/High |
| chatgpt-web/extra-high | Pro-gated |
| chatgpt-web/pro | Pro-gated |

Zero Risk routes are:

| Route | Meaning |
| --- | --- |
| chatgpt-web/zero-risk | Manual browser interaction with the user selecting the ChatGPT model and submitting the prompt. |
| chatgpt-web/zero-risk-pro | Optional Pro-sized manual profile enabled explicitly by --zero-risk-pro. |

The route list is a capability catalogue, not a promise that every account has every route. For automatic accounts, the runtime only enables routes established by the authenticated product surface. Unknown or unverifiable capability state fails closed.

Do not configure the provider by backend model IDs such as gpt-5.6-sol or gpt-5.6-luna. Those are internal transport identities; users select the public chatgpt-web/... route.

### Context and model limits

The plugin reports practical Web transport capacity rather than blindly exposing the underlying model's theoretical context.

Important current limits include:

- Luna automatic transport uses a measured composer boundary around 120000 characters and a model context window of about 1050000 tokens, with browser-side safeguards and rolling checkpoints.
- Automatic Sol routes use account/effort-specific practical windows. Non-Pro accounts expose smaller measured browser envelopes than Pro accounts.
- Pro routes use larger measured message and context limits.
- Zero Risk uses a fixed multi-turn manual context profile; the optional Pro profile is larger but still depends on manually selecting the appropriate ChatGPT product mode.
- --bigger-context multiplies the eligible automatic context profile, but it does not remove browser composer, account, or product limits and is unavailable in Zero Risk.

Treat these values as implementation limits for the current release, not as guarantees of what ChatGPT will expose permanently. The authenticated product capability state remains authoritative.

### Full mode: Tunnel and runtime key configuration

Full mode is separate from the native DSH provider. It adds the OpenAI MCP Tunnel/Codex integration surface and therefore needs an OpenAI Tunnel and a runtime key with the required tunnel permissions.

Interactive setup:

~~~
dsh-chatgpt-web setup --full
~~~

Non-interactive setup can supply both values:

~~~
dsh-chatgpt-web setup --full \
  --tunnel-id <TUNNEL_ID> \
  --runtime-key-file /secure/path/runtime-key
~~~

A runtime key can also be imported into the plugin-managed private location:

~~~
dsh-chatgpt-web tunnel key-import
~~~

Automatic and Zero Risk interaction modes require different Tunnel IDs and separate ChatGPT connector identities. Do not reuse one Tunnel ID between the two modes.

### Zero Risk configuration

Zero Risk keeps model selection and prompt submission under user control through the Launcher. It intentionally disables ChatGPT DOM inspection/automatic submission.

Typical setup:

~~~
dsh-chatgpt-web setup \
  --full \
  --zero-risk-browser-interaction \
  --browser-host-descriptor <LIVE_LAUNCHER_DESCRIPTOR> \
  --tunnel-id <ZERO_RISK_TUNNEL_ID>
~~~

Enable the additional Pro-sized manual route only when you intend to manually select a Pro product mode:

~~~
dsh-chatgpt-web setup \
  --full \
  --zero-risk-browser-interaction \
  --browser-host-descriptor <LIVE_LAUNCHER_DESCRIPTOR> \
  --tunnel-id <ZERO_RISK_TUNNEL_ID> \
  --zero-risk-pro
~~~

Zero Risk cannot use --bigger-context, cannot refresh account capabilities through the automatic probe, and cannot use the plugin's --login flow because authentication is owned by the Launcher.

### Security-sensitive settings

Treat the following as security-sensitive:

- browser authentication state;
- Tunnel runtime keys;
- the sidecar control token;
- Launcher control variables;
- --auto-approve-tool-calls;
- full-mode connector configuration.

The plugin keeps private files in its storage directory with restrictive permissions where the platform allows it. Never publish browser state, runtime keys, control tokens, or Launcher authorization material.

### Configuration precedence

For plugin storage location, the effective order is:

1. --home PATH for the current CLI invocation;
2. DSH_CHATGPT_FREE_HOME, retained as a compatibility alias;
3. DSH_CHATGPT_WEB_HOME;
4. ~/.dsh/storages/chatgpt-web;
5. legacy storage locations are considered only when the current default directory does not exist.

For browser path, an explicit --chrome setup value overrides automatic executable discovery.

For capability/model selection, the authenticated ChatGPT Web product surface is authoritative. Local route names or backend IDs cannot override a failed capability check.

## ChatGPT Advisor

The composer offers **Review with ChatGPT** on the last completed `user → assistant` turn of the session. The review carries that step only — the project name, the DSH agent preset it ran under, your review instructions, the last human request and the last final response — into a **separate retained ChatGPT Web conversation**, so a review never enters the DSH session history and never collides with the chat's own conversation.

The review dialog is a modal centred over the composer:

- **Model** — `Normal` (lightest non-Pro route) or `Think` (deepest non-Pro route).
- **DSH agent preset** — the presets this deployment composes, read from DSH (broken presets are not offered). It is preselected to the preset the session already runs and travels with the review as context: it labels the review, appears on the result card, and is carried into `Send to DSH`. It never composes a DSH session and never changes the model route. A deployment with no agent-preset registry simply offers `No preset`.
- **Review instructions** — editable, and remembered in this browser.
- **Context (read-only)** — the human request and the DSH response under review.

`Escape`, the close control and a click on the backdrop dismiss the dialog. A review that is already running is never cancelled by an outside click.

A successful review appears as a **ChatGPT Advisor** card in that turn's tail, with its mode, model and preset. **Send to DSH** submits the full review through the normal DSH prompt flow as a new prompt, and the plugin executes nothing by itself.

---

## Diagnostics & Health Check

Verify your setup at any time with the built-in diagnostic doctor:

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
```

Example healthy output:

```text
✓ Configuration is valid (~/.dsh/storages/chatgpt-web/config.json)
✓ Chrome executable found
✓ ChatGPT login state has authenticated browser evidence
✓ ChatGPT Web sidecar is healthy on 127.0.0.1:17841/healthz
Doctor result: ready
```

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues: browser executable paths, snap confinement, missing configuration, and runtime (Node/Bun) notes.

---

## Notes & Limitations

1. **Unofficial Web bridge:** The current ChatGPT provider operates through local browser automation on `chatgpt.com`. It is not the official OpenAI API and is not affiliated with or endorsed by OpenAI.
2. **Current concurrency behavior:** The current `main` implementation still contains an account-level ChatGPT browser lease that can prevent a second DSH chat from starting while another turn is active on the same authenticated account. This is an implementation limitation, not a fundamental WebChat architecture rule; the intended ownership model is one active turn per logical conversation with concurrency governed by isolated transport resources. The regression/fix is tracked in [#201](https://github.com/lordraiden/dsh-chatgpt-web/issues/201) / [#202](https://github.com/lordraiden/dsh-chatgpt-web/pull/202).
3. **Capability separation:** DSH-owned tools, skills, approvals, and sandbox policy remain under DSH authority; ChatGPT-native product capabilities must not be treated as DSH permissions.
4. **Product scope:** The current production provider supports authenticated ChatGPT Web model routes exposed by the account. Codex/Work-quota-bound routes are explicitly excluded. Availability remains subject to the authenticated product capability state and account-specific limits.
5. **Multi-provider roadmap:** Qwen Chat and DeepSeek Chat are architectural targets for the text-only WebChat layer, not current user-facing provider routes.

---

## Related Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup and contribution guidelines.
- [SECURITY.md](./SECURITY.md) — how the plugin handles your session credentials.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — diagnosing setup and runtime problems.
- [doc/architecture.md](./doc/architecture.md) — definitive provider architecture, ownership boundaries, and product-scope rules.
- [LICENSE](./LICENSE) — MIT.