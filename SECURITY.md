# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
harness prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon's default listener is bound to loopback. Treat the authenticated browser profile and the
data directory (`DSH_CHATGPT_WEB_HOME`) as sensitive local credentials: anyone who can access that
storage or account session may be able to act as the authenticated ChatGPT user.

The containerised HTTP service is the product, and its API is the execution ingress. `/v1/responses`,
`/v1/chat/completions` and `/v1/models` describe the service's own surface, not a compatibility shim,
and the public `/v1/*` surface is gated by `DSH_CHATGPT_WEB_API_KEY` (or `<data dir>/api-key`): a
non-loopback bind refuses to start without a configured key. That key is a separate authority from the
operator control token used by `/v1/control/*` and `/admin/*`, and `/healthz` is deliberately open
because it reports liveness metadata only.

Keep dependency security fixes and lockfile overrides documented in the repository. Verify security-sensitive
dependency changes with the repository's normal typecheck, build, regression, packaging, and smoke-test gates.

For security reports, use the repository's private reporting channel when available. Do not publish a proof
of concept that exposes credentials or enables arbitrary local execution; contact the maintainer privately
through the GitHub account listed by the repository.


## Diagnostics and provenance

Routine runtime diagnostics use safe metadata rather than raw payloads. Tool diagnostics may include names, counts, and size statistics but not raw arguments or freeform input. Error diagnostics may include stable identity, codes, types, and status but not raw messages containing prompts or tool output. Arbitrary sidecar text is represented by length and a short fingerprint. Provenance and correlation identifiers are diagnostic only and must never become an alternate capability, sandbox, retry, or routing authority.

Do not add logging that prints prompts, files, browser credentials, cookies, session tokens, raw tool output, or raw browser state.
