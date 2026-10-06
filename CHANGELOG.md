# Changelog

## 1.0.9 — development

1.0.8 is the closed chat-only stability baseline.

1.0.9 development is intentionally focused on optimizing the browser-backed chat path before any tool execution work is reconsidered.

- automatically migrate persisted `releaseVersion` to the installed plugin release during config loading, while refusing silent downgrades from a newer config.

Identity fix in this development cycle:
- authenticate the browser lease against the stable ChatGPT user identity instead of mutable storage-state serialization.
- persist the account fingerprint during login so restarts keep the same logical account identity.

Focus:
- observability and diagnostics;
- chat turn reliability and lifecycle behavior;
- browser submission and streaming robustness;
- latency and unnecessary work in the chat path;
- context/continuity efficiency without changing the external provider contract.

Tools are intentionally out of scope for this development cycle.
