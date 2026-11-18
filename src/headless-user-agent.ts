/**
 * The Windows desktop user agent the managed headless browser presents.
 *
 * ChatGPT's web surface only serves the headless flow to a browser that looks like a desktop one:
 * the turn browser launches with this identity, and the stored-session verifier must present the
 * same one or it lands on a page without the composer (the health probe would then report a working
 * capture as `expired`). One owner for the string keeps the two launches from drifting.
 */
export const HEADLESS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
