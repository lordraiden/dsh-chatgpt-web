# dsh-chatgpt-web Architecture

**Status:** Definitive architecture and implementation boundary  
**Implementation status:** Target architecture; implementation follows the phased backlog below  
**Document role:** Single architectural source of truth for issues #8–#14  
**Repository:** lordraiden/dsh-chatgpt-web  
**Last updated:** 2026-10-03

> API-like outside, product-native inside.

This project makes an authenticated ChatGPT Web session available to DeepSeek Harness (DSH) as a native LLM provider. The public boundary is a normal DSH provider contract. The Phase 1 implementation is ChatGPT-Web-specific, while the browser execution seams are intentionally service-neutral enough to support future browser-backed providers without creating a generic provider framework. Browser interaction, product-side tool looping, account state, and UI recovery remain provider/service internals.

The architecture is intentionally conservative. Phase 1 contains only the boundaries and invariants required for a solid first pilot. Phase 2 contains compatibility convergence, cleanup, and optional hardening that does not need to block the first native provider.

### 1.3 Supported account matrix: normal ChatGPT Web Free + paid

The supported product target for this plugin is normal authenticated **ChatGPT Web usage through the chatgpt.com product surface**, on both **Free and paid ChatGPT accounts**. The target is the Web/product usage path and its available models, not Codex consumption.

Routes whose usage is accounted against the **Codex allocation, ChatGPT Work allocation, or a shared Codex/Work credit pool are explicitly out of scope**. Native Codex passthrough remains a separate protocol boundary and must never be pulled into the ChatGPT Web ProviderCore.

Eligibility is established from observable ChatGPT Web product/account capability rather than plan name, display label, or backend model ID. When the product route cannot be established, capability state is `unknown` and automatic selection fails closed.

This distinction is architectural, not cosmetic:

- OpenAI API model cards, API context windows, API token limits, and API pricing are **not authoritative** for this provider's browser transport budget.
- Official ChatGPT product documentation is authoritative for current Web product availability and plan-level limits, but those limits can change independently of the API.
- ChatGPT Web transport limits used by this adapter are provider measurements/guardrails for the Free Web surface. They must be documented as such and must not be presented as official API or model limits.
- Any paid-account compatibility code retained elsewhere in the repository is outside the supported #11-A/#11-B contract and must not influence the Free-account context policy.

The current OpenAI Free-plan documentation confirms that Free users have access to ChatGPT features through the product UI and that usage limits are plan/model dependent and mutable. The image-input documentation likewise states that the number of images that can be added depends on image size and accompanying text; therefore this provider may impose a conservative transport cap without treating that number as an OpenAI product maximum.


---

## 1. Goals and non-goals

### 1.1 Goals

The pilot must provide:

- a first-class DSH provider registered through ctx.llm;
- ChatGPT Web as the actual model execution surface;
- deterministic turn ownership and account/browser concurrency;
- DSH as the authority for all DSH-projected tools and skills;
- one provider execution core for all ChatGPT Web entrypoints;
- one canonical DSH-to-ChatGPT context projection;
- isolated browser/DOM mechanics;
- deterministic cancellation, settlement, retry, and recovery;
- clear provenance between DSH-authorized capability activity and ChatGPT-native product activity;
- a small architecture that an implementation agent can follow without inventing parallel abstractions.

### 1.2 Non-goals

This architecture does not attempt to:

- reproduce an OpenAI API internally;
- make ChatGPT Web behave like an ordinary stateless HTTP provider in every respect;
- reimplement the DSH agent loop;
- reimplement DSH tools or skills;
- turn ChatGPT-native product features into DSH tools;
- guarantee arbitrary browser concurrency;
- promise theoretical model context as usable web transport capacity;
- force the first-party Codex passthrough through the browser provider;
- build a generic provider framework above DSH ctx.llm;
- implement additional browser-backed providers as part of the Phase 1 pilot.

---

## 2. Phased delivery

The repository keeps seven implementation issues. The issues are implementation slices, not competing design documents.

| Issue | Phase | Purpose |
|---|---|---|
| #8 | Phase 1 | Native DSH LLM provider boundary |
| #9 | Phase 1 | ProviderCore, execution authority, account/browser lease, turn state, continuity and control-protocol boundary |
| #10 | Phase 1 | DSH capability projection, capability transport, broker binding and immutable turn snapshot |
| #11 | Phase 1 | Canonical context/replay/compaction projection and transport budgeting |
| #12 | Phase 1 | WebSurfaceTransport and browser resilience boundary |
| #13 | Phase 2 | Responses compatibility convergence and compatibility demotion |
| #14 | Phase 2 | Provenance, architecture verification and removal of proven redundancy |

### 2.1 Phase 1 definition

Phase 1 is complete when the native DSH path can execute a real ChatGPT Web turn through the architecture below without relying on the localhost Responses endpoint as its semantic provider boundary.

Phase 1 must include the minimum hardening that protects correctness:

- native provider registration;
- narrow ProviderCore;
- explicit authenticated account/browser resource ownership;
- monotonic turn state;
- logical versus physical settlement;
- safe retry boundary;
- exact resume versus replay versus failed recovery;
- untrusted model-visible control protocol parsing;
- DSH capability authority and turn snapshotting;
- canonical context projection;
- effective transport budget;
- isolated WebSurfaceTransport;
- explicit reentrancy rules.

Phase 1 does not require a multi-account pool, advanced capability caching, arbitrary parallel browser lanes, a generic browser abstraction framework, or a broad observability platform.

