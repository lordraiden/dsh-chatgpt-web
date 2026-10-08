# dsh-chatgpt-web Architecture

**Status:** Target architecture for multi-provider text-only Web Chat  
**Implementation status:** Partially implemented; the repository currently contains the ChatGPT Web implementation and the extraction path defined below  
**Document role:** Single architectural source of truth for the Web Chat provider architecture  
**Repository:** lordraiden/dsh-chatgpt-web  
**Last updated:** 2026-10-08

> **Provider-neutral core, provider-owned conversation, transport-independent exchange.**

This project exposes authenticated consumer-web chat services to DeepSeek Harness (DSH) as native LLM providers.

The architecture is being expanded from a single ChatGPT Web integration into a **text-only Web Chat provider layer** that can support ChatGPT, Qwen Chat, and DeepSeek Chat without duplicating the execution engine.

The key design decision is:

> **Abstract the logical conversation and text exchange, not the browser page.**

A provider may use a retained web page, a browser network session, a private web endpoint reached through an authenticated browser, or a hybrid of these. Those are provider transport decisions. The shared core must not depend on any one of them.

This document replaces the previous ChatGPT-centric architecture. Older design sections and issue mappings that were built around a single ChatGPTWebProviderCore, ChatGPT-native MCP/capability execution, or the Responses server as an architectural concern are historical and must not be used as the basis for new provider work.

---

## 1. Scope

### 1.1 In scope

The target architecture covers:

- native DSH LLM provider integration;
- authenticated consumer-web chat services;
- text input and streamed text output;
- provider model discovery and model selection;
- provider-specific reasoning/mode selection where the web product exposes it;
- persistent conversation affinity per DSH session;
- provider-native conversation identifiers and continuation cursors;
- safe first-turn and continuation behavior;
- explicit recovery when provider continuity is lost;
- deterministic cancellation;
- submission/stream/completion state;
- authentication/session health;
- provider-neutral error normalization;
- provider-specific browser or network transport;
- provider conformance tests.

The first target services are:

- ChatGPT Web;
- Qwen Chat;
- DeepSeek Chat.

The architecture must also allow another text-only web provider to be added without changing the DSH-facing adapter or the shared conversation/exchange state machine.

### 1.2 Explicitly out of scope for the common core

The common Web Chat architecture does **not** standardize:

- files;
- image input/output;
- video/audio;
- MCP;
- DSH tool execution;
- browser computer-use actions;
- provider-native tool loops;
- sandbox execution;
- arbitrary agent orchestration;
- API/OAuth integrations used instead of the consumer-web surface.

Those features may continue to exist in the current ChatGPT-specific implementation, but they are provider-specific compatibility features and must not leak into the shared Web Chat core.

---

## 2. Goals and non-goals

### 2.1 Goals

The architecture must provide:

1. One DSH-facing LLM adapter boundary for all text-only Web Chat providers.
2. One shared execution state machine for submission, streaming, completion, cancellation, timeout, and recovery.
3. Stable conversation affinity between one DSH chat and one provider conversation.
4. Provider-native continuation state as an opaque provider-owned handle.
5. No silent conversation fork after a continuity failure.
6. No automatic duplicate submission after an ambiguous send.
7. Provider transport freedom: DOM, browser-network, hybrid, or another web-native mechanism.
8. Provider-specific authentication and model behavior without contaminating the core.
9. Explicit separation between:
   - DSH session identity,
   - provider account/session identity,
   - provider conversation identity,
   - transport resource identity,
   - individual turn identity.
10. A conformance suite that every provider must satisfy.
11. Incremental migration from the existing ChatGPT implementation without a green-field rewrite.

### 2.2 Non-goals

The architecture does not attempt to:

- create a universal browser-automation framework;
- create a universal reverse-engineered API layer;
- make Qwen, DeepSeek, and ChatGPT expose the same private protocol;
- emulate the OpenAI API internally;
- force every provider to retain a browser page;
- force every provider to resend the complete DSH history on every turn;
- make provider-private conversation state authoritative over DSH session state;
- unify provider-specific model identifiers into one universal backend ID;
- preserve provider-native features that cannot be expressed safely through text-only DSH semantics.

---

## 3. Why the architecture is changing

The previous document centered the design on:

~~~text
DSH
  -> ChatGPTWebProviderCore
      -> retained ChatGPT page
      -> ChatGPT DOM transport
~~~

That model is correct for the current implementation but is the wrong long-term abstraction.

The three target web services have materially different implementation characteristics.

### ChatGPT Web

The current implementation can maintain a physical conversation surface in a retained browser page and continue by writing only the new turn into the existing conversation.

### Qwen Chat

Current independent implementations of the Qwen Web surface show that conversation continuity can be represented by a server-side chat_id plus a provider response/parent cursor. Other implementations also rely on persistent browser state and anti-bot/session data. These details are not stable public contracts and therefore must remain inside a Qwen-specific driver.

### DeepSeek Chat

Current independent implementations of the DeepSeek Web surface use a server-side chat session and message lineage such as chat_session_id / parent_message_id, with additional web-session protections such as proof-of-work in some flows. DeepSeek officially documents chat.deepseek.com as the consumer chat surface and continues to evolve its web models independently of its API.

Therefore:

~~~text
Wrong abstraction:
    Web Provider == Browser Page

Correct abstraction:
    Web Provider
        |
        +-- Conversation Handle
        +-- Text Exchange
        +-- Authentication Session
        +-- Provider Transport
~~~

The common layer owns the semantics. The provider owns the mechanism.

---

## 4. Core architectural principles

### 4.1 One DSH-facing contract, many provider drivers

DSH should not know how ChatGPT, Qwen, or DeepSeek talks to its website.

The public routing authority remains the DSH LLM runtime. The WebChat layer sits behind that contract and resolves the already-selected provider route to the appropriate driver.

~~~text
DSH LLM runtime
      |
      | provider route already selected
      v
WebChatLlmAdapter
      |
      v
WebChat Core
      |
      +--> driver resolver
              |
              +--> ChatGPT driver
              +--> Qwen driver
              +--> DeepSeek driver
