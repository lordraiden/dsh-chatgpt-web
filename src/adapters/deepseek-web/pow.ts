/**
 * The DeepSeek Web proof of work — **performed by the page's own solver**, never reimplemented here.
 *
 * ## What the signed-in capture measured
 *
 * One turn issued two completions and each carried its own `x-ds-pow-response` header, so a proof is
 * **per completion** and a recorded one can never be replayed. The header value is
 * `base64(JSON)` of exactly:
 *
 * ```json
 * { "algorithm": "DeepSeekHashV1", "challenge": "…", "salt": "…",
 *   "answer": 131708, "signature": "…", "target_path": "/api/v0/chat/completion" }
 * ```
 *
 * and the challenge it answers is `POST /api/v0/chat/create_pow_challenge` →
 * `data.biz_data.challenge` (`{algorithm, challenge, salt, signature, difficulty, expire_at,
 * expire_after, target_path}`). The page solves it in a **Web Worker** it starts from its own static
 * assets: the worker receives `{type:"pow-challenge", challenge:{…, expireAt}}` and answers
 * `{type:"pow-answer", answer:{algorithm, challenge, salt, answer, signature}}`, where `answer` is
 * the number returned by the SHA3 WASM module's `wasm_solve(challenge, prefix, difficulty)` with
 * `prefix = ${salt}_${expireAt}_`.
 *
 * ## Why this module drives the page's worker instead of hashing anything
 *
 * The challenge contract is the vendor's: the algorithm id, the prefix, the difficulty comparison and
 * the WASM ABI all live in assets the page loads. Reimplementing them would be a guess that only
 * *looks* like it works against one capture, and a fabricated header is worse than a failed turn.
 * So this module:
 *
 * 1. locates the page's own worker asset **from the page's live bundle at call time** (the bundle
 *    names its worker chunk and the chunk hash; nothing is hard-coded);
 * 2. starts that worker, posts the challenge, and takes the worker's own answer;
 * 3. base64-encodes that answer together with `target_path` — the only composition this module does.
 *
 * If the app is not loaded, cannot be fetched, does not name its worker, or the worker refuses, the
 * result is a typed `TRANSPORT_UNAVAILABLE` / `DEEPSEEK_POW_UNAVAILABLE` failure with nothing sent —
 * never a fabricated clearance and never a retry.
 */
import type { Page } from "playwright-core";

import { isWebChatError, webChatError } from "../../web-chat/core";
import {
  DEEPSEEK_WEB_PROVIDER_ID,
  type DeepSeekProofChallenge,
} from "./provider";

/** The recorded request header the solved proof travels in (measured, one signed-in completion). */
export const DEEPSEEK_WEB_POW_HEADER = "x-ds-pow-response";

/** The single algorithm the page's solver accepts (`DeepSeekHashV1`). */
export const DEEPSEEK_WEB_POW_ALGORITHM = "DeepSeekHashV1";

/**
 * How long one proof may take.
 *
 * The recorded challenge allowed 300 s (`expire_after`), and the page's difficulty is a real search;
 * this bound is deliberately generous but finite, so a worker that never answers fails the turn
 * instead of holding the page forever.
 */
export const DEEPSEEK_WEB_POW_TIMEOUT_MS = 120_000;

/** One solved proof: the header it travels in, and its value. */
export interface DeepSeekProofOfWork {
  /** Always {@link DEEPSEEK_WEB_POW_HEADER}; carried with the value so one seam owns both. */
  readonly header: string;
  /** The base64 JSON blob the provider accepts. Never logged. */
  readonly value: string;
}

/** What a solver is given. */
export interface DeepSeekProofOfWorkRequest {
  /** The route the proof is for — the recorded `target_path` is the completion path. */
  readonly targetPath: string;
  /** The provider's challenge, with its raw object so a field this build did not name is available. */
  readonly challenge: DeepSeekProofChallenge;
}

/** The one seam the proof-of-work step is isolated behind. */
export type DeepSeekProofOfWorkSolver = (request: DeepSeekProofOfWorkRequest) => Promise<DeepSeekProofOfWork>;