### 2.2 Phase 2 definition

Phase 2 improves integration completeness without changing the Phase 1 authority model:

- Responses compatibility becomes a thin ingress adapter over ProviderCore;
- provenance and architecture tests become explicit cross-layer contracts;
- redundant compatibility/legacy state is removed only after parity is demonstrated;
- optional capability cache/epoch optimizations may be added;
- optional support for multiple authenticated browser sessions may be added;
- future transport substitution may be pursued without changing the DSH-facing provider contract.

Phase 2 features must not introduce a second authority or a second ChatGPT Web execution core.

---

## 3. Architectural principles

### 3.1 API-like outside, product-native inside

DSH sees:

~~~text
DSH -> ctx.llm -> ChatGPT Web provider -> stream
~~~

The implementation is allowed to be:

~~~text
ProviderCore -> account/browser lease -> WebSurfaceTransport -> ChatGPT Web
                            |
                            +-> capability transport -> DSH runtime
~~~

The project must not emulate an OpenAI-compatible API internally just to make browser transport look familiar.

### 3.2 One authority per concern

- DSH owns DSH runtime authority.
- ChatGPT owns model reasoning and ChatGPT-native product behavior.
- ProviderCore owns ChatGPT Web provider orchestration.
- CapabilityProjector decides what DSH exposes to ChatGPT.
- CapabilityTransport decides how that projection crosses the boundary.
- TurnBroker coordinates asynchronous turn-bound capability traffic.
- WebSurfaceTransport owns browser and DOM mechanics.

No lower layer may become an alternative source of truth for a higher layer.

### 3.3 Hide mechanism, preserve semantics

The adapter must hide browser mechanics from DSH while preserving DSH-visible provider semantics such as model resolution, streaming, cancellation, provider errors, and replay state.

Not every web property is equivalent to an API property. The provider must publish the strongest contract the browser can actually satisfy.

A browser-backed provider has two kinds of state:

- shared execution machinery that is independent of the upstream web service;
- service-specific semantics such as authentication/session state, model catalogue, model selection, reasoning controls, context rules, submission/completion mechanics, native capabilities, and WebSurfaceTransport behavior.

The first category may be reused by later providers. The second category must remain behind the provider-specific service profile. Phase 1 implements only ChatGPT Web.

---

## 4. Identity model

The architecture distinguishes four identities.

~~~text
DSH Session
  = canonical DSH conversation and lifecycle

ChatGPT Conversation / Thread
  = provider-private product continuity

Browser Page / Context
  = physical transport resource

Authenticated ChatGPT Account
  = authenticated product resource shared by one or more browser contexts
~~~

These identities must never be conflated.

### 4.1 Required relationships

The default pilot policy is:

~~~text
one DSH session
  -> one stable ChatGPT conversation affinity

one active DSH turn
  -> one turn-bound browser interaction lane

many DSH turns
  -> may share one authenticated account only through explicit account/browser arbitration
~~~

The system must never silently switch a DSH session to another ChatGPT conversation.

### 4.2 BrowserAccountLease

Phase 1 introduces a small internal concept equivalent to BrowserAccountLease.

It is not a new public abstraction. It is a lifecycle/coordination primitive whose identity is service-scoped:

~~~text
serviceId
account/session identity
browser profile identity
browser context/page
DSH turn identity
ownership state
~~~

For ChatGPT Web, the serviceId is chatgpt-web. A future DeepSeek Web or Grok Web implementation would use its own service/session identity and must not share authenticated product state merely because it shares Chromium.

The lease answers:

- which authenticated service account/session is being used;
- which browser profile/context/page owns the active turn;
- whether that resource is available;
- which DSH turn currently holds it;
- when it may be reused;
- how it is released after physical settlement;
- how shutdown/crash revokes it.

The lease owns resource ownership, not authorization policy. It must not contain the canonical DSH tool registry, sandbox policy, approval state, or skill policy.

---

## 5. Trust and authority

### 5.1 DSH authority

DSH remains authoritative for:

- provider selection;
- DSH session and agent identity;
- workspace roots;
- sandbox;
- approvals and guards;
- DSH tools;
- DSH skills and their policy;
- capability authorization;
- cancellation authority;
- DSH lifecycle.

### 5.2 ChatGPT authority

ChatGPT Web remains authoritative for:

- model reasoning;
- model-generated content;
- ChatGPT-native product behavior;
- ChatGPT-native product capabilities supplied by the authenticated account.

ChatGPT-native capabilities are not DSH tools and are not made safe by the DSH sandbox.

### 5.3 ProviderCore authority

ProviderCore is an orchestrator, not an alternative runtime authority.

It may own:

- provider-specific turn identity;
- provider-private continuity;
- trusted bindings between DSH state and a ChatGPT turn;
- provider-specific retry classification;
- browser/account coordination;
- provider diagnostics and provenance.

It may not redefine:

- DSH session history;
- DSH tool authorization;
- sandbox policy;
- approval state;
- skill policy;
- agent identity.

---

## 6. Target architecture

~~~text
                                  DeepSeek Harness
