# dsh-chatgpt-web

[English](./README.md) | [中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Cordis%20Plugin-0078d4?style=flat)](https://github.com/deepseek-ai/deepseek-harness)

> **DeepSeek Harness Cordis plugin that bridges an authenticated ChatGPT Web session into DSH.**

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
- [Diagnostics & Health Check](#diagnostics--health-check)
- [Troubleshooting](#troubleshooting)
- [Notes & Limitations](#notes--limitations)
- [Related Documentation](#related-documentation)

---

## Overview

**dsh-chatgpt-web** bridges an authenticated ChatGPT Web session into DeepSeek Harness (DSH), exposing the browser-backed model through a local provider/compatibility surface.

It uses headless or visible Chrome/Chromium automation against `chatgpt.com` and translates the web session into DSH-compatible model requests, streaming responses, reasoning, usage, errors, and cancellation semantics. The browser is an implementation detail of the provider; it is not an official OpenAI API.

### Architecture and capability boundaries

The project is designed around a clear ownership boundary:

- **DSH remains the runtime authority** for DSH sessions, tools, skills, approvals, sandbox policy, and provider lifecycle.
- **ChatGPT remains the model/provider surface** for model reasoning and ChatGPT-native product capabilities.
- **Browser automation is isolated transport machinery** that handles ChatGPT Web readiness, submission, streaming, completion, cancellation, and recovery.
- **Compatibility surfaces converge on the same provider execution path** rather than creating separate browser execution implementations.

The repository also contains optional/native integration paths that are intentionally distinct from the browser transport, including the native Codex passthrough and the local Responses compatibility surface.

### Key Features

- **Authenticated ChatGPT Web backend:** Reuses a local browser session instead of requiring an OpenAI API key for the browser-backed route.
- **Cordis Plugin-First Lifecycle:** Managed by DSH via `ctx.effect`. DeepSeek Harness starts the background sidecar automatically on launch and shuts it down on exit.
- **Runtime model/account discovery:** Detects the ChatGPT Web account/model surface available to the authenticated session.
- **Streaming and provider semantics:** Exposes streamed text, reasoning, usage, errors, and cancellation through the DSH-facing transport.
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

The published package can also be installed from the package registries:

```bash
dsh plugin --profile <profile> add @lordraiden/dsh-chatgpt-web
```

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

### 3. Enable in DeepSeek Harness

Provider configuration lives in the profile's Cordis patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`), not in a global settings file. Add the `chatgpt-web` provider under the existing `providers` map of the `llm-pi-ai` entry:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # ...your existing providers...
      chatgpt-web:
        displayName: "ChatGPT Web (Free)"
        api: openai-responses
        baseURL: http://127.0.0.1:17841/v1
        headers:
          Authorization: "Bearer chatgpt-web-free"
        streamIdleTimeoutMs: 300000
        models:
          - id: chatgpt-web/luna
            name: "ChatGPT Web — Luna (Free)"
            contextWindow: 1050000
            maxTokens: 32768
            input:
              - text
              - image
```

Optionally, make it the agent's default model in the `agent-default-model` entry:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    model: chatgpt-web/luna
```

Now start DeepSeek Harness with the profile:

```bash
dsh --profile <profile> web
```

DSH will automatically start the background sidecar process, connect to your authenticated ChatGPT session, and accept prompts!

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
✓ Responses proxy is healthy on 127.0.0.1:17841
Doctor result: ready
```

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues: browser executable paths, snap confinement, missing configuration, and runtime (Node/Bun) notes.

---

## Notes & Limitations

1. **Unofficial Bridge:** Operates via local Playwright browser automation on `chatgpt.com`. Not affiliated with or endorsed by OpenAI.
2. **Single-Session Concurrency:** Runs within a single browser tab. Sequential queries and normal DSH agent chats work seamlessly; avoid launching parallel multi-subagent swarms against the same tab simultaneously.
3. **Capability separation:** DSH-owned tools, skills, approvals, and sandbox policy remain under DSH authority; ChatGPT-native product capabilities must not be treated as DSH permissions.
4. **Browser/session limits:** The browser-backed route is session-bound and subject to ChatGPT Web product behavior and account-specific limits.

---

## Related Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) — development setup and contribution guidelines.
- [SECURITY.md](./SECURITY.md) — how the plugin handles your session credentials.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — diagnosing setup and runtime problems.
- [doc/architecture.md](./doc/architecture.md) — definitive provider architecture and ownership boundaries.
- [LICENSE](./LICENSE) — MIT.
