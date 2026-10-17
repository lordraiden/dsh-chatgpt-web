# WebChat Core (provider-neutral contracts)

`src/web-chat/core` is the semantic layer every text-only web chat provider implements. It was
introduced by issue #189 (`[PR 1/11] refactor(web-chat): introduce provider-neutral WebChat core`)
and is the contract the rest of the codebase builds on.

The target architecture is defined in [architecture.md](./architecture.md). This document is the
index between that specification and the code that implements it today.

## Module map

| Module | What it owns | Architecture |
| --- | --- | --- |
| `core/errors.ts` | The stable failure categories and `WebChatError` (category + optional provider detail). Retry policy is **not** here. | §8.5 |
| `core/events.ts` | The normalized exchange event vocabulary (`ready`, `submitted`, `text_delta`, `completed`, `cancelled`, `error`). | §8.3 |
| `core/exchange.ts` | `WebChatTurnInput`, `WebChatTurnIdentity`, the `WebChatExchange` interface, and the text-only admission rule. | §8.3, §6.5, §1.2 |
| `core/conversation.ts` | The separate identities (host session, account binding, conversation key/handle/generation/status) and the opaque handle admission. | §6, §8.2 |
| `core/conversation-key.ts` | The generic conversation-key derivation. | §7, §19.2 |
| `core/model.ts` | Provider-neutral model metadata; the common layer is text-only. | §14 |
| `core/provider.ts` | The driver contract, the conversation assessment inputs/outcomes, and the provider-tagged replay-state ownership rule. | §8.1, §8.2, §8.4 |
| `core/resolver.ts` | Resolution of an **already-selected** host route to its driver. | §17 |
| `core/account-binding.ts` | The stable identity of one provider/account binding (a fingerprint, never a credential). | §6.2, §7 |
| `core/conversation-store.ts` | The durable continuity record, the store port, the in-memory reference implementation and the record invariants (generations, confirmed checkpoints, no secrets, opaque handles). | §6.3, §7.3, §18 |
| `core/continuation.ts` | The continuation decisions: explicit new conversation, exact resume, explicit replay, or an explicit failure — never a silent fork. | §7.1, §10, §11 |
| `core/exchange-state.ts` | The exchange lifecycle: monotonic states, the submission phase, logical versus physical settlement, cancellation and stale-result protection. | §9 |
| `core/retry-authority.ts` | Retry safety and the exchange's own retry decision, so the host's route-level retry and the exchange cannot both retry one submitted turn. | §9.1, §9.4 |

The transport layer (`src/web-chat/transport/`) holds the provider-neutral seam and its ownership:
`text-transport.ts` (the semantic operations a provider transport implements), `transport-lease.ts`
(exclusive ownership, settlement and retirement of a physical resource) and `exchange-runner.ts`,
which composes the core lifecycle with a transport **without** taking any of their authority. The
core never imports it; a provider implements the seam and the host drives it (architecture §12).

The durable **backend** for the store is infrastructure and lives outside the core
(`src/web-chat/persistence/conversation-store-file.ts`): it owns the JSON document, reuses the
plugin's atomic write helper, re-reads on every operation (no cache) and refuses a corrupt file or
an unknown schema version instead of presenting an empty store.

## Invariants (enforced by tests)

The surviving architecture-boundary scans live in `tests/issue-194-web-chat-architecture-contracts.test.ts`,
which replaced `tests/issue-189-web-chat-core-boundaries.test.ts` when the latter was removed with the
dead code. That suite pins the public surface and the import direction; the remaining import-rule and
forbidden-identifier invariants are **recorded** there rather than each asserted behaviourally, so read
the list below as rules the Core follows:


1. **Import rule (§18.1).** Every core import is a `node:` builtin or another module inside the
   core. Never a provider, a browser, a host wire shape or a store.
2. **No provider, browser or routing knowledge.** No automation library, no DOM locator, no
   selector, no endpoint schema, no credential/session material, no provider name, and no
   host-adapter registration (the host runtime owns provider selection, model routing and
   retry policy).
3. **Not a store.** No filesystem, browser storage, `JSON.parse` over opaque handles, transcript
   owner or append API. `replayHistory` is an *input*; canonical history stays with the host.
4. **Pinned surface.** The barrel's export inventory is asserted exactly, and no exported name may
   own state or provider policy — so the core cannot grow silently.

`tests/issue-189-web-chat-core-contracts.test.ts` pins the vocabulary and the behaviour: the
category list, the event list, the text-only admission (content — files/images/audio/video/attachments —
refused by name, capability declarations — tools/toolChoice/mcp — discarded and reported), the opaque
handle, the resolver's resolution-only semantics, a driver implemented with no browser page, the
fail-closed replay-state ownership rule, and the exact conversation-key digests captured before the
extraction.