~~~

The internal driver resolver is not a second DSH provider registry or a second user-visible routing authority. It only answers:

"Given the provider route DSH already selected, which WebChat implementation owns it?"

The DSH-facing adapter remains provider-neutral.

### 4.2 Provider-private mechanisms stay behind the driver

The provider driver owns:

- login/authentication semantics;
- session cookies/browser profile semantics;
- model selection controls;
- model identifiers;
- reasoning/mode controls;
- conversation identifiers;
- continuation cursors;
- response parsing;
- submission/completion detection;
- provider-specific transport;
- provider-specific recovery rules;
- provider-specific limitations.

The shared core never parses:

- ChatGPT thread IDs;
- Qwen chat_id;
- DeepSeek chat_session_id;
- Qwen/DeepSeek parent IDs;
- provider DOM selectors;
- provider-specific network endpoints.

### 4.3 Logical conversation is not a physical browser surface

A logical provider conversation may be implemented through:

- a retained page;
- a new page in the same authenticated browser context;
- browser-network requests;
- a browser context plus provider session identifiers;
- a provider API exposed only through the authenticated product session.

The common core therefore stores an **opaque conversation handle**, not a Page.

A physical browser object may be retained by a provider transport, but it must never become the identity of the logical conversation.

### 4.4 The DSH session remains canonical

The DSH session remains the source of truth for:

- session identity;
- model request history;
- user/assistant message history;
- provider selection;
- lifecycle.

A provider conversation is continuity state, not a replacement transcript.

### 4.5 No silent fork

If the provider conversation is lost, expired, corrupted, or no longer matches the stored continuation state, the system must not silently create a new provider conversation and pretend that continuity was preserved.

The result must explicitly distinguish:

- exact continuation;
- explicit replay/rebuild;
- continuity failure.

### 4.6 No duplicate send after ambiguity

Once a provider may have accepted a message, a timeout is not sufficient evidence that nothing happened.

After the submit boundary, automatic retry is prohibited unless the provider driver can prove that no duplicate request can be generated.

This is the central at-most-once submission invariant.

### 4.7 Do not over-generalize the browser

A shared browser helper may exist for:

- profile management;
- Chrome/Chromium startup;
- context lifecycle;
- CDP;
- persistent cookies.

But those utilities are infrastructure, not the Web Chat provider contract.

A provider may bypass them entirely if its transport does not require them.

---

## 5. Target architecture

~~~text
+--------------------------------------------------------------------------+
|                           DeepSeek Harness                               |
|                                                                          |
|   Session / Agent Runtime                                                |
|            |                                                             |
|            v                                                             |
|       DSH LLM Runtime                                                    |
|            |                                                             |
|            v                                                             |
|      WebChatLlmAdapter                                                     |
+------------|-------------------------------------------------------------+
             |
             v
+----------------------------------------------------------------------------+
|                              WebChat Core                                  |
|                                                                            |
|  Driver Resolver for DSH-selected routes                                 |
|       |                                                                    |
|       +--> Model Resolver                                                  |
|       |                                                                    |
|       +--> Conversation Affinity Store                                     |
|       |                                                                    |
|       +--> Exchange State Machine                                          |
|       |                                                                    |
|       +--> Continuation / Replay Coordinator                               |
|       |                                                                    |
|       +--> Stream / Error Normalization                                    |
|       |                                                                    |
|       +--> Cancellation / Shutdown                                         |
|       |                                                                    |
|       +--> Provider Health                                                 |
|                                                                            |
+-------------+----------------------+----------------------+----------------+
              |                      |                      |
              v                      v                      v
      +---------------+      +---------------+      +---------------+
      | ChatGPT Driver|      | Qwen Driver   |      | DeepSeek Driver|
      +---------------+      +---------------+      +---------------+
      | Auth          |      | Auth          |      | Auth          |
      | Models        |      | Models        |      | Models        |
      | Conversation  |      | Conversation  |      | Conversation  |
      | Transport     |      | Transport     |      | Transport     |
      +-------+-------+      +-------+-------+      +-------+-------+
              |                      |                      |
              v                      v                      v
       ChatGPT Web              Qwen Chat             DeepSeek Chat
~~~

There is no requirement for the three provider drivers to share a browser worker implementation.

---

## 6. The five identities that must stay separate

### 6.1 DSH Session Identity

This is the DSH conversation/session identity.

It is the stable logical anchor used by DSH.

Example:

~~~text
dshSessionId = "session-123"
~~~

The Web Chat layer must never replace this identity with a provider identifier.

### 6.2 Provider Account Binding

This identifies the authenticated product account/profile used for the provider.

It should be represented internally by a stable non-secret binding identifier.

Example:

~~~text
bindingId = "qwen-profile-default"
~~~

Do not use email addresses, cookies, bearer tokens, or browser storage blobs as the logical identifier.

### 6.3 Provider Conversation Handle

This is an opaque provider-owned continuity record.

Conceptually:

~~~text
ProviderConversationHandle
  providerId
  bindingId
  generation
  opaqueState
~~~

Examples of opaqueState:

- ChatGPT-specific thread/generation information;
- Qwen chat ID plus continuation cursor;
- DeepSeek session ID plus parent message ID.

The core stores and passes this state. It does not interpret provider fields.

### 6.4 Transport Resource

A provider may hold a physical resource such as:

- Playwright page;
- browser context;
- CDP session;
- authenticated web session;
- provider-network connection.

The core sees this only through a provider-owned resource/lease boundary.

### 6.5 Turn Identity

Each DSH model call receives a unique logical turn identity.

Example:

~~~text
turnId = "turn-456"
~~~

Turn identity is used for:

- cancellation;
- stream correlation;
- logging;
- duplicate protection;
- stale-result rejection.

A turn is never itself the conversation.

---

## 7. Conversation affinity

Conversation affinity maps one DSH session and one provider/account binding to one provider conversation.

Conceptually:

~~~text
conversationKey =
    providerId
    + accountBindingId
    + dshSessionId
~~~

Hashing or internal normalization is implementation detail.