+----------------------------------------------------------------------------+
|                                                                            |
|  Agent / Session Runtime                                                   |
|       |                                                                    |
|       +----------------------+                                             |
|       |                      |                                             |
|       v                      v                                             |
|    ctx.llm              ctx.tools / ctx.skills                             |
|       |                      |                                             |
|       v                      v                                             |
| ChatGptWebLlmAdapter   CapabilityProjector                                |
|       |                      |                                             |
|       +----------+-----------+                                             |
|                  v                                                         |
|        ChatGPTWebProviderCore                                              |
|        |     |       |       |                                             |
|        |     |       |       +--> Diagnostics / Provenance                  |
|        |     |       +----------> ContextProjector                         |
|        |     +------------------> TurnCoordinator                           |
|        +------------------------> AccountBrowserLease                      |
|                                  |                                        |
+----------------------------------|-----------------------------------------+
                                   |
                        +----------+-----------+
                        |                      |
                        v                      v
                CapabilityTransport     WebSurfaceTransport
                        |                      |
                   MCP today              Playwright today
                        |                      |
                     TurnBroker           browser context/page
                        |                      |
                        v                      v
                 DSH capability         chatgpt.com
                    runtime
~~~

Compatibility entrypoints:

~~~text
Responses compatibility -> thin ingress adapter -> ProviderCore

Native Codex passthrough -> first-party Codex backend
                             (separate protocol boundary)
~~~

The browser ProviderCore is the single execution core for ChatGPT Web, not a universal execution core for every upstream protocol in the repository.

### 6.1 Future browser-backed providers

The reusable architectural role is a browser-backed provider execution core, but Phase 1 does not require a generic framework or a second implementation.

Future provider routes may look like:

~~~text
chatgpt-web -> ChatGPT service profile -> ChatGPT WebSurfaceTransport
deepseek-web -> DeepSeek service profile -> DeepSeek WebSurfaceTransport
grok-web -> Grok service profile -> Grok WebSurfaceTransport
~~~

Shared machinery may include:

- browser/account resource leasing;
- turn lifecycle and physical settlement;
- retry/submit safety;
- capability snapshot/binding;
- broker coordination;
- transport budgeting;
- browser process lifecycle.

Service-specific machinery remains provider-local:

- authenticated account/session semantics;
- model catalogue and model selection;
- reasoning/configuration controls;
- context and transport limits;
- submission/completion mechanics;
- provider-private continuity and replay rules;
- model-visible control protocol;
- native product capabilities;
- DOM/browser surface behavior.

The first implementation remains ChatGPT Web. Later services should reuse only seams proven useful by the first implementation rather than forcing premature abstraction.

---

## 7. Native DSH provider boundary

The native provider is registered through the DSH LLM runtime.

~~~text
Cordis plugin
    |
    +-> inject llm
    |
    v
ctx.llm.registerAdapter(["chatgpt-web"], ChatGptWebLlmAdapter)
~~~

The adapter translates between the DSH GenerateOptions/StreamChunk contract and ProviderCore.

It is responsible for:

- provider registration;
- model listing/resolution;
- provider capability metadata;
- reasoning-effort mapping;
- multimodal capability declarations;
- provider-neutral error normalization;
- stream conversion;
- cancellation propagation;
- provider retry policy at the adapter boundary.

It must not know:

- DOM selectors;
- Playwright objects;
- MCP message details;
- broker internals;
- sandbox implementation;
- skill registry internals;
- Responses HTTP protocol details.

Provider registration must not require a logged-in browser merely to load the plugin. Authentication/account capability discovery may be lazy and must fail with stable provider errors when needed.

The exact DSH contract is defined by the supported DSH release, not by a plugin-local adapter abstraction.

---

## 8. ChatGPTWebProviderCore

ProviderCore is the single ChatGPT Web provider orchestration boundary.

Its purpose is intentionally narrower than "everything."

It coordinates:

- provider/model resolution;
- account capability resolution;
- creation and settlement of logical turns;
- account/browser lease acquisition and release;
- provider-private continuity;
- canonical context projection;
- capability snapshot binding;
- WebSurfaceTransport delegation;
- cancellation;
- retry classification;
- usage normalization;
- provider diagnostics/provenance.

It delegates rather than owns:

- browser selectors -> WebSurfaceTransport;
- DSH tool authorization -> DSH;
- skill policy -> DSH;
- asynchronous capability delivery -> CapabilityTransport/TurnBroker;
- DSH session history -> DSH session subsystem.

### 8.1 Internal seams

The minimum internal seams are:

~~~text
ChatGPTWebProviderCore
├── ModelResolver / service profile
├── BrowserAccountLease
├── TurnCoordinator
├── ContextProjector
├── CapabilityProjector
├── CapabilitySnapshot / Binding
├── CapabilityTransport
├── WebSurfaceTransport
├── Continuity / Replay state
├── Result / Stream normalization
└── Diagnostics / Provenance
~~~

These are responsibilities, not a requirement for one class per box.

The implementation should prefer existing modules and small interfaces over introducing a large framework.

---

## 9. Turn lifecycle

Each provider invocation has one logical turn with monotonic state.

~~~text
PREPARING
   |
   v
LEASED / BOUND
   |
   v
SURFACE_READY
   |
   v
SUBMITTED
   |
   v
RUNNING <----+
   |          |
   |          +-- CAPABILITY_WAIT
   |
   +--> COMPLETED
   +--> CANCELLED
   +--> FAILED
            |
            v
         SETTLING
            |
            v
          RETIRED
~~~

The exact internal enum names may differ, but:

- state is monotonic;
- a retired turn cannot become running;
- a stale binding cannot execute against a newer turn;
- cancellation is idempotent;
- cleanup is safe to repeat.

