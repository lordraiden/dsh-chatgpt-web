/**
 * Driver resolution for an already-selected host provider route (architecture §17).
 *
 * The host runtime is the authority that selects a provider route; this layer only maps that
 * selection to the driver that implements it. It keeps no registry policy, no catalog and no
 * fallback: a route with no driver is simply not resolvable, and the caller decides what that
 * means.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import type { WebChatProviderDriver } from "./provider";

/** Maps one already-selected provider route to its driver. */
export interface WebChatDriverResolver {
  /**
   * @param selectedProviderId - the provider route the host runtime already selected.
   * @returns the driver that implements it, or undefined when this deployment has none.
   */
  resolve(selectedProviderId: string): WebChatProviderDriver | undefined;
  /** The routes this resolver can serve, for diagnostics only. */
  readonly providerIds: readonly string[];
}

/**
 * Build a resolver over a fixed set of drivers.
 *
 * Resolution is a plain map lookup: a later PR wires the host's selected route into it. Duplicate
 * driver ids are refused, because that would make resolution order-dependent (a policy this layer
 * must not own).
 *
 * @param drivers - the drivers this deployment composes.
 * @returns the resolver.
 * @throws {TypeError} when two drivers declare the same id.
 */
export function createWebChatDriverResolver(
  drivers: readonly WebChatProviderDriver[],
): WebChatDriverResolver {
  const byProviderId = new Map<string, WebChatProviderDriver>();
  for (const driver of drivers) {
    if (byProviderId.has(driver.id)) {
      throw new TypeError(`Duplicate WebChat provider driver id: ${driver.id}`);
    }
    byProviderId.set(driver.id, driver);
  }
  return {
    providerIds: [...byProviderId.keys()],
    resolve: (selectedProviderId: string) => byProviderId.get(selectedProviderId),
  };
}