The important invariant is that the key must include the provider and account binding.

This prevents an accidental cross-provider collision:

~~~text
DSH session 123
  -> ChatGPT conversation A

DSH session 123
  -> Qwen conversation B

DSH session 123
  -> DeepSeek conversation C
~~~

Changing provider must therefore never reuse another provider's conversation handle.

### 7.1 Model changes

A model change does not automatically create a new conversation.

The driver must declare whether a requested model can continue the current provider conversation.

The continuation decision is:

~~~text
CONTINUE
  provider confirms that the conversation can continue

NEW_CONVERSATION_REQUIRED
  provider requires a new remote conversation

UNSUPPORTED
  the requested model/option cannot be served
~~~

The core must not silently convert NEW_CONVERSATION_REQUIRED into a new conversation.

The default policy is fail-closed unless the caller explicitly requests a new provider conversation or a replay path is part of the product contract.

### 7.2 Conversation generation

A provider conversation may need generations.

Generation changes are allowed only for explicit lifecycle events such as:

- provider continuity loss;
- intentional replay;
- provider-required model transition;
- provider-required reset;
- explicit user action.

Every generation transition must be recorded in the conversation store and must invalidate stale transport resources.

### 7.3 Durable conversation state

Conversation continuity is durable provider state, not merely in-memory runtime state.

The conversation store must preserve enough non-secret state to restore or explicitly recover a provider conversation after a WebChat runtime restart when the provider itself still supports continuation.

A durable record conceptually contains:

~~~text
conversationKey
providerId
accountBindingId
generation
opaqueProviderHandle
status
lastConfirmedTurn
revision
~~~

The record must not contain cookies, bearer tokens, browser storage, or other authentication secrets.

Updates to the record must be atomic from the core's perspective. Provider-specific handle changes are committed only after the provider reaches the semantic checkpoint that makes the new handle authoritative.

A crash or transport failure at an unknown checkpoint must never be interpreted as successful continuation merely because a request was attempted. The driver must be able to report an uncertain or lost state and the core must then choose explicit resume, replay, or failure according to the provider's recovery contract.

---

## 8. Provider-neutral contracts

The common layer should stay small.

### 8.1 Provider driver

Conceptually:

~~~text
WebChatProviderDriver
  id

  inspectAccount()
  listModels()
  resolveModel()

  assessConversation()
  createConversation()
  resumeConversation()
  replayConversation()

  health()
  shutdown()
~~~

The exact TypeScript interface may differ.

assessConversation() is important: the driver decides whether the current provider conversation is compatible with the requested turn state. That decision may depend on provider-specific model rules, reasoning or mode selection, system/developer instructions, remote conversation state, or other provider facts.

The driver must not return Playwright objects as part of its public provider contract.

### 8.2 Provider conversation

Conceptually:

~~~text
WebChatConversation
  key
  provider
  bindingId
  generation
  handle
  status
~~~

handle is provider-owned opaque state.

### 8.3 Text exchange

The normalized exchange is deliberately text-only.

The core does not define provider-specific prompt syntax. It carries a small semantic input that the driver can project into the selected web product:

~~~text
WebChatTurnInput
  systemInstructions?
  userText
  replayHistory?
  model
  reasoningMode?
~~~

replayHistory is present only when the provider cannot continue the existing remote conversation and an explicit replay has been selected. It is derived from canonical DSH text history; it is never a second persistent transcript.

Normal continuation should prefer the provider's own conversation memory and send only the new turn plus whatever provider-specific state is required to maintain the contract.

Unsupported DSH input such as files, images, or tool definitions must result in a stable UNSUPPORTED_OPTION-class failure. Providers must not silently drop or reinterpret unsupported content.

The normalized exchange is:

~~~text
WebChatExchange
  prepare()
  submit()
  stream()
  abort()
~~~

The provider driver owns how the semantic input becomes transport data.

The event vocabulary should be small:

~~~text
ready
submitted
text_delta
completed
cancelled
error
~~~

Providers may internally have much richer events, but only the semantics needed by the shared core should be normalized.

### 8.4 DSH routing and replay-state boundary

The DSH LLM runtime remains the public authority for provider routing and model dispatch.

The WebChat Core must not replace:

- ctx.llm provider registration;
- DSH provider selection;
- DSH model catalog/discovery semantics;
- DSH retry policy ownership.

A WebChat implementation may expose one multi-route adapter instance or provider-specific adapter instances. Both are valid, provided that provider selection remains owned by DSH and all routes converge on the same WebChat semantics.

DSH provider replay state is optional transport metadata, not the durable WebChat conversation store. If finish.replayState is used, it must always be tagged or validated with provider identity and may only be consumed when the WebChat ownership rules prove that the state belongs to the requested provider conversation. Cross-provider replay state must fail closed.

### 8.5 Error contract

Core error classes should describe the semantic failure:

~~~text
AUTH_REQUIRED
AUTH_EXPIRED
ACCOUNT_UNAVAILABLE
MODEL_UNAVAILABLE
CONVERSATION_LOST
CONVERSATION_STATE_MISMATCH
SUBMISSION_AMBIGUOUS
RESPONSE_TIMEOUT
UPSTREAM_RATE_LIMITED
UPSTREAM_ERROR
INPUT_TOO_LARGE
CANCELLED
TRANSPORT_UNAVAILABLE
UNSUPPORTED_OPTION
SHUTDOWN
~~~

Provider-specific diagnostic detail stays attached to the error but does not change the shared category.

---

## 9. Exchange state machine

Every text request follows the same high-level lifecycle.

~~~text
CREATED
   |
   v
PREPARING
   |
   v
TRANSPORT_READY
   |
   v
SUBMITTING
   |
   v
SUBMITTED
   |
   v
STREAMING
   |
   v
COMPLETED
~~~

Terminal alternatives:

~~~text
PREPARING --------> FAILED
TRANSPORT_READY --> FAILED
SUBMITTING -------> SUBMISSION_AMBIGUOUS
SUBMITTED --------> RESPONSE_TIMEOUT / UPSTREAM_ERROR
STREAMING --------> CANCELLED / FAILED
~~~

