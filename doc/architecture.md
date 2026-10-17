# dsh-chatgpt-web Architecture

**Status:** Architecture of the container-only product  
**Implementation status:** Delivered — the provider-neutral core, durable continuation, the exchange lifecycle, the ChatGPT-Web adapter and the provider conformance suite are implemented; the ChatGPT-specific product layer and the Advisor are implemented; the containerised service is the shipping distribution (§32; issues #245–#250 merged and closed); Qwen and DeepSeek remain roadmap providers  
**Document role:** Single architectural source of truth for the Web Chat provider architecture  
**Repository:** lordraiden/dsh-chatgpt-web  
**Last updated:** 2026-10-16

> **Provider-neutral core, provider-owned conversation, transport-independent exchange.**

This project exposes authenticated consumer-web chat services through a containerised HTTP service as provider-qualified text routes.

The architecture is being expanded from a single ChatGPT Web integration into a **text-only Web Chat provider layer** that can support ChatGPT, Qwen Chat, and DeepSeek Chat without duplicating the execution engine.

The key design decision is:

> **Abstract the logical conversation and text exchange, not the browser page.**

All providers in this project are consumed through their user-facing websites in an authenticated Chrome/Chromium browser controlled by Playwright. Provider-specific UI mechanics remain inside each driver; the shared core abstracts logical conversations and text exchanges rather than browser details. This is a product constraint: do not call public, private, or undocumented provider APIs, website-internal HTTP endpoints, or WebSockets to submit prompts, discover models, continue conversations, or obtain generated answers. Do not fall back to such paths when UI automation is difficult.

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
- provider-specific Chrome/Playwright website UI interaction;
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
7. Provider-specific Playwright-driven website UI interaction, behind a provider-neutral semantic exchange contract.
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

Qwen Chat may maintain server-side conversation continuity, but the plugin must operate it through the authenticated website UI. The driver owns the visible model picker, composer, Send action, response detection, and whatever opaque continuity state is required by the existing WebChat contract. Do not reproduce or call the website's internal protocol.

### DeepSeek Chat

DeepSeek Chat may maintain server-side conversation continuity and web-session protections, but the plugin must operate it through the authenticated website UI. The driver discovers models and continues conversations through Chrome/Playwright UI interactions. API model families and internal website protocols are not substitutes for observing the actual consumer product.

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

- a retained Playwright page;
- a new page in the same authenticated Chrome context;
- a provider website conversation reached and continued through its rendered UI.

The driver may keep provider-specific continuity data as opaque state, but it must acquire and use it through the supported website UI interaction path rather than by calling or parsing the site's internal network protocol.

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
|       +--> Model resolution delegation                                    |
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
|       +--> Provider health delegation                                     |
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
- authenticated Chrome browser context/profile;
- CDP session;
- provider website session state.

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

Unsupported DSH input is handled **by kind**, and that distinction is a property of the product rather
than a configurable policy:

- a **capability** declaration (`tools`, `toolChoice`, `mcp` and the legacy `functions`/`function_call`
  aliases) names something this bridge cannot execute. The provider is a consumer web chat reached as
  text: it has no execution path and no return channel to the caller's harness, so a tool definition is
  protocol noise, not content. It is accepted, discarded, and **declared** (the public API names what it
  dropped in `x-dsh-chatgpt-web-ignored-features` and in one log line per request) — never refused, and
  never forwarded.
- a **content** feature (`files`, `images`, `audio`, `video`, `attachments`, non-text content parts) is
  data the model was supposed to *see*. It must result in a stable UNSUPPORTED_OPTION-class failure:
  providers must not silently drop or reinterpret content.

The split is owned once by the core (`WEB_CHAT_CAPABILITY_FEATURES` / `WEB_CHAT_CONTENT_FEATURES`), so no
surface keeps a second list and "drop capability declarations" cannot slide into "drop attached content".
The same rule family covers tool-shaped message state: a `role: "tool"` message is dropped by the
message-only projection (§32.2, issue #253), and an assistant message's `tool_calls` is never read by the
API translation.

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

### 8.4 Routing and replay-state boundary

The service's provider runtime remains the authority for provider routing and model dispatch.

The WebChat Core must not replace:

- service provider registration;
- provider selection;
- model catalog/discovery semantics;
- retry policy ownership.

A WebChat implementation may expose one multi-route adapter instance or provider-specific adapter instances. Both are valid, provided that provider selection remains owned by the service's routing authority and all routes converge on the same WebChat semantics.

Provider replay state is optional transport metadata, not the durable WebChat conversation store. If finish.replayState is used, it must always be tagged or validated with provider identity and may only be consumed when the WebChat ownership rules prove that the state belongs to the requested provider conversation. Cross-provider replay state must fail closed.

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

### 9.4 Retry authority

There are two different retry layers and they must never become competing execution authorities.

**WebChat exchange retry** is internal to one logical turn. It may recover a provider transport failure only while the provider can prove that the text was not submitted.

**DSH LLM retry** is route-level orchestration around the adapter. It may re-invoke the provider according to the DSH retry policy only when the WebChat adapter has declared the failure retry-safe.

The adapter must therefore expose enough semantic failure information to prevent DSH from retrying a turn after ambiguous or confirmed submission.

At minimum:

~~~text
pre-submit transport failure
    -> may be retryable

submission confirmed
    -> not automatically retryable

submission ambiguous
    -> never automatically retryable

completed stream with consumer-side failure
    -> not an instruction to resend
~~~

A lower-level transport retry must settle before the DSH retry layer sees the operation as failed.

This prevents a provider from accidentally implementing two independent retry loops around the same user message.

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

## 12. Provider website interaction architecture

All supported providers are consumed through their customer-facing website UI in authenticated Chrome/Chromium controlled by Playwright. This is a project constraint, not a transport option chosen independently by each provider.

The browser naturally performs network traffic to load and operate the website, but the plugin must interact through the rendered UI. It must not call or replay public, private, or undocumented provider model APIs, website-internal HTTP endpoints, WebSockets, or direct network protocols. It must not parse internal network responses as an alternate source of model output, model catalogue data, or continuation authority. There is no API/network fallback when UI automation becomes difficult.

### 12.1 Playwright UI transport

The provider driver maps the shared semantic exchange to the provider's visible product UI:

~~~text
authenticated Chrome/Chromium context
          |
          v
provider website UI
          |
          +--> inspect visible model choices
          |
          +--> enter text through the composer
          |
          +--> activate the visible Send action
          |
          +--> observe rendered response text and completion state
~~~

A driver should use stable accessible roles/names and visible UI state where available, with provider-local selectors as necessary. It owns provider-specific details such as navigation, the model picker, composer controls, submit activation, response streaming/completion detection, and conversation continuation.

Model discovery for the Advisor and normal provider integration must reflect the models available through the provider's website UI in the authenticated account. Do not substitute the provider's separate API model catalogue or assume that API model IDs, pricing, limits, or capabilities match the website product.

When the website requires interactive login, access verification, or a challenge, follow the provider's supported user-facing browser flow. Do not bypass access controls or replace the UI path with undocumented endpoints.

### 12.2 Provider-local browser ownership

Each driver owns its page interaction and knows the UI for its own website. Shared browser infrastructure may help manage Chrome startup, configured profiles, contexts, CDP, and lifecycle, but it must not become a giant universal provider driver.

Drivers may differ in UI structure and conversation continuation while using the same semantic core contract. Provider-private selectors, visible model labels, DOM observations, and opaque continuation details remain provider-local.

### 12.3 What the core must never assume

The core must never require:

- a Playwright Page;
- CSS selectors or accessible names;
- an editable composer;
- browser DOM traversal;
- a specific website layout;
- a provider's private JSON schema or network protocol.

The core sees only semantic exchange operations. The Playwright requirement applies to provider drivers and their transport boundary, not to the provider-neutral core.
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
- revalidation before browser-driven website interaction is allowed.

These mechanisms remain provider-local.

The common core must not assume that a headless or automated browser can always establish a valid consumer-web session. A provider driver may require an existing authenticated Chrome profile or an interactive user-facing bootstrap step. The semantic result exposed to the core remains only the provider authentication/session state. All subsequent model interaction remains through Chrome/Playwright UI.

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

## 16. Service integration

The service exposes the shared core over HTTP. The public contract is the OpenAI/Responses-compatible wire surface rather than an in-process host adapter:

~~~text
POST /v1/responses
POST /v1/chat/completions
GET  /v1/models
~~~

The Web Chat integration should follow those wire contracts rather than create another public LLM protocol.

The HTTP boundary is responsible for:

- resolving the caller's catalogue model identifier to a provider route;
- translating wire request fields into the shared Web Chat request;
- translating normalized text stream events into SSE frames;
- resolving model metadata;
- forwarding cancellation;
- exposing unsupported-option errors.

It must not know:

- provider DOM;
- provider network payloads;
- session cookies;
- conversation cursors;
- browser worker internals.

Opaque provider continuation metadata may be retained as replay state when the adapter owns that continuation. The Web Chat architecture may use this mechanism where useful, but long-lived conversation affinity remains a Web Chat responsibility rather than a caller-visible provider ID.

The adapter must also reject unsupported **content** rather than silently discard it. In particular, a
text-only WebChat route must not quietly strip file/image content or other content the caller meant the
model to see simply to make a call succeed. This preserves the service's stable provider error
semantics. Capability declarations — tool definitions, a tool choice, MCP state — are the deliberate
exception and are discarded instead: the provider cannot execute them and has no return channel to the
caller's harness (§8.3, §32.2).

The service's local, config-driven route registry performs route selection for a distribution with no separate host. It is not a second public provider registry: it still runs the shared driver resolver, which only maps an already-selected catalogue route to the implementation that owns it (see §17 and §32).

---

## 17. Provider driver resolution

The service must move from a ChatGPT-only adapter boundary to a WebChat adapter capable of resolving multiple provider drivers.

Conceptually:

~~~text
catalogue model route
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

The service's configured catalogue remains the authority that selects the provider route. The internal driver resolver only maps that already-selected route to an implementation.

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

Configuration namespacing is not provider routing. The selected catalogue route remains authoritative.

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
          playwright-ui.ts
          ...
      deepseek/
        driver.ts
        auth.ts
        models.ts
        conversation.ts
        transport/
          playwright-ui.ts
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

### 19.2 Extracted into the common core

These responsibilities became provider-neutral and now live under `src/web-chat/`:

~~~text
src/adapters/base.ts
    -> remains the lowest adapter seam

src/web-chat/core/**                              (issue #189)
    -> provider-neutral contracts: text exchange, conversation identity and
       handle, model descriptor, normalized events, error taxonomy, driver
       resolver and account binding

src/web-chat/core/conversation-store.ts
src/web-chat/persistence/conversation-store-file.ts (issue #190)
    -> generic conversation-key / continuation core and the durable continuity
       record, with ChatGPT-specific rules removed

src/web-chat/core/exchange-state.ts
src/web-chat/core/retry-authority.ts
src/web-chat/transport/**                          (issue #191)
    -> generic exchange state machine, submission boundary and retry
       authority, transport lease and the shared exchange runner

src/adapters/chatgpt-web/chatgpt-driver.ts
src/adapters/chatgpt-web/chatgpt-continuity.ts
src/adapters/chatgpt-web/text-turn.ts
src/adapters/chatgpt-web/webchat-transport.ts      (issues #192, #236)
    -> the ChatGPT driver/transport implementing those contracts
~~~

`src/adapters/chatgpt-web/retained-surface.ts` still holds ChatGPT's physical
retention; the generic lease and settlement semantics live in
`src/web-chat/transport/transport-lease.ts`.

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

Delivered (issues #191–#192, #236). The previous ChatGPT-shaped WebSurfaceTransport was split into two layers:

~~~text
WebChat core
    |
    v
TextExchangeTransport          (src/web-chat/transport/text-transport.ts)
    |
    +--> provider-specific Playwright UI driver
            |
            +--> ChatGPT website UI
            +--> Qwen website UI
            +--> DeepSeek website UI
~~~

The shared interface is semantic and provider-neutral. Every consumer-web driver uses Chrome/Playwright to operate its own website UI; that requirement does not make the core depend on DOM structure or Playwright types. The current ChatGPT surface transport (`src/adapters/chatgpt-web/webchat-transport.ts`) is one implementation of the provider UI seam, not the universal provider implementation.

---

## 20. ChatGPT-specific compatibility and provider-neutral features above the core

The current repository includes ChatGPT-specific functionality beyond the text-only WebChat exchange.

ChatGPT-specific compatibility features include:

- MCP/capability bridging;
- native Codex-related routes;
- Responses compatibility;
- compaction/control protocols;
- image/tool payloads.

These may remain operational for ChatGPT and must remain outside WebChat Core.

The Advisor is different: it is a **provider-neutral feature above the WebChat host boundary**, not part of the common core and not a ChatGPT driver responsibility.

~~~text
DSH Advisor UI / task lifecycle
              |
              v
Provider-neutral Advisor orchestration
              |
              v
Existing DSH route authority + WebChat host/core
              |
       +------+------+
       |      |      |
    ChatGPT  Qwen  DeepSeek
    driver  driver  driver
       |
       v
Authenticated consumer website via Chrome/Playwright
~~~

The Advisor selects an already-registered public model route, submits a semantic text review through the selected driver, and keeps its review conversation separate from the primary DSH conversation and from normal WebChat conversations. It must not import ChatGPT-specific adapters, browser workers, model assumptions, or transport code.

A future provider becomes eligible for Advisor use when its WebChat driver is integrated, exposes a usable route through the existing DSH route authority, and can discover/operate its website models through the UI-only contract. It does not implement its own copy of Advisor.

**Result handoff (issue #225).** A finished review is presented in the Advisor result editor: the provider's original response stays immutable, the user edits a separate handoff draft, and **Inject into DSH** delivers exactly one ordinary user-authored message to the session the review belongs to through DSH's public session-addressed input API (`session/prompt`). The Advisor never appends to the Session log, never fabricates events, never writes into an unrelated composer draft, and never delivers anything without an explicit user action; the delivery identity makes a retry idempotent, and an unconfirmed acceptance is reported instead of being resubmitted.

**Advisor state is scoped to its session.** A finished review belongs to the DSH session that produced
it: the activity list is requested from the sidecar with that session and persisted per session, the
turn result card selects a result only for the session it is rendered in, and recording a result keeps
"the latest per turn" per session. A session in which the Advisor was never invoked therefore shows no
Advisor content at all, which is what keeps the ordinary chat and the Advisor independent.

**Implementation status (issues #224, #236).** The provider-neutral Advisor host, the eligible-model catalogue, the tracked task lifecycle and the client surface are implemented (`src/advisor/**` and the sidecar control API). A review turn now executes through the **shared exchange**: the provider composition opens a `WebChatTextTransport` plus the exchange identity and semantic turn (`src/web-chat/host/text-turn.ts`), and the host drives it with `createWebChatExchange` (`src/web-chat/host/text-exchange.ts`, `src/web-chat/transport`). ChatGPT implements that transport over its existing turn execution, exposing readiness, its proven submission phase and its physical settlement (`src/adapters/chatgpt-web/{text-turn,webchat-transport}.ts`); the earlier provider-local execution seam is retired, so no provider runs a parallel turn path for Advisor use.

The shared WebChat contract remains text-only. This separation prevents both ChatGPT-specific compatibility features and the Advisor orchestration from becoming a generic agent runtime inside WebChat Core.

### 20.1 Normal Chat Mode is incremental; Advisor Mode owns its context

Normal Chat Mode is the ordinary automatic conversation (the chat-only route). It is a minimal
conversational transport to the provider:

- the first physical message of a conversation carries only a deterministic project header and the
  current user message;
- every later message carries only the current user message;
- the provider conversation itself is the conversation history, so DSH does not serialize its
  session history, previous assistant responses, runtime/environment context, Git state, tool
  descriptions or memory content into the request;
- the project header is generated programmatically from authoritative package metadata
  (`package.json`), never inferred from the user's message, the working directory or a model answer;
  when that metadata cannot be resolved, the repository line is omitted rather than fabricated;
- a message is eligible to become the user turn only when the DSH host marked it as the human turn
  (`source.kind === "user"`). Every injected block — the skills catalogue, runtime context, the Aegis
  bootstrap, Hindsight recall, the time snapshot — is dropped at the projection boundary by that
  allowlist, so a new harness injection cannot reach the provider by default and, in particular,
  cannot be mistaken for the user's message.

Advisor Mode is a separate feature with its own context. It owns its reviewer system prompt, the
project/preset label, the review instructions, the last human request and the last final DSH
response, and it runs in its own retained conversation. A Chat Mode change must not disable it, and
an Advisor request must never be routed through the minimal Chat Mode envelope.

The DSH tool-execution route and the manual/compaction transports keep their own documented context
contracts; they are not Chat Mode. Because the provider conversation is the history, an explicit
replay/rebuild (a replacement physical generation) deliberately re-projects canonical DSH history;
that recovery path is not normal Chat Mode.

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

- authenticated Chrome profile/context state;
- conversation creation and continuation through the visible Qwen Chat UI;
- provider-specific model choices discovered from the website's model picker;
- rendered response streaming/completion and UI-specific failure detection;
- provider access-verification and session requirements.

The driver must not call Qwen's public API or replay website-internal endpoints. Any server-side conversation identifiers are an implementation detail; the supported interaction path for this project remains the website UI controlled by Playwright.

### 21.3 DeepSeek driver

The driver should be designed to accommodate:

- authenticated Chrome profile/context state;
- conversation creation and continuation through the visible DeepSeek Chat UI;
- product model choices discovered through its website model picker;
- rendered response streaming/completion and UI-specific failure detection;
- web-session protections and interactive verification that may change over time.

DeepSeek Chat is a separate product from its API. The driver must not call either the public DeepSeek API or undocumented website endpoints. API model IDs, request formats, pricing, and limits must not be treated as the website product catalogue or contract.

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

### 24.3 Playwright UI transport tests

Each provider's Playwright UI driver should have separate tests for:

- authenticated browser/profile readiness;
- visible model discovery and selection;
- composer submission activation;
- submission confirmation;
- text extraction from the rendered page;
- completion detection;
- abort;
- resource close;
- physical-settlement guarantees.

No transport test may rely on direct provider API calls or parse internal network responses to obtain model output.

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

Even inside an individual provider driver, this project must not call or replay public/private provider APIs or website-internal endpoints. Operate the consumer-facing website with Chrome/Playwright instead.

### 26.4 Put DOM selectors and Playwright objects in the common core

Rejected.

Reason:

- each provider has different UI structure and interaction mechanics;
- DOM and Playwright types would contaminate provider-neutral contracts;
- conversation continuity is a logical provider concern, not a page identity.

The project nevertheless requires each provider-specific driver to consume the consumer website through Chrome/Playwright UI. The distinction is that this is a **driver/transport constraint**, not a common-core protocol.

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

The migration is delivered as small reviewable slices. The issue/PR numbering below refers to implementation order; status is current as of 2026-10-16.

| Slice | Issue | Status |
| --- | --- | --- |
| 1 · WebChat contracts | #189 | Delivered |
| 2 · Conversation affinity and durable continuation | #190 | Delivered |
| 3 · Exchange state machine and transport ownership | #191 | Delivered |
| 4 · ChatGPT migration to WebChat | #192 | Delivered |
| 5 · DSH route integration and driver resolution | #193 | Delivered |
| 6 · Provider conformance and architecture suite | #194 | Delivered |
| 7 · Qwen Chat text provider | #195 | Open — next |
| 8 · Qwen real-session validation and recovery hardening | #196 | Open |
| 9 · DeepSeek Chat text provider | #197 | Open |
| 10 · DeepSeek real-session validation and recovery hardening | #198 | Open |
| 11 · Cross-provider integration validation | #199 | Open |

The **containerised service** is the shipping distribution (§32), delivered as issues #245–#250. It does not consume a migration release number.

The per-slice descriptions below record the original delivery intent of each slice; the status table
above is authoritative for what is done.

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

The extraction described in §19 is implemented. This section maps the target ownership onto the
repository as it stands.

### Provider-neutral layer (implemented)

- `src/web-chat/core/**` — the provider-neutral contracts and semantics: text exchange, conversation
  identity and handle, model descriptor, normalized events and error taxonomy, driver resolver,
  account binding, conversation store, continuation decisions, exchange state and retry authority
  (issues #189–#191).
- `src/web-chat/transport/**` — the provider-neutral transport seam (`text-transport.ts`), the
  transport lease and the shared exchange runner.
- `src/web-chat/persistence/conversation-store-file.ts` — the durable JSON backend for continuity
  state.
- `src/web-chat/host/**` — the service host boundary: driver resolution for already-selected routes,
  provider-scoped configuration, the API message projection, health and the shared text turn
  (`provider-host.ts`, `api-projection.ts`, `text-turn.ts`, `text-exchange.ts`) (issue #193).
- `tests/issue-189..194-*.test.ts` and `tests/web-chat-provider-conformance.ts` — the executable
  boundaries and the reusable provider conformance suite (issue #194).

### ChatGPT-specific layer (provider-local)

- `src/browser-login.ts`, `src/chatgpt-session.ts`, `src/chatgpt-web-authority.ts`,
  `src/chatgpt-web-models.ts`, `src/chatgpt-web-provider-config.ts`, `src/model-catalog.ts`
  (ChatGPT Web authority is still embedded here);
- `src/adapters/chatgpt-web/**` — driver, continuity, `conversation-key.ts`, browser worker, prompt
  compiler, turn execution, retained surface, compaction/checkpoint, MCP/capability, tool and
  native-Codex modules;
- `src/bridge.ts`, `src/native-passthrough.ts`, `src/codex-*.ts`, `src/responses/**` — ChatGPT/Codex
  wire compatibility, which remains outside WebChat Core (§20).

These remain provider-local until a second provider supplies concrete evidence for a smaller
reusable seam (§19.3, §26.2).

### Entry point

- `lib/cli.js` (`src/cli.ts`) — the CLI and the HTTP service it hosts (`serve`, plus `doctor`,
  `login` and `auth import`), deliberately independent of any DeepSeek Harness package; CI asserts
  that in `scripts/smoke-tarball.mjs`. It is the entry point the container image runs (§32).

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
The provider's visible website UI is the source of truth for model availability, authentication, and supported user-facing behavior. Do not use third-party reverse-engineered clients as implementation templates, and do not copy or replay their private endpoints, request schemas, anti-bot techniques, or browser fingerprinting strategies. Provider access verification must be handled through the supported browser flow.

### DeepSeek

- Official DeepSeek V4 announcement and web service:
  https://deepseek.com/en/news/v4-preview/
The DeepSeek consumer website, not its API documentation or third-party protocol implementations, is the source of truth for the supported model picker, authentication, and visible conversation behavior. Do not implement against reverse-engineered endpoint details, PoW recipes, private request headers, or response schemas.

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
  = provider-specific Chrome/Playwright website UI
  = visible model selection, composer, send action, rendered response and completion detection

Browser Runtime
  = shared infrastructure for configured Chrome profiles, contexts, pages, CDP and lifecycle
~~~

The three fundamental invariants are:

> **The DSH LLM runtime selects the provider; WebChat only resolves and executes the already-selected provider route.**

> **The DSH session is canonical; the provider conversation is a continuity handle.**

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
       Playwright UI  Playwright UI     Playwright UI
          |               |                |
          v               v                v
       Web Chat         Web Chat         Web Chat
~~~

That is the architecture to implement. Everything else in the repository should be evaluated against these ownership boundaries.

---

## 32. Service distribution: the containerised HTTP surface

The ownership model above is unchanged. This section applies it to the repository's shipping
distribution.

The product ships as one distribution over one core (§28 "Entry point"):

- the **containerised service** — the image and Compose stacks that run `lib/cli.js serve`, where no
  separate host process exists and the service itself decides which provider and model a request
  addresses.

It is text-only and runs the same drivers, core semantics and conformance suite. The service adds a
wire-compatibility and operations layer; it does not create a second execution engine, a second retry
authority or a second provider registry.

### 32.1 Routing authority

The invariant "the caller selects the provider; WebChat only resolves the already-selected route"
(§4.1, §16, §17) holds here directly: the caller selects the provider through the catalogue model
identifier and the service resolves it through the **same** resolver. The service's route registry is
local configuration; it must never become a public provider registry.

### 32.2 API surface

- `POST /v1/responses` — the Responses-compatible text endpoint with SSE.
- `GET /v1/models` — the provider-qualified catalogue, carrying both the existing `models` array and
  an additive OpenAI-compatible `data` array.
- `POST /v1/chat/completions` — OpenAI-compatible text chat for arbitrary harnesses (issue #248).
- `/v1/control/*` and `/admin/*` — operator routes with constant-time token authorization.
- The public API surface requires its own authorization and fails closed on a non-loopback bind
  without a configured key (issue #247).

Text-only is the contract: attached content and non-text content parts are refused explicitly rather
than silently dropped, while **capability declarations** (`tools`, `tool_choice`, `mcp` and the legacy
aliases) are discarded by design — the provider has no execution path and no return channel to the
caller's harness — and declared on the response (`x-dsh-chatgpt-web-ignored-features`) and in the log,
never forwarded (§1.2, §8.3, §16).

**Message-only is part of that contract.** The API transmits the conversation's messages and nothing
else: session context a harness injects at the start of a session (its own instructions, environment
blocks, file trees, timestamps) must not become part of the provider turn. A generic client carries no
provenance metadata, so this cannot be a per-harness rule: it has to be structural, in the shape the service
already uses (§20.1 — only the current user message crosses, and the provider conversation
is the history). The rule is implemented in `src/web-chat/host/api-projection.ts`, structural and never
per-harness: a client-provided session identity (OpenAI's `user`, or the `session_id` extension) makes
the API transmit **only the current user message** with the provider conversation as the history;
without one the request is stateless and every non-conversational role (`system`, `developer`, `tool`,
unknown) is dropped. That is universal in the only sense the protocol allows — a generic client carries
no provenance — and its limit is explicit rather than papered over: harness text placed *inside* the
current user message cannot be distinguished structurally and does cross. Content heuristics are
deliberately **not** the mechanism, because they are per-harness and per-version (issue #253).

**The same projection decides the provider conversation identity.** An API caller is not a DSH thread and
carries no native turn metadata, so the surface must choose the conversation key itself instead of
collapsing every caller onto a constant. A client-provided session identity (`user`/`session_id`) **is**
that key, verbatim: stable across the caller's turns and distinct from every other caller. With none,
the key is derived from the **content** of the transmitted messages (`dsh-chat-<hash>`) and never from
the request — the same content keeps the same conversation (a resending client keeps continuity; a retry
does not fork a second conversation) and different content is isolated. The rule is deliberately
content-derived and **never per-request**: minting an identity per call would fork every turn of a client
that resends its history. The identity travels to the turn on the channel the turn identity extractor
already reads (`client_metadata["x-codex-turn-metadata"].thread_id`), so the surface adds no second
identity channel and the identity is never provider-visible message text. Its documented limit is
explicit: two callers with **no identity** and **identical message content** are indistinguishable and
share one provider conversation, because nothing in the request can tell them apart; a caller that must
be distinct has to send `user`/`session_id`, and a stateless caller that wants continuity has to resend
its history. The core still only stores and passes the resulting key: the provider conversation itself
stays opaque provider state (§7.3, §26.5).

**Both ingresses obey that rule, and they share one derivation owner.** `/v1/chat/completions` carries
the key it decided in `client_metadata`. A `/v1/responses` caller is not translated by a surface that
could decide it, so the adapter's turn-identity extractor resolves the key for the turn it is about to
run — and its metadata-less fallback calls the **same** content-identity function
(`contentConversationIdentity`, the owner of both the canonical encoding and the conversational-role
filter) rather than deriving a second one. That fallback was the constant `dsh-session`, so every
metadata-less Responses caller shared one provider conversation: the same defect slice 1 fixed on the
chat surface, reached through the other door. A caller that *does* provide a thread — the native
Codex/DSH path, or a client that sends `client_metadata` — keeps it verbatim; only the fallback changed.
The documented limit is the same and applies identically: two callers with no identity and identical
content are indistinguishable and share one conversation.

### 32.3 Runtime and credentials

- The service runs headless Chromium, supplied by a pinned Playwright base image whose browser build
  matches the installed `playwright-core` version.
- A provider session is a browser session, not an API key. The runtime requires both the Playwright
  `storageState` and its verification marker; credentials live only in the mounted data volume
  (`DSH_CHATGPT_WEB_HOME`), never in the image, the conversation store or logs (§13, §25).
- Credentials are provider-scoped (`providers/<providerId>/…`), with one account per provider and the
  legacy single-provider layout kept as a compatibility alias (§29).
- One active exchange per provider conversation (§15.1); an account whose provider cannot isolate
  sessions is serialised (§15.2).

### 32.4 Non-goals

- A public multi-tenant service. The consumer-web session is the binding constraint, so this is a
  personal/local bridge: one account, one instance.
- Re-exposing consumer-web output as a general-purpose model API with accounting guarantees: `usage`
  is an estimate, not consumer-web accounting.
- Weakening the UI-only rule (§3, §26.3): providers are still operated through their websites.

**Status.** Issues #245–#250 delivered this distribution in order: spike (base image, headless
Chromium, health probe), production image and Compose stack, API authorization and safe exposure,
OpenAI-compatible `/v1/chat/completions`, guided provider login and credential layout, and
multi-provider routing. All are merged and closed; the container is the product. The frozen
base-image facts and the findings recorded during delivery — including that the default sidecar is
loopback-only unless the authenticated exposed stack is used — are in [container.md](./container.md).
