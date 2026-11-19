/**
 * Readiness for the public listener (issue #699 / D1.4).
 *
 * The service has three distinct probes, and they must never be confused:
 *
 * - **liveness** (`GET /healthz`): the process answers HTTP. Cheap, never touches the browser, never
 *   reads a credential, never spends quota. A supervisor restarts on this.
 * - **readiness** (this module, `GET /readyz`): the listener can accept a turn *right now* — it is not
 *   draining, its data directory is writable, the session capture its own routes need is present, its
 *   turn queue is not saturated and its model catalogue resolved in memory. Still no browser and no
 *   quota: none of these checks may cost a provider message.
 * - **canary**: a real minimal turn. That is the only check that proves the account can *send*, and it
 *   spends one provider message, so it is deliberately **not** part of readiness, not automatic, and
 *   belongs to an explicit operator action (see the README and TROUBLESHOOTING).
 *
 * The readiness answer is a compact JSON object with one entry per check, so a supervisor (or a human)
 * can tell *which* precondition failed instead of receiving one opaque 503. It never contains a
 * credential, a prompt, a filesystem path or a caller identity.
 *
 * The storage probe is a real write+unlink in the data directory (permission bits alone lie on a
 * read-only mount), cached for a short window so a probe loop cannot turn into a disk-write loop.
 */
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultAuthHealthProviders } from "../../auth-health";
import { getConfigDir, type AppConfig } from "../../config";
import { publicModelRouteIds } from "../../model-catalog";
import { isChatGptWebModelSlug } from "../../chatgpt-web-models";

/** The provider whose browser session this listener's primary transport owns. */
const CHATGPT_WEB_PROVIDER = "chatgpt-web";

/** One probe result: an `ok` flag plus compact, credential-free detail. */
export interface ReadinessCheck {
  readonly ok: boolean;
  readonly [detail: string]: unknown;
}

/** The queue facts readiness needs; the provider's snapshot is wider, this is the subset it reads. */
export interface TurnQueueReadiness {
  /** Turns waiting for a slot right now (all accounts). */
  readonly waiting: number;
  /** Turns that may wait before the queue refuses a new one. */
  readonly maxWaiters: number;
  /** Slots held by committed turns right now. */
  readonly active: number;
}

/** The published readiness document. */
export interface ReadinessBody {
  readonly status: "ready" | "not_ready";
  readonly service: "dsh-chatgpt-web";
  readonly version: string;
  readonly checked_at: string;
  readonly checks: Readonly<Record<string, ReadinessCheck>>;
}

/** One readiness snapshot: the body plus the HTTP status that matches it. */
export interface ReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly httpStatus: 200 | 503;
  readonly body: ReadinessBody;
}

/** Options for {@link createReadinessProbe}. */
export interface ReadinessProbeOptions {
  readonly config: AppConfig;
  /** The service version, so a probe can be matched against the deployment. */
  readonly version: string;
  /** Whether the listener is accepting new turns (false while draining). */
  readonly isAcceptingTurns: () => boolean;
  /** The live turn-queue facts. */
  readonly turnQueue: () => TurnQueueReadiness;
  /** Clock seam; tests inject one. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How long one storage write probe is reused. Default 10 s.
   *
   * The probe writes a file, so an unauthenticated readiness loop must not translate one HTTP hit
   * into one disk write. Ten seconds keeps a supervisor's 30 s poll honest without turning a
   * misconfigured monitor into a write storm.
   */
  readonly storageProbeTtlMs?: number;
  /** Capture-presence seam; tests may inject it. Defaults to a non-empty file check. */
  readonly capturePresent?: (storageStatePath: string) => boolean;
}

/** The readiness surface: one synchronous check per call, no browser, no network, no quota. */
export interface ReadinessProbe {
  snapshot(): ReadinessReport;
}

export const DEFAULT_STORAGE_PROBE_TTL_MS = 10_000;