### 9.1 Submission boundary

The critical boundary is:

~~~text
before submit
    |
    v
submit activation
    |
    v
submission accepted
    |
    v
response stream
~~~

Before the submit boundary, a failed attempt may normally be retried.

After the provider may have accepted the message, the runtime must not resend automatically unless the driver can prove duplicate suppression.

### 9.2 Cancellation

Cancellation is idempotent.

The sequence is:

~~~text
logical cancellation
    ->
abort provider exchange
    ->
wait for or force physical settlement
    ->
release transport resource
~~~

A logical turn can finish before the physical resource is safe to reuse.

Therefore the shared core must track both logical result and physical settlement.

### 9.3 Physical settlement

The core does not assume that:

~~~text
error returned == browser/network operation stopped
~~~

A provider driver must report or enforce physical settlement before reusing a resource that could still produce late output.

This is particularly important for retained browser pages.

---

## 10. Continuation, replay and recovery

The common core defines three semantic outcomes.

### EXACT_RESUME

The provider conversation handle remains valid and the next turn continues the same provider conversation.

~~~text
DSH session
    |
    v
same provider conversation
    |
    v
new turn
~~~

### REPLAY

Provider continuity is unavailable or intentionally replaced.

The new provider conversation is rebuilt from canonical DSH text state.

~~~text
DSH canonical history
    |
    v
provider replay projection
    |
    v
new provider conversation
~~~

Replay is a deliberate recovery mode, not a hidden fallback.

### FAILED

The system cannot safely establish continuity or cannot prove that replay is safe.

The request fails explicitly.

### 10.1 No silent downgrade

Never:

~~~text
EXACT_RESUME failed
    ->
silently create new conversation
    ->
pretend success
~~~

Instead:

~~~text
EXACT_RESUME failed
    ->
CONVERSATION_LOST
    ->
explicit recovery decision
    -> EXACT_RESUME
    -> REPLAY
    -> FAILED
~~~

### 10.2 Ambiguous submission is different

A lost conversation after a confirmed submit is not equivalent to a pre-submit failure.

Example:

~~~text
message sent
    |
    v
network timeout
    |
    v
unknown whether provider generated an answer
~~~

The correct state is SUBMISSION_AMBIGUOUS.

The system must not replay the same prompt automatically merely because the response was not observed.

---

## 11. Canonical text history

The DSH session remains canonical.

The Web Chat layer must distinguish:

- canonical DSH history;
- provider-native continuation state;
- transport payload.

These are not the same thing.

### 11.1 Normal continuation

When provider continuity is healthy, the driver should prefer native continuation.

For a provider with server-side conversation memory:

~~~text
DSH canonical history
      |
      +---- provider conversation already contains prior turns
      |
      v
only current text is submitted
~~~

This reduces:

- repeated prompt transfer;
- browser composer size;
- serialization cost;
- risk of formatting drift.

### 11.2 Initial conversation

The first turn may need the complete relevant system/user context.

The driver owns how the provider's web product must receive it.

The shared core should not contain a universal prompt compiler.

### 11.3 Replay

Replay may need to reconstruct prior text.

The driver receives a canonical replay projection rather than provider-specific transcript markup.

Provider-specific formatting remains in the driver.

### 11.4 System instructions

System/developer instructions are part of DSH request semantics.

Whether a provider:

- stores them in a persistent conversation prefix;
- repeats them every turn;
- embeds them in the first prompt;
- requires conversation recreation when they change;

is provider-specific.

The common core should model this as continuation compatibility rather than as a ChatGPT-specific fingerprint algorithm.

---

## 12. Transport architecture

The transport layer is intentionally more flexible than the old browser-only design.

### 12.1 DOM transport

The provider uses the product UI directly.

~~~text
browser page
   |
composer
   |
send
   |
visible response stream
~~~

Suitable when:

- the DOM is the only stable product surface;
- authentication is easiest through the UI;
- web requests are inaccessible or too volatile to reproduce.

ChatGPT currently uses this class of transport.

### 12.2 Browser-network transport

The provider uses the authenticated browser session as the trust/session anchor but exchanges text through the web application's network surface.

~~~text
authenticated browser context
          |
          +--> cookies / session state
          |
          +--> provider web request
          |
          +--> streamed response
~~~

This is useful when:

- the web UI's internal request protocol is more stable than DOM scraping;
- conversation IDs/cursors are explicit in web requests;
- the browser session provides authentication and anti-bot state.

Qwen and DeepSeek have current independent implementations following variants of this model.

### 12.3 Hybrid transport

A provider may:

1. authenticate through the browser;
2. maintain the browser profile/context;
3. execute text exchange through a network path;
4. fall back to DOM interaction only where the network path cannot safely express an operation.

This must remain provider-local.

### 12.4 What the core must never assume

The core must never require:

- a Playwright Page;
- CSS selectors;
- an editable composer;
- browser DOM traversal;
- a specific web endpoint;
- a provider's private JSON schema.

The core sees only semantic exchange operations.

---

## 13. Authentication and provider sessions

Authentication is provider-owned.

The shared layer should expose only a minimal semantic state:

~~~text
AUTHENTICATED
AUTH_REQUIRED
AUTH_EXPIRED
AUTH_UNAVAILABLE
UNKNOWN
~~~

Provider drivers own:

- login URL;
- cookie/session semantics;
- browser profile;
- session refresh;
- account detection;
- anti-bot/session requirements;
- logout or invalidation.

Credentials and session-bearing browser state must never be stored in conversation records or written to logs.

### 13.1 Session bootstrap and interactive verification

Authentication is broader than cookie loading.

A provider may require:

- an already authenticated persistent browser profile;
- user-assisted login;
- access verification or anti-bot challenges;
- browser-derived session material;
- provider-specific challenge computation;
- revalidation before each transport mode is allowed.

These mechanisms remain provider-local.

The common core must not assume that a headless or automated browser can always establish a valid consumer-web session. A provider driver may require an existing real browser profile, an interactive bootstrap step, or a browser-assisted network transport. The semantic result exposed to the core remains only the provider authentication/session state.

