import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";

import {
  DEEPSEEK_WEB_CLIENT_BUNDLE_ID,
  DEEPSEEK_WEB_CLIENT_BUNDLE_ID_GB,
  DEEPSEEK_WEB_CLIENT_PLATFORM,
  DEEPSEEK_WEB_CLIENT_VERSION,
  DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY,
  DEEPSEEK_WEB_DEVICE_MODEL,
  DEEPSEEK_WEB_LEIM_STORAGE_KEY,
  DEEPSEEK_WEB_POW_ALGORITHM,
  DEEPSEEK_WEB_POW_CHALLENGE_PATH,
  DEEPSEEK_WEB_POW_HEADER,
  DEEPSEEK_WEB_SESSION_CREATE_PATH,
  DEEPSEEK_WEB_TOKEN_STORAGE_KEY,
  createDeepSeekPageProofAnswerer,
  createDeepSeekPageRequestFacility,
  createDeepSeekProofOfWorkSolver,
  deepSeekAccessTokenFromStorage,
  deepSeekAuthorizationHeader,
  deepSeekBundleIdForRegion,
  deepSeekClientHeaders,
  deepSeekLeimFromStorage,
  deepSeekProofHeaderValue,
  readDeepSeekPageIdentity,
  unprovenDeepSeekProofOfWork,
  type DeepSeekPageIdentity,
  type DeepSeekPowAnswer,
  type DeepSeekProofChallenge,
  type DeepSeekProofOfWork,
} from "../src/adapters/deepseek-web";
import { isWebChatError } from "../src/web-chat/core";

/**
 * The DeepSeek proof of work and the page identity — **recorded shape, synthetic values**.
 *
 * The shapes here are measured from the signed-in capture (2026-10-24): the header name, the
 * base64-JSON payload keys, the worker's answer fields, the page's storage handles and the client
 * header family. Every value is synthetic: no captured token, device id, challenge, proof or header
 * from the operator's session appears in this file.
 */

/** A synthetic page token: the capture shows an opaque bearer, never a JWT. */
const TOKEN = "synthetic-page-token-0123456789abcdef0123456789abcdef";

/** One synthetic challenge in the recorded shape. */
function challenge(overrides: Partial<DeepSeekProofChallenge> = {}): DeepSeekProofChallenge {
  return {
    raw: {
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM,
      challenge: "a".repeat(64),
      salt: "b".repeat(20),
      signature: "c".repeat(64),
      difficulty: 144000,
      expire_at: 1_792_841_306_806,
      expire_after: 300000,
      target_path: "/api/v0/chat/completion",
    },
    challenge: "a".repeat(64),
    salt: "b".repeat(20),
    signature: "c".repeat(64),
    difficulty: 144000,
    expireAt: 1_792_841_306_806,
    expireAfter: 300000,
    ...overrides,
  };
}

/** The page's own answer shape (the worker's `pow-answer` payload). */
function answer(overrides: Partial<DeepSeekPowAnswer> = {}): DeepSeekPowAnswer {
  return {
    algorithm: DEEPSEEK_WEB_POW_ALGORITHM,
    challenge: "a".repeat(64),
    salt: "b".repeat(20),
    signature: "c".repeat(64),
    answer: 131708,
    ...overrides,
  };
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ category: string; providerCode?: string; message: string }> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(isWebChatError(thrown)).toBe(true);
  const error = thrown as { category: string; providerCode?: string; message: string };
  return { category: error.category, ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }), message: error.message };
}