/**
 * The page's own answer, as its worker returned it.
 *
 * `answer` is the number the WASM solver found; the other fields are the challenge echoed back, which
 * the header payload carries verbatim.
 */
export interface DeepSeekPowAnswer {
  readonly algorithm: string;
  readonly challenge: string;
  readonly salt: string;
  readonly answer: number;
  readonly signature: string;
}

/** Computes the answer for one challenge. Production is the page's worker; tests inject a fake. */
export type DeepSeekProofAnswerer = (input: {
  readonly targetPath: string;
  readonly challenge: DeepSeekProofChallenge;
}) => Promise<DeepSeekPowAnswer>;

/** Options for {@link createDeepSeekProofOfWorkSolver}. */
export interface DeepSeekProofOfWorkSolverOptions {
  /** The solver's own ceiling. Defaults to {@link DEEPSEEK_WEB_POW_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The typed refusal every "the page could not solve it" path lands on. */
function powUnavailable(detail: string, cause?: unknown): Error {
  return webChatError(
    "TRANSPORT_UNAVAILABLE",
    "DeepSeek requires a per-completion proof of work, and this page could not run the app's own "
    + `solver (${detail}), so no completion was sent. The proof is never fabricated and never replayed; `
    + "open https://chat.deepseek.com in the session browser so the app is loaded, then retry the turn.",
    {
      providerId: DEEPSEEK_WEB_PROVIDER_ID,
      providerCode: "DEEPSEEK_POW_UNAVAILABLE",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * The header payload, in the recorded key order.
 *
 * The shape is measured; every value comes from the page's answer or from the challenge. This is the
 * only place a proof value is composed, and it is pure so a test can assert the shape without a
 * browser or a real proof.
 */
export function deepSeekProofHeaderValue(input: {
  readonly algorithm: string;
  readonly challenge: string;
  readonly salt: string;
  readonly answer: number;
  readonly signature: string;
  readonly targetPath: string;
}): string {
  if (input.algorithm !== DEEPSEEK_WEB_POW_ALGORITHM) {
    throw new TypeError(`Unsupported DeepSeek proof algorithm ${JSON.stringify(input.algorithm)}`);
  }
  if (input.challenge.length === 0 || input.salt.length === 0 || input.signature.length === 0) {
    throw new TypeError("A DeepSeek proof requires the challenge, its salt and its signature");
  }
  if (!Number.isSafeInteger(input.answer) || input.answer < 0) {
    throw new TypeError("A DeepSeek proof answer must be a non-negative integer");
  }
  if (input.targetPath.length === 0) throw new TypeError("A DeepSeek proof requires its target path");
  return Buffer.from(JSON.stringify({
    algorithm: input.algorithm,
    challenge: input.challenge,
    salt: input.salt,
    answer: input.answer,
    signature: input.signature,
    target_path: input.targetPath,
  }), "utf8").toString("base64");
}

/** Race a promise against a bound without leaving a timer behind. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(powUnavailable(`${what} did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Whether a value is the raw answer the page's worker answers with. */
function isPowAnswer(value: unknown): value is DeepSeekPowAnswer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["algorithm"] === "string"
    && typeof record["challenge"] === "string"
    && typeof record["salt"] === "string"
    && typeof record["signature"] === "string"
    && typeof record["answer"] === "number"
    && Number.isSafeInteger(record["answer"])
    && record["answer"] >= 0;
}

/**
 * Build the solver around one answerer.
 *
 * The challenge is validated before the answerer runs (algorithm, challenge/salt/signature presence),
 * and its answer is validated afterwards. Nothing is coerced: an answer that is not the worker's own
 * shape is a typed refusal, because attaching a half-understood value is how a fabricated header
 * would start.
 */
export function createDeepSeekProofOfWorkSolver(
  answer: DeepSeekProofAnswerer,
  options: DeepSeekProofOfWorkSolverOptions = {},
): DeepSeekProofOfWorkSolver {
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_WEB_POW_TIMEOUT_MS;
  return async (request: DeepSeekProofOfWorkRequest): Promise<DeepSeekProofOfWork> => {
    const rawChallenge = request.challenge.raw;
    const algorithm = typeof rawChallenge["algorithm"] === "string"
      ? rawChallenge["algorithm"]
      : DEEPSEEK_WEB_POW_ALGORITHM;
    if (algorithm !== DEEPSEEK_WEB_POW_ALGORITHM) {
      throw powUnavailable(`the challenge names algorithm ${JSON.stringify(algorithm)}`);
    }
    const challenge = request.challenge.challenge;
    const salt = request.challenge.salt;
    const signature = request.challenge.signature;
    if (challenge === undefined || salt === undefined || signature === undefined) {
      throw powUnavailable("the challenge is missing its challenge/salt/signature fields");
    }
    // The page's prefix is `${salt}_${expireAt}_` and its search uses `difficulty`; a challenge
    // without them cannot be solved correctly, so it is refused instead of producing a wrong proof.
    if (request.challenge.expireAt === undefined || request.challenge.difficulty === undefined) {
      throw powUnavailable("the challenge is missing its expire_at/difficulty fields");
    }

    let solved: unknown;
    try {
      solved = await withTimeout(answer({ targetPath: request.targetPath, challenge: request.challenge }), timeoutMs, "the proof solver");
    } catch (error) {
      if (isWebChatError(error)) throw error;
      throw powUnavailable("the page's solver failed", error);
    }
    if (!isPowAnswer(solved)) throw powUnavailable("the page's solver answered no usable proof");
    // The answer must be for *this* challenge: echoing a different one is a mixed-up proof, not a
    // solution, and sending it would spend the challenge for nothing.
    if (solved.challenge !== challenge || solved.salt !== salt || solved.signature !== signature) {
      throw powUnavailable("the page's solver answered for a different challenge");
    }
    if (solved.algorithm !== algorithm) throw powUnavailable("the page's solver answered a different algorithm");

    return {
      header: DEEPSEEK_WEB_POW_HEADER,
      value: deepSeekProofHeaderValue({
        algorithm,
        challenge,
        salt,
        answer: solved.answer,
        signature,
        targetPath: request.targetPath,
      }),
    };
  };
}

/**
 * The explicit "no solver wired" seam.
 *
 * It is never the production default any more (the page's own solver is), but it stays exported so a
 * caller that deliberately composes a facility without a page keeps a typed refusal instead of an
 * accident. It fabricates nothing.
 */
export function unprovenDeepSeekProofOfWork(): DeepSeekProofOfWorkSolver {
  return async () => {
    throw powUnavailable("no page-backed solver was wired into this facility");
  };
}

/** The shape the page hands back: the worker's answer, or a serializable failure. */
interface DeepSeekPageSolveOutcome {
  readonly answer?: unknown;
  readonly error?: string;
}

/**
 * Run the page's solver, inside the page's own browsing context.
 *
 * Deliberately self-contained (Playwright serializes this function's source): it reads the app's
 * script tag, fetches the app's own bundle, finds the worker chunk id and hash in it, starts that
 * worker exactly as the app does, posts the recorded `pow-challenge` message and awaits
 * `pow-answer`. It carries no hard-coded hash, no proof and no credential.
 */
async function solveDeepSeekProofInPage(input: {
  readonly challenge: {
    readonly algorithm: string;
    readonly challenge: string;
    readonly salt: string;
    readonly difficulty?: number;
    readonly signature: string;
    readonly expireAt?: number;
  };
  readonly timeoutMs: number;
}): Promise<DeepSeekPageSolveOutcome> {
  const scope = window as unknown as { __dshDeepSeekPowWorker?: string };
  try {
    let workerUrl = scope.__dshDeepSeekPowWorker;
    if (workerUrl === undefined || workerUrl.length === 0) {
      const mainUrls = Array.from(document.scripts)
        .map(script => script.src)
        .filter(src => /\/static\/main\.[0-9a-f]+\.js$/.test(src));
      if (mainUrls.length === 0) {
        return { error: "the DeepSeek app's main bundle is not loaded in this page" };
      }
      const mainUrl = mainUrls[0]!;
      const bundle = await fetch(mainUrl, { credentials: "same-origin" });
      if (!bundle.ok) return { error: `the DeepSeek app bundle answered HTTP ${bundle.status}` };
      const text = await bundle.text();
      const chunk = /new Worker\(new URL\([^)]*?\.u\((\d+)\)/.exec(text);
      if (chunk === null) return { error: "the DeepSeek app bundle does not name its proof worker" };
      const chunkId = chunk[1]!;
      const hash = new RegExp(`"${chunkId}":"([0-9a-f]+)"`).exec(text);
      if (hash === null) return { error: "the DeepSeek app bundle does not carry its worker hash" };
      const publicPath = mainUrl.replace(/static\/main\.[0-9a-f]+\.js.*$/, "");
      workerUrl = `${publicPath}static/${chunkId}.${hash[1]}.js`;
      scope.__dshDeepSeekPowWorker = workerUrl;
    }

    const answer = await new Promise<unknown>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(workerUrl!, { type: undefined });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (outcome: { value?: unknown; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        if (outcome.error !== undefined) reject(new Error(outcome.error));
        else resolve(outcome.value);
      };
      const timer = setTimeout(() => finish({ error: `the proof worker did not answer within ${input.timeoutMs} ms` }), input.timeoutMs);
      worker.onerror = () => finish({ error: "the proof worker failed to start" });
      worker.onmessage = (message: MessageEvent) => {
        const data = message.data as { type?: unknown; answer?: unknown; error?: unknown } | null;
        if (data === null || typeof data !== "object") return;
        if (data.type === "pow-answer") finish({ value: data.answer });
        else if (data.type === "pow-error") {
          finish({ error: `the proof worker refused: ${String(data.error).slice(0, 200)}` });
        }
      };
      worker.postMessage({
        type: "pow-challenge",
        challenge: {
          algorithm: input.challenge.algorithm,
          challenge: input.challenge.challenge,
          salt: input.challenge.salt,
          difficulty: input.challenge.difficulty,
          signature: input.challenge.signature,
          expireAt: input.challenge.expireAt,
        },
      });
    });
    return { answer };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Options for {@link createDeepSeekPageProofAnswerer}. */
export interface DeepSeekPageProofAnswererOptions {
  /** The solver's ceiling inside the page. Defaults to {@link DEEPSEEK_WEB_POW_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The production answerer: the page's own worker, driven from inside the page.
 *
 * The page returns either the worker's answer or a serializable failure; a failure becomes a typed
 * refusal in {@link createDeepSeekProofOfWorkSolver}. This function never invents an answer and never
 * caches one — each call starts a fresh worker against a fresh challenge.
 */
export function createDeepSeekPageProofAnswerer(
  page: Page,
  options: DeepSeekPageProofAnswererOptions = {},
): DeepSeekProofAnswerer {
  const timeoutMs = options.timeoutMs ?? DEEPSEEK_WEB_POW_TIMEOUT_MS;
  return async ({ targetPath, challenge }) => {
    const outcome = await page.evaluate(solveDeepSeekProofInPage, {
      challenge: {
        algorithm: typeof challenge.raw["algorithm"] === "string"
          ? challenge.raw["algorithm"] as string
          : DEEPSEEK_WEB_POW_ALGORITHM,
        challenge: challenge.challenge ?? "",
        salt: challenge.salt ?? "",
        ...(challenge.difficulty === undefined ? {} : { difficulty: challenge.difficulty }),
        signature: challenge.signature ?? "",
        ...(challenge.expireAt === undefined ? {} : { expireAt: challenge.expireAt }),
      },
      timeoutMs,
    });
    if (outcome.error !== undefined) {
      throw powUnavailable(`${outcome.error} (for ${targetPath})`);
    }
    return outcome.answer as DeepSeekPowAnswer;
  };
}