/** A capture is present when the file exists and carries bytes; an empty file is not a session. */
function defaultCapturePresent(storageStatePath: string): boolean {
  try {
    return statSync(storageStatePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Create the readiness probe for one listener.
 *
 * Every dependency is injected (clock, queue, capture check) so the 503 branches are deterministic
 * tests instead of timing-dependent ones.
 *
 * @param options - the deployment configuration and the live facts readiness reads.
 * @returns the probe; `snapshot()` is synchronous and never touches the browser.
 */
export function createReadinessProbe(options: ReadinessProbeOptions): ReadinessProbe {
  const now = options.now ?? Date.now;
  const storageProbeTtlMs = options.storageProbeTtlMs ?? DEFAULT_STORAGE_PROBE_TTL_MS;
  if (!Number.isSafeInteger(storageProbeTtlMs) || storageProbeTtlMs < 0) {
    throw new TypeError("A readiness probe requires a non-negative storage probe TTL");
  }
  const capturePresent = options.capturePresent ?? defaultCapturePresent;
  let storageProbe: { readonly at: number; readonly ok: boolean; readonly code?: string } | undefined;

  /**
   * Whether the data directory can take a write, probed with a real file and cached (see the TTL).
   *
   * A missing directory is its own verdict: the entrypoint bootstraps the volume, so a service whose
   * directory vanished is not silently "created" by a health probe.
   */
  const probeStorage = (instant: number): ReadinessCheck => {
    if (storageProbe !== undefined && instant - storageProbe.at < storageProbeTtlMs) {
      return storageProbe.ok
        ? { ok: true }
        : { ok: false, code: storageProbe.code ?? "storage_unwritable" };
    }
    const directory = getConfigDir();
    let verdict: { ok: boolean; code?: string };
    try {
      if (!statSync(directory).isDirectory()) {
        verdict = { ok: false, code: "storage_missing" };
      } else {
        const probePath = join(directory, `.readyz-${process.pid}`);
        try {
          writeFileSync(probePath, "readyz", { mode: 0o600 });
        } finally {
          unlinkSync(probePath);
        }
        verdict = { ok: true };
      }
    } catch (error) {
      // A vanished directory and an unwritable one are different operator actions (bootstrap the
      // volume vs fix permissions), so the verdict names which one it saw.
      const code = (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
        ? "storage_missing"
        : "storage_unwritable";
      verdict = { ok: false, code };
    }
    storageProbe = { at: instant, ...verdict };
    return verdict.ok ? { ok: true } : { ok: false, code: verdict.code ?? "storage_unwritable" };
  };

  /**
   * Whether the session capture the served routes need is present.
   *
   * The gate is the ChatGPT Web capture when this deployment serves a ChatGPT Web route, because that
   * is the browser transport the listener owns. The other providers' captures are reported beside it
   * (a composed-but-unauthenticated provider is a real, localised failure, not a reason to take the
   * whole listener out of rotation), and their own health surface is the one that proves them.
   */
  const assessAuth = (): ReadinessCheck => {
    const served = publicModelRouteIds(options.config);
    const chatGptServed = served.some(isChatGptWebModelSlug);
    const providers = defaultAuthHealthProviders(options.config);
    const present: string[] = [];
    const missing: string[] = [];
    for (const provider of providers) {
      const id = provider.importProvider.id;
      if (capturePresent(provider.storageStatePath)) present.push(id);
      else missing.push(id);
    }
    // Gate the browser transport this listener owns. A deployment that serves no ChatGPT Web route
    // either serves another Web family (then it must have at least one usable capture) or nothing at
    // all (a native Codex proxy, where a provider session is not a precondition).
    const required: string[] = chatGptServed ? [CHATGPT_WEB_PROVIDER] : [];
    const ok = required.length > 0
      ? required.every(id => present.includes(id))
      : (served.length === 0 || present.length > 0);
    return { ok, required, present, missing };
  };

  return {
    snapshot(): ReadinessReport {
      const instant = now();
      const acceptingTurns = options.isAcceptingTurns();
      const queue = options.turnQueue();
      const models = publicModelRouteIds(options.config).length;
      const checks: Record<string, ReadinessCheck> = {
        lifecycle: { ok: acceptingTurns, accepting_turns: acceptingTurns },
        storage: probeStorage(instant),
        auth: assessAuth(),
        turn_queue: {
          // A full queue refuses the next turn immediately, so the listener is not ready to accept
          // work even though it is alive.
          ok: queue.waiting < queue.maxWaiters,
          waiting: queue.waiting,
          max_waiters: queue.maxWaiters,
          active: queue.active,
        },
        catalogue: { ok: models > 0, models },
      };
      const ready = Object.values(checks).every(check => check.ok);
      const status = ready ? "ready" : "not_ready";
      return {
        status,
        httpStatus: ready ? 200 : 503,
        body: {
          status,
          service: "dsh-chatgpt-web",
          version: options.version,
          checked_at: new Date(instant).toISOString(),
          checks,
        },
      };
    },
  };
}
