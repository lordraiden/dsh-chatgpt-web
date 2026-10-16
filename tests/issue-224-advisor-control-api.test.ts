import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { awaitChatGptSubmissionPhase, createChatGptTurnEventQueue } from "../src/adapters/chatgpt-web/text-turn";
import type { ChatGptWebProviderAdapter } from "../src/adapters/chatgpt-web/index";
import { defaultConfig } from "../src/config";
import { startServer, type RunningServer } from "../src/server";
import type { CodexParsedRequest } from "../src/types";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
  type SavedChatGptWebHome,
} from "./support/chatgpt-web-home";

/**
 * The Advisor control API (`/v1/control/advisor/*`) driven over HTTP against the REAL listener.
 *
 * These routes are the operator-facing half of the provider-neutral Advisor host: the plugin suites
 * that used to cover them are gone, so this suite holds the seam they exercised — the
 * control-token authority (never the API key), the catalogue, the tracked review lifecycle and the
 * read-only recovery — through the exact HTTP shapes the container exposes.
 */
const API_KEY = "issue-224-advisor-api-key-0123456789";
const CONTROL_TOKEN = "issue-224-advisor-control-token-0123456789";
const ACCOUNT = "issue-224-advisor-control-account";

const ENV_KEYS = ["DSH_CHATGPT_WEB_API_KEY"] as const;
let savedEnv: Map<string, string | undefined>;
let savedHome: SavedChatGptWebHome;
let home: string;

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  savedHome = captureChatGptWebHome();
  home = useTemporaryChatGptWebHome("issue-224-advisor-control-", { clearFreeHome: true });
});

const running: RunningServer[] = [];
afterEach(async () => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  while (running.length > 0) {
    const server = running.pop()!;
    await Promise.race([
      Promise.resolve(server.stop(true)).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  restoreChatGptWebHome(savedHome, home);
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...defaultConfig(),
    port: 0,
    host: "127.0.0.1",
    controlToken: CONTROL_TOKEN,
    // The provider facts the driver derives from: an acknowledged account makes the ChatGPT Web
    // provider authenticated, exactly as a completed sign-in does in the container.
    accountIdentityFingerprint: ACCOUNT,
    ...overrides,
  };
}

/** A well-formed review body; each test overrides only the field it is about. */
function reviewBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "advisor-session-1",
    reviewedTurnId: "advisor-turn-1",
    humanRequest: "the human request",
    dshResponse: "the dsh response",
    instructions: "review this",
    route: "chatgpt-web/luna",
    ...overrides,
  };
}

/** A provider turn that settles immediately with a fixed answer. */
function settlingAdapter(events: (queue: ReturnType<typeof createChatGptTurnEventQueue>) => void, answer = "the review"): ChatGptWebProviderAdapter {
  return {
    name: "chatgpt-web",
    async openTextTurn(_parsed: CodexParsedRequest) {
      const queue = createChatGptTurnEventQueue();
      queue.markReady();
      queue.markSubmission("accepted");
      queue.markSettled("fulfilled");
      events(queue);
      queue.push({ type: "text_delta", text: answer });
      queue.push({ type: "done" });
      queue.close();
      const finished = Promise.resolve();
      return {
        ready: queue.ready,
        submissionPhase: () => queue.submission(),
        awaitSubmission: () => awaitChatGptSubmissionPhase(queue, finished),
        events: queue,
        settled: () => queue.settled(),
        abort: async () => {},
        finished,
      };
    },
    async recoverRetainedAnswer() {
      return { text: "the retained answer", capturedAt: 1_700_000_000_000 };
    },
  } as unknown as ChatGptWebProviderAdapter;
}

/** A provider turn that stays in flight until the suite releases it, so a task can be observed live. */
function holdingAdapter(): { adapter: ChatGptWebProviderAdapter; release: () => void } {
  let release: () => void = () => {};
  const adapter = {
    name: "chatgpt-web",
    async openTextTurn(_parsed: CodexParsedRequest) {
      const queue = createChatGptTurnEventQueue();
      queue.markReady();
      queue.markSubmission("accepted");
      let close: () => void = () => {};
      const finished = new Promise<void>((resolve) => { close = resolve; });
      release = () => { queue.push({ type: "done" }); queue.close(); close(); };
      return {
        ready: queue.ready,
        submissionPhase: () => queue.submission(),
        awaitSubmission: () => awaitChatGptSubmissionPhase(queue, finished),
        events: queue,
        settled: () => queue.settled(),
        abort: async () => release(),
        finished,
      };
    },
    async recoverRetainedAnswer() {
      throw new Error("no retained answer");
    },
  } as unknown as ChatGptWebProviderAdapter;
  return { adapter, release: () => release() };
}

function serve(adapterFactory?: unknown, config = makeConfig()): RunningServer {
  const server = startServer(config as never, (adapterFactory !== undefined ? { adapterFactory } : {}) as never);
  running.push(server);
  return server;
}

