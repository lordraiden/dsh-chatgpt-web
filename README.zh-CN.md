# dsh-chatgpt-web

[English](./README.md) | [中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)
[![tarball smoke](https://img.shields.io/github/actions/workflow/status/lordraiden/dsh-chatgpt-web/tarball-smoke.yml?style=flat&label=tarball%20smoke)](https://github.com/lordraiden/dsh-chatgpt-web/actions/workflows/tarball-smoke.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Cordis%20Plugin-0078d4?style=flat)](https://github.com/deepseek-ai/deepseek-harness)

> **将已认证的 ChatGPT Web 会话桥接到 DSH 的 DeepSeek Harness Cordis 插件。**

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

**dsh-chatgpt-web** 将经过认证的 ChatGPT Web 会话桥接到 DeepSeek Harness (DSH)，通过本地 provider/兼容性入口暴露浏览器后端模型。

它通过无头或可视的 Chrome/Chromium 浏览器自动化连接至 `chatgpt.com`，将网页会话转换为 DSH 可用的模型请求，并流式传递回答、推理、使用量、错误以及取消语义。浏览器只是 provider 的实现细节，并不是 OpenAI 官方 API。

### 架构与能力边界

项目遵循明确的所有权边界：

- **DSH 仍是运行时权威：** 负责 DSH 会话、工具、技能、审批、沙箱策略以及 provider 生命周期。
- **ChatGPT 负责模型能力：** 包括模型推理和 ChatGPT 原生产品能力。
- **浏览器自动化只是传输层：** 负责 ChatGPT Web 的就绪、提交、流式、完成、取消和恢复。
- **兼容性入口共享同一执行路径：** 避免为不同入口维护重复的浏览器执行实现。

仓库还包含有意保持独立的集成路径，包括原生 Codex passthrough 和本地 Responses 兼容入口。

### 核心功能

- **经过认证的 ChatGPT Web 后端：** 浏览器后端路线复用本地会话，无需为该路线配置 OpenAI API Key。
- **Cordis 插件优先生命周期：** 由 DSH 通过 `ctx.effect` 管理。DeepSeek Harness 在启动时自动拉起后台 Sidecar 进程，并在退出时安全关闭。
- **运行时模型/账户发现：** 根据已认证会话发现可用的 ChatGPT Web 模型与账户能力。
- **流式与 provider 语义：** 向 DSH 侧暴露流式文本、推理、使用量、错误和取消语义。
- **控制与诊断入口：** 提供 setup/login/doctor 工具，以及用于传输状态和调优的本地控制入口。
- **可移植且经过校验的发布产物：** 发布的 tarball 在到达仓库（registry）之前会由 CI 校验（干净安装、运行时冒烟测试、依赖解析、无构建环境路径污染）。

---

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

发布到软件包仓库后，也可以直接安装已发布的软件包：

```bash
dsh plugin --profile <profile> add @lordraiden/dsh-chatgpt-web
```

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

### 3. 在 DeepSeek Harness 中启用

提供者配置位于 profile 的 Cordis 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）中，而不是某个全局配置文件里。在 `llm-pi-ai` 条目的现有 `providers` 映射下添加 `chatgpt-web` 提供者：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # ...你现有的 providers...
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

可选地，在 `agent-default-model` 条目中将其设为智能体的默认模型：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: chatgpt-web
    model: chatgpt-web/luna
```

现在使用你的 profile 启动 DeepSeek Harness：

```bash
dsh --profile <profile> web
```

DSH 将自动启动后台 Sidecar 进程，连接已登录的 ChatGPT 会话并开始处理提问！

---

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
✓ Responses proxy is healthy on 127.0.0.1:17841
Doctor result: ready
```

---

## 故障排查

常见问题请参见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)：浏览器可执行文件路径、snap 沙箱限制、缺失的配置，以及运行时（Node/Bun）说明。

---

## 注意事项与使用限制

1. **非官方桥接：** 通过本地 Playwright 自动化驱动 `chatgpt.com` 网页。与 OpenAI 官方无隶属或背书关系。
2. **单会话并发：** 运行在单个浏览器标签页中。顺序查询和正常的 DSH 智能体对话完全顺畅；请避免同时对同一标签页发起多个高并发子智能体任务。
3. **能力边界：** DSH 所拥有的工具、技能、审批和沙箱策略仍由 DSH 控制；ChatGPT 原生产品能力不应被视为 DSH 权限。
4. **浏览器与会话限制：** 浏览器后端路线受 ChatGPT Web 产品行为以及账户级限制影响。

---

## 相关文档

- [CONTRIBUTING.md](./CONTRIBUTING.md) — 开发环境与贡献指南。
- [SECURITY.md](./SECURITY.md) — 插件如何保管你的会话凭据。
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — 配置与运行时问题诊断。
- [doc/architecture.md](./doc/architecture.md) — provider 架构与能力所有权边界。
- [LICENSE](./LICENSE) — MIT。
