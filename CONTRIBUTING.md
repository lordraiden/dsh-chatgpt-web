# Contributing to dsh-chatgpt-web

Contributions to `dsh-chatgpt-web` should preserve its role as a browser-backed ChatGPT Web service, distributed as a container image and Compose stack and surfaced through the CLI and the HTTP API. The browser sidecar and browser/DOM automation are implementation machinery behind that surface.

## Guidelines

- Keep contributions small, focused, and well-tested.
- Isolated bug fixes, parser enhancements, and documentation improvements are preferred.
- Ensure all automated tests pass before submitting pull requests.

## Architecture & Scope

Read [`doc/architecture.md`](./doc/architecture.md) before making architectural changes. It is the authoritative description of the provider-neutral WebChat core, the ChatGPT Web provider and WebSurfaceTransport boundaries, the durable conversation store, the service's own routing authority over its configured provider catalogue, the separate native Codex protocol, and the role of `/v1/responses` and `/v1/chat/completions` as wire-compatible ingresses onto one shared internal turn.

The supported product scope is authenticated normal ChatGPT Web usage on supported Free and paid accounts. Routes whose usage belongs to the Codex/Work allocation are outside this provider.

## Security & Privacy

Never commit or publish ChatGPT cookies, browser storage state, browser user-data profiles, API keys, session tokens, tunnel identifiers, raw private prompts, or sensitive tool results. Use sanitized examples in issues, tests, and documentation.

Runtime diagnostics intentionally use safe metadata at the public logging boundary. Preserve existing redaction and fingerprinting behavior when changing logging or provenance code.

**Fail-closed behavior:** when ChatGPT DOM changes or connection drops occur, fail gracefully with bounded, actionable diagnostics rather than silently hanging.

## Development & Verification

1. Install dependencies:
   ```bash
   bun install
   ```
2. Run the full test suite (the gate CI runs):
   ```bash
   bun run test
   ```
3. Verify TypeScript types:
   ```bash
   bun run typecheck
   ```
4. Build bundle:
   ```bash
   bun run build
   ```
