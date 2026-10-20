# AGENTS.md — dsh-chatgpt-web

## Project identity

This repository implements `@lordraiden/dsh-chatgpt-web`, a **container-only** product: a
self-contained service distributed as a Docker image plus Compose stacks.

**Product surface:**

- the CLI (`dsh-chatgpt-web serve|doctor|login|auth import`, plus its other documented subcommands);
- the HTTP API (`/v1/responses`, `/v1/chat/completions`, `/v1/models`, `/healthz`, `/admin/*`,
  `/v1/control/*`), with API-key authentication through `DSH_CHATGPT_WEB_API_KEY`;
- the remote interactive sign-in surface (`GET /v1/control/auth/` and the `/v1/control/auth/*` endpoints),
  which drives a provider's own sign-in browser from the operator's page;
- the ChatGPT-Web browser adapter;
- the WebChat core contracts and the durable conversation store;
- the container artifacts (`Dockerfile`, the Compose stacks, `docker/**`).

**The DeepSeek Harness Cordis plugin is abandoned.** There is no DSH plugin, no Cordis bundle, no
`client.js`, no `cordis.patch.yml`, no `lib/plugin.js`, no `ctx.llm` provider, and no
private-npm-registry or `dsh plugin update` release contract. Do not reintroduce any of them, and do
not describe the product as a DSH plugin.