const url = (server: RunningServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const token = (server: RunningServer, path: string) =>
  fetch(url(server, path), { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
const post = (server: RunningServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("advisor control API — the control token is the only authority", () => {
  test("the API key never opens the Advisor routes", async () => {
    process.env.DSH_CHATGPT_WEB_API_KEY = API_KEY;
    const adapter = settlingAdapter(() => {});
    const server = serve(() => adapter);

    // No credentials at all.
    expect((await fetch(url(server, "/v1/control/advisor/models"))).status).toBe(401);
    expect((await fetch(url(server, "/v1/control/advisor/reviews"))).status).toBe(401);
    expect((await fetch(url(server, "/v1/control/advisor/recover"))).status).toBe(401);

    // The public API key is a different authority and must not open the operator surface.
    const withApiKey = { authorization: `Bearer ${API_KEY}` };
    expect((await fetch(url(server, "/v1/control/advisor/models"), { headers: withApiKey })).status).toBe(401);
    expect((await fetch(url(server, "/v1/control/advisor/reviews"), { headers: withApiKey })).status).toBe(401);

    // The control token opens all of them.
    expect((await token(server, "/v1/control/advisor/models")).status).toBe(200);
    expect((await token(server, "/v1/control/advisor/reviews")).status).toBe(200);
    expect((await post(server, "/v1/control/advisor/recover", { sessionId: "s-1" })).status).toBe(200);
  });
});

describe("advisor control API — the eligible model catalogue", () => {
  test("only the authenticated provider contributes, and every choice names provider and model", async () => {
    const adapter = settlingAdapter(() => {});
    const server = serve(() => adapter);

    const response = await token(server, "/v1/control/advisor/models");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      providers: Array<{ providerId: string; authenticated: boolean; healthy: boolean; models: unknown[] }>;
      choices: Array<{ route: string; providerId: string; modelId: string; modelLabel: string; label: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]?.providerId).toBe("chatgpt-web");
    expect(body.providers[0]?.authenticated).toBe(true);
    expect(body.providers[0]?.healthy).toBe(true);
    expect(body.providers[0]?.models.length).toBeGreaterThan(0);

    // The default (Sol/Pro unsupported) deployment serves the Luna route; a choice is always
    // provider-qualified, never a bare provider-local id.
    expect(body.choices.some((choice) => choice.route === "chatgpt-web/luna")).toBe(true);
    const luna = body.choices.find((choice) => choice.route === "chatgpt-web/luna")!;
    expect(luna.providerId).toBe("chatgpt-web");
    expect(luna.modelId).toBe("luna");
    expect(luna.modelLabel).toContain("Luna");
    expect(luna.label).toBeTruthy();
    expect(body.choices.every((choice) => choice.route.startsWith("chatgpt-web/"))).toBe(true);
  });

  test("a deployment with no acknowledged account contributes no choice, and says why", async () => {
    // The temp home has no browser storage state, so the derived fingerprint is unknown.
    const server = serve(() => settlingAdapter(() => {}), makeConfig({ accountIdentityFingerprint: undefined }));

    const body = await (await token(server, "/v1/control/advisor/models")).json() as {
      ok: boolean;
      providers: Array<{ authenticated: boolean; healthy: boolean; unavailableReason?: string }>;
      choices: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.providers[0]?.authenticated).toBe(false);
    expect(body.providers[0]?.unavailableReason).toBe("auth_required");
    expect(body.choices).toEqual([]);
  });
});

describe("advisor control API — a review is a tracked background task", () => {
  test("acceptance returns 202 promptly and the task keeps running independently", async () => {
    const holding = holdingAdapter();
    const server = serve(() => holding.adapter);

    const accepted = await post(server, "/v1/control/advisor/reviews", reviewBody());
    expect(accepted.status).toBe(202);
    const body = await accepted.json() as {
      ok: boolean;
      duplicate: boolean;
      task: { reviewId: string; state: string; sessionId: string; provenance: { route: string; providerId: string; modelId: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.task.state).toBe("running");
    expect(typeof body.task.reviewId).toBe("string");
    expect(body.task.reviewId.length).toBeGreaterThan(0);
    expect(body.task.sessionId).toBe("advisor-session-1");
    expect(body.task.provenance.route).toBe("chatgpt-web/luna");
    expect(body.task.provenance.providerId).toBe("chatgpt-web");
    expect(body.task.provenance.modelId).toBe("luna");

    // The listener still serves control reads while the task is in flight.
    expect((await token(server, "/v1/control/advisor/models")).status).toBe(200);

    holding.release();
    // Let the accepted task settle before teardown.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a second start of the running review is an idempotent duplicate", async () => {
    const holding = holdingAdapter();
    const server = serve(() => holding.adapter);

    const first = await (await post(server, "/v1/control/advisor/reviews", reviewBody())).json() as { task: { reviewId: string } };
    const second = await post(server, "/v1/control/advisor/reviews", reviewBody());
    expect(second.status).toBe(200);
    const body = await second.json() as { ok: boolean; duplicate: boolean; task: { reviewId: string } };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);
    expect(body.task.reviewId).toBe(first.task.reviewId);

    holding.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a malformed body, a missing route and an unserved route are refused with their own codes", async () => {
    const server = serve(() => settlingAdapter(() => {}));

    const notAnObject = await fetch(url(server, "/v1/control/advisor/reviews"), {
      method: "POST",
      headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
      body: "[]",
    });
    expect(notAnObject.status).toBe(400);
    expect((await notAnObject.json() as { code?: string }).code).toBe("advisor_input_invalid");

    const noRoute = await post(server, "/v1/control/advisor/reviews", reviewBody({ route: undefined }));
    expect(noRoute.status).toBe(400);
    expect((await noRoute.json() as { code?: string }).code).toBe("advisor_input_invalid");

    const noSource = await post(server, "/v1/control/advisor/reviews", { sessionId: "s", route: "chatgpt-web/luna" });
    expect(noSource.status).toBe(400);
    expect((await noSource.json() as { code?: string }).code).toBe("advisor_input_invalid");

    // A well-formed body for a route this deployment does not serve is a typed refusal, never a
    // silent substitution onto another model.
    const unserved = await post(server, "/v1/control/advisor/reviews", reviewBody({
      reviewedTurnId: "advisor-turn-2",
      route: "chatgpt-web/light",
    }));
    expect(unserved.status).toBe(409);
    const refusal = await unserved.json() as { ok?: boolean; code?: string; message?: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("advisor_model_unavailable");
    expect(refusal.message).toContain("chatgpt-web/light");
  });
});

describe("advisor control API — status, listing and read-only recovery", () => {
  test("a completed review is readable by id and listed for its session", async () => {
    const server = serve(() => settlingAdapter(() => {}, "the finished review"));

    const accepted = await (await post(server, "/v1/control/advisor/reviews", reviewBody())).json() as { task: { reviewId: string } };
    const reviewId = accepted.task.reviewId;

    // The list is the persistent activity view: bounded, session-filtered, newest first.
    const listed = await (await token(server, "/v1/control/advisor/reviews?sessionId=advisor-session-1&limit=5")).json() as {
      ok: boolean;
      reviews: Array<{ reviewId: string; state: string; sessionId: string; text?: string }>;
    };
    expect(listed.ok).toBe(true);
    expect(listed.reviews).toHaveLength(1);
    expect(listed.reviews[0]?.reviewId).toBe(reviewId);
    expect(listed.reviews[0]?.state).toBe("completed");
    expect(listed.reviews[0]?.text).toBe("the finished review");

    const one = await (await token(server, `/v1/control/advisor/reviews/${reviewId}`)).json() as {
      ok: boolean;
      task: { reviewId: string; state: string; text?: string };
    };
    expect(one.ok).toBe(true);
    expect(one.task.reviewId).toBe(reviewId);
    expect(one.task.state).toBe("completed");
    expect(one.task.text).toBe("the finished review");

    // An unknown or blank id is a typed 404/400, never an unrelated task.
    const unknown = await token(server, "/v1/control/advisor/reviews/does-not-exist");
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { code?: string }).code).toBe("advisor_task_unavailable");
    const blank = await token(server, "/v1/control/advisor/reviews/%20");
    expect(blank.status).toBe(400);
  });

  test("recovery reads the retained answer, and a provider refusal is a typed unavailable", async () => {
    const server = serve(() => settlingAdapter(() => {}));
    const recovered = await post(server, "/v1/control/advisor/recover", {
      sessionId: "advisor-session-1",
      route: "chatgpt-web/luna",
    });
    expect(recovered.status).toBe(200);
    const body = await recovered.json() as {
      ok: boolean; text?: string; capturedAt?: number; route?: string; providerId?: string; modelId?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.text).toBe("the retained answer");
    expect(body.capturedAt).toBe(1_700_000_000_000);
    expect(body.route).toBe("chatgpt-web/luna");
    expect(body.providerId).toBe("chatgpt-web");
    expect(body.modelId).toBe("luna");

    const refusing = {
      name: "chatgpt-web",
      async openTextTurn() { throw new Error("unused"); },
      async recoverRetainedAnswer() { throw new Error("The retained ChatGPT conversation is no longer available."); },
    } as unknown as ChatGptWebProviderAdapter;
    const failing = serve(() => refusing);
    const refused = await post(failing, "/v1/control/advisor/recover", { sessionId: "advisor-session-1", route: "chatgpt-web/luna" });
    expect(refused.status).toBe(502);
    const refusal = await refused.json() as { ok: boolean; code?: string; message?: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("advisor_recovery_unavailable");

    const invalid = await post(server, "/v1/control/advisor/recover", {});
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { code?: string }).code).toBe("advisor_input_invalid");
  });
});
