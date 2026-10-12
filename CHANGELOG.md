# Changelog

## 1.0.28

- Normal Chat Mode sends only the user's message — plus the deterministic `Project:`/`github:` header on the first message of a conversation. DSH host context (the skills catalogue, runtime context, the Aegis bootstrap, Hindsight recall and the time snapshot) can no longer reach ChatGPT Web, and can no longer be mistaken for the user's turn.
- Scope Advisor state to the DSH session that produced it: the turn result card and the activity list no longer show another session's review, the activity list is requested and persisted per session, and recording a result no longer replaces another session's result for the same turn number.


## 1.0.27

- Reject a healthy-but-outdated sidecar instead of reusing it after a plugin package upgrade.
- Include the running daemon's reported version and PID in the diagnostic, and direct the user to restart the old `serve` process and DSH safely.
- Require sidecar service identity and exact version agreement both when reusing an existing daemon and when waiting for a newly started daemon.


## 1.0.26

- Separate normal Chat Mode from Advisor: normal turns retain provider-native continuity and send only the current user input; deterministic project metadata supplies the optional repository header.
- Route normal ChatGPT Web turns through the shared provider-neutral WebChat exchange lifecycle and transport boundary.
- Include the merged architecture, provider conformance, transport and CLI/sidecar boundary fixes present on `main` at release preparation.


## 1.0.25

- Fix the standalone CLI/sidecar dependency boundary: the CLI no longer imports the host-only `@deepseek-ai/dsh-llm` adapter peer (PR #230).
- Resolve ChatGPT Web provider identity from the canonical WebChat host route while retaining the public native adapter alias.
- Add a clean-tarball regression check that the CLI bundle does not import the host-only peer.

## 1.0.16

- send the retained ChatGPT Web first turn as plain composer text with the persona prefix, project name, and human message.
- send only the new human message on normal retained continuations.
- keep the installed system fingerprint frozen for the physical ChatGPT conversation generation.
- remove the legacy JSON-envelope fallback from retained continuations and fail explicitly when no human delta remains.
- strip Aegis and operational transport content while preserving the persona system prompt.

## 1.0.15

- retain the managed-Chrome ChatGPT Web surface across turns of the same DSH conversation.
- minimize retained ChatGPT Web continuation transport to the newest DSH delta instead of replaying the fixed contract and stable system prompt.
- bind the installed system fingerprint to the physical conversation generation so replacements safely reinstall the system contract.
- remove the ChatGPT Web bridge tool transport contract and synthetic Pure Chat commentary from normal turns.
- preserve native/OAuth/Codex tool infrastructure separately from the ChatGPT Web prompt transport.

## 1.0.14

- declare compatibility with the current DSH `0.2.1-alpha.1` LLM peer runtime.
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
