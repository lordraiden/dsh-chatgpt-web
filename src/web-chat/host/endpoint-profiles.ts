/**
 * Endpoint profiles (issue #356): the host-owned public endpoint view.
 *
 * The operator wants more than one API endpoint from one service — a `temporary` ChatGPT surface for
 * a caller that must not write the account's chat history, and a `persistent` one for normal visible
 * chats — while the default `/v1/*` endpoint keeps the configured global behaviour.
 *
 * This module owns that view and deliberately nothing else:
 *
 * - **A profile is a view over the configured catalogue, never a second registry.** It binds a public
 *   path prefix (`/p/<name>/v1`), the `chatVisibility` provider fact a turn on that endpoint uses
 *   (issue #355), and optionally a subset of the catalogue's model ids and a concurrency budget. It
 *   adds no provider, no route and no model: the requested model must already be a public catalogue
 *   route, and the turn is executed by exactly the same ingress, provider core and retry authority as
 *   the default endpoint.
 * - **The service stays the routing authority.** `applyEndpointProfile` produces a request-scoped
 *   `AppConfig`; every existing resolver (`effectiveChatGptWebProviderConfig`, the model catalogue,
 *   the route authority, the ingress) reads it unchanged. Nothing here selects a provider or a driver.
 * - **An unhonourable profile fails closed, with a typed refusal.** A profile that names a model this
 *   service no longer serves, or a visibility mode the deployment cannot honour, is refused at the
 *   endpoint with its own stable code instead of being served as a silent fallback. A deleted profile
 *   answers a typed 404 on its path — never the default endpoint's behaviour.
 * - **The profile's visibility statement wins for its endpoint.** A profile states the mode
 *   explicitly, so it is authoritative over the flat `chatVisibility` field and over a
 *   provider-scoped `webChat.providers["chatgpt-web"].chatVisibility` pin for that endpoint only. The
 *   default endpoint keeps the configured behaviour byte-for-byte.
 *
 * The management surface (`GET/POST/PUT/DELETE /v1/control/endpoint-profiles`) and the page in
 * `endpoint-profiles-page.ts` are the operator's client of this module; the control token guards
 * every data-carrying endpoint exactly like the rest of `/v1/control/*`.
 */
import {
  CHATGPT_WEB_ROUTE_ID,
  providerConfig,
  validateChatGptWebProviderFacts,
  validateEndpointProfiles,
  type AppConfig,
  type EndpointProfile,
} from "../../config";
import { isChatGptWebModelSlug } from "../../chatgpt-web-models";
import { effectiveChatGptWebProviderConfig } from "../../chatgpt-web-provider-config";
import { publicModelRouteIds } from "../../model-catalog";
import type { ChatGptWebChatVisibility } from "../../types";

/** The public path prefix every profile endpoint lives under. */
export const ENDPOINT_PROFILE_PATH_PREFIX = "/p/";

/**
 * The public contract paths a profile serves, relative to its `/p/<name>/v1` base.
 *
 * Deliberately the OpenAI/Responses contract only: `/v1/models`, `/v1/responses` and
 * `/v1/chat/completions`. Codex-native routes (`/v1/responses/compact`, `/v1/alpha/search`) and the
 * operator surface are not reachable through a profile, because a profile selects among the public
 * catalogue models and has no native-passthrough authority.
 */
export const ENDPOINT_PROFILE_PUBLIC_PATHS: readonly string[] = [
  "/v1/models",
  "/v1/responses",
  "/v1/chat/completions",
];

/** Stable refusal codes, so a client can act on the reason instead of matching prose. */
export const ENDPOINT_PROFILE_NOT_FOUND_CODE = "endpoint_profile_not_found";
export const ENDPOINT_PROFILE_ROUTE_NOT_FOUND_CODE = "endpoint_profile_route_not_found";
export const ENDPOINT_PROFILE_UNAVAILABLE_CODE = "endpoint_profile_unavailable";
export const ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE = "endpoint_profile_model_not_allowed";
export const ENDPOINT_PROFILE_CONCURRENCY_EXCEEDED_CODE = "endpoint_profile_concurrency_exceeded";

/** A typed refusal this module produces; the HTTP layer publishes it verbatim. */
export interface EndpointProfileRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** The public-path match of one profile request. */
export interface EndpointProfilePathMatch {
  /** The profile name the path selects. */
  readonly name: string;
  /** The public contract path after the prefix, for example `/v1/chat/completions`. */
  readonly path: string;
}

