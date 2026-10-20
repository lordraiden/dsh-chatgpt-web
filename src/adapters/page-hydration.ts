/**
 * Wait, bounded, for a provider's own page to restore its session (issue #299).
 *
 * Some consumer-web providers keep a session in cookies **and** a short-lived access token in page
 * storage that their own client installs *after* boot: on load, the app reads the cookies, asks its
 * own auth endpoint for a token, and writes the result where its request interceptor reads it. A
 * probe that runs at `domcontentloaded` therefore sees a page that has not authenticated itself yet,
 * and one that runs after a fixed sleep is a bet on the page's load time.
 *
 * This module is the **provider-neutral mechanism** for the honest alternative: poll an observation of
 * the page's own state until the provider's own predicate says the page has hydrated, bounded by a
 * deadline. What is observed (a storage key, a token manager flag, an app state) and when it counts as
 * ready are the provider's business and must never be decided here. The polling interval is a
 * *polling interval*, not a correctness sleep: the correctness comes from the observable condition
 * and the deadline, so a page that never hydrates ends at the bound instead of hanging or being
 * declared ready.
 *
 * Deliberately small: one loop, no browser type, no second scheduler. It is a transport primitive,
 * like `page-context-request.ts` (AGENTS.md → *Browser is a transport mechanism, not the
 * architecture*).
 */

/** How long one hydration wait may take before the page is treated as "still not hydrated". */
export interface PageHydrationOptions {
  /** The deadline. A page that has not hydrated by then is reported as not hydrated, never waited on. */
  readonly timeoutMs: number;
  /** How often the observation is re-read. Defaults to {@link PAGE_HYDRATION_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

/** What one wait observed. `state` is the last value the observer returned. */
export interface PageHydrationWait<T> {
  /** Whether the page's own predicate became true before the deadline. */
  readonly hydrated: boolean;
  /** The last observed state; absent only when every observation failed. */
  readonly state?: T;
  /** How long the wait took, in milliseconds. Diagnostics only. */
  readonly waitedMs: number;
}

/** The default polling interval. A web app's boot is measured in hundreds of milliseconds. */
export const PAGE_HYDRATION_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Observe one value, giving up after `timeoutMs` so a wedged page cannot hold the wait open.
 *
 * The underlying promise is not cancelled — the caller cannot cancel a page's own evaluation — but
 * its settlement is ignored after the bound, and its rejection is consumed so it cannot surface as
 * an unhandled rejection later.
 */
function observeWithin<T>(observe: () => Promise<T>, timeoutMs: number): Promise<{ state?: T }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: { state?: T }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { finish({}); }, timeoutMs);
    observe().then(
      state => { finish({ state }); },
      () => { finish({}); },
    );
  });
}

/**
 * Poll `observe` until `isHydrated` accepts its value, or `timeoutMs` elapses.
 *
 * The first observation happens immediately (a page that is already hydrated costs one read), then
 * every `pollIntervalMs`. An observation that throws — a page mid-navigation, a context being torn
 * down — is "not yet", not a failure: the deadline decides. The returned `waitedMs` is the actual
 * elapsed time, so a caller can report the bound it enforced instead of the bound it asked for.
 */
export async function waitForPageHydration<T>(
  observe: () => Promise<T>,
  isHydrated: (state: T) => boolean,
  options: PageHydrationOptions,
): Promise<PageHydrationWait<T>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("A page-hydration wait requires a positive timeout");
  }
  const pollIntervalMs = options.pollIntervalMs ?? PAGE_HYDRATION_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("A page-hydration wait requires a positive polling interval");
  }

  const started = Date.now();
  let lastState: T | undefined;
  for (;;) {
    const remaining = options.timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      return {
        hydrated: false,
        waitedMs: Date.now() - started,
        ...(lastState === undefined ? {} : { state: lastState }),
      };
    }

    const observed = await observeWithin(observe, remaining);
    if (observed.state !== undefined) lastState = observed.state;
    const waitedMs = Date.now() - started;
    if (lastState !== undefined && isHydrated(lastState)) {
      return { hydrated: true, state: lastState, waitedMs };
    }
    if (waitedMs >= options.timeoutMs) {
      return {
        hydrated: false,
        waitedMs,
        ...(lastState === undefined ? {} : { state: lastState }),
      };
    }
    await sleep(Math.min(pollIntervalMs, options.timeoutMs - waitedMs));
  }
}