### 9.1 Logical versus physical settlement

Two different events must be tracked.

Logical settlement means the provider has determined the DSH-visible result.

Physical settlement means the browser/page/account resource is no longer capable of continuing the old turn.

Examples:

~~~text
logical failure
    !=
browser already idle

logical failure
    !=
safe resource reuse
~~~

A timeout, cancellation, or unknown browser outcome must not release the BrowserAccountLease until physical settlement is proven or the browser resource is forcibly retired.

This prevents a subsequent turn from inheriting a still-running browser operation.

---

## 10. Retry and submit boundary

The provider has an explicit submit boundary.

~~~text
PRE_SUBMIT
    |
    v
SUBMIT_INTENT
    |
    v
SUBMITTED_CONFIRMED
    |
    v
RUNNING
~~~

Automatic retry is permitted only while the system can prove that the previous attempt was not submitted.

After SUBMITTED_CONFIRMED, an ambiguous failure is not automatically retried if the turn may already have executed or triggered a side effect.

This is an at-most-once safety invariant for provider submission.

Retry classification must distinguish at least:

- pre-submit UI/attachment failure;
- submission accepted;
- post-submit but no first response;
- active generation;
- capability execution;
- completion observed but settlement uncertain.

Rate-limit/account-capability errors must not be retried as generic browser failures.

---

## 11. Continuity and recovery

DSH session state is canonical. ChatGPT conversation state is provider-private.

The provider defines three explicit recovery outcomes:

~~~text
EXACT_RESUME
  same intended ChatGPT conversation and trusted continuity retained

REPLAY
  new ChatGPT conversation or rebuilt browser continuity
  reconstructed from canonical DSH state

FAILED
  safe continuity cannot be established
~~~

The critical rule is:

> EXACT_RESUME must never silently degrade into REPLAY.

A caller must be able to distinguish "the original ChatGPT continuity resumed" from "a new ChatGPT conversation was reconstructed."

Replay boundaries are trusted execution-state artifacts, not caller-provided transcript interpretations. A replay boundary must be created from the canonical DSH projection plus authoritative DSH/ProviderCore settled/pending execution state, and must prove that every canonical tool call is classified exactly once. Browser transcript position cannot satisfy this proof.

A replay may restore DSH-visible messages, tools, images, reasoning material needed by the provider, and other reconstructible state. It cannot restore undocumented ChatGPT hidden product state that is not represented in DSH state.

Provider-private continuity must never redefine:

- DSH session id;
- agent identity;
- workspace;
- sandbox;
- approvals;
- tool scope.

---

## 12. Model-visible control protocol

The browser integration may need a textual control protocol because ChatGPT Web is a product surface rather than a structured provider API.

This protocol is explicitly untrusted.

~~~text
trusted DSH state
      |
      v
ControlProtocolEncoder
      |
      v
ChatGPT Web / model-visible content
      |
      v
model-generated text
      |
      v
ControlProtocolParser
      |
      v
validation
      |
      v
trusted broker/capability binding
~~~

The model-visible protocol must be treated as a wire format, not as natural-language interpretation.

Phase 1 requirements:

- explicit protocol version;
- unambiguous framing;
- maximum frame size;
- required fields;
- strict field types;
- correlation id that is opaque to the model;
- duplicate detection;
- incomplete-frame rejection;
- malformed/ambiguous frame rejection;
- no authority derived from free-form text;
- no "best effort" interpretation for executable requests.

The parser must never turn arbitrary prose into a tool invocation.

Any identifier echoed in model-visible content is advisory. Trusted state comes from the runtime and its binding tables.

Advanced protocol evolution, compatibility negotiation, and richer typed event schemas can remain Phase 2.

---

## 13. Capability architecture

The previous "capability plane" is decomposed into three responsibilities.

~~~text
DSH ctx.tools / ctx.skills
          |
          v
CapabilityProjector
  what may be exposed
          |
          v
CapabilityTransport
  how it crosses the ChatGPT boundary
          |
          v
TurnBroker / transport endpoint
  which turn owns the request
          |
          v
DSH runtime
  executes under DSH authority
~~~

MCP is one CapabilityTransport implementation today. It is not the architectural identity of the provider.

### 13.1 CapabilityProjector

The projector decides:

- which DSH tools are model-visible;
- which schemas and names are exposed;
- which skill projection is available;
- which scope applies;
- which capability snapshot belongs to the turn.

It must derive from current DSH runtime state and must not create a second authoritative registry.

### 13.2 CapabilityTransport

The transport serializes and carries a capability request.

Today this is MCP where required by the ChatGPT Web surface.

Future transports may differ without changing DSH authority or ProviderCore semantics.

### 13.3 TurnBroker

The broker owns transport-time coordination:

- correlation;
- turn binding;
- request lifetime;
- expiration/lease;
- delivery;
- cancellation;
- late-call rejection;
- settlement.

It does not decide whether a DSH operation is authorized.

### 13.4 Capability snapshot

Each logical turn receives an immutable capability snapshot.

Conceptually:

~~~text
CapabilitySnapshot
├── snapshotId
├── dshSessionId
├── agentId
├── turnId
├── visible tool/skill identities
├── relevant authorization binding
└── expiration / lifecycle binding
~~~

Execution validates the requested capability against that trusted snapshot.

The broker must not simply consult "current tools" during an old turn, because DSH capability state can change while ChatGPT is still thinking.

A monotonically increasing epoch/cache layer is optional Phase 2 optimization. The immutable turn snapshot itself is Phase 1.