## Continuity: the two keys, the record and the decisions

- **Two derivations, one owner each.** `webChatAffinityKey` is the canonical affinity key of §7
  (provider + account binding + host session/thread + namespace). `legacyWebChatThreadKey` is the
  pre-migration thread key of the existing provider path, `@deprecated` with the driver migration
  (issue #192) as its retirement trigger; it exists so an installed conversation keeps its affinity,
  and a boundary test keeps it to exactly one production caller.
- **The record holds continuity only**: affinity identity, generation, the opaque handle, the
  driver's last established status, whether that state is authoritative (`checkpoint`), the
  initialization fingerprint installed in the current generation, and the last confirmed turn. It
  holds no messages (the host owns canonical history), no lease (the exchange lifecycle owns
  transport readiness) and no transport resource.
- **Generations are monotonic** and a stale one is refused rather than silently replaced; an
  initialization fingerprint is never current for a later generation.
- **Nothing is implicit.** `resolveWebChatContinuation` returns `exact_resume`, `new_conversation`,
  `replay` or `failed`; a lost, unreachable, unsupported, unconfirmed or stale conversation fails
  explicitly, and only an explicit caller intent starts a new conversation or a replay. A handle is
  committed only after the driver established it, so a failed driver leaves the record untouched.

## The exchange: submit boundary, settlement and leases

- **The submit boundary is the retry boundary.** `WebChatSubmissionPhase` records what the provider
  proved: `prepared` (nothing was sent — retry-safe), `send_activated` (it may have been sent —
  ambiguous, never retried automatically) or `accepted` (confirmed). `webChatRetrySafetyOf` turns
  that into what the host may do, and `decideWebChatRetry` is the exchange's own decision, so the two
  retry layers cannot both act on one submitted turn. Partial output is never evidence of non-submission.
- **Logical and physical settlement are separate.** A turn can be finished logically while the
  transport resource may still produce late output; only a published physical settlement makes it
  reusable, and a settlement that cannot be proven retires the resource.
- **Nothing is reused while it may still produce output.** The lease registry keeps a conversation
  exclusive, leaves a released-but-unsettled resource `settling`, and refuses a retired one until an
  explicit `reset` — a lost resource never becomes a new one on its own.
- **Cancellation is idempotent** and ordered logical cancellation → provider abort → settlement →
  release; a result arriving after cancellation, after retirement, or from another conversation epoch
  is never accepted.

## Consuming the core today (reference: ChatGPT)

The ChatGPT implementation was migrated onto WebChat Core by issue #192 and exposed through the service host boundary by issue #193. The responsibilities are deliberately split:

- `src/adapters/chatgpt-web/conversation-key.ts` owns the ChatGPT-specific interpretation of host thread/session identity and delegates the stable affinity digest to `core/conversation-key.ts`. The digest remains a compatibility surface.
- `src/adapters/chatgpt-web/chatgpt-driver.ts` implements the provider contract. It reports model availability, account binding, conversation assessment and provider-native continuation; Core applies the shared continuation rules.
- `src/adapters/chatgpt-web/chatgpt-continuity.ts` expresses explicit new/resume/replay decisions through Core and confirms a durable record only after the turn settles successfully. Canonical transcript history remains owned by the host.
- `src/adapters/chatgpt-web/index.ts` composes the native turn with the shared continuity/exchange semantics and ChatGPT's own browser transport. Physical browser settlement and logical turn completion remain distinct.
- `src/web-chat/host/provider-host.ts`, `src/server.ts` and `src/doctor.ts` form the host boundary. The service resolves only drivers that are actually implemented, projects provider-scoped model identity, reports health, and translates retry safety.

The provider-code boundary test still requires every ChatGPT-specific failure code to be classified or explicitly excluded with a reason. ChatGPT-specific DOM, browser resources, MCP/capability behavior and legacy compatibility remain outside `src/web-chat/core`.

## What is deliberately not here

The common Core remains text-only and provider-neutral. It does not own provider implementations, browser transports, credentials, provider-private IDs, the canonical transcript or host route registration. Those remain with the provider, transport, host and service runtime respectively.

Qwen and DeepSeek are roadmap providers, not current routes. Their provider-specific session IDs, lineage, auth challenges and transport protocols must remain opaque to Core.

The containerised service drives the same Core over HTTP, adding a wire-compatibility and operations layer without adding an execution path. See [architecture.md](./architecture.md) §32 and issues #245–#250.