/** The result of resolving one profile request against the live configuration. */
export type EndpointProfileResolution =
  | { readonly ok: true; readonly profile: EndpointProfile; readonly path: string }
  | ({ readonly ok: false } & EndpointProfileRefusal);

/** The management view of one profile: the persisted fields plus the resulting public base path. */
export interface EndpointProfileView {
  readonly name: string;
  readonly path: string;
  readonly chatVisibility: ChatGptWebChatVisibility;
  readonly models: readonly string[] | null;
  readonly maxConcurrentTurns: number | null;
}

function refusal(status: number, code: string, message: string): EndpointProfileRefusal {
  return { status, code, message };
}

/**
 * The base path an OpenAI-compatible client configures for one profile.
 *
 * A prefix (rather than a header-selected profile) is the smallest shape that works for a client
 * that only knows a base URL: point it at `http://host:port/p/<name>/v1` and the client's own
 * `/chat/completions` and `/models` calls land on that profile. No custom header, no second
 * credential and no client change beyond the URL.
 */
export function endpointProfileBasePath(name: string): string {
  return `${ENDPOINT_PROFILE_PATH_PREFIX}${name}/v1`;
}

/**
 * Match a request path against the profile prefix.
 *
 * @param pathname - the request path.
 * @returns the selected name and remaining public path, or `undefined` when the path is not under
 *   the profile prefix at all (the default endpoint's dispatch must be untouched).
 */