### 13.2 Browser profiles

A persistent browser profile is an implementation detail.

It may be reused by several conversations of one provider/account, but:

~~~text
browser profile != conversation
browser context != conversation
page != conversation
~~~

The conversation store must not use a browser object as its identity.

---

## 14. Model architecture

Model selection is provider-owned.

The common model descriptor should contain only semantics useful to DSH:

~~~text
WebChatModel
  providerId
  id
  displayName
  reasoningModes?
  capabilities
~~~

The provider owns:

- exact web UI/model identifier;
- display label;
- reasoning mode mapping;
- availability;
- account eligibility;
- provider-specific limitations.

The common core must not assume that model IDs are globally unique.

Use:

~~~text
providerId + modelId
~~~

as the logical identity.

### 14.1 Reasoning modes

Reasoning is optional provider metadata.

Examples might include:

~~~text
off
low
medium
high
~~~

or provider-specific web modes.

The common layer treats these as opaque ordered identifiers supplied by the driver.

It must not invent a universal mapping such as thinking=true.

---

## 15. Concurrency and resource ownership

The default policy is conservative.

### 15.1 One active exchange per provider conversation

A single logical provider conversation must not accept two concurrent turns unless the provider driver explicitly proves that its conversation protocol is concurrency-safe.

Default:

~~~text
conversation A
   |
   +--> turn 1  [active]
   |
   X--> turn 2  [reject or queue]
~~~

This prevents:

- interleaved prompt submission;
- parent-cursor corruption;
- page/composer races;
- response misattribution.

### 15.2 Account sharing

One authenticated provider account may serve multiple DSH sessions.

This is permitted only when provider transport resources can be safely separated.

Example:

~~~text
Qwen account
  |
  +--> DSH session A -> conversation A -> transport resource A
  |
  +--> DSH session B -> conversation B -> transport resource B
~~~

If the provider cannot safely isolate those sessions, the provider driver must serialize them.

### 15.3 Transport lease

A provider may expose an internal resource lease.

The lease owns:

- transport resource;
- exclusive ownership;
- release;
- forced retirement;
- physical settlement.

It does not own:

- DSH authorization;
- provider conversation identity;
- canonical history.

---

## 16. DSH integration

DeepSeek Harness already provides a provider-neutral adapter contract:

~~~text
LlmAdapter
  stream(GenerateOptions)
      -> AsyncIterable<StreamChunk>
~~~

The Web Chat integration should follow that contract rather than create another public LLM protocol.

The DSH adapter is responsible for:

- provider route registration;
- translating DSH request fields into the shared Web Chat request;
- translating normalized text stream events into DSH StreamChunk;
- resolving model metadata;
- forwarding cancellation;
- exposing unsupported-option errors.

It must not know:

- provider DOM;
- provider network payloads;
- session cookies;
- conversation cursors;
- browser worker internals.

DSH's own adapter documentation also provides an important continuity seam: provider-specific follow-up metadata can be retained as opaque replay state when the adapter owns that continuation. The Web Chat architecture may use this mechanism where useful, but long-lived conversation affinity remains a Web Chat responsibility rather than a caller-visible provider ID.

The adapter must also reject unsupported GenerateOptions content rather than silently discard it. In particular, a text-only WebChat route must not quietly strip tool definitions, file/image content, or other unsupported request features simply to make a call succeed. This preserves DSH's stable provider error semantics.

---

## 17. Provider driver resolution

The plugin must move from a ChatGPT-only adapter boundary to a WebChat adapter capable of resolving multiple provider drivers.

Conceptually:

~~~text
DSH provider route
       |
       v
WebChatLlmAdapter
       |
       v
Driver Resolver
       |
       +--> chatgpt-web
       +--> qwen-web
       +--> deepseek-web
~~~

The DSH LLM runtime remains the authority that selects the provider route. The internal driver resolver only maps that already-selected route to an implementation.

It must not become a second public provider registry, routing policy, or model authority.

Each driver is independently testable.

Provider configuration may be namespaced by provider:

~~~text
webChat:
  providers:
    chatgpt-web: ...
    qwen-web: ...
    deepseek-web: ...
~~~

Configuration namespacing is not provider routing. The selected DSH route remains authoritative.

The repository package name remains dsh-chatgpt-web during this architectural migration to avoid breaking existing installation/configuration. A future package rename is optional and is not required for the architecture to be correct.

---

## 18. Target code organization

The exact filenames may evolve, but the conceptual ownership should converge toward:

~~~text
src/
  adapters/
    base.ts

    web-chat/
      llm-adapter.ts

  web-chat/
    core/
      errors.ts
      events.ts
      exchange.ts
      exchange-state.ts
      conversation.ts
      conversation-key.ts
      conversation-store.ts
      continuation.ts
      runtime.ts
      model.ts
      provider.ts

    transport/
      text-transport.ts
      transport-lease.ts

    auth/
      account-binding.ts
      auth-state.ts

    providers/
      chatgpt/
        driver.ts
        auth.ts
        models.ts
        conversation.ts
        transport/
          dom.ts
          ...
      qwen/
        driver.ts
        auth.ts
        models.ts
        conversation.ts
        transport/
          browser-network.ts
          ...
      deepseek/
        driver.ts
        auth.ts
        models.ts
        conversation.ts
        transport/
          browser-network.ts
          ...
~~~

### 18.1 Core import rule

The dependency direction is:

~~~text
DSH adapter
    |
    v
WebChat core
    |
    +--> provider driver interface
    |
    +--> transport interface
           ^
           |
     provider implementation
~~~

The core must never import:

- ChatGPT browser worker code;
- Qwen selectors;
- DeepSeek endpoint definitions;
- provider-specific cookies;
- provider-specific response DTOs.

Provider drivers may import shared core contracts.

---

## 19. Migration of the current ChatGPT implementation

The current repository already contains useful seams. The goal is extraction and ownership cleanup, not a rewrite.

### 19.1 Keep

These ideas are architecturally sound:

- stable DSH conversation identity;
- one conversation affinity per DSH chat/provider binding;
- explicit physical resource retention;
- tombstoning a lost retained surface instead of silently creating another;
- explicit submission activation;
- explicit submission confirmation;
- logical versus physical settlement;
- normalized adapter events;
- cancellation;
- provider-specific model metadata.

### 19.2 Extract into the common core

The following responsibilities should become provider-neutral:

~~~text
src/adapters/base.ts
    -> remains the lowest adapter seam

chatgpt-web/conversation-key.ts
    -> generic conversation-key / continuation core
       with ChatGPT-specific rules removed

chatgpt-web/retained-surface.ts
    -> generic retained-resource/transport lease mechanism
       with Page-specific typing removed from the core

ChatGPT turn state
    -> generic exchange state machine

ChatGPT adapter stream normalization
    -> generic WebChat event normalization
~~~

### 19.3 Keep provider-local

The following remain ChatGPT-specific:

~~~text
src/browser-login.ts
src/chatgpt-session.ts
src/chatgpt-web-models.ts
src/chatgpt-web-authority.ts
src/adapters/chatgpt-web/browser-worker.ts
src/adapters/chatgpt-web/prompt.ts
src/adapters/chatgpt-web/compaction-*.ts
src/adapters/chatgpt-web/rolling-checkpoint.ts
src/adapters/chatgpt-web/mcp-*.ts
src/adapters/chatgpt-web/native-*.ts
~~~

Some of these may later be retired or reduced, but they should not be generalized simply because another provider exists.

### 19.4 WebSurfaceTransport change

The existing WebSurfaceTransport concept is useful but too ChatGPT-shaped.

It should become two layers:

~~~text
WebChat core
    |
    v
TextExchangeTransport
    |
    +--> provider transport
            |
            +--> DOM
            +--> browser-network
            +--> hybrid
~~~

The current ChatGPT surface transport then becomes one implementation of the provider transport seam.

It must not define the universal Web Chat interface.

---

## 20. ChatGPT-specific features outside the common architecture

The current repository includes functionality beyond text-only exchange.

Examples include:

- MCP/capability bridging;
- native Codex-related routes;
- Responses compatibility;
- Advisor review;
- compaction/control protocols;
- image/tool payloads.

These may remain operational for ChatGPT.

They are intentionally classified as:

~~~text
ChatGPT-specific compatibility/features
        |
        v
outside WebChat Core
~~~

The shared Web Chat contract must remain text-only.

A future provider does not inherit ChatGPT MCP, capability, Codex, or Advisor semantics merely by implementing WebChatProviderDriver.

This separation is essential to prevent the new architecture from becoming a generic agent runtime.

---

## 21. Provider-specific design expectations

### 21.1 ChatGPT driver

Expected characteristics:

- browser-authenticated consumer product;
- retained conversation surface may be useful;
- DOM text transport is currently the primary mechanism;
- conversation affinity can map to a retained physical generation;
- existing ChatGPT-specific model and system-prefix rules remain provider-local.

The migration must preserve current ChatGPT continuity before adding other providers.

### 21.2 Qwen driver

The driver should be designed to accommodate:

- authenticated browser session/profile state;
- provider conversation ID;
- provider parent/response cursor;
- web-network exchange where useful;
- DOM fallback only if required;
- provider anti-bot/session requirements;
- provider-specific model/mode selection.

Current independent work against chat.qwen.ai demonstrates server-side chat_id and parent/response chaining, while separate recon work reports that automated browser sessions can encounter the site's access-verification layer. This reinforces the architectural rule that session bootstrap, browser profile choice, anti-bot handling and network transport remain Qwen-local implementation decisions.

### 21.3 DeepSeek driver

The driver should be designed to accommodate:

- authenticated web session;
- provider conversation/session ID;
- provider message-parent lineage;
- streamed web responses;
- browser-network or DOM transport;
- current product modes such as reasoning/non-reasoning;
- web-session protections that may change over time.

DeepSeek's current web service is explicitly separate from the API product surface, even though the Web and API model families evolve rapidly in parallel. API model IDs, API request formats, API pricing and API context limits therefore must not be used as the Web provider architecture. The DeepSeek driver must establish current Web model availability and Web session behavior independently.

---

## 22. Failure and recovery rules

The following rules are mandatory.

### 22.1 Authentication loss

~~~text
AUTH_EXPIRED
  ->
stop before submit
  ->
refresh/re-authenticate if the provider supports it
  ->
resume only if the conversation handle remains valid
~~~

No new conversation is silently substituted.

### 22.2 Conversation loss

~~~text
CONVERSATION_LOST
  ->
invalidate old generation
  ->
explicit recovery decision
~~~

A dead conversation handle is never reused.

### 22.3 Transport failure before submit

Safe retry may occur within the configured retry policy.

### 22.4 Transport failure after submit

Classify as SUBMISSION_AMBIGUOUS unless the provider proves a different outcome.

No automatic duplicate send.

### 22.5 Stream failure after partial output

The DSH-facing result must clearly distinguish incomplete output from a clean completion.

The provider must not fabricate a normal completion merely because some text was received.

---

## 23. Observability and provenance

Every turn should be traceable with internal identifiers:

~~~text
provider
accountBinding
conversationKey
conversationGeneration
turnId
transportResourceId
~~~

These identifiers are implementation telemetry, not model-visible instructions.

Never log:

- cookies;
- bearer tokens;
- browser storage;
- full authentication headers;
- raw private browser profile data;
- sensitive user prompts by default.

Provider-specific diagnostic detail may be attached to normalized errors, but the core must remain responsible for semantic classification.

---

## 24. Testing strategy

The test strategy is contract-first.

### 24.1 Core tests

The shared core must verify:

- stable conversation-key derivation;
- provider/account/session isolation;
- first-turn creation;
- same-conversation continuation;
- model compatibility decisions;
- generation changes;
- monotonic exchange state;
- cancellation;
- logical/physical settlement separation;
- post-submit retry prohibition;
- ambiguous submission classification;
- stale-handle rejection;
- explicit replay;
- failed recovery.

### 24.2 Provider conformance suite

