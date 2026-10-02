# AGENTS.md — dsh-chatgpt-web

## Project identity

This repository implements `@lordraiden/dsh-chatgpt-web`, a DeepSeek Harness Cordis plugin that exposes an authenticated ChatGPT Web session as a local model/provider.

Treat this repository as a **browser-backed provider integration**, not as a generic autonomous agent runtime. Preserve the existing separation between DSH/Cordis lifecycle, the local sidecar, browser automation, provider/adapters, and the optional Codex integration.

The project currently targets:

- Node.js `>=22.19.0`
- Bun `>=1.3.0`
- DeepSeek Harness `>=0.2.0-rc.2`

## Project context and source of truth

Use the repository code, tests, configuration, and documentation as the current source of truth.

Do not infer current behavior from old discussions, previous agent output, or memory alone.

When Hindsight is available through the harness, use it as the project's long-term memory and decision history:

1. Recall relevant knowledge before substantial changes, bug fixes involving intended behavior, test changes, architectural changes, or questions about why the code works a certain way.
2. Treat Hindsight results as historical evidence, not as proof of current behavior.
3. Verify remembered claims against the current code and tests before relying on them.
4. When current code disproves a stored memory, prefer the current verified implementation and record a correction in Hindsight when appropriate.
5. Use Hindsight to recover rationale and settled decisions instead of repeatedly re-litigating them from source code alone.
6. Do not place credentials, cookies, session data, API keys, or other secrets in Hindsight or repository instruction files.

Hindsight is part of the development workflow, but it is not a substitute for verification.

## How to work on this repository

Before changing code:

1. Inspect the relevant implementation, tests, configuration, and documentation.
2. Identify the existing owner of the behavior being changed.
3. Preserve established boundaries unless the task explicitly changes the architecture.
4. Prefer the smallest change that fully solves the problem.
5. Avoid introducing speculative abstractions, compatibility layers, or fallbacks without evidence that they are required.

When editing:

- Preserve existing error semantics, lifecycle ownership, timing behavior, and security boundaries.
- Prefer targeted edits over broad rewrites.
- Do not duplicate logic when an existing owner can be extended.
- Do not silently change public defaults or persisted formats.
- Do not add behavior merely because it would be convenient for an agent.
- Do not weaken validation or fail-open behavior to make browser automation appear more reliable.

## Architectural invariants

### Cordis integration

The Cordis plugin owns lifecycle integration and the sidecar process.

Changes to plugin startup/shutdown must preserve:

- health-check based startup;
- explicit `autoStart` semantics;
- bounded readiness waiting;
- cleanup on plugin shutdown;
- useful diagnostics when the sidecar cannot start.

Do not turn the plugin into an independently competing process manager unless the architecture explicitly requires it.

### ChatGPT Web adapter

The browser-backed adapter is sensitive to ChatGPT Web DOM/session behavior.

When changing browser interaction:

- preserve authentication/session isolation;
- preserve bounded retries and timeout behavior;
- fail closed with actionable diagnostics when the browser state is invalid;
- avoid hidden infinite waits;
- avoid assuming DOM structure that is not verified by the implementation;
- preserve single-session/concurrency constraints.

Do not introduce parallel browser turns against the same ChatGPT session unless the concurrency model explicitly supports them.

### Pure Chat boundary

The provider is intended to deliver conversational responses, reasoning, Markdown, and code through the ChatGPT Web session.

Do not silently convert it into a generic local tool-execution agent.

Changes involving filesystem execution, shell execution, arbitrary MCP tools, autonomous tool loops, or new execution authority are architectural changes and require explicit scope rather than being treated as routine provider work.

### Codex integration

Codex-specific integration is a separate boundary from the ordinary browser-backed provider path.

When modifying Codex integration, preserve:

- rollout/session identity validation;
- parent/child lineage checks;
- path containment checks;
- explicit authorization for launcher-controlled operations;
- cancellation and cleanup semantics;
- fail-closed behavior when authoritative state cannot validate a requested resource.

Do not use weaker filesystem or session heuristics merely as a convenience fallback.

### Compaction

Compaction and browser-turn handoff are stateful lifecycle boundaries.

When changing compaction behavior:

- preserve transaction ownership;
- keep capability/control tokens opaque and short-lived;
- do not leak tool environments through compaction state;
- distinguish logical cancellation from physical worker cleanup;
- do not allow a replacement turn to race an unfinished cleanup handshake.

Compaction changes require focused verification because failures can corrupt session continuity even when ordinary requests still appear to work.

## Security and privacy

Never commit:

- ChatGPT cookies;
- browser storage state;
- browser user-data directories;
- API keys or session tokens;
- launcher control credentials;
- tunnel identifiers that provide access;
- raw private prompts or sensitive tool results;
- private local filesystem paths when publishing diagnostics.

Do not weaken authorization, path validation, or timing-sensitive comparisons.

Public bug reports and documentation must use sanitized examples.

## Documentation rules

Update documentation when user-visible behavior, configuration, installation, diagnostics, security behavior, or operational procedures change.

Keep one authoritative home for each important fact.

Prefer:

- `README.md` for user-facing overview and setup;
- `TROUBLESHOOTING.md` for operational diagnosis;
- `SECURITY.md` for security policy;
- source comments/JSDoc for local implementation contracts;
- a dedicated architectural/decision document when rationale needs to persist beyond the implementation.

Do not turn `AGENTS.md` into a second README or a historical changelog. Keep it focused on standing instructions for future agents.

## Verification

Use proportional verification based on the change.

For normal TypeScript changes:

```bash
bun run typecheck
bun run build
```

For changes affecting packaging, installation, or the published artifact:

```bash
bun test
```

`bun test` is the repository's tarball/smoke validation path; do not describe it as a comprehensive unit-test suite.

For browser/session changes, also use the relevant diagnostics such as:

```bash
dsh-chatgpt-web doctor
```

When a failure is encountered, investigate the failure itself before changing code. Do not treat an unexplained failing command as successful verification.

Before declaring work complete, verify the exact acceptance path that was changed and report any remaining uncertainty.

## Dependency changes

Do not add a dependency merely to avoid a small amount of local code.

When dependencies change:

- update the lockfile;
- run typecheck/build;
- run the relevant packaging/security checks;
- verify that the dependency is actually required by the runtime path.

Avoid dependency upgrades unrelated to the task.

## Git and change hygiene

Keep changes focused and reviewable.

Do not mix unrelated refactors, formatting sweeps, dependency upgrades, or speculative cleanup into a feature or bug fix.

Preserve existing public behavior unless the task explicitly changes it.

Before commit or handoff:

- inspect the final diff;
- ensure no secrets or generated session data are present;
- confirm documentation and tests match the changed behavior;
- verify that no unrelated files were modified.

## Agent decision discipline

When the user's proposed approach is technically questionable, do not implement it blindly.

First determine:

1. what behavior is actually required;
2. what the current architecture already provides;
3. whether a simpler existing mechanism can satisfy it;
4. what invariants or persistence boundaries would be affected.

State assumptions explicitly when evidence is incomplete.

Prefer verified behavior over plausible behavior, and current code over stale memory.