---

## 14. Reentrancy

A ChatGPT-owned turn may re-enter DSH through DSH-projected capability execution.

This is allowed:

~~~text
ChatGPT turn
   |
   +--> DSH capability
           |
           +--> child work
~~~

This is not allowed:

~~~text
ChatGPT turn A
   |
   +--> synchronous re-entry into ChatGPT turn A
           |
           +--> wait on A's own capability channel
~~~

A nested agent must have independent DSH identity and independent turn/channel state.

A provider-owned turn may therefore re-enter DSH, but it may not synchronously re-enter itself or block on its own capability channel.

This rule prevents provider/broker deadlocks without requiring a general-purpose nested execution framework.

---

## 15. Context, replay and compaction

DSH-native message/context structures remain canonical until the final ChatGPT Web projection.

The target is:

~~~text
DSH structures
    |
    v
one canonical ChatGPT Web projection
    |
    v
browser composer
~~~

Avoid:

~~~text
DSH
 -> ad-hoc JSON
 -> custom prompt object
 -> protocol text
 -> prompt text
 -> browser
~~~

where each stage independently changes semantics.

### 15.1 Trusted versus model-visible state

The following remain trusted and out-of-band whenever possible:

- DSH session/agent identity;
- turn identity;
- browser/account lease;
- workspace roots;
- sandbox policy;
- approvals;
- capability snapshot;
- broker binding;
- cancellation authority.

A model-visible copy is advisory only.

### 15.2 Roles and content

Projection must preserve, where supported:

- system/developer priority;
- user content;
- assistant content;
- tool results;
- agent-message semantics;
- reasoning material required by replay;
- image inputs and tool-returned images.

The adapter should preserve structured images until the web transport boundary.

### 15.3 Compaction ownership

DSH session history remains canonical.

Provider-specific compaction, rolling checkpoints, and replay handoff are optimization/transport state.

They may reduce the amount of material physically re-submitted to ChatGPT Web, but they do not become a second DSH session log. For #11-B's deterministic transport reduction, required developer instructions, the latest user/agent/assistant continuity, and settled tool-call/result pairs are protected; older ordinary conversation may be omitted from the transport projection without mutating DSH's canonical history.

If provider-private continuity is lost, replay comes from DSH state, not from a provider-owned substitute history.

---

## 16. Context budget model

A model context window and a browser transport limit are different quantities.

~~~text
ResolvedModel
├── contextWindowTokens
└── providerTransportBudget
    ├── max serialized input
    ├── per-part limits
    ├── image budget
    ├── protocol overhead
    └── reserved output headroom
~~~

DSH receives a conservative provider-safe context capacity.

ProviderCore uses transport-specific budgets internally.

Before submit:

1. estimate the projected request;
2. compare it with the transport budget;
3. compact if necessary;
4. reduce transport-only overhead where safe;
5. use a supported multipart strategy if already available;
6. otherwise return a deterministic context error.

Never rely on browser/editor truncation as context management.
### 16.1 Free Web guardrails are empirical transport policy

The current #11-B Free Web policy uses conservative measurements from the ChatGPT Web surface, not OpenAI API limits:

- the visible browser input token ceiling is `128,000`;
- the Luna composer boundary is `120,000` characters;
- the transport image guardrail is `10` images per request;
- the compaction-control envelope is capped at `110,000` JSON bytes.

These values are adapter guardrails, not claims about the ChatGPT product's universal limits. OpenAI documents that Free-plan limits are mutable and that the number of image inputs depends on image size and accompanying text. When the Web surface changes, these measurements must be revalidated independently of API model documentation.

The underlying model-context field used in diagnostics is informational only. It must never be used to admit a Free Web request beyond the measured browser transport budget.

---

## 17. WebSurfaceTransport

All service-specific DOM/browser knowledge belongs behind one small WebSurfaceTransport boundary for each browser-backed provider.

Conceptual contract:

~~~text
ensureReady()
detectCapabilities()
selectModel()
selectReasoning()
submit()
observeTurn()
readResponse()
cancel()
recover()
close()
~~~

The exact TypeScript interface may differ.

The caller must not receive:

- Playwright Locator objects;
- CSS selectors;
- ARIA selector knowledge;
- ProseMirror details;
- DOM traversal helpers;
- response-container selectors.

### 17.1 Surface state

The transport must distinguish, at minimum:

- page loaded;
- composer attached;
- composer editable;
- model control available;
- reasoning control available;
- send enabled;
- submission accepted;
- generation running;
- response completed;
- physical browser settlement.

### 17.2 Capability detection

Account/product capability detection is dynamic.

Do not treat today's UI or account limits as a permanent provider contract.

The transport may cache a result, but stale capability data must be invalidated when the observed surface contradicts the cached result.

A full capability cache/epoch strategy is Phase 2. Runtime detection and safe invalidation are Phase 1.

### 17.3 Completion

No single UI string is a completion protocol.

ChatGPT Web product context exhaustion is a transport-owned terminal condition. The browser surface may detect it from a structural error surface and localized equivalent copy, but the provider exposes only the semantic `context_exhausted` error to DSH. Detection never authorizes replay or creates a replacement conversation. Once confirmed, the retained conversation handle is invalidated while physical browser settlement remains independent and must complete before the retained resource is released.