export function matchEndpointProfilePath(pathname: string): EndpointProfilePathMatch | undefined {
  if (!pathname.startsWith(ENDPOINT_PROFILE_PATH_PREFIX)) return undefined;
  const rest = pathname.slice(ENDPOINT_PROFILE_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  if (!name) return undefined;
  return { name, path: slash === -1 ? "" : rest.slice(slash) };
}

/** The public catalogue route ids this configuration serves, as a set. */
function catalogueRoutes(config: AppConfig): Set<string> {
  return new Set(publicModelRouteIds(config));
}

/**
 * Validate one profile's visibility fact against the deployment's provider facts.
 *
 * It delegates to the single owner of the provider-fact invariants (`validateChatGptWebProviderFacts`),
 * so the temporary↔launcher rule is not restated here: a profile that asks for a surface the
 * deployment cannot produce is refused with the same message the flat and scoped blocks get.
 *
 * @param config - the deployment configuration.
 * @param visibility - the profile's visibility mode.
 * @param path - the location named in the refusal.
 * @throws {Error} when the deployment cannot honour the mode.
 */
export function validateEndpointProfileFacts(
  config: AppConfig,
  visibility: ChatGptWebChatVisibility,
  path: string,
): void {
  validateChatGptWebProviderFacts({
    ...providerConfig(config).chatgptWeb,
    chatVisibility: visibility,
  }, path);
}

/**
 * Validate one already-shape-checked profile against the live catalogue and provider facts.
 *
 * @param config - the deployment configuration the profile will be served by.
 * @param profile - the normalized profile.
 * @param path - the location named in the refusal.
 * @returns the profile.
 * @throws {Error} when the profile names an unknown model or an unhonourable mode.
 */
function honourProfile(config: AppConfig, profile: EndpointProfile, path: string): EndpointProfile {
  const catalogue = catalogueRoutes(config);
  const unknown = (profile.models ?? []).filter(model => !catalogue.has(model));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown model${unknown.length === 1 ? "" : "s"} in ${path}: ${unknown.join(", ")}.`
      + " A profile selects among the models this service already serves (GET /v1/models).",
    );
  }
  validateEndpointProfileFacts(config, profile.chatVisibility, path);
  return profile;
}

/**
 * Validate one authored profile against the live catalogue and the deployment's provider facts.
 *
 * This is the management-write owner: it refuses an unknown model id and an unhonourable visibility
 * mode before anything is persisted, so the operator learns at the control surface instead of on the
 * first turn.
 *
 * @param config - the deployment configuration the profile will be served by.
 * @param value - the authored profile (shape validated by {@link validateEndpointProfiles}).
 * @param path - the location named in the refusal.
 * @returns the normalized profile.
 * @throws {Error} when the profile names an unknown model or an unhonourable mode.
 */
export function validateEndpointProfileCandidate(
  config: AppConfig,
  value: unknown,
  path: string,
): EndpointProfile {
  const [profile] = validateEndpointProfiles([value], path);
  return honourProfile(config, profile, path);
}

/**
 * Validate a whole authored profile set against the live catalogue and provider facts.
 *
 * Used by `PUT /v1/control/config`, which replaces the set in one write. Each entry goes through
 * {@link validateEndpointProfileCandidate}, so the bulk and per-profile write paths cannot disagree.
 *
 * @param config - the deployment configuration the profiles will be served by.
 * @param value - the authored `endpointProfiles` value.
 * @param path - the location named in the refusal.
 * @returns the normalized profiles.
 * @throws {Error} when any profile is invalid or unhonourable.
 */
export function validateEndpointProfileSet(
  config: AppConfig,
  value: unknown,
  path: string,
): EndpointProfile[] {
  return validateEndpointProfiles(value, path).map(
    profile => honourProfile(config, profile, `${path} (endpointProfiles["${profile.name}"])`),
  );
}

/**
 * The request-scoped configuration one profile endpoint runs with.
 *
 * It is a shallow copy: the profile's visibility replaces the flat fact, and a provider-scoped
 * `chatVisibility` pin is removed from the copied scoped block so the profile's explicit statement is
 * the effective fact for this endpoint. Nothing else about the provider facts changes, and the
 * caller's configuration object is never mutated (two profiles may be in flight at once).
 *
 * @param config - the live deployment configuration.
 * @param profile - the resolved profile.
 * @returns the configuration every existing resolver reads for this request.
 */
export function applyEndpointProfile(config: AppConfig, profile: EndpointProfile): AppConfig {
  const providers = config.webChat?.providers;
  const scoped = providers?.[CHATGPT_WEB_ROUTE_ID];
  let webChat = config.webChat;
  if (providers !== undefined && scoped !== null && typeof scoped === "object" && !Array.isArray(scoped)) {
    webChat = {
      ...config.webChat,
      providers: {
        ...providers,
        // `undefined` is filtered by the merge owner, so this removes the pin instead of restating it.
        [CHATGPT_WEB_ROUTE_ID]: { ...(scoped as Record<string, unknown>), chatVisibility: undefined },
      },
    };
  }
  return {
    ...config,
    chatVisibility: profile.chatVisibility,
    ...(webChat === undefined ? {} : { webChat }),
  };
}

/**
 * Resolve one profile request against the live configuration, without mutating anything.
 *
 * The checks are ordered so the most specific answer wins: an unknown name is a 404 (a deleted
 * profile never falls back), an unsupported path under a known profile is a 404, and a profile that
 * cannot be honoured against the current catalogue or provider facts is a typed 409. The requested
 * model's membership is checked later, by the ingress that knows which model the caller asked for
 * ({@link endpointProfileModelRefusal}).
 *
 * @param config - the live deployment configuration.
 * @param match - the path match.
 * @returns the resolved profile and public path, or a typed refusal.
 */
export function resolveEndpointProfileRequest(
  config: AppConfig,
  match: EndpointProfilePathMatch,
): EndpointProfileResolution {
  const profile = (config.endpointProfiles ?? []).find(candidate => candidate.name === match.name);
  if (profile === undefined) {
    return {
      ok: false,
      ...refusal(
        404,
        ENDPOINT_PROFILE_NOT_FOUND_CODE,
        `Unknown endpoint profile ${JSON.stringify(match.name)}. It may have been deleted; list the`
        + " configured profiles at GET /v1/control/endpoint-profiles.",
      ),
    };
  }
  if (!ENDPOINT_PROFILE_PUBLIC_PATHS.includes(match.path)) {
    return {
      ok: false,
      ...refusal(
        404,
        ENDPOINT_PROFILE_ROUTE_NOT_FOUND_CODE,
        `Endpoint profile ${JSON.stringify(profile.name)} serves only`
        + ` ${ENDPOINT_PROFILE_PUBLIC_PATHS.join(", ")} under ${endpointProfileBasePath(profile.name)}.`,
      ),
    };
  }
  const catalogue = catalogueRoutes(config);
  const unknown = (profile.models ?? []).filter(model => !catalogue.has(model));
  if (unknown.length > 0) {
    return {
      ok: false,
      ...refusal(
        409,
        ENDPOINT_PROFILE_UNAVAILABLE_CODE,
        `Endpoint profile ${JSON.stringify(profile.name)} cannot be honoured: it names`
        + ` model${unknown.length === 1 ? "" : "s"} this service no longer serves`
        + ` (${unknown.join(", ")}). Edit or delete the profile at /v1/control/endpoints/.`,
      ),
    };
  }
  try {
    validateEndpointProfileFacts(config, profile.chatVisibility, `endpointProfiles["${profile.name}"]`);
    // The effective facts include a provider-scoped overlay, so a scoped block that makes the
    // profile's mode impossible is refused here instead of failing the turn later.
    effectiveChatGptWebProviderConfig(applyEndpointProfile(config, profile));
  } catch (error) {
    return {
      ok: false,
      ...refusal(
        409,
        ENDPOINT_PROFILE_UNAVAILABLE_CODE,
        `Endpoint profile ${JSON.stringify(profile.name)} cannot be honoured:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  return { ok: true, profile, path: match.path };
}

/**
 * The typed refusal for a model a profile endpoint may not serve, or `undefined` when it may.
 *
 * Two rules, both fail-closed:
 *
 * - the model must be a public catalogue route **and** one the profile allows. A profile never
 *   forwards to the native Codex passthrough: it selects among the catalogue models this service
 *   already serves, and "not in the catalogue" is a refusal, not a fallback;
 * - a `temporary` profile can only be honoured by a ChatGPT Web route. The visibility fact is a
 *   ChatGPT Web fact (issue #355); serving a Qwen/DeepSeek model through a temporary endpoint would
 *   silently run it on whatever surface that provider owns, which is exactly the silent fallback the
 *   profile exists to prevent.
 *
 * @param config - the request-scoped configuration.
 * @param profile - the resolved profile.
 * @param model - the model the caller requested.
 * @returns the refusal, or `undefined` when the profile can honour the request.
 */
export function endpointProfileModelRefusal(
  config: AppConfig,
  profile: EndpointProfile,
  model: string,
): EndpointProfileRefusal | undefined {
  const catalogue = catalogueRoutes(config);
  const allowed = profile.models ?? [...catalogue];
  if (!model || !allowed.includes(model) || !catalogue.has(model)) {
    return refusal(
      400,
      ENDPOINT_PROFILE_MODEL_NOT_ALLOWED_CODE,
      `Model ${JSON.stringify(model)} is not served by endpoint profile ${JSON.stringify(profile.name)}.`
      + ` Allowed models: ${allowed.join(", ")}.`,
    );
  }
  if (profile.chatVisibility === "temporary" && !isChatGptWebModelSlug(model)) {
    return refusal(
      409,
      ENDPOINT_PROFILE_UNAVAILABLE_CODE,
      `Endpoint profile ${JSON.stringify(profile.name)} requires temporary chat visibility, which only`
      + ` the ChatGPT Web routes can honour; model ${JSON.stringify(model)} cannot.`,
    );
  }
  return undefined;
}

/**
 * The management view of one profile.
 *
 * It carries no secret: the base path is public information, and the credential that guards it is
 * reported once for the whole surface (the service API key), never per profile.
 */
export function endpointProfileView(profile: EndpointProfile): EndpointProfileView {
  return {
    name: profile.name,
    path: endpointProfileBasePath(profile.name),
    chatVisibility: profile.chatVisibility,
    models: profile.models ?? null,
    maxConcurrentTurns: profile.maxConcurrentTurns ?? null,
  };
}

/** What guards the profile endpoints, as the management surface reports it. */
export interface EndpointProfileCredentialView {
  /** The credential family; always the service API key, never a per-profile key. */
  readonly scheme: "api-key";
  /**
   * Whether the service currently requires it: an API key is configured. A non-loopback bind always
   * has one (the server refuses to start without it), so this boolean covers both cases.
   */
  readonly required: boolean;
  /** The header to send, with a placeholder — never a value. */
  readonly header: string;
}

/**
 * The credential the profile endpoints are guarded by.
 *
 * Profiles deliberately mint no credential of their own: the API key stays global (issue #356 design
 * decision), so there is one authority for `/v1/*` and `/p/*` and no second secret to distribute or
 * leak. The management surface only reports whether that global key is required.
 *
 * @param apiKeyConfigured - whether the service has an API key configured.
 * @returns the credential view.
 */
export function endpointProfileCredential(apiKeyConfigured: boolean): EndpointProfileCredentialView {
  return {
    scheme: "api-key",
    required: apiKeyConfigured,
    header: "Authorization: Bearer <api key>",
  };
}