Every provider driver should pass the same semantic suite:

~~~text
1. authenticate
2. resolve model
3. create first conversation
4. submit first text
5. stream response
6. continue second turn
7. continue third turn
8. verify remote continuity
9. cancel an active turn
10. simulate/handle auth loss
11. handle provider error
12. reject duplicate concurrent turn
13. handle lost conversation
14. perform explicit replay
15. restore continuation after process restart when supported
~~~

The exact transport assertions are provider-specific.

### 24.3 Transport tests

DOM/network/hybrid transports should have separate tests for:

- readiness;
- submit activation;
- submission confirmation;
- text extraction;
- completion;
- abort;
- resource close;
- physical-settlement guarantees.

### 24.4 Architecture tests

Add automated import/layering tests that fail when:

- core imports provider-specific modules;
- provider code imports another provider's implementation;
- ChatGPT-specific capability/MCP code leaks into the common text contract;
- browser Page types appear in common conversation types;
- provider-private identifiers are interpreted by core.

---

## 25. Security boundaries

The main security boundary remains authentication and session ownership.

The architecture must guarantee:

1. provider sessions never cross providers;
2. conversation handles never cross providers;
3. authenticated browser profiles remain provider-scoped;
4. provider-private state is treated as sensitive;
5. model-visible text is never a source of authorization;
6. transport code cannot widen DSH authority;
7. failed continuity does not cause silent cross-session reuse;
8. browser resources are never reused after their physical ownership has become uncertain.

The text-only common core deliberately has no tool-authority or sandbox semantics. Those belong to DSH or to provider-specific features outside this architecture.

---

## 26. Rejected architectures

### 26.1 One giant generic BrowserProvider

Rejected.

Reason:

- different providers use different transport mechanisms;
- a browser page is not a universal conversation abstraction;
- this would force all providers into the ChatGPT implementation model.

### 26.2 Copy browser-worker.ts three times

Rejected.

Reason:

- duplicated lifecycle logic;
- duplicated retry/settlement bugs;
- duplicated conversation affinity;
- inconsistent recovery behavior.

Provider-specific code should implement the driver/transport contract instead.

### 26.3 Make private web endpoints the common protocol

Rejected.

Reason:

- endpoints and payloads are provider-specific;
- private contracts change;
- the common architecture would become reverse-engineering debt.

Private web endpoints may be used inside an individual provider driver.

### 26.4 Make DOM interaction the common protocol

Rejected.

Reason:

- some providers are better represented by their web network exchange;
- DOM structure is unstable and service-specific;
- conversation continuity may live outside the page.

### 26.5 Make the provider conversation ID the DSH conversation ID

Rejected.

Reason:

- one DSH session can use multiple providers;
- provider IDs may expire/change;
- DSH session semantics must survive provider replacement or replay.

### 26.6 Resend the complete DSH history on every normal turn

Rejected as the default.

Reason:

- inefficient;
- unnecessary for providers with server-side conversation state;
- increases transport size and failure surface.

Full history remains the canonical replay source, not the mandatory normal transport payload.

### 26.7 Automatically fork on continuity failure

Rejected.

Reason:

- it silently changes the conversation;
- the user cannot distinguish resume from replay;
- it makes duplicate/lineage bugs hard to detect.

---

## 27. Implementation roadmap

The migration should be delivered as small reviewable slices. The issue/PR numbering below refers to implementation order.

### PR 1 — WebChat contracts

Establish the provider-neutral semantic contracts:

- provider driver contract;
- provider-neutral model descriptor;
- DSH-to-WebChat text projection;
- conversation handle;
- conversation key;
- normalized exchange events;
- normalized error taxonomy;
- explicit unsupported-option behavior.

No functional Qwen or DeepSeek provider is introduced.

### PR 2 — Conversation affinity and durable continuation

Establish the durable continuity layer:

- provider/account/DSH conversation identity;
- opaque provider handle;
- conversation generation;
- durable conversation record;
- atomic continuation-state updates;
- continuation compatibility assessment;
- lost/stale state;
- explicit replay/rebuild.

Do not create a second transcript store.

### PR 3 — Exchange state machine and transport ownership

Extract:

- submission boundary;
- submitted/streaming/completed states;
- ambiguous submission;
- cancellation;
- logical/physical settlement;
- transport lease/resource ownership;
- stale turn rejection.

The common layer remains unaware of DOM and provider network protocols.

### PR 4 — ChatGPT migration to WebChat

Make ChatGPT the first concrete provider using the new contracts.

Preserve current behavior. Keep ChatGPT-specific product features outside the common text-only core.

### PR 5 — DSH route integration and driver resolution

Connect the WebChat architecture to the current DSH LLM runtime:

- provider-route registration;
- driver resolution for selected routes;
- provider-scoped configuration;
- model discovery/resolution;
- authentication and health state;
- backward-compatible ChatGPT route handling.

Do not introduce a second public provider registry or replace DSH provider routing.

### PR 6 — Provider conformance and architecture suite

Make the common lifecycle and layering rules executable and reusable by every provider.

### PR 7 — Qwen Chat text provider

Implement the Qwen-specific driver and transport for text-only web exchange, including its authentication/session bootstrap and provider-native conversation continuity.

The transport strategy remains an implementation decision based on the current Web surface.

### PR 8 — Qwen real-session validation and recovery hardening

Validate the provider against real Qwen Web behavior and harden provider-specific authentication/session, continuity, concurrency and recovery behavior without changing WebChat Core semantics.

This PR handles operational behavior that cannot be established from generic contract tests alone.

### PR 9 — DeepSeek Chat text provider

Implement the DeepSeek-specific driver and transport for text-only web exchange, including its authentication/session bootstrap and provider-native conversation continuity.

The transport strategy remains an implementation decision based on the current Web surface.

### PR 10 — DeepSeek real-session validation and recovery hardening

Validate the provider against real DeepSeek Web behavior and harden provider-specific authentication/session, streaming, continuity and recovery behavior without changing WebChat Core semantics.

### PR 11 — Cross-provider integration validation

