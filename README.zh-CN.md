# dsh-chatgpt-web

[English](./README.md) | [中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Cordis%20Plugin-0078d4?style=flat)](https://github.com/deepseek-ai/deepseek-harness)

> **将已认证的消费级 Web Chat 会话桥接到 DSH 的 DeepSeek Harness Cordis 插件。当前生产 provider 是 ChatGPT Web；仓库正在演进为共享的纯文本 WebChat 架构，以支持后续 Web provider。**

<p align="center">
  <img src="./assets/hero-demo.png" alt="dsh-chatgpt-web 在 DeepSeek Harness 中" width="100%">
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="dsh-chatgpt-web 交互演示" width="100%">
</p>

---

## 目录

- [概述](#%E6%A6%82%E8%BF%B0)
- [环境要求](#%E7%8E%AF%E5%A2%83%E8%A6%81%E6%B1%82)
- [快速上手](#%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B)
- [诊断与健康检查](#%E8%AF%8A%E6%96%AD%E4%B8%8E%E5%81%A5%E5%BA%B7%E6%A3%80%E6%9F%A5)
- [故障排查](#%E6%95%85%E9%9A%9C%E6%8E%92%E6%9F%A5)
- [注意事项与使用限制](#%E6%B3%A8%E6%84%8F%E4%BA%8B%E9%A1%B9%E4%B8%8E%E4%BD%BF%E7%94%A8%E9%99%90%E5%88%B6)
- [相关文档](#%E7%9B%B8%E5%85%B3%E6%96%87%E6%A1%A3)

---

## 概述

**dsh-chatgpt-web** 当前将经过认证的 ChatGPT Web 会话作为原生 `ctx.llm` provider 接入 DeepSeek Harness (DSH)。`/v1/responses` 仅作为兼容性入口保留，并不是原生 DSH provider 边界。

仓库正在演进为 provider-neutral 的 **WebChat Core**，面向经过认证的消费级 Web Chat、纯文本输入与流式文本输出。ChatGPT Web 是当前生产实现。Qwen Chat 与 DeepSeek Chat 是架构和路线图中的后续 provider，**尚未作为当前版本的可用功能发布**。

### 当前 provider 状态

| Provider | 状态 | 范围 |
| --- | --- | --- |
| ChatGPT Web | **可用** | 当前生产 provider。经过认证的消费级 Web Chat、流式输出、推理/模式、连续对话、取消，以及现有 ChatGPT 专属兼容能力。 |
| Qwen Chat | **计划中** | 纯文本 WebChat provider。正在按统一架构推进，当前版本不会宣传为可用 route。 |
| DeepSeek Chat | **计划中** | 纯文本 WebChat provider。正在按统一架构推进，当前版本不会宣传为可用 route。 |

### 架构与能力边界

项目遵循明确的所有权边界：

- **DSH 负责 provider 路由和 DSH 生命周期。** WebChat 不得建立第二套公开的 provider 选择权威。
- **DSH 会话/历史是规范来源。** provider conversation 只是连续性 handle，而不是第二份 transcript。
- **WebChat Core 负责 provider-neutral 的会话 affinity、exchange 生命周期、continuation/recovery、取消、retry 分类和标准化文本事件。**
- **各 provider 自己负责认证/session、模型映射、provider conversation ID/cursor、传输机制和 provider 专属恢复逻辑。**
- **浏览器自动化只是传输方式，不是通用架构。** provider 可以选择 DOM、browser-network 或 hybrid。
- **共享 WebChat 范围是纯文本。** 文件、图片、MCP、DSH tools、computer-use 和 provider 专属 agent loop 不属于共享 WebChat contract。
- **原生 Codex passthrough 保持独立。** 它不属于 ChatGPT Web provider，也不属于未来的纯文本 WebChat contract。
- 本地 `/v1/responses` 兼容入口会汇聚到 ChatGPT Web 的标准执行路径，而不是建立第二套浏览器执行 authority。

完整的 ownership 与 recovery 规则以 [`doc/architecture.md`](./doc/architecture.md) 为准。多 provider 实现路线图见 [#189](https://github.com/lordraiden/dsh-chatgpt-web/issues/189) 到 [#199](https://github.com/lordraiden/dsh-chatgpt-web/issues/199)。

### 核心功能

- **原生 DSH provider：** 通过 DSH 的 `ctx.llm` 运行时注册 `chatgpt-web`，复用经过认证的浏览器会话，无需为浏览器后端路线配置 OpenAI API Key。
- **Cordis 插件优先生命周期：** 由 DSH 通过 `ctx.effect` 管理。DeepSeek Harness 在启动时自动拉起后台 Sidecar 进程，并在退出时安全关闭。
- **运行时模型/账户发现：** 根据已认证会话发现可用的 ChatGPT Web 模型与账户能力。
- **流式与 provider 语义：** 向 DSH 侧暴露流式文本、推理、使用量、错误和取消语义。
- **控制与诊断入口：** 提供 setup/login/doctor 工具，以及用于传输状态和调优的本地控制入口。
- **可移植且经过校验的发布产物：** 发布的 tarball 在发布前由 CI 校验（干净安装、运行时冒烟测试、依赖解析、无构建环境路径污染）。

## 环境要求

- **运行时：** Node.js `>=22.19.0` **或** Bun `>=1.3.0`（两者均受支持，CLI 可在任一运行时上运行）。
- **DeepSeek Harness：** `>=0.2.0-rc.2`。
- **浏览器：** 你机器上的 Chrome 或 Chromium（用于一次性登录与运行服务）。

---

## 快速上手

### 1. 安装插件

直接从本 GitHub 仓库安装：

```bash
dsh plugin --profile <profile> add github:lordraiden/dsh-chatgpt-web
```

本插件仅发布到仓库对应的**私有 GitHub Packages npm registry**，不会发布到 npmjs.com。

在安装或更新前，为 profile 配置 `@lordraiden` scope：

```ini
@lordraiden:registry=https://npm.pkg.github.com
```

另外使用 GitHub personal access token (classic) 并授予 `read:packages` 权限进行认证。Token 应保存在用户的 `~/.npmrc` 或启动 DSH 的环境中，绝不能提交到仓库。

例如：

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

之后正常安装或更新：

```bash
dsh plugin --profile <profile> add @lordraiden/dsh-chatgpt-web
dsh plugin --profile <profile> update @lordraiden/dsh-chatgpt-web
```

发布版本使用 SemVer tag，例如 `v1.0.17`；具体可用版本以对应 tag 和 package release 为准。

这会将插件注册到 profile 的 `package.json` bundles 中，其 Cordis 条目会被自动组合——无需手动 `insert`。

### 2. 一次性浏览器登录

进行一次性的 ChatGPT 账号登录验证。插件可执行文件位于 profile 的 `node_modules/.bin` 中：

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup
```

系统将打开专用的 Chrome/Chromium 窗口。登录你的 OpenAI / ChatGPT 账号。一旦看到 ChatGPT 输入框，setup 会捕获会话，并将配置和浏览器状态写入插件的存储目录（默认 `~/.dsh/storages/chatgpt-web/`）。

如果你的浏览器不在默认路径，请显式传入：

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --chrome /path/to/chrome
```

#### 使用受 snap 沙箱限制的浏览器（例如 snap 版 Chromium）

受 snap 沙箱限制的浏览器只能写入 `$HOME` 下的**非隐藏**路径。插件的默认存储目录（`~/.dsh/storages/chatgpt-web/`）是隐藏目录，因此 snap 浏览器无法在其中创建 profile 锁文件，setup 会失败并报告：

```text
Failed to create .../login-profile-XXXX/SingletonLock: Permission denied (13)
```

解决方法是通过环境变量 `DSH_CHATGPT_WEB_HOME` 将插件的存储主目录指向一个**非隐藏**目录。

**该变量的工作原理：** `VAR=value command` 是标准的 shell 语法——它只为*那一条命令*设置环境变量，不会持久化。插件在启动时读取 `DSH_CHATGPT_WEB_HOME`；一旦设置，它拥有的所有文件（配置、浏览器 profile、存储状态）都会放在该目录下，而不是 `~/.dsh/storages/chatgpt-web/`。

**逐步操作：**

1. **在命令上附加该变量，运行一次性 setup：**

   ```bash
   DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web" \
     ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web setup --chrome /snap/bin/chromium
   ```

   浏览器窗口会打开；登录 ChatGPT。会话将保存在 `~/dsh-chatgpt-web/` 下。

2. **为启动 DSH 的 shell 持久化该变量。** 后台 Sidecar 进程由 DeepSeek Harness 启动，继承的是 DSH 的环境——它*不会*继承你在终端里一次性使用的 `VAR=value` 前缀。因此请在你的 shell 配置文件（例如 `~/.bashrc`）中导出该变量，然后从该 shell 启动 DSH：

   ```bash
   # 添加到 ~/.bashrc（或 ~/.zshrc）：
   export DSH_CHATGPT_WEB_HOME="$HOME/dsh-chatgpt-web"

   # 重新加载，然后在该 shell 中启动 DSH：
   source ~/.bashrc
   dsh --profile <profile> web
   ```

   这样 Sidecar 就能找到 setup 创建的同一份 `config.json` 和浏览器状态。

3. **用 doctor 验证**（在相同的环境中运行）：

   ```bash
   ~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
   ```

> **重要：** 所有接触插件状态的命令——`setup`、`login`、`doctor`，以及运行 Sidecar 的 DSH 进程——必须看到**同一个** `DSH_CHATGPT_WEB_HOME`。如果一部分使用隐藏默认路径、另一部分使用非隐藏路径，Sidecar 会报告 `Configuration is missing`。

### 3. 选择原生 DSH provider

插件会直接通过 DSH 的 `ctx.llm` 运行时注册 `chatgpt-web`。原生 DSH 调用**不需要**在 `llm-pi-ai` 中添加 provider，也不需要配置 OpenAI Responses URL 或第二套 provider。

如果希望新创建的 agent 默认使用 ChatGPT Web，可配置标准的 DSH 默认模型条目：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    # 请选择已认证 ChatGPT Web 模型目录当前暴露的路由，例如：
    # model: chatgpt-web/light       # 使用 Sol 模型选择器的账户
    # model: chatgpt-web/luna        # 仅有 Luna 路由的账户
```

可用的 ChatGPT Web 模型路由由已认证账户的产品能力状态决定。插件面向受支持的 Free 和付费 ChatGPT 账户提供正常 Web 产品使用。使用 Codex/Work 配额的路由不属于 `chatgpt-web` provider，会被排除。

使用 profile 启动 DeepSeek Harness：

```bash
dsh --profile <profile> web
```

插件会注册 provider、启动本地浏览器 sidecar，并连接到已认证的 ChatGPT Web 会话。

## 诊断与健康检查

随时使用内置的诊断工具检查环境配置：

```bash
~/.dsh/profiles/<profile>/node_modules/.bin/dsh-chatgpt-web doctor
```

正常输出示例：

```text
✓ Configuration is valid (~/.dsh/storages/chatgpt-web/config.json)
✓ Chrome executable found
✓ ChatGPT login state has authenticated browser evidence
✓ ChatGPT Web sidecar is healthy on 127.0.0.1:17841/healthz
Doctor result: ready
```

---

## 故障排查

常见问题请参见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)：浏览器可执行文件路径、snap 沙箱限制、缺失的配置，以及运行时（Node/Bun）说明。

---

## 注意事项与使用限制

1. **非官方 Web 桥接：** 当前 ChatGPT provider 通过 `chatgpt.com` 上的本地浏览器自动化运行，并非 OpenAI 官方 API，也未获 OpenAI 背书。
2. **当前并发行为：** 当前 `main` 实现仍存在 ChatGPT authenticated account 级别的 browser lease，因此同一账号上的第二个 DSH chat 可能在前一个 turn 运行时被阻止。这是当前实现限制，不是目标 WebChat 架构规则；目标模型是每个 logical conversation 单独串行，同时允许彼此隔离的 transport resources 并行。相关修复见 [#201](https://github.com/lordraiden/dsh-chatgpt-web/issues/201) / [#202](https://github.com/lordraiden/dsh-chatgpt-web/pull/202)。
3. **能力隔离：** DSH 所拥有的 tools、skills、审批和 sandbox 策略始终由 DSH 控制；不得将 ChatGPT 原生 product capabilities 视为 DSH 权限。
4. **产品范围：** 当前生产 provider 支持认证账户实际暴露的 ChatGPT Web model routes。Codex/Work quota 路由明确不在范围内。实际可用性取决于认证后的产品能力状态和账户限制。
5. **多 provider 路线图：** Qwen Chat 与 DeepSeek Chat 是纯文本 WebChat 的架构目标，目前尚未作为用户可用 provider 发布。

## 相关文档

- [CONTRIBUTING.md](./CONTRIBUTING.md) — 开发环境与贡献指南。
- [SECURITY.md](./SECURITY.md) — 插件如何保管你的会话凭据。
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — 配置与运行时问题诊断。
- [doc/architecture.md](./doc/architecture.md) — provider 架构、能力所有权边界以及产品范围规则。
- [LICENSE](./LICENSE) — MIT。
