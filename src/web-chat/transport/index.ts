/**
 * Provider-neutral transport layer (architecture §12, §15.3, §18).
 *
 * It depends on the core and is never imported by it: a provider implements
 * {@link WebChatTextTransport} and the core drives it through the exchange runner.
 */
export {
  createWebChatExchange,
  isWebChatExchangeOpen,
  assertWebChatExchangeSettled,
  type WebChatExchangeOptions,
  type WebChatExchangeRunner,
} from "./exchange-runner";
export { createWebChatTransportLeaseRegistry, type WebChatTransportLease, type WebChatTransportLeaseAcquireOptions, type WebChatTransportLeaseRegistry, type WebChatTransportLeaseSnapshot, type WebChatTransportLeaseState, type WebChatTransportResource } from "./transport-lease";
export type { WebChatTextTransport, WebChatTextTransportContext } from "./text-transport";
