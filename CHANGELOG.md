# Changelog

## 1.0.10

- automatically migrate persisted `releaseVersion` to the installed plugin release during config loading.
- refuse silent downgrades when a persisted config was created by a newer plugin release.
- add regression coverage for config and setup migration paths.

## 1.0.9

1.0.8 is the closed chat-only stability baseline.

1.0.9 focused on optimizing the browser-backed chat path before any tool execution work was reconsidered.

Identity fix:
- authenticate the browser lease against the stable ChatGPT user identity instead of mutable storage-state serialization.
- persist the account fingerprint during login so restarts keep the same logical account identity.

Focus:
- observability and diagnostics;
- chat turn reliability and lifecycle behavior;
- browser submission and streaming robustness;
- latency and unnecessary work in the chat path;
- context/continuity efficiency without changing the external provider contract.

Tools remained intentionally out of scope for this development cycle.