Validate all providers together and verify that the architecture remains one shared text-only execution model with independent provider implementations.

---
 
## 28. Current repository mapping

The existing repository already contains several useful architectural pieces.

### Existing generic seams

- src/adapters/base.ts
  - already defines a provider-neutral internal adapter boundary.
- src/types.ts
  - already contains a normalized internal event vocabulary and provider-private context.
- src/adapters/web-composer-resolver.ts
  - already contains service-neutral web-composer selection logic.
- src/adapters/chatgpt-web/retained-surface.ts
  - already proves that physical retention can be isolated from transcript state.
- src/adapters/chatgpt-web/conversation-key.ts
  - already proves stable DSH-thread affinity can be separated from model/turn properties.

These are extraction candidates, not designs that need to be replaced wholesale.

### Current ChatGPT-specific seams

- src/browser-login.ts
- src/chatgpt-session.ts
- src/chatgpt-web-authority.ts
- src/chatgpt-web-models.ts
- src/model-catalog.ts where ChatGPT-specific authority is still embedded
- src/adapters/chatgpt-web/browser-worker.ts
- src/adapters/chatgpt-web/prompt.ts
- src/adapters/chatgpt-web/turn-execution.ts
- ChatGPT-specific compaction/checkpoint modules
- ChatGPT-specific MCP/capability modules

These remain provider-local until there is a concrete reason to extract a smaller reusable seam.

### Current plugin boundary

src/plugin.ts currently registers the ChatGPT adapter and manages the local sidecar lifecycle.

The target is to preserve the sidecar lifecycle responsibility while replacing single-provider registration with a provider-neutral WebChat adapter and driver resolver. The DSH LLM runtime remains the actual provider routing authority; WebChat does not create a competing public registry.

---

## 29. Compatibility policy

The package remains named @lordraiden/dsh-chatgpt-web during the migration.

Do not make a package rename a prerequisite for architectural correctness.

Existing ChatGPT configuration should continue to work through compatibility aliases.

Conceptually:

~~~text
legacy ChatGPT route
      |
      v
ChatGPT driver
      |
      v
WebChat Core
~~~

Provider-neutral internal names may therefore be introduced without breaking the external package/configuration surface.

A later package rename can be handled independently once multi-provider support is mature.

---

## 30. External evidence and references

The following references inform the architecture. They are evidence about current implementations or upstream contracts, not universal web-provider protocols.

### DeepSeek Harness

- LLM adapter cookbook:
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md
- LLM adapter development guide:
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md
- LLM runtime and adapter contract:
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts
- LLM streaming semantics:
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md

These establish the DSH-side rule: provider implementations are LlmAdapter instances, GenerateOptions is provider-neutral, and provider-specific continuation metadata may be retained as opaque replay state when appropriate.

### Qwen

- Qwen official web/product surface:
  https://chat.qwen.ai/
- Qwen cookie/session notice:
  https://qwen.ai/cookies-notice
- Current independent Qwen web reverse-engineering reference:
  https://github.com/AnonymoDGH/Qwen-Reverse
- Current Playwright-based Qwen proxy/reference:
  https://github.com/pedrofariasx/qwenproxy

The independent projects are used only to validate the architectural observation that Qwen conversation state and web transport are provider-specific and may require persistent browser/session state. Current Qwen web recon also reports an access-verification layer that can reject automated browser sessions, reinforcing that authentication/session bootstrap must remain provider-local. Their private endpoints, anti-bot headers, fingerprinting and internal schemas are not architectural contracts for this repository.

### DeepSeek

- Official DeepSeek V4 announcement and web service:
  https://deepseek.com/en/news/v4-preview/
- Current independent DeepSeek Web protocol reference:
  https://github.com/kittors/deepseek-web-api
- Current independent DeepSeek Web API reference:
  https://github.com/ForgetMeAI/FreeDeepseekAPI

The independent projects are used only to validate that DeepSeek Web can expose server-side conversation/message lineage and streamed text exchange through its consumer-web session. Private endpoint names, PoW details, and headers remain strictly provider-local implementation details.

---

## 31. Final ownership model

~~~text
DSH
  = canonical conversation/session history
  = provider selection
  = agent lifecycle
  = DSH cancellation lifecycle

WebChat Core
  = provider-neutral WebChat semantics
  = driver resolution for already-selected DSH provider routes
  = provider-neutral model metadata
  = conversation affinity
  = opaque provider continuation state
  = turn/exchange lifecycle
  = submission boundary
  = logical/physical settlement
  = cancellation
  = continuity/replay decisions
  = normalized text events
  = normalized provider errors
  = provider conformance semantics

Provider Driver
  = authentication
  = account/session binding
  = provider model IDs
  = provider reasoning/modes
  = provider conversation IDs/cursors
  = provider recovery rules
  = provider transport selection

Provider Transport
  = DOM
  = browser-network
  = hybrid
  = provider-specific response parsing
  = provider-specific readiness/submission/completion detection

Browser Runtime
  = optional infrastructure for profiles, contexts, pages, CDP and lifecycle
~~~

The three fundamental invariants are:

> **The DSH LLM runtime selects the provider; WebChat only resolves and executes the already-selected provider route.**

> **The DSH session is canonical; the provider conversation is a continuity handle.**

> **The shared architecture owns the semantics of a text exchange; each provider owns how its web product actually performs that exchange.**

and:

> **The shared architecture owns the semantics of a text exchange; each provider owns how its web product actually performs that exchange.**

A correct implementation therefore looks like:

~~~text
               +----------------------+
               |      DSH Session     |
               +----------+-----------+
                          |
                          v
                +-------------------+
                | WebChat Core      |
                |                   |
                | affinity          |
                | exchange state    |
                | continuation      |
                | recovery          |
                +---------+---------+
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
      ChatGPT           Qwen           DeepSeek
       driver           driver           driver
          |               |                |
       DOM/Browser     Network/Browser   Network/Browser
          |               |                |
          v               v                v
       Web Chat         Web Chat         Web Chat
~~~

That is the architecture to implement. Everything else in the repository should be evaluated against these ownership boundaries.
