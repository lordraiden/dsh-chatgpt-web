# WebChat Core (provider-neutral contracts)

`src/web-chat/core` is the semantic layer every text-only web chat provider implements. It was
introduced by issue #189 (`[PR 1/11] refactor(web-chat): introduce provider-neutral WebChat core`)
and is the contract the rest of the WebChat migration builds on.

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

The durable **backend** for the store is infrastructure and lives outside the core
(`src/web-chat/persistence/conversation-store-file.ts`): it owns the JSON document, reuses the
plugin's atomic write helper, re-reads on every operation (no cache) and refuses a corrupt file or
an unknown schema version instead of presenting an empty store.

## Invariants (enforced by tests)

`tests/issue-189-web-chat-core-boundaries.test.ts` scans the core sources and fails when one of
these is broken:

1. **Import rule (§18.1).** Every core import is a `node:` builtin or another module inside the
   core. Never a provider, a browser, a host wire shape or a store.
2. **No provider, browser or routing knowledge.** No automation library, no DOM locator, no
   selector, no endpoint schema, no credential/session material, no provider name, and no
   `ctx.llm`/adapter registration (the host runtime owns provider selection, model routing and
   retry policy).
3. **Not a store.** No filesystem, browser storage, `JSON.parse` over opaque handles, transcript
   owner or append API. `replayHistory` is an *input*; canonical history stays with the host.
4. **Pinned surface.** The barrel's export inventory is asserted exactly, and no exported name may
   own state or provider policy — so the core cannot grow silently.

`tests/issue-189-web-chat-core-contracts.test.ts` pins the vocabulary and the behaviour: the
category list, the event list, the text-only admission (with the explicit refusal of
files/images/audio/video/attachments/tools/toolChoice/MCP), the opaque handle, the resolver's
resolution-only semantics, a driver implemented with no browser page, the fail-closed replay-state
ownership rule, and the exact conversation-key digests captured before the extraction.

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

## Consuming the core today (reference: ChatGPT)

The ChatGPT path consumes the core without being migrated yet (issue #192 owns that):

- `src/adapters/chatgpt-web/conversation-key.ts` owns the ChatGPT-specific half of affinity (which
  thread identity a request carries, which namespace it runs under) and delegates the digest to
  `core/conversation-key.ts`. The digest is a compatibility surface and must not change.
- `src/adapters/chatgpt-web/web-chat-bridge.ts` projects the existing ChatGPT values into core
  types: the turn identity, the account binding, and the classification of every ChatGPT failure
  code into a core category. The test that scans the provider's declared codes fails when a new
  code is neither classified nor explicitly excluded with a reason.

## What is deliberately not here

The continuity layer exists (issue #190) and is consumed by the provider migration when it moves
that path onto the core key and records its conversations through this store.

| Owner | Work |
| --- | --- |
| #191 (PR 3) | The exchange state machine, retry authority, transport lease, physical settlement. |
| #192 (PR 4) | The ChatGPT driver implementation and its transport behind the core, including retiring `legacyWebChatThreadKey`. |
| #193 (PR 5) | Host route integration: adapter, drivers, models, auth, health. |
| #194 (PR 6) | The provider conformance and architecture-contract suite. |

Qwen and DeepSeek are not implemented and are not referenced by the core.
