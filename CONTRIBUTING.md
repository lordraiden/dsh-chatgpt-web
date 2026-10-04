# Contributing to dsh-chatgpt-web

Contributions to `dsh-chatgpt-web` should preserve its role as a browser-backed ChatGPT Web provider for DeepSeek Harness. The native DSH provider boundary is `ctx.llm`; the browser sidecar and browser/DOM automation are implementation machinery behind that boundary.

## Guidelines

- Keep contributions small, focused, and well-tested.
- Isolated bug fixes, parser enhancements, and documentation improvements are preferred.
- Ensure all automated tests pass before submitting pull requests.

## Architecture & Scope

Read [`doc/architecture.md`](./doc/architecture.md) before making architectural changes. It is the authoritative description of the native `ctx.llm` provider boundary, the ChatGPT Web ProviderCore and WebSurfaceTransport boundaries, DSH ownership of sessions/tools/skills/approvals/sandbox policy, the separate native Codex protocol, and the role of `/v1/responses` as compatibility ingress rather than execution authority.

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
2. Run test suite:
   ```bash
   bun test
   ```
3. Verify TypeScript types:
   ```bash
   bun run typecheck
   ```
4. Build bundle:
   ```bash
   bun run build
   ```