Context-exhaustion recovery consumes that semantic condition through the existing #11 replay boundary. The recovery creates a new ChatGPT conversation epoch only after the exhausted browser execution has physically settled, blocks the replacement before prompt submission until surface readiness is acknowledged, binds the replacement without changing DSH session/agent/turn/capability identity, and then releases generation from the same canonical DSH projection. The old epoch is permanently stale; a replacement retry never reuses its browser event stream. A failed replacement or readiness proof fails closed.

Completion must use transport state and authoritative signals such as:

- turn identity;
- response observation;
- generation state;
- known terminal state;
- browser settlement.

Visible phrases are model output, not trusted lifecycle signals.

### 17.4 Special browser profiles

Automatic/manual/other supported browser interaction modes are transport policy.

They do not create new providers or model identities.

The normalized provider input is conceptually:

~~~text
provider = chatgpt-web
model = luna
browserInteractionMode = automatic | manual
~~~

For a future browser-backed provider, the same DSH boundary remains:

~~~text
provider = <service-specific route>
model = <service-specific model id>
~~~

while service-specific browser mechanics remain inside that provider's WebSurfaceTransport. A service does not inherit ChatGPT-specific DOM assumptions merely by reusing the common lifecycle machinery.

---

## 18. Browser process boundary

The browser worker may run in a separate local process.

The process boundary is allowed for:

- Playwright isolation;
- browser crash containment;
- dependency isolation;
- lifecycle separation;
- independent browser recovery.

The key invariant is:

> local HTTP/IPC is private infrastructure, not the semantic DSH provider boundary.

Therefore:

~~~text
DSH ctx.llm
    |
    v
ProviderCore
    |
    v
private browser IPC
    |
    v
browser worker
~~~

The Responses compatibility HTTP server is a different concern and must not be confused with this internal process boundary.

---

## 19. Compatibility architecture

### 19.1 Responses compatibility

The local Responses endpoint remains supported where useful, but it is Phase 2 compatibility.

Its responsibility is only to translate:

- request shape;
- model aliases;
- tools/input representation where required;
- streaming;
- errors;
- usage/compatibility fields.

It must delegate execution to the same ProviderCore used by native DSH.

It must not own:

- browser execution;
- turn lifecycle;
- capability authority;
- independent compaction;
- provider-private continuity authority.

### 19.2 Native Codex passthrough

The repository's first-party Codex passthrough is a separate upstream protocol.

It must remain outside ChatGPTWebProviderCore.

It may share transport-independent utilities such as:

- authentication checks;
- bridge-artifact scrubbing;
- stable error normalization;
- provenance.

It must not be forced through the browser execution path.

---

## 20. Native ChatGPT capabilities

Native capabilities supplied by a browser-backed product are a separate trust domain.

For ChatGPT Web these include product-provided web search or other account-controlled features. Future providers may expose different native capabilities.

They must be represented as:

~~~text
origin = chatgpt-native
authorization = outside DSH
~~~

They must not be represented as:

~~~text
origin = DSH tool
authorization = DSH-approved
~~~

The architecture therefore does not try to make DSH sandbox or authorize ChatGPT's own first-party product actions.

This distinction is important for both diagnostics and user expectations.

---

## 21. Lifecycle

The Cordis/plugin lifecycle is split between provider registration and browser availability.

Target sequence:

~~~text
plugin load
   |
   +--> register ctx.llm provider
   |
   +--> initialize ProviderCore
   |
   +--> browser/account infrastructure attaches lazily or eagerly
   |
   v
provider callable
~~~

Provider registration must not depend on an already authenticated browser.

At call time, missing prerequisites become deterministic provider errors such as:

- AUTH_REQUIRED;
- ACCOUNT_CAPABILITY_UNAVAILABLE;
- BROWSER_UNAVAILABLE;
- SURFACE_UNAVAILABLE;
- PROVIDER_SHUTDOWN.

Shutdown:

1. stop accepting new provider calls;
2. cancel active logical turns;
3. revoke capability bindings;
4. wait for physical settlement where possible;
5. close broker/transport channels;
6. flush required provider state;
7. stop browser infrastructure.

---

## 22. Concurrency

Phase 1 defaults to conservative sequencing.

The provider must not promise arbitrary parallel calls on one ChatGPT account.

Parallel execution is allowed only when the implementation can prove isolation of:

- DSH session;
- ChatGPT conversation;
- browser page/context;
- turn;
- capability snapshot;
- broker binding.

Two unrelated turns must never race on the same composer.

If safe parallelism cannot be established, queue or reject explicitly.

A future multi-account/session pool is Phase 2.

---

## 23. Streaming and errors

The native adapter returns DSH StreamChunk values.

Conceptually:

~~~text
browser/provider events
       |
       v
ProviderCore normalized events
       |
       v
ChatGptWebLlmAdapter
       |
       v
DSH StreamChunk
~~~

Provider-internal ChatGPT tool calls are not fabricated as DSH AgentLoop tool calls when the ChatGPT-side loop owns them.

Usage is authoritative only when the provider can prove it. Otherwise it is explicitly estimated/best-effort.

Errors should be normalized to stable provider categories where possible:

- authentication/session unavailable;
- account capability unavailable;
- rate limited;
- context too large;
- browser/surface unavailable;
- provider timeout;
- user aborted;
- stale/retired turn;
- unsupported option.

Structured runtime state is preferred over parsing arbitrary error strings.

---

## 24. Provenance

Phase 1 requires enough internal identity to debug one turn across boundaries.

At minimum, trusted state should correlate:

- DSH provider call;
- logical provider turn;
- account/browser lease;
- capability snapshot;
- capability request;
- broker binding;
- browser turn.

Phase 2 may expose richer user-facing provenance and broader cross-layer diagnostics.

All correlation values used for authorization come from trusted runtime state. Model-authored text is never a trusted correlation source.

---

## 25. Testing strategy

The tests are contract tests at the architecture boundaries, not exhaustive browser simulation.

### Phase 1 minimum

Provider boundary:

- native registration;
- model resolution;
- stream conversion;
- cancellation;
- missing-auth failure.

ProviderCore:

- monotonic turn states;
- lease acquisition/release;
- logical versus physical settlement;
- post-submit retry prohibition;
- stale/retired turn rejection;
- exact resume/replay/failed distinction.

Control protocol:

- valid frame;
- malformed frame rejection;
- oversize frame rejection;
- duplicate/correlation rejection;
- free-form text cannot trigger execution.

Capabilities:

- snapshot isolation;
- authorization and sandbox remain in DSH;
- broker cannot widen authority;
- late calls rejected;
- cancellation reaches DSH execution.

Context:

- role/order preservation;
- image preservation;
- stale handle neutralization;
- deterministic oversize handling.

Surface:

- readiness states;
- capability detection;
- submission detection;
- completion detection;
- cancellation;
- recovery.

### Phase 2 minimum

- Responses compatibility parity with native DSH;
- provenance assertions;
- architecture import/layering checks;
- redundant-path audit;
- retirement verification.

---

## WebSurfaceTransport boundary

ChatGPT browser and DOM mechanics are isolated behind the `WebSurfaceTransport` boundary. ProviderCore consumes only semantic turn operations and lifecycle callbacks such as physical-surface binding, surface readiness, send activation, and submission acceptance. Playwright objects, selectors, DOM traversal, and ChatGPT-specific UI structures remain implementation details of the concrete browser worker behind the boundary.

This boundary is not a second lifecycle or authorization authority: DSH/ProviderCore continue to own session, turn, capability, tool, retry, and settlement semantics. The surface transport only reports and performs provider-specific browser mechanics needed by those owners.

## 26. Architecture invariants

The following are non-negotiable.

1. DSH session history is canonical.
2. DSH owns authorization for DSH-projected capabilities.
3. ChatGPT-native capabilities remain outside DSH authorization.
4. ProviderCore coordinates; it does not become a second DSH runtime.
5. Account/browser resource ownership is explicit.
6. A logical turn and physical browser settlement are separate states.
7. Automatic retry stops at confirmed submission.
8. EXACT_RESUME is never silently downgraded to REPLAY.
9. Model-visible text is untrusted.
10. No model-visible identifier can create or widen authority.
11. Each turn has an immutable capability snapshot.
12. Broker/MCP transport cannot widen capability authority.
13. ChatGPT Web DOM knowledge exists only in WebSurfaceTransport.
14. ChatGPT Web provider entrypoints share one ProviderCore.
15. Native Codex passthrough remains outside that core.
16. Browser transport capacity is not the same as theoretical model context.
17. A provider-owned turn may re-enter DSH, but cannot synchronously re-enter itself.
18. Compatibility is an ingress concern, not a second execution core.
19. Browser execution seams must not require ChatGPT-specific semantics when a service-neutral contract is sufficient.
20. Additional browser-backed providers reuse proven execution seams but provide their own service profile and WebSurfaceTransport.

---

## 27. Rejected approaches

### Keep llm-pi-ai + localhost Responses as canonical DSH integration

Rejected because it adds a semantic protocol boundary and makes compatibility transport part of provider identity.

### Put Playwright into the DSH AgentLoop

Rejected because DOM mechanics belong in a transport layer.

### Make ProviderCore the owner of all DSH state

Rejected because that creates a second runtime and duplicates authority.

### Let MCP own tool authorization

Rejected because MCP is transport, not the DSH security boundary.

### Treat ChatGPT-native actions as DSH tools

Rejected because the DSH sandbox cannot govern capabilities owned by ChatGPT.

### Retry after an ambiguous submission

Rejected because browser timeouts cannot prove that the original turn did not execute.

### Use natural-language parsing to authorize operations

Rejected because model output is untrusted data.

### Build multi-account/session pooling in Phase 1

Rejected as unnecessary pilot complexity.

### Build a generic multi-service browser framework before a second provider exists

Rejected because the reusable boundaries can be defined now without inventing factories, registries, or plugin hierarchies whose value has not yet been demonstrated. DeepSeek Web and Grok Web remain future provider additions, not Phase 1 abstraction requirements.

---

## 28. Migration and issue mapping

### Phase 1

**#8 Native DSH provider boundary**

Only the DSH-facing seam changes. Existing browser execution is reused.

**#9 ProviderCore and execution authority**

Extract the ChatGPT Web provider orchestration while keeping its internal seams service-neutral. Introduce BrowserAccountLease, turn lifecycle, logical/physical settlement, retry boundary, continuity states, reentrancy rule, and control-protocol trust boundary. Do not build a multi-provider framework.

**#10 Capability architecture**

Make DSH tools/skills authoritative. Introduce CapabilityProjector, CapabilityTransport, capability snapshot, and broker binding without creating a second registry.

**#11 Canonical context/replay**

Unify projection, replay, compaction handoff, stale-handle removal, and transport budgeting.

**#12 WebSurfaceTransport**

