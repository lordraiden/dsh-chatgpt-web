/**
 * The Advisor's eligible model catalogue (issue #224).
 *
 * The list is built from the **one** provider composition the host already holds: each provider's
 * driver answers what it can serve, and the provider's own account/health state decides whether it is
 * currently usable. There is deliberately no second catalogue:
 *
 * - a choice's public route identity is `providerId/modelId`, exactly the identity the DSH catalogue
 *   exposes for the same driver (`webChatModelCatalogueEntries`), so the Advisor can never advertise
 *   a route the composition cannot serve;
 * - only authenticated providers contribute choices, and each choice is labelled with both provider
 *   and model so two providers exposing the same model name stay distinguishable;
 * - the order is deterministic (provider, then route) so "the deterministic eligible choice" is a
 *   stable product behavior rather than a race.
 *
 * Nothing here is provider-specific; the provider's driver owns model discovery, including its
 * website-UI discovery.
 */
import { webChatPublicRoute } from "../web-chat/host/text-turn";
import type { WebChatProviderRuntime } from "../web-chat/host/text-turn";
import { isWebChatModelDescriptor } from "../web-chat/core";

/** One selectable Advisor model choice. */
export interface AdvisorModelChoice {
  /** Public, provider-qualified route identity. */
  readonly route: string;
  readonly providerId: string;
  readonly providerLabel: string;
  /** Provider-local model identity (the driver's descriptor id). */
  readonly modelId: string;
  readonly modelLabel: string;
  /** Label shown to the user: provider and model together, never the model alone. */
  readonly label: string;
  /** Reasoning variants the provider advertises for this model, when any. */
  readonly reasoningModes?: readonly string[];
}

/** Why a provider contributes no choices, when it does not. */
export type AdvisorProviderUnavailableReason =
  | "auth_required"
  | "unhealthy"
  | "no_models"
  | "unavailable";

/** One provider's availability, as the driver reported it. */
export interface AdvisorProviderAvailability {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly authenticated: boolean;
  readonly healthy: boolean;
  readonly unavailableReason?: AdvisorProviderUnavailableReason;
  /** Non-secret diagnostic detail, when the provider reported one. */
  readonly detail?: string;
  readonly models: readonly AdvisorModelChoice[];
}

/** The catalogue the dialog populates its single model dropdown from. */
export interface AdvisorModelCatalogue {
  readonly providers: readonly AdvisorProviderAvailability[];
  /** Every eligible choice, in deterministic order. */
  readonly choices: readonly AdvisorModelChoice[];
  readonly generatedAt: number;
}

/** Build one choice from a provider-local descriptor. */
function choiceOf(
  runtime: WebChatProviderRuntime,
  providerLabel: string,
  descriptor: { id: string; label: string; reasoningModes?: readonly string[] },
): AdvisorModelChoice {
  const route = webChatPublicRoute(runtime.driver.id, descriptor.id);
  return {
    route,
    providerId: runtime.driver.id,
    providerLabel,
    modelId: descriptor.id,
    modelLabel: descriptor.label,
    label: `${providerLabel} — ${descriptor.label}`,
    ...(descriptor.reasoningModes !== undefined ? { reasoningModes: descriptor.reasoningModes } : {}),
  };
}

/**
 * Build the eligible model catalogue of one provider composition.
 *
 * A provider that cannot answer (a throwing driver) is reported as unavailable with no choices,
 * never as an empty healthy provider, so the dialog can tell "nothing is eligible" from "the
 * catalogue failed to load".
 */
export async function buildAdvisorModelCatalogue(
  runtimes: readonly WebChatProviderRuntime[],
  now: () => number = Date.now,
): Promise<AdvisorModelCatalogue> {
  const ordered = [...runtimes].sort((left, right) => left.driver.id.localeCompare(right.driver.id));
  const providers: AdvisorProviderAvailability[] = [];
  for (const runtime of ordered) {
    const providerLabel = runtime.providerLabel ?? runtime.driver.id;
    try {
      const [account, models] = await Promise.all([
        runtime.driver.inspectAccount(),
        runtime.driver.listModels(),
      ]);
      const descriptors = models.filter(isWebChatModelDescriptor);
      const choices = descriptors.map(descriptor => choiceOf(runtime, providerLabel, descriptor));
      if (!account.authenticated) {
        providers.push({
          providerId: runtime.driver.id,
          providerLabel,
          authenticated: false,
          healthy: true,
          unavailableReason: "auth_required",
          models: choices,
        });
        continue;
      }
      providers.push({
        providerId: runtime.driver.id,
        providerLabel,
        authenticated: true,
        healthy: true,
        ...(choices.length === 0 ? { unavailableReason: "no_models" as const } : {}),
        models: choices,
      });
    } catch (error) {
      providers.push({
        providerId: runtime.driver.id,
        providerLabel,
        authenticated: false,
        healthy: false,
        unavailableReason: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
        models: [],
      });
    }
  }
  const choices = providers
    .filter(provider => provider.authenticated && provider.healthy)
    .flatMap(provider => provider.models)
    .sort((left, right) => left.route.localeCompare(right.route));
  return { providers, choices, generatedAt: now() };
}

/** The deterministic eligible choice of a catalogue: the first one in its stable order. */
export function deterministicAdvisorChoice(
  catalogue: AdvisorModelCatalogue,
): AdvisorModelChoice | undefined {
  return catalogue.choices[0];
}

/** The eligible choice for one public route, when it is currently eligible. */
export function advisorChoiceForRoute(
  catalogue: AdvisorModelCatalogue,
  route: string,
): AdvisorModelChoice | undefined {
  return catalogue.choices.find(choice => choice.route === route);
}

/**
 * The choice to preselect when the dialog opens.
 *
 * The last successfully used route wins when it is still eligible; otherwise the deterministic
 * eligible choice is used. A route that is no longer eligible is never silently replaced with a
 * different model the user did not choose *while it is displayed* — this only chooses the initial
 * displayed value, and the caller keeps the user's explicit selection authoritative afterwards.
 */
export function preferredAdvisorChoice(
  catalogue: AdvisorModelCatalogue,
  lastUsedRoute?: string,
): AdvisorModelChoice | undefined {
  if (lastUsedRoute !== undefined) {
    const preferred = advisorChoiceForRoute(catalogue, lastUsedRoute);
    if (preferred) return preferred;
  }
  return deterministicAdvisorChoice(catalogue);
}
