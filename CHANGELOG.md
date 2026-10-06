# Changelog

## 1.0.14

- fix conversational projection when DSH injects Hindsight or operational context as separate user-role messages.
- preserve clean user/assistant history instead of dropping it when standalone internal context is present.
- detect operational context lines anywhere inside a message and strip them safely.
- reject ambiguous multiple canonical context envelopes and strip hidden metadata from embedded messages.


## 1.0.13

- validate native DSH NDJSON events at the sidecar boundary instead of trusting TypeScript casts at runtime.
- validate every adapter-emitted DSH stream chunk before exposing it to the harness, converting protocol corruption into a serializable terminal error instead of an AssistantStreamAccumulator serialization crash.
- add regressions for malformed error and tool-call events that previously could inject undefined fields into stream chunks.

## 1.0.12

- fix parsing of escaped quotes and backslashes inside the DSH JSON context envelope.
- prevent invalid lossless stream chunks when an input projection error occurs by omitting undefined finish status fields.
- add regression coverage using realistic escaped Hindsight content and DSH stream serialization.

## 1.0.11

- project DSH transport envelopes down to conversational user/assistant history before sending turns to ChatGPT Web.
- remove Hindsight, transport, environment, operational timestamp, and private checkpoint content from the ChatGPT-facing context.
- fail closed when a DSH transport envelope is present but cannot be parsed safely.
- add adversarial regression coverage for nested JSON, malformed envelopes, and unterminated internal blocks.

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