Isolate DOM/browser mechanics, readiness, capability detection, submission, completion, cancellation, and recovery.

### Phase 2

**#13 Compatibility convergence**

Make Responses compatibility a thin adapter over ProviderCore. Keep native Codex separate.

**#14 Verification and retirement**

Add cross-layer provenance and architecture contract tests, then remove only redundant code proven obsolete.

---

## 29. Definition of done for the pilot

Phase 1 is structurally sound when all of the following are true:

~~~text
ctx.llm
   |
   v
ChatGptWebLlmAdapter
   |
   v
ChatGPTWebProviderCore
   |
   +--> AccountBrowserLease
   +--> TurnCoordinator
   +--> ContextProjector
   +--> CapabilityProjector
   +--> CapabilityTransport
   +--> WebSurfaceTransport
   |
   v
ChatGPT Web
~~~

and:

- no Responses server is required for native DSH calls;
- browser/DOM details do not leak into the DSH adapter;
- DSH remains the authority for DSH-projected execution;
- browser/account ownership is explicit;
- post-submit retries are safe by construction;
- continuity recovery is explicit;
- model-visible protocol text is parsed as untrusted data;
- capability state is turn-scoped;
- the provider can report precise failure categories;
- the architecture does not require any Phase 2 feature to remain correct.

---

## 30. Current repository evidence

The architecture is grounded in existing repository components:

- src/plugin.ts — current Cordis/plugin lifecycle and sidecar integration.
- src/adapters/chatgpt-web/index.ts — current ChatGPT Web provider/turn execution.
- src/adapters/chatgpt-web/environment.ts — trusted turn environment.
- src/adapters/chatgpt-web/turn-broker.ts — cross-process turn/capability coordination.
- src/adapters/chatgpt-web/mcp-server.ts — ChatGPT-facing capability bridge.
- src/adapters/chatgpt-web/prompt.ts — context/control projection.
- src/adapters/chatgpt-web/turn-execution.ts — turn execution and settlement.
- src/adapters/chatgpt-web/thread-environment.ts — persisted thread environment.
- src/adapters/chatgpt-web/compaction-handoff.ts — compaction handoff.
- src/adapters/chatgpt-web/rolling-checkpoint.ts — provider continuity checkpoints.
- src/chatgpt-session.ts — browser surface and DOM selectors.
- src/chatgpt-web-models.ts — account/model capability definitions.
- src/native-passthrough.ts — native Codex passthrough.
- src/server.ts — Responses compatibility server.
- package.json — supported DSH version constraint and runtime dependencies.

The current code confirms that the project already has substantial browser, turn, broker, checkpoint, compaction and capability machinery. The architecture therefore favors extraction and ownership cleanup over a green-field rewrite.

---

## 31. External references used

These references were used to verify the architecture's external contracts and current product constraints.

### DeepSeek Harness

- LLM runtime and LlmAdapter contract:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts
- LLM types / GenerateOptions / StreamChunk:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/types.ts
- Official LLM adapter cookbook:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md
- LLM adapter developer guide:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md
- DSH LLM streaming semantics:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md
- DSH tools subsystem:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md
- DSH skills subsystem:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md
- DSH skill tool projection:  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/src/index.ts

### OpenAI / ChatGPT product constraints

- ChatGPT Free Tier FAQ:  
  https://help.openai.com/en/articles/9275245-chatgpt-free-tier-faq
- ChatGPT image input FAQ:  
  https://help.openai.com/en/articles/8400551-chatgpt-image-inputs-faq
- Developer mode and MCP apps in ChatGPT:  
  https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- ChatGPT Search:  
  https://help.openai.com/en/articles/9237897-chatgpt-search

These pages describe mutable ChatGPT product behavior for the supported Free Web account matrix. They are not OpenAI API contracts. API model documentation, even when it describes the same underlying model family, MUST NOT be used to derive this browser adapter's Free Web transport budget. The supported account matrix and measured browser limits must be re-checked when ChatGPT Free product behavior changes.

### Model Context Protocol

- MCP 2026-07-28 specification release:  
  https://blog.modelcontextprotocol.io/posts/2026-07-28/
- MCP 2026 roadmap / transport direction:  
  https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/

MCP is treated here as a capability transport, not as the identity of the provider architecture.

---

## 32. Final ownership model

~~~text
DSH
  = canonical session history
  = provider selection
  = DSH tools / skills
  = authorization
  = sandbox / approvals / guards
  = agent lifecycle

ChatGPT
  = model reasoning
  = model output
  = ChatGPT-native product behavior

Browser-backed ProviderCore role
  = provider orchestration
  = turn lifecycle
  = account/browser coordination
  = provider-private continuity
  = context projection
  = capability binding
  = cancellation/retry/settlement
  = provider diagnostics

ChatGPTWebProviderCore (Phase 1)
  = first concrete implementation of that role

CapabilityProjector
  = what DSH exposes

CapabilityTransport
  = how it crosses into ChatGPT

TurnBroker
  = which turn owns the transport request

WebSurfaceTransport
  = browser/DOM mechanics

Responses compatibility
  = alternate ingress into ProviderCore

Native Codex passthrough
  = separate first-party upstream protocol
~~~

The core invariant is:

> **ChatGPT decides what it wants to do; DSH decides what it is allowed to do.**

The provider invariant is:

> **Every ChatGPT Web provider entrypoint converges on one ProviderCore, while browser mechanics remain isolated behind WebSurfaceTransport.**
