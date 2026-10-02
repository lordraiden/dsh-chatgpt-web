# AGENTS.md — dsh-chatgpt-web

## Project identity

This repository implements `@lordraiden/dsh-chatgpt-web`, a DeepSeek Harness Cordis plugin that exposes an authenticated ChatGPT Web session as a local model/provider.

Treat it as a **browser-backed provider integration**, not as a generic autonomous-agent runtime. Preserve the separation between DSH/Cordis lifecycle, the sidecar, browser automation, provider/adapters, and the Codex integration.

## Current behavior and project memory

Current code, tests, configuration, and documentation establish current behavior. **Hindsight**, when available through the DSH harness, provides project memory for architectural rationale, past decisions, known constraints, and unresolved context.

Use Hindsight before substantial changes, architectural work, relevant test changes, or when historical rationale matters. Treat it as historical evidence, not as authority over verified current behavior. Check memory-derived claims against the implementation before relying on them, and record corrections when stored knowledge is demonstrably stale.

Do not store credentials, cookies, session state, API keys, or other secrets in Hindsight or repository instruction files.

## Working rules

Before changing code:

1. Inspect the relevant implementation, tests, configuration, and documentation.
2. Identify the existing owner of the behavior being changed.
3. Preserve established boundaries unless the task explicitly changes the architecture.
4. Prefer the smallest complete change; avoid speculative abstractions, compatibility layers, or fallbacks.

When editing:

- Preserve existing error semantics, lifecycle ownership, timing behavior, and security boundaries.
- Prefer targeted edits over broad rewrites.
- Extend an existing owner rather than duplicating logic.
- Do not silently change public defaults or persisted formats.
- Do not weaken validation or fail-open behavior for convenience.

## Architectural invariants

### Cordis and sidecar

The Cordis plugin integrates the sidecar into the DSH lifecycle and owns cleanup **only for processes it spawned**.

Preserve:

- health-check based startup;
- explicit `autoStart` semantics;
- bounded readiness waiting;
- cleanup of spawned processes on shutdown;
- actionable diagnostics when startup fails.

Do not turn the plugin into a competing or unconditional process manager.

### ChatGPT Web adapter

Browser interaction is sensitive to ChatGPT Web session and DOM behavior. Preserve:

- authentication/session isolation;
- bounded retries and timeouts;
- fail-closed behavior with actionable diagnostics;
- verified DOM assumptions;
- the existing single-session/concurrency model.

Do not introduce parallel browser turns against one ChatGPT session unless the concurrency contract explicitly supports them.

### Runtime and capability boundaries

`browser-only` is the pure conversational provider path. `full` explicitly enables the tool/MCP and Codex-related integration surfaces. Do not widen or bypass these capabilities implicitly.

Keep browser-only behavior free of autonomous local execution. Tool-capable behavior must remain behind its explicit runtime and protocol boundaries.

`automatic` and `manual`/Zero Risk browser interaction are distinct capability contracts. Do not mix their identities, connectors, tools, or capability assumptions.

### Codex integration

Codex integration is a separate boundary from the ordinary browser-backed provider path.

Preserve:

- rollout/session identity validation;
- parent/child lineage checks;
- path containment checks;
- explicit authorization for launcher-controlled operations;
- cancellation and cleanup semantics;
- fail-closed behavior when authoritative state cannot validate a resource.

Do not replace these checks with weaker filesystem or session heuristics merely as a convenience fallback.

### Compaction

Compaction and browser-turn handoff are stateful lifecycle boundaries, not just text transformations.

Preserve transaction ownership, opaque short-lived control tokens, tool-environment isolation, and the distinction between logical cancellation and physical worker cleanup. Do not let a replacement turn race an unfinished cleanup handshake.

Treat compaction changes as high-sensitivity changes to session continuity and verify them accordingly.

## Security and privacy

Never commit or publish:

- ChatGPT cookies or browser storage state;
- browser user-data directories;
- API keys, session tokens, or launcher credentials;
- access-bearing tunnel identifiers;
- raw private prompts or sensitive tool results;
- private local filesystem paths in public diagnostics.

Do not weaken authorization, path validation, or timing-sensitive comparisons. Use sanitized examples in issues and documentation.

## Documentation

Keep one authoritative home for important facts:

- `README.md`: user-facing overview and setup;
- `TROUBLESHOOTING.md`: operational diagnosis;
- `SECURITY.md`: security policy;
- source comments/JSDoc: local implementation contracts;
- dedicated architecture/decision documents: durable rationale.

Update documentation when behavior, configuration, installation, diagnostics, security behavior, or operational procedures change. Keep `AGENTS.md` focused on standing instructions, not a second README or changelog.

## Verification

Use proportional verification.

For normal TypeScript changes:

```bash
bun run typecheck
bun run build
```

For packaging, installation, or published-artifact changes:

```bash
bun test
```

Here, `bun test` is the tarball/smoke validation path, not a comprehensive unit-test suite.

For browser/session changes, also use the relevant diagnostics, such as:

```bash
dsh-chatgpt-web doctor
```

Investigate failures before changing code; never treat an unexplained failure as successful verification. Before handoff, verify the exact acceptance path changed and state any remaining uncertainty.

## Dependencies and Git hygiene

Do not add dependencies or perform unrelated upgrades without evidence they are required.

When dependencies change, update the lockfile and run the relevant typecheck, build, packaging, and security checks.

Keep changes focused and reviewable. Do not mix unrelated refactors, formatting sweeps, dependency upgrades, or speculative cleanup into a feature or bug fix.

Before commit or handoff:

- inspect the final diff;
- check for secrets or generated session data;
- ensure documentation/tests match the changed behavior;
- confirm no unrelated files changed.

## Agent decision discipline

Do not implement a technically questionable user proposal blindly. First determine:

1. the required behavior;
2. what the current architecture already provides;
3. whether an existing mechanism can satisfy it;
4. which invariants or persistence boundaries are affected.

State assumptions when evidence is incomplete. Prefer verified behavior and current code over plausible behavior or stale memory.
