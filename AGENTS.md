# AGENTS.md — dsh-chatgpt-web

## Project identity

This repository implements `@lordraiden/dsh-chatgpt-web`, a DeepSeek Harness (DSH) Cordis plugin.

**Current production implementation:** authenticated ChatGPT Web as a native DSH `ctx.llm` provider.

**Architectural direction:** the repository is being evolved toward a provider-neutral **WebChat Core** for authenticated, text-only consumer-web chat. ChatGPT is the existing provider being migrated to that architecture. Qwen Chat and DeepSeek Chat are planned providers; they are not current production routes.

Do not confuse these two states:

- current behavior is established by the implementation and tests on `main`;
- target architecture is established by `doc/architecture.md` and implementation issues #189–#199.

When they differ, do not pretend the target is already implemented. Preserve current behavior unless the task is explicitly implementing the architectural migration.

## Source-of-truth hierarchy

Use sources in this order:

1. current implementation and tests for behavior that exists today;
2. `doc/architecture.md` for the target WebChat ownership model;
3. DSH upstream contracts and current provider/web evidence for external behavior;
4. Hindsight/project memory for historical rationale only.

Hindsight is useful for decisions, constraints, and unresolved context when available, but it is not authoritative over verified current code. Re-check memory-derived claims against the repository before relying on them and correct stale conclusions rather than perpetuating them.

Never store credentials, cookies, browser storage, session tokens, API keys, runtime keys, or other secrets in Hindsight or repository instruction files.

## Core engineering rules

Before changing code:

1. Inspect the relevant implementation, tests, configuration, and documentation.
2. Identify the current owner of the behavior.
3. Check `doc/architecture.md` and the relevant issue/PR boundary.
4. Check current DSH upstream contracts when the change depends on DSH behavior.
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

### DSH is the provider-routing authority

The DSH LLM runtime owns public provider selection and route dispatch.

WebChat may resolve an already-selected provider route to its internal driver, but WebChat must not become a second public provider registry or routing authority.

The rule is:

```text
DSH selects provider
        ↓
WebChat resolves driver
        ↓
provider executes the selected turn
```

Do not move provider selection, public model routing, or DSH retry policy into WebChat.

### DSH session is canonical

The DSH session/history remains authoritative.

A provider conversation is continuity state only.

Never make:

- a ChatGPT thread;
- a Qwen chat identifier;
- a DeepSeek session identifier;
- a browser page;
- a network session;

the identity of the DSH conversation.

The same DSH session may intentionally have separate provider conversations.

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

Replay is a deliberate recovery mode derived from canonical DSH text state.

### One active turn per logical conversation

A provider conversation is sequential by default.

Do not allow two active turns to mutate the same logical provider conversation unless the provider protocol explicitly proves concurrency safety.

Concurrency between different DSH sessions/conversations is a separate resource-ownership question.

For ChatGPT specifically, the current `main` branch still contains an account-level lease limitation that can block a second DSH chat on the same authenticated account. This is a known implementation issue tracked by #201/#202. Do not generalize that current account-level exclusivity into the future WebChat Core.

The intended architecture scopes exclusivity to the logical conversation and the physical transport resource, while account-level fan-out remains bounded and provider-specific.

### Retry boundary

There are two distinct retry layers:

1. WebChat/transport retry inside one logical turn.
2. DSH LLM retry around the adapter.

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
- DSH tool execution;
- computer-use;
- provider-native agent loops;
- sandbox execution;
- generic autonomous-browser behavior.

Unsupported request content must fail explicitly. Never silently discard files, images, tools, or other unsupported `GenerateOptions` content just to make a request succeed.

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

### DSH replay state

DSH `replayState`, when used, is supplemental opaque metadata.

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

## Cordis and sidecar lifecycle

The Cordis plugin integrates the sidecar into the DSH lifecycle and owns cleanup **only for processes it spawned**.

Preserve:

- health-check based startup;
- explicit `autoStart` semantics;
- bounded readiness waiting;
- cleanup of spawned processes on shutdown;
- actionable diagnostics when startup fails.

Do not turn the plugin into a competing or unconditional process manager.

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

The multi-provider migration is intentionally staged.

Implementation order:

1. WebChat contracts.
2. Durable conversation affinity/continuation.
3. Exchange lifecycle and transport ownership.
4. ChatGPT migration.
5. DSH route integration and driver resolution.
6. Provider conformance and architecture tests.
7. Qwen Web text provider.
8. Qwen real-session validation/recovery hardening.
9. DeepSeek Web text provider.
10. DeepSeek real-session validation/recovery hardening.
11. Cross-provider integration validation.

The corresponding issues are #189–#199.

Do not skip the shared contracts and then implement Qwen/DeepSeek by copying ChatGPT code.

Do not let a provider-specific quirk change WebChat Core semantics merely to make a provider fit.

## Security and privacy

Never commit or publish:

- ChatGPT cookies or browser storage state;
- Qwen/DeepSeek browser/session credentials;
- browser user-data directories;
- API keys;
- session tokens;
- launcher credentials;
- runtime keys;
- access-bearing tunnel identifiers;
- control tokens;
- raw private prompts or sensitive tool results;
- private local filesystem paths in public diagnostics.

Do not weaken authorization, path validation, or timing-sensitive comparisons.

Use sanitized examples in issues and documentation.

## Documentation

Keep one authoritative home for important facts:

- `README.md`: current user-facing behavior, setup and supported features;
- `README.zh-CN.md`: synchronized Chinese user-facing documentation;
- `TROUBLESHOOTING.md`: operational diagnosis and current known limitations;
- `SECURITY.md`: security policy;
- `doc/architecture.md`: target architecture and durable ownership/rationale;
- source comments/JSDoc: local implementation contracts;
- GitHub issues/PRs: implementation plans and review history.

Do not turn `AGENTS.md` into a second README or changelog.

When behavior changes, update the correct authoritative document. When current implementation differs from target architecture, document the distinction explicitly rather than silently rewriting history.

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

For browser/session changes, also use the relevant diagnostics:

```bash
dsh-chatgpt-web doctor
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

## Release cadence for the WebChat migration

The numbered WebChat migration issues #189–#199 are released **one PR at a time**. Each completed migration PR produces exactly one stable patch release.

The current `main` package version is `1.0.17`. Version `1.0.17` is a normal maintenance/consolidation release for the merged #202/#205 work and is therefore no longer reserved for the WebChat migration sequence. The migration sequence begins at `v1.0.18`.

| Migration PR | Issue | Release |
| --- | --- | --- |
| PR 1/11 | #189 | `v1.0.18` |
| PR 2/11 | #190 | `v1.0.19` |
| PR 3/11 | #191 | `v1.0.20` |
| PR 4/11 | #192 | `v1.0.21` |
| PR 5/11 | #193 | `v1.0.22` |
| PR 6/11 | #194 | `v1.0.23` |
| PR 7/11 | #195 | `v1.0.24` |
| PR 8/11 | #196 | `v1.0.25` |
| PR 9/11 | #197 | `v1.0.26` |
| PR 10/11 | #198 | `v1.0.27` |
| PR 11/11 | #199 | `v1.0.28` |

For these PRs:

- The PR must include the corresponding `package.json` version bump.
- The PR must not skip or consume another migration step's version.
- The implementation PR is responsible for its own release preparation; do not create a separate release PR just for the version bump.
- Before merge, run the required verification for that PR and ensure the version matches the planned release.
- After merge, tag the exact merged `main` commit with the planned version.
- The next migration PR must start from the released version produced by the previous migration PR.
- If a migration PR is intentionally abandoned or reordered, stop and reconcile the release sequence before merging a later numbered migration PR. Never silently renumber releases.
- Non-migration fixes/docs PRs do not consume a reserved WebChat migration release number. They use the normal release policy only when a release is actually required.

This release cadence is a delivery constraint for the migration, not a reason to bundle unrelated changes into a migration PR.

## Release and DSH update contract

Releases are tag-based. A merge to `main` is not itself a release.

- `package.json` `version` is the package version source of truth.
- Stable tags must be `vX.Y.Z` and must match `package.json` without the leading `v`.
- A release tag must point to the exact commit already merged into `main`.
- Do not release from feature, fix, archive, or release branches.

### Release sequence

1. Bump `package.json` version in a normal PR.
2. Merge into `main` and wait for green CI/tarball smoke.
3. Tag the exact `main` commit and push the tag:
   `git tag vX.Y.Z <main-sha>`
   `git push origin vX.Y.Z`
4. Tag CI validates the version and publishes the package **only to the private GitHub Packages npm registry** at `https://npm.pkg.github.com`.
5. The Release workflow waits until that exact version is available in GitHub Packages and then creates the corresponding published GitHub Release.
6. A stable version is complete only when the matching tag, private GitHub package, and GitHub Release exist.

There is **no npmjs.com publication**. Do not add an npmjs.com publish step, token, or registry entry.

### DSH update contract

For this private package, pnpm must resolve the `@lordraiden` scope through GitHub Packages:

```ini
@lordraiden:registry=https://npm.pkg.github.com
```

Authentication must be supplied outside the repository, for example through the user's `~/.npmrc` or environment:

```ini
//npm.pkg.github.com/:_authToken=\${GITHUB_PACKAGES_TOKEN}
```

Never commit a token to the repository or to a DSH profile file.

DSH updates must use stable SemVer versions from the private registry. Do not follow `main`, feature branches, or moving Git refs for normal updates.

The intended chain is:

`main` merge → green CI → `vX.Y.Z` tag → private GitHub Packages publication → GitHub Release → `dsh plugin update`.

Before any manual release operation:

```bash
git checkout main
git pull --ff-only
node -p "require('./package.json').version"
git rev-parse HEAD
```

The tag must be created from that exact `HEAD`. Never retag an already-published version with a different commit.