describe("deepseek-web — the proof header is the measured blob, never a constant", () => {
  test("the value is base64 JSON with the recorded keys and order", () => {
    const value = deepSeekProofHeaderValue({
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM,
      challenge: "a".repeat(64),
      salt: "b".repeat(20),
      answer: 131708,
      signature: "c".repeat(64),
      targetPath: "/api/v0/chat/completion",
    });
    const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["algorithm", "challenge", "salt", "answer", "signature", "target_path"]);
    expect(decoded).toEqual({
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM,
      challenge: "a".repeat(64),
      salt: "b".repeat(20),
      answer: 131708,
      signature: "c".repeat(64),
      target_path: "/api/v0/chat/completion",
    });
    // A blob of JSON is what the capture carried (368 base64 chars for a 274-char payload).
    expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("an unsupported algorithm, a missing field or a non-integer answer is refused", () => {
    expect(() => deepSeekProofHeaderValue({
      algorithm: "OtherHash", challenge: "x", salt: "y", answer: 1, signature: "z", targetPath: "/p",
    })).toThrow(TypeError);
    expect(() => deepSeekProofHeaderValue({
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM, challenge: "", salt: "y", answer: 1, signature: "z", targetPath: "/p",
    })).toThrow(TypeError);
    expect(() => deepSeekProofHeaderValue({
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM, challenge: "x", salt: "y", answer: 1.5, signature: "z", targetPath: "/p",
    })).toThrow(TypeError);
    expect(() => deepSeekProofHeaderValue({
      algorithm: DEEPSEEK_WEB_POW_ALGORITHM, challenge: "x", salt: "y", answer: 1, signature: "z", targetPath: "",
    })).toThrow(TypeError);
  });

  test("a fresh proof is produced per call: the answer and target travel into it", async () => {
    let calls = 0;
    const solver = createDeepSeekProofOfWorkSolver(async ({ targetPath }) => {
      calls += 1;
      expect(targetPath).toBe("/api/v0/chat/completion");
      return answer({ answer: 1000 + calls });
    });
    const first = await solver({ targetPath: "/api/v0/chat/completion", challenge: challenge() });
    const second = await solver({ targetPath: "/api/v0/chat/completion", challenge: challenge() });
    expect(first.header).toBe(DEEPSEEK_WEB_POW_HEADER);
    expect(calls).toBe(2);
    const decode = (proof: DeepSeekProofOfWork): Record<string, unknown> =>
      JSON.parse(Buffer.from(proof.value, "base64").toString("utf8")) as Record<string, unknown>;
    expect(decode(first).answer).toBe(1001);
    expect(decode(second).answer).toBe(1002);
    expect(first.value).not.toBe(second.value);
  });

  test("the page answerer is driven through page.evaluate and returns the worker's answer", async () => {
    const seen: unknown[] = [];
    const page = {
      evaluate: async (fn: unknown, arg: unknown) => {
        seen.push(arg);
        return { answer: answer() };
      },
    } as unknown as Page;
    const solver = createDeepSeekProofOfWorkSolver(createDeepSeekPageProofAnswerer(page));
    const proof = await solver({ targetPath: "/api/v0/chat/completion", challenge: challenge() });
    expect(proof.header).toBe(DEEPSEEK_WEB_POW_HEADER);
    // The page receives the challenge and its `expireAt` the way the app's worker expects it.
    const sent = seen[0] as { challenge: { expireAt?: number; algorithm: string }; timeoutMs: number };
    expect(sent.challenge).toMatchObject({ algorithm: DEEPSEEK_WEB_POW_ALGORITHM, expireAt: 1_792_841_306_806 });
    expect(sent.timeoutMs).toBeGreaterThan(0);
  });

  test("a page that cannot run the solver is a typed refusal, never a fabricated header", async () => {
    const page = {
      evaluate: async () => ({ error: "the DeepSeek app's main bundle is not loaded in this page" }),
    } as unknown as Page;
    const solver = createDeepSeekProofOfWorkSolver(createDeepSeekPageProofAnswerer(page));
    const refused = await refusalOf(() => solver({ targetPath: "/api/v0/chat/completion", challenge: challenge() }));
    expect(refused.category).toBe("TRANSPORT_UNAVAILABLE");
    expect(refused.providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");
  });

  test("the explicit no-solver seam is typed and names the page", async () => {
    const refused = await refusalOf(() => unprovenDeepSeekProofOfWork()({
      targetPath: "/api/v0/chat/completion",
      challenge: challenge(),
    }));
    expect(refused.category).toBe("TRANSPORT_UNAVAILABLE");
    expect(refused.providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");
    expect(refused.message).toContain("chat.deepseek.com");
  });

  test("a solver error, an answer for another challenge and an unknown algorithm are refused", async () => {
    const exploding = createDeepSeekProofOfWorkSolver(async () => { throw new Error("worker died"); });
    expect((await refusalOf(() => exploding({ targetPath: "/p", challenge: challenge() }))).providerCode)
      .toBe("DEEPSEEK_POW_UNAVAILABLE");

    const mixedUp = createDeepSeekProofOfWorkSolver(async () => answer({ salt: "d".repeat(20) }));
    expect((await refusalOf(() => mixedUp({ targetPath: "/p", challenge: challenge() }))).providerCode)
      .toBe("DEEPSEEK_POW_UNAVAILABLE");

    const wrongAlgorithm = createDeepSeekProofOfWorkSolver(async () => answer({ algorithm: "OtherHash" }));
    expect((await refusalOf(() => wrongAlgorithm({ targetPath: "/p", challenge: challenge() }))).providerCode)
      .toBe("DEEPSEEK_POW_UNAVAILABLE");

    const incomplete = createDeepSeekProofOfWorkSolver(async () => answer());
    expect((await refusalOf(() => incomplete({
      targetPath: "/p",
      challenge: challenge({ expireAt: undefined, difficulty: undefined }),
    }))).providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");

    const unsupported = createDeepSeekProofOfWorkSolver(async () => answer());
    expect((await refusalOf(() => unsupported({
      targetPath: "/p",
      challenge: challenge({ raw: { algorithm: "OtherHash" } }),
    }))).providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");
  });

  test("a solver that never answers hits the bound instead of holding the turn", async () => {
    const solver = createDeepSeekProofOfWorkSolver(
      () => new Promise<DeepSeekPowAnswer>(() => undefined),
      { timeoutMs: 20 },
    );
    const refused = await refusalOf(() => solver({ targetPath: "/p", challenge: challenge() }));
    expect(refused.providerCode).toBe("DEEPSEEK_POW_UNAVAILABLE");
    expect(refused.message).toContain("did not answer");
  });
});

describe("deepseek-web — the authorization value is the page's own token", () => {
  test("the app's storage shape is read; anything else yields no token", () => {
    expect(deepSeekAccessTokenFromStorage(JSON.stringify({ value: TOKEN, __version: "0" }))).toBe(TOKEN);
    expect(deepSeekAccessTokenFromStorage(JSON.stringify(TOKEN))).toBe(TOKEN);
    expect(deepSeekAccessTokenFromStorage(JSON.stringify({ value: "" }))).toBeUndefined();
    expect(deepSeekAccessTokenFromStorage(JSON.stringify({ value: 7 }))).toBeUndefined();
    expect(deepSeekAccessTokenFromStorage("not json at all")).toBeUndefined();
    expect(deepSeekAccessTokenFromStorage(null)).toBeUndefined();
    expect(deepSeekAccessTokenFromStorage("   ")).toBeUndefined();
  });

  test("the leim cache is a JSON string in the app's storage handle", () => {
    expect(deepSeekLeimFromStorage(JSON.stringify("synthetic.leim"))).toBe("synthetic.leim");
    expect(deepSeekLeimFromStorage("synthetic.leim")).toBe("synthetic.leim");
    expect(deepSeekLeimFromStorage(JSON.stringify(""))).toBeUndefined();
    expect(deepSeekLeimFromStorage(JSON.stringify({ value: "x" }))).toBeUndefined();
    expect(deepSeekLeimFromStorage(null)).toBeUndefined();
    expect(deepSeekLeimFromStorage("   ")).toBeUndefined();
  });

  test("the bundle id follows the page's own region mapping", () => {
    expect(deepSeekBundleIdForRegion("ES")).toBe(DEEPSEEK_WEB_CLIENT_BUNDLE_ID);
    expect(deepSeekBundleIdForRegion(undefined)).toBe(DEEPSEEK_WEB_CLIENT_BUNDLE_ID);
    expect(deepSeekBundleIdForRegion("GB")).toBe(DEEPSEEK_WEB_CLIENT_BUNDLE_ID_GB);
  });

  test("the client header family is the measured one, and leim is omitted when the page has none", () => {
    const identity: DeepSeekPageIdentity = {
      authorization: `Bearer ${TOKEN}`,
      deviceId: "00000000-0000-4000-8000-000000000000",
      locale: "en_US",
      timezoneOffsetSeconds: 7200,
      bundleId: DEEPSEEK_WEB_CLIENT_BUNDLE_ID,
    };
    expect(deepSeekClientHeaders(identity)).toEqual({
      "x-client-bundle-id": DEEPSEEK_WEB_CLIENT_BUNDLE_ID,
      "x-client-platform": DEEPSEEK_WEB_CLIENT_PLATFORM,
      "x-client-version": DEEPSEEK_WEB_CLIENT_VERSION,
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "7200",
      "x-device-id": "00000000-0000-4000-8000-000000000000",
      "x-device-model": DEEPSEEK_WEB_DEVICE_MODEL,
    });
    expect(deepSeekClientHeaders({ ...identity, leim: "synthetic.leim" }))
      .toMatchObject({ "x-hif-leim": "synthetic.leim" });
    expect(deepSeekAuthorizationHeader(identity)).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(deepSeekAuthorizationHeader({ ...identity, authorization: undefined })).toEqual({});
  });

  test("the page is read at call time: a rotated token is used by the next request", async () => {
    let token = "first-token";
    const page = {
      evaluate: async () => ({
        region: "ES",
        locale: "en_US",
        timezoneOffsetSeconds: 7200,
        deviceId: "00000000-0000-4000-8000-000000000000",
        leimStorage: JSON.stringify("synthetic.leim"),
        tokenStorage: JSON.stringify({ value: token, __version: "0" }),
      }),
    } as unknown as Page;
    const first = await readDeepSeekPageIdentity(page);
    expect(first.authorization).toBe("Bearer first-token");
    token = "second-token";
    const second = await readDeepSeekPageIdentity(page);
    expect(second.authorization).toBe("Bearer second-token");
  });
});

describe("deepseek-web — the request facility attaches the page's identity and its own proof", () => {
  /** The identity the fake page hands back. */
  function identityRaw(token: string | undefined): Record<string, unknown> {
    return {
      region: "ES",
      locale: "en_US",
      timezoneOffsetSeconds: 7200,
      deviceId: "00000000-0000-4000-8000-000000000000",
      leimStorage: JSON.stringify("synthetic.leim"),
      ...(token === undefined ? {} : { tokenStorage: JSON.stringify({ value: token, __version: "0" }) }),
    };
  }

  /** A page double: identity reads, page-context JSON calls, and the stream's bindings. */
  function fakePage(options: { readonly token?: string }): {
    readonly page: Page;
    readonly jsonHeaders: () => Record<string, string>[];
    readonly streamHeaders: () => Record<string, string>[];
  } {
    const bindings = new Map<string, (source: unknown, payload: unknown) => Promise<unknown>>();
    const json: Record<string, string>[] = [];
    const stream: Record<string, string>[] = [];
    const page = {
      exposeBinding: async (name: string, fn: (source: unknown, payload: unknown) => Promise<unknown>) => {
        bindings.set(name, fn);
      },
      evaluate: async (_fn: unknown, arg: unknown) => {
        const input = (arg ?? {}) as Record<string, unknown>;
        if ("deviceKey" in input && "tokenKey" in input) return identityRaw(options.token);
        if ("challenge" in input && "timeoutMs" in input) {
          // The proof worker double: answer for the challenge it was handed.
          const asked = input["challenge"] as { algorithm: string; challenge: string; salt: string; signature: string };
          return { answer: {
            algorithm: asked.algorithm,
            challenge: asked.challenge,
            salt: asked.salt,
            signature: asked.signature,
            answer: 131708,
          } };
        }
        if ("chunkBinding" in input) {
          stream.push(input["headers"] as Record<string, string>);
          const open = bindings.get(input["openBinding"] as string);
          await open?.({}, { status: 200, contentType: "text/event-stream" });
          const chunk = bindings.get(input["chunkBinding"] as string);
          await chunk?.({}, 'event: close\ndata: {"click_behavior":"none"}\n\n');
          return { status: 200, contentType: "text/event-stream" };
        }
        if ("url" in input) {
          json.push(input["headers"] as Record<string, string>);
          const payload = input["url"] === "/api/v0/chat/create_pow_challenge"
            ? { code: 0, msg: "", data: { biz_code: 0, biz_data: { challenge: {
              algorithm: DEEPSEEK_WEB_POW_ALGORITHM, challenge: "a".repeat(64), salt: "b".repeat(20),
              signature: "c".repeat(64), difficulty: 4, expire_at: 1, expire_after: 1,
            } } } }
            : { code: 0, msg: "", data: { biz_code: 0, biz_data: { chat_session: { id: "session-fixture" } } } };
          return { status: 200, contentType: "application/json", text: JSON.stringify(payload), truncated: false };
        }
        throw new Error("unexpected page.evaluate call");
      },
    } as unknown as Page;
    return { page, jsonHeaders: () => json, streamHeaders: () => stream };
  }

  test("JSON calls carry the client/device family and the page bearer, but never a proof", async () => {
    const { page, jsonHeaders } = fakePage({ token: TOKEN });
    const facility = createDeepSeekPageRequestFacility(page);
    await facility.postJson(DEEPSEEK_WEB_POW_CHALLENGE_PATH, { target_path: "/api/v0/chat/completion" });
    await facility.postJson(DEEPSEEK_WEB_SESSION_CREATE_PATH, {});

    expect(jsonHeaders()).toHaveLength(2);
    for (const headers of jsonHeaders()) {
      expect(headers).toMatchObject({
        accept: "*/*",
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        "x-client-bundle-id": DEEPSEEK_WEB_CLIENT_BUNDLE_ID,
        "x-client-platform": DEEPSEEK_WEB_CLIENT_PLATFORM,
        "x-client-version": DEEPSEEK_WEB_CLIENT_VERSION,
        "x-client-locale": "en_US",
        "x-client-timezone-offset": "7200",
        "x-device-id": "00000000-0000-4000-8000-000000000000",
        "x-device-model": DEEPSEEK_WEB_DEVICE_MODEL,
        "x-hif-leim": "synthetic.leim",
      });
      expect(headers).not.toHaveProperty(DEEPSEEK_WEB_POW_HEADER);
    }
  });

  test("the completion stream carries the proof header, and only there", async () => {
    const { page, jsonHeaders, streamHeaders } = fakePage({ token: TOKEN });
    const facility = createDeepSeekPageRequestFacility(page);
    await facility.postJson(DEEPSEEK_WEB_SESSION_CREATE_PATH, {});
    const proof = await facility.requestProofOfWork({
      targetPath: "/api/v0/chat/completion",
      challenge: challenge(),
    });
    expect(proof.header).toBe(DEEPSEEK_WEB_POW_HEADER);
    await facility.postEventStream("/api/v0/chat/completion", {}, () => false, { proof });

    expect(jsonHeaders()[0]).not.toHaveProperty(DEEPSEEK_WEB_POW_HEADER);
    expect(streamHeaders()).toHaveLength(1);
    expect(streamHeaders()[0]).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      [DEEPSEEK_WEB_POW_HEADER]: proof.value,
    });
  });

  test("a page with no token sends no Authorization header, and the provider's refusal decides", async () => {
    const { page, jsonHeaders } = fakePage({ token: undefined });
    const facility = createDeepSeekPageRequestFacility(page);
    await facility.postJson(DEEPSEEK_WEB_SESSION_CREATE_PATH, {});
    expect(jsonHeaders()[0]).not.toHaveProperty("authorization");
    // The client/device family still comes from the page: it is not a credential.
    expect(jsonHeaders()[0]?.["x-device-id"]).toBe("00000000-0000-4000-8000-000000000000");
  });

  test("an explicit token reader overrides only the bearer", async () => {
    const { page, jsonHeaders } = fakePage({ token: undefined });
    const facility = createDeepSeekPageRequestFacility(page, { authorization: async () => "override-token" });
    await facility.postJson(DEEPSEEK_WEB_SESSION_CREATE_PATH, {});
    expect(jsonHeaders()[0]).toMatchObject({ authorization: "Bearer override-token" });
    expect(jsonHeaders()[0]?.["x-client-platform"]).toBe(DEEPSEEK_WEB_CLIENT_PLATFORM);
  });

  test("the storage keys and the header **names** are the measured literals", () => {
    // Named so a capture can be compared with the code without reading a secret.
    expect(DEEPSEEK_WEB_TOKEN_STORAGE_KEY).toBe("userToken");
    expect(DEEPSEEK_WEB_DEVICE_ID_STORAGE_KEY).toBe("deepseek-device-id:chat");
    expect(DEEPSEEK_WEB_LEIM_STORAGE_KEY).toBe("hif_leim_cached");
    expect(DEEPSEEK_WEB_POW_HEADER).toBe("x-ds-pow-response");
    expect(DEEPSEEK_WEB_POW_ALGORITHM).toBe("DeepSeekHashV1");
  });
});
