# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
DeepSeek Harness prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon's normal listener is bound to loopback. Treat the authenticated browser profile and plugin
storage as sensitive local credentials: anyone who can access that storage or account session may be able
to act as the authenticated ChatGPT user.

The native DSH provider is the canonical provider boundary. Trusted DSH context and authorization state
are carried through runtime state rather than reconstructed from model-visible text or browser state.
`/v1/responses` is a compatibility ingress and must not become an independent authorization or execution authority.

Keep dependency security fixes and lockfile overrides documented in the repository. Verify security-sensitive
dependency changes with the repository's normal typecheck, build, regression, packaging, and smoke-test gates.

For security reports, use the repository's private reporting channel when available. Do not publish a proof
of concept that exposes credentials or enables arbitrary local execution; contact the maintainer privately
through the GitHub account listed by the repository.


## Diagnostics and provenance

Routine runtime diagnostics use safe metadata rather than raw payloads. Tool diagnostics may include names, counts, and size statistics but not raw arguments or freeform input. Error diagnostics may include stable identity, codes, types, and status but not raw messages containing prompts or tool output. Arbitrary sidecar text is represented by length and a short fingerprint. Provenance and correlation identifiers are diagnostic only and must never become an alternate capability, sandbox, retry, or routing authority.

Do not add logging that prints prompts, files, browser credentials, cookies, session tokens, raw tool output, or raw browser state.