**Architectural direction:** a provider-neutral **WebChat Core** for authenticated, text-only
consumer-web chat. ChatGPT Web, **Qwen Code** (`qwen-code/<model>`, issue #299 slice 2) and **Qwen
Chat** (`qwen-chat/<model>`, a second Qwen product with many models and three reasoning modes) are the
current providers; DeepSeek Chat is a planned provider and is not a current route.

## Source-of-truth hierarchy

Use sources in this order:

1. current implementation and tests for behavior that exists today;
2. `doc/architecture.md` for the ownership model and durable rationale;
3. `doc/container.md` for the container's verified operational facts;
4. current provider/web evidence for external behavior;
5. Hindsight/project memory for historical rationale only.

Hindsight is useful for decisions, constraints, and unresolved context when available, but it is not
authoritative over verified current code. Re-check memory-derived claims against the repository before
relying on them and correct stale conclusions rather than perpetuating them.

Never store credentials, cookies, browser storage, session tokens, API keys, control tokens, or other
secrets in Hindsight or repository instruction files.

## Core engineering rules

Before changing code:

1. Inspect the relevant implementation, tests, configuration, and documentation.
2. Identify the current owner of the behavior.
3. Check `doc/architecture.md` and the relevant issue/PR boundary.
4. For container behavior, check `doc/container.md` and the container workflow.
5. For provider-specific web behavior, inspect the current web surface rather than assuming an old protocol still exists.
6. Prefer a complete change that preserves ownership boundaries over a locally convenient patch.

When editing:

- Preserve existing error semantics, lifecycle ownership, security boundaries, and compatibility behavior unless the task explicitly changes them.
- Prefer targeted migrations over parallel implementations.
- Extend an existing owner rather than creating a second authority.
- Do not silently change public defaults or persisted formats.
- Do not weaken validation or fail open for convenience.
- Do not add compatibility layers merely to avoid understanding the current contract.
- Do not copy provider-specific implementation patterns into the common core without evidence that the semantic behavior is actually common.

## WebChat architecture invariants

The complete architecture is defined in `doc/architecture.md`. These invariants are mandatory.

### The service is the provider-routing authority

The service's configured provider catalogue owns provider selection and route dispatch. The API caller
selects a catalogue model identifier, and WebChat resolves that already-selected route to its internal
driver.

The rule is:

```text
caller selects a catalogue model
        ↓
WebChat resolves driver
        ↓
provider executes the selected turn
```

WebChat must not become a second public provider registry. Do not move provider selection or public
model routing into a provider driver, and do not create a second retry authority.

### Canonical history is owned by the caller

Canonical transcript history belongs to the caller that keeps it.

A provider conversation is continuity state only.

Never make:

- a ChatGPT thread;
- a Qwen chat identifier;
- a DeepSeek session identifier;
- a browser page;
- a network session;

the identity of the caller's conversation.

One caller conversation may intentionally have separate provider conversations.

### Provider conversation is opaque

WebChat Core may store, persist, compare, version, and pass provider continuation state, but it must not interpret provider-private identifiers.

Provider-specific conversation IDs, parent cursors, network payloads, response DTOs, or web selectors belong inside the provider driver/transport.

### Browser is a transport mechanism, not the architecture

Do not create a generic architecture around `Page`, Playwright, DOM selectors, or a ChatGPT-shaped browser worker.

A provider may use:

- DOM interaction;
- browser-network exchange;
- a hybrid;
- another authenticated web-native mechanism.

A physical page/context/session is a transport resource. It is never the logical conversation identity.

### Durable continuity

Conversation affinity and provider continuation state must be durable enough to survive a runtime restart when the provider itself supports continuation.

Conversation storage must not become a second transcript store and must not contain authentication secrets.

A crash or unknown remote checkpoint is not proof of successful continuation. Unknown state must remain explicit until the provider can reconcile it or the core chooses an explicit replay/failure path.

### No silent fork

Never silently create a replacement provider conversation after continuity loss.

The system must distinguish, at minimum:

- exact resume;
- new conversation required;
- explicit replay;
- continuity lost/uncertain;
- unsupported.

Replay is a deliberate recovery mode derived from canonical text state.

### One active turn per logical conversation

A provider conversation is sequential by default.

Do not allow two active turns to mutate the same logical provider conversation unless the provider protocol explicitly proves concurrency safety.

Concurrency between different caller conversations is a separate resource-ownership question.

For ChatGPT specifically, an account-level *exclusive* lease used to block a second chat on the same authenticated account. That limitation was tracked by #201 and its fix PR #202 and is now **resolved**: one authenticated account serves a bounded fan-out of `MAX_CHATGPT_BROWSER_TABS` simultaneous browser turns (`src/adapters/chatgpt-web/concurrency.ts`), enforced with one shared refusal by the provider core, the turn-session registry and the browser worker. Do not reintroduce account-level exclusivity, and do not generalize the provider-specific fan-out bound into the future WebChat Core.

Exclusivity is scoped to the logical conversation and the physical transport resource: one active turn per logical provider conversation (the transport lease, and the retained ChatGPT surface for its `conversationKey`), one lease per physical browser resource id, and one active turn per native DSH thread. Account-level fan-out remains bounded and provider-specific.

### Retry boundary

There are two distinct retry layers:

1. WebChat/transport retry inside one logical turn.
2. The API client's retry around the service.

They must never become competing execution authorities.

At minimum:

```text
pre-submit transport failure
    → may be retry-safe

confirmed submission
    → not automatically retryable

submission ambiguous
    → never automatically retryable

partial/late output
    → never means "the request was not sent"
```

A lower-level retry must settle before an outer retry layer can observe the attempt as failed.

Never resend the same user message merely because the response was not observed.

### Text-only common scope

The common WebChat contract is intentionally text-only.

Do not add to the common core:

- files;
- images;
- audio/video;
- MCP;
- host/agent tool execution;
- computer-use;
- provider-native agent loops;
- sandbox execution;
- generic autonomous-browser behavior.

Unsupported request content must fail explicitly. Never silently discard files, images, or other
unsupported request **content** just to make a request succeed.

**Capability declarations are discarded by design; attached content is refused.** This is a property of
the product, not a configurable policy, and future work must not "restore" the old refusal of tools:

- a **capability** declaration (`tools`, `tool_choice`/`function_call`, `mcp`/`functions`) names
  something this bridge cannot execute. The provider is a consumer web chat reached as text: it has no
  execution path and no return channel to the caller's harness, so a tool definition is protocol noise,
  not content. It is therefore accepted, discarded, and **declared** — the public API reports it with
  the `x-dsh-chatgpt-web-ignored-features` header and one log line per request — never refused, and
  never forwarded to the provider.
- a **content** feature (files, images, audio/video, attachments, non-text content parts) is data the
  model was supposed to *see*. Discarding it would be silent content loss, so it keeps failing
  explicitly with a stable `UNSUPPORTED_OPTION`-class refusal in every mode. Dropping capability
  declarations must never become a way to drop attached content.

The split is owned once by the Core (`src/web-chat/core/exchange.ts`,
`WEB_CHAT_CAPABILITY_FEATURES` vs `WEB_CHAT_CONTENT_FEATURES`); no surface keeps a second list. The
same rule family covers tool-shaped message state: `role: "tool"` messages are dropped by the
message-only projection (`src/web-chat/host/api-projection.ts`, issue #253), and an assistant message's
`tool_calls` is never read by the API translation.

### Provider-specific responsibilities

Each provider driver owns:

- authentication/session bootstrap;
- account binding;
- model discovery/resolution for the Web product;
- reasoning/mode mapping;
- provider conversation identifiers/cursors;
- submission/completion detection;
- response parsing;
- provider-specific transport;
- provider-specific recovery;
- provider-specific anti-bot/access verification behavior.

Do not assume API model IDs or API transport semantics describe the consumer-Web product.

For Qwen and DeepSeek especially, the driver may require persistent browser state, interactive verification, browser-assisted network transport, or other provider-local session mechanisms.

### Opaque replay state

Provider replay state, when used, is supplemental opaque metadata.

It does not replace the durable WebChat conversation store.

Replay state must be scoped to provider/account/conversation ownership and must fail closed on cross-provider reuse.

## ChatGPT-specific boundaries

ChatGPT currently contains additional functionality outside the common text-only WebChat architecture, including:

- Responses compatibility;
- Advisor;
- Codex-related integration;
- MCP/capability surfaces;
- compaction and browser-turn handoff;
- ChatGPT-specific prompt/context mechanisms.

These remain ChatGPT-specific until there is a concrete architectural reason to extract a smaller semantic seam.

Do not generalize ChatGPT MCP, Codex, Advisor, Responses, file/image, or tool semantics into the common WebChat contract merely because another provider is being added.

The separate native Codex passthrough must remain separate from ChatGPT Web and from the future WebChat Core.

## Service runtime behavior

The container runs one service process: the entrypoint bootstraps the data volume and then execs
`node lib/cli.js "$@"`. Preserve:

- health-check based startup;
- bounded readiness waiting;
- cleanup of processes the service itself spawned, and only those;
- actionable diagnostics when startup fails;
- the entrypoint's default-configuration bootstrap on an empty volume.

Do not turn the entrypoint or the service into a competing or unconditional process manager.

## ChatGPT browser/runtime behavior

Preserve:

- authenticated session isolation;
- bounded timeouts;
- fail-closed behavior with actionable diagnostics;
- verified browser/DOM assumptions;
- explicit logical versus physical settlement;
- conversation-scoped transport ownership;
- stale-resource rejection;
- deterministic cancellation and recovery.

Do not assume that a browser error, page close, or request timeout proves that the provider turn physically stopped. Physical settlement must be established before unsafe resource reuse.

Do not reintroduce account-wide exclusivity as a generic WebChat rule.

## Provider migration discipline

The multi-provider work is intentionally staged. The shared contracts, the ChatGPT migration, the
service host integration, the conformance suite and the **Qwen Code text provider** (issue #299 slice 2,
`src/adapters/qwen-code/**`) are delivered; the remaining order is:

1. Qwen real-session validation/recovery hardening.
2. DeepSeek Web text provider.
3. DeepSeek real-session validation/recovery hardening.
4. Cross-provider integration validation.

Do not re-litigate the delivered stages while adding a provider.

Do not skip the shared contracts and then implement Qwen/DeepSeek by copying ChatGPT code.

Do not let a provider-specific quirk change WebChat Core semantics merely to make a provider fit.

## Security and privacy

Never commit or publish:

- ChatGPT cookies or browser storage state;
- Qwen/DeepSeek browser/session credentials;
- browser user-data directories;
- API keys (`DSH_CHATGPT_WEB_API_KEY`, `<data dir>/api-key`);
- session tokens;
- control tokens;
- the private data volume;
- raw private prompts or sensitive tool results;
- private local filesystem paths in public diagnostics.

Do not weaken:

- the API-key guard or the fail-closed non-loopback bind;
- the operator control-token authority (`/v1/control/*`, `/admin/*`) or its separation from the API key;
- path validation or timing-sensitive comparisons.

A display supplied by the operator for `authBrowserMode: "display"` (or for the CLI `login`) grants
control of an authenticated browser session: keep an X server exposed for it on the host's loopback
only. The container provides no display of its own, and the former noVNC sign-in image is retired
(issue #276 slice 3b): `headless` is the default and the supported path on a headless host.

The interactive sign-in surface (`/v1/control/auth/*`) follows the same authority boundary:

- the operator **control token** guards it, never the API key;
- the page at `GET /v1/control/auth/` is served anonymously **by design** — a browser navigation cannot
  carry a header, and the token must never be put in a URL — while every endpoint that carries data is
  guarded like the rest of `/v1/control/*`;
- no cookie or browser storage state may ever appear in a session view or a log.

Use sanitized examples in issues and documentation.

## Documentation

Keep one authoritative home for important facts:

- `README.md`: user-facing behavior, quick start, API surface and supported features;
- `TROUBLESHOOTING.md`: operational diagnosis and current known limitations;
- `SECURITY.md`: security policy;
- `doc/architecture.md`: architecture and durable ownership/rationale;
- `doc/container.md`: the container operations manual (image, Compose, data volume, credentials, exposure);
- source comments/JSDoc: local implementation contracts;
- GitHub issues/PRs: implementation plans and review history.

Do not turn `AGENTS.md` into a second README or changelog.

When behavior changes, update the correct authoritative document. When the container's behavior differs from a stated intent, document the distinction explicitly rather than silently rewriting history.

## Verification

Use proportional verification.

For normal TypeScript changes:

```bash
bun run typecheck
bun run build
```

For packaging, installation, architecture, routing, persistence, or behavioral changes:

```bash
bun run test
```

`bun run test` is the gate CI runs. `bun test` alone is **not** that gate: it skips the container-pin
check (`scripts/test-246-container-pin.mjs`), the authority check
(`scripts/test-issue-75-authority.ts`) and the tarball smoke test that `bun run test` includes.

For container changes:

```bash
docker build -t dsh-chatgpt-web:local .
docker compose up -d --wait
./docker/verify-container.sh
```

The `Container image` workflow (`.github/workflows/container.yml`) builds the image, runs the default
and exposed stacks and checks both catalogue shapes; keep it green.

For browser/session changes, also use the relevant diagnostics:

```bash
docker compose exec chatgpt-web node lib/cli.js doctor --json
```

For provider/web integrations, add deterministic contract tests first and use real authenticated provider sessions only for provider-specific behavior that mocks cannot prove.

When verifying:

- investigate failures before changing code;
- do not treat unexplained failures as success;
- inspect the final diff;
- check for secrets and generated session data;
- confirm documentation/tests match the changed behavior;
- state remaining uncertainty honestly.

## Dependencies and Git hygiene

Do not add dependencies or perform unrelated upgrades without evidence they are required.

When dependencies change:

- update the lockfile;
- run typecheck;
- run build;
- run the relevant test/packaging/security checks.

Keep changes focused and reviewable.

Do not mix unrelated refactors, formatting sweeps, dependency upgrades, or speculative cleanup into feature/fix work.

Before commit or handoff:

- inspect the exact diff;
- confirm only intended files changed;
- check for secrets/session artifacts;
- confirm tests and documentation match the change.

## Agent decision discipline

Do not implement a technically questionable proposal blindly.

For every non-trivial change, determine:

1. the required behavior;
2. the current owner;
3. the target architectural owner;
4. whether the current repository already has a mechanism that should be extracted rather than duplicated;
5. which identity, persistence, retry, concurrency, or security boundary is affected;
6. which parts are provider-specific and therefore must remain outside Core.

When evidence is incomplete:

- investigate current code and upstream contracts;
- state the uncertainty;
- do not invent a provider protocol;
- do not convert a temporary implementation limitation into an architectural rule.

Prefer verified behavior over stale memory.

## Release and verification contract

Releases are tag-based. A merge to `main` is not itself a release.

- `package.json` `version` is the package version source of truth, and it must agree with `src/version.ts`.
- Stable tags must be `vX.Y.Z` and must match `package.json` without the leading `v`.
- A release tag must point to the exact commit already merged into `main`.
- Do not release from feature, fix, archive, or release branches.

### Release sequence

1. Bump `package.json` version (and `src/version.ts`) in a normal PR.
2. Merge into `main` and wait for green CI/tarball smoke.
3. The `verify` job (`.github/workflows/ci.yml`) detects the bump, regenerates the checked-in `lib` from
   `src`, and creates `vX.Y.Z` **itself** from the exact commit it just tested. Do not push release tags
   by hand: a hand-made tag skips the `lib` synchronization, so the artifact would be built from a stale
   bundle.
4. The same job packs the artifact, smoke-tests those exact bytes, and is the single owner of the tag and
   the release. There is no separate Release workflow, because a tag pushed by CI cannot trigger one
   (GitHub suppresses runs caused by `GITHUB_TOKEN`).

The **container image is the shipping distribution**. `.github/workflows/container.yml` builds the
production image and waits for health on every change to `Dockerfile`, the Compose
stacks, `docker/**`, `package.json`, `bun.lock` or `src/**`. Nothing is pushed to an image registry and
there is no private-registry or plugin-update release contract to maintain; do not add one.

Before any manual release operation:

```bash
git checkout main
git pull --ff-only
node -p "require('./package.json').version"
git rev-parse HEAD
```

The tag must be created from that exact `HEAD`. Never retag an already-published version with a different commit.
