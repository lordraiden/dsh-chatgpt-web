# Issue #73 parity and retirement audit

The native DSH provider and `/v1/responses` are verified at the ProviderCore ingress boundary.

## Parity

- Model resolution and route eligibility: both converge on `requireChatGptWebRoute()` and `routeChatGptWebRequest()`.
- Canonical context: Responses parsing produces the same `CodexParsedRequest` consumed by the Web adapter; the adapter owns canonical DSH -> Web projection.
- Capability binding: `ChatGptWebProviderCore` owns the immutable per-turn snapshot and its binding identity.
- Turn identity: native turn/thread metadata is extracted before Web execution and is bound to the same ProviderCore execution key.
- Streaming: Responses is only a wire bridge over the adapter event stream.
- Cancellation: the Responses request signal is converted to the adapter abort path; browser/turn cancellation remains in the Web execution layer.
- Retry classification: compatibility code does not own retry authorization; ProviderCore owns attempt budget and submission gating, while `retry-policy.ts` only classifies provider errors.
- Context exhaustion/replay: canonical replay state is implemented in the Web adapter/replay path, not in Responses compatibility modules.
- Logical/physical settlement: ProviderCore tracks both and gates retirement on physical settlement.
- Error normalization: Web adapter errors are converted by the common bridge/server boundary rather than by a second Responses execution core.
- Provenance: ProviderCore owns trusted execution/turn/lease provenance; compatibility state does not authorize execution.

## Retirement decision

No compatibility execution path was safely removable after the audit.

`src/responses/state.ts` is retained because `previous_response_id` is an externally observable `/v1/responses` continuation contract. Its state is explicitly cache-only, bounded and non-authoritative; it does not own DSH context, capabilities, browser resources, retry policy, replay, or settlement.

`src/responses/compaction.ts`, parser/schema/reasoning translation and the Responses bridge remain because they implement externally visible wire compatibility. Native Codex passthrough remains a separate protocol path.

This is intentional: #73 retires redundant authority, not externally required compatibility translation.
