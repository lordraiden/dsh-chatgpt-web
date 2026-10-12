import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #225 — inspect, edit, discard, or inject a finished Advisor result.
 *
 * The result is delivered to the DSH session it belongs to through the platform's public
 * session-addressed prompt admission (`ctx.remote.session.prompt`) — never by appending to a Session
 * log, fabricating an event, or writing into whatever composer happens to be open.
 *
 * client.js is a plain-JS browser module; this harness captures its module descriptor, runs the
 * factory against a minimal react stub, and exercises the units exported on `mod.__test`.
 */
let mod: any;

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

/** A stub Client Remote service: records every prompt admission. */
function stubRemote(behaviour?: (request: any) => any) {
  const calls: any[] = [];
  const remote = {
    session: {
      async prompt(request: any) {
        calls.push(request);
        if (behaviour) return behaviour(request);
        return { ok: true, value: { accepted: true } };
      },
    },
  };
  return { remote, calls };
}

const RESULT = {
  reviewId: "review-1",
  sessionId: "session-origin",
  turn: 4,
  original: "**Verdict: request changes.**\n\n- fix X",
  route: "chatgpt-web/light",
  providerLabel: "ChatGPT Web",
  modelLabel: "Light",
};

function openResult(store: any, storage: any, overrides: Record<string, unknown> = {}) {
  store.openResult({ ...RESULT, ...overrides }, storage);
}

beforeAll(async () => {
  const captured: { descriptor: any } = { descriptor: null };
  (globalThis as any).window = {
    __ModuleLoader__: {
      load(d: any) {
        captured.descriptor = d;
      },
    },
    localStorage: makeStorage(),
  };
  // @ts-expect-error plain-JS browser module without type declarations
  await import("../client.js");
  expect(captured.descriptor).not.toBeNull();
  expect(captured.descriptor.id).toBe("@lordraiden/dsh-chatgpt-web");

  const requireShim = (id: string) => {
    if (id === "react") {
      return {
        createElement: (...args: unknown[]) => args,
        useState: (init: unknown) => [init, () => {}],
        useEffect: () => {},
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: () => unknown) => fn,
      };
    }
    throw new Error(`unexpected require: ${id}`);
  };
  mod = captured.descriptor.factory(requireShim);
});

describe("issue #225 — the injected message", () => {
  test("delivers the edited review in the provider-neutral wrapper to the recorded session", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("  edited review text  ", storage);
    const { remote, calls } = stubRemote();

    await store.injectResult(remote, storage);

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("session-origin");
    expect(calls[0].mode).toBe("queue");
    expect(calls[0].content).toEqual([{ type: "text", text: mod.__test.buildInjectedPrompt("edited review text") }]);
    expect(typeof calls[0].requestId).toBe("string");
    expect(calls[0].requestId.length).toBeGreaterThan(0);
    if (calls[0].clientTimeZone !== undefined) {
      expect(typeof calls[0].clientTimeZone).toBe("string");
      expect(calls[0].clientTimeZone.length).toBeGreaterThan(0);
    }
    expect(store.getSnapshot().result.injectState).toBe("injected");
  });

  test("a result from another session injects into THAT session, never the active one", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    // The editor can be opened from the cross-session activity list.
    openResult(store, storage, { sessionId: "session-other", turn: undefined });
    const { remote, calls } = stubRemote();
    await store.injectResult(remote, storage);
    expect(calls[0].sessionId).toBe("session-other");
  });

  test("a result with no recorded session is refused visibly and nothing is delivered", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage, { sessionId: "" });
    const { remote, calls } = stubRemote();
    await store.injectResult(remote, storage);
    expect(calls).toHaveLength(0);
    const result = store.getSnapshot().result;
    expect(result.injectState).toBe("failed");
    expect(result.failureCode).toBe("advisor_inject_unavailable");
  });

  test("an unavailable session remote is a visible failure, and the draft survives", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("keep me", storage);
    await store.injectResult(undefined, storage);
    expect(store.getSnapshot().result.injectState).toBe("failed");
    expect(store.getSnapshot().result.draft).toBe("keep me");
    expect(mod.__test.loadAdvisorDraft(storage, "review-1").draft).toBe("keep me");
  });

  test("an empty draft is refused before it reaches the platform", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("   ", storage);
    const { remote, calls } = stubRemote();
    await store.injectResult(remote, storage);
    expect(calls).toHaveLength(0);
    expect(store.getSnapshot().result.injectState).toBe("failed");
  });
});

describe("issue #225 — delivery outcomes", () => {
  test("a confirmed refusal is a failed delivery and can be retried with the same identity", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    let attempt = 0;
    const { remote, calls } = stubRemote(() => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, error: { code: "session/not-found", message: 'session "session-origin" not found' } };
      }
      return { ok: true, value: { accepted: true } };
    });

    await store.injectResult(remote, storage);
    const failed = store.getSnapshot().result;
    expect(failed.injectState).toBe("failed");
    expect(failed.failureCode).toBe("session/not-found");
    expect(failed.failureMessage).toContain("not found");
    expect(mod.__test.loadAdvisorDraft(storage, "review-1").injectState).toBe("failed");

    await store.injectResult(remote, storage);
    expect(store.getSnapshot().result.injectState).toBe("injected");
    expect(calls).toHaveLength(2);
    // Retrying reuses the delivery identity, so the Host can de-duplicate it.
    expect(calls[1].requestId).toBe(calls[0].requestId);
  });

  test("an ambiguous carrier failure is never retried automatically", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote, calls } = stubRemote(() => ({ ok: false, error: { code: "gateway/internal", message: "carrier lost" } }));

    await store.injectResult(remote, storage);

    expect(store.getSnapshot().result.injectState).toBe("unknown");
    expect(store.getSnapshot().result.failureCode).toBe("gateway/internal");
    // Exactly one delivery attempt: the plugin never resubmits an ambiguous acceptance.
    expect(calls).toHaveLength(1);
    expect(mod.__test.loadAdvisorDraft(storage, "review-1").injectState).toBe("unknown");
  });

  test("a manual retry after an ambiguous outcome reuses the same delivery identity", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote, calls } = stubRemote(() => ({ ok: false, error: { code: "gateway/internal", message: "carrier lost" } }));
    await store.injectResult(remote, storage);
    // The user explicitly asks again (the editor labels this "Deliver again").
    await store.injectResult(remote, storage);
    expect(calls).toHaveLength(2);
    expect(calls[1].requestId).toBe(calls[0].requestId);
    expect(store.getSnapshot().result.injectState).toBe("unknown");
  });

  test("a rejected call is a failure the user can retry", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote, calls } = stubRemote(() => {
      throw new Error("remote not mounted");
    });
    await store.injectResult(remote, storage);
    expect(calls).toHaveLength(1);
    expect(store.getSnapshot().result.injectState).toBe("failed");
    expect(store.getSnapshot().result.failureMessage).toBe("remote not mounted");
  });

  test("a cancelled delivery stays ambiguous", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote } = stubRemote(() => ({ ok: false, error: { code: "gateway/cancelled", message: "aborted" } }));
    await store.injectResult(remote, storage);
    expect(store.getSnapshot().result.injectState).toBe("unknown");
  });

  test("the failure classifier keeps domain refusals retryable and carrier failures ambiguous", () => {
    expect(mod.__test.classifyAdvisorInjectionFailure({ code: "gateway/bad-request", message: "x" }).status).toBe("failed");
    expect(mod.__test.classifyAdvisorInjectionFailure({ code: "session/writer-held", message: "x" }).status).toBe("failed");
    expect(mod.__test.classifyAdvisorInjectionFailure({ code: "gateway/internal", message: "x" }).status).toBe("unknown");
    expect(mod.__test.classifyAdvisorInjectionFailure({ code: "gateway/cancelled", message: "x" }).status).toBe("unknown");
    expect(mod.__test.classifyAdvisorInjectionFailure(new Error("boom")).status).toBe("failed");
  });
});

describe("issue #225 — duplicate activation and idempotence", () => {
  test("a second injection while one is in flight is refused and only one message is delivered", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    let release: (value: any) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const { remote, calls } = stubRemote(() => gate);

    const first = store.injectResult(remote, storage);
    const second = store.injectResult(remote, storage);
    store.injectResult(remote, storage);
    release({ ok: true, value: { accepted: true } });
    await first;
    await second;

    expect(calls).toHaveLength(1);
    expect(store.getSnapshot().result.injectState).toBe("injected");
  });

  test("an injected result is never delivered again by another activation", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote, calls } = stubRemote();
    await store.injectResult(remote, storage);
    await store.injectResult(remote, storage);
    expect(calls).toHaveLength(1);
    expect(store.getSnapshot().result.injectState).toBe("injected");
  });

  test("the delivery identity is stable across a reload of the editor", () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const record = mod.__test.loadAdvisorDraft(storage, "review-1");
    expect(typeof record.requestId).toBe("undefined");
    store.injectResult(stubRemote(() => new Promise(() => {})).remote, storage);
    const first = mod.__test.loadAdvisorDraft(storage, "review-1").requestId;
    expect(typeof first).toBe("string");
    // Reopening the editor (a fresh page, same storage) keeps the same delivery identity.
    const reopened = mod.__test.createAdvisorStore();
    openResult(reopened, storage);
    expect(mod.__test.loadAdvisorDraft(storage, "review-1").requestId).toBe(first);
  });

  test("nothing is delivered merely by opening, editing or re-reading the result", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    const { remote, calls } = stubRemote();
    openResult(store, storage);
    store.setDraft("edited", storage);
    store.requestDiscard();
    store.cancelDiscard();
    store.closeDialog();
    openResult(store, storage);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(mod.__test.loadAdvisorDraft(storage, "review-1").injectState).toBe("ready");
  });
});

describe("issue #225 — inspect and edit", () => {
  test("the original response is immutable and the draft is separate", () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("my own wording", storage);
    const record = mod.__test.loadAdvisorDraft(storage, "review-1");
    expect(record.original).toBe(RESULT.original);
    expect(record.draft).toBe("my own wording");
    expect(store.getSnapshot().result.original).toBe(RESULT.original);
    expect(store.getSnapshot().result.draft).toBe("my own wording");
  });

  test("the draft survives closing and reopening the editor", () => {
    const storage = makeStorage();
    const first = mod.__test.createAdvisorStore();
    openResult(first, storage);
    first.setDraft("survives", storage);
    first.closeDialog();
    const second = mod.__test.createAdvisorStore();
    openResult(second, storage);
    expect(second.getSnapshot().result.draft).toBe("survives");
    expect(second.getSnapshot().result.original).toBe(RESULT.original);
  });

  test("the editor carries the provider/model provenance and the originating session", () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const result = store.getSnapshot().result;
    expect(result.route).toBe("chatgpt-web/light");
    expect(result.providerLabel).toBe("ChatGPT Web");
    expect(result.modelLabel).toBe("Light");
    expect(result.sessionId).toBe("session-origin");
    expect(result.turn).toBe(4);
    expect(store.getSnapshot().view).toBe("result");
  });

  test("a persisted draft is bounded like the activity list", () => {
    const storage = makeStorage();
    for (let index = 0; index < 60; index += 1) {
      mod.__test.ensureAdvisorDraft(storage, { reviewId: `r-${index}`, sessionId: "s", original: `o-${index}` });
    }
    const drafts = mod.__test.loadAdvisorDrafts(storage);
    expect(drafts).toHaveLength(50);
    expect(drafts[0].reviewId).toBe("r-59");
    expect(mod.__test.parseAdvisorDrafts("not json")).toEqual([]);
  });
});

describe("issue #225 — discard", () => {
  test("a dirty draft asks for confirmation, then discards only Advisor-owned state", async () => {
    const storage = makeStorage();
    mod.__test.recordAdvisorResult(storage, {
      turn: 4,
      reviewId: "review-1",
      sessionId: "session-origin",
      text: RESULT.original,
    });
    mod.__test.recordAdvisorResult(storage, { turn: 6, reviewId: "other", sessionId: "session-origin", text: "another review" });
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("edited", storage);

    store.requestDiscard();
    expect(store.getSnapshot().discard.confirming).toBe(true);
    expect(mod.__test.loadAdvisorDraft(storage, "review-1")).not.toBeNull();

    const { remote, calls } = stubRemote();
    store.discardResult(storage);
    expect(store.getSnapshot().result).toBeNull();
    expect(store.getSnapshot().view).toBe("activity");
    expect(mod.__test.loadAdvisorDraft(storage, "review-1")).toBeNull();
    // Only this review's turn card entry is removed; other results stay.
    expect(mod.__test.loadAdvisorResults(storage).map((entry: any) => entry.turn)).toEqual([6]);
    // Discarding never delivers anything.
    expect(calls).toHaveLength(0);
  });

  test("an unedited draft discards without a confirmation prompt", () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.requestDiscard();
    expect(store.getSnapshot().discard.confirming).toBe(false);
    store.discardResult(storage);
    expect(store.getSnapshot().result).toBeNull();
  });

  test("cancelling a discard keeps the draft and the result", () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    store.setDraft("edited", storage);
    store.requestDiscard();
    store.cancelDiscard();
    expect(store.getSnapshot().discard.confirming).toBe(false);
    expect(store.getSnapshot().result.draft).toBe("edited");
    expect(mod.__test.loadAdvisorDraft(storage, "review-1")).not.toBeNull();
  });

  test("discarding after a successful injection never claims to retract the DSH message", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    await store.injectResult(stubRemote().remote, storage);
    expect(store.getSnapshot().result.injectState).toBe("injected");
    store.requestDiscard();
    store.discardResult(storage);
    // The Advisor copy is gone; nothing about DSH history is touched or rewritten by this code.
    expect(mod.__test.loadAdvisorDraft(storage, "review-1")).toBeNull();
    expect(store.getSnapshot().result).toBeNull();
  });

  test("an already-injected result keeps its recorded state when reopened", () => {
    const storage = makeStorage();
    const first = mod.__test.createAdvisorStore();
    openResult(first, storage);
    first.discardResult(storage);
    expect(mod.__test.loadAdvisorDraft(storage, "review-1")).toBeNull();

    const reopened = mod.__test.createAdvisorStore();
    openResult(reopened, storage);
    expect(reopened.getSnapshot().result.injectState).toBe("ready");
  });
});

describe("issue #225 — platform boundary", () => {
  test("the client declares the Client Remote service and uses the session-addressed admission", () => {
    const source = readFileSync(join(import.meta.dir, "..", "client.js"), "utf8");
    expect(source).toContain("inject: ['slots', 'locale', 'configForms', 'remote']");
    expect(source).toContain("remote.session");
    expect(source).toContain("session.prompt({");
    expect(source).toContain("mode: 'queue'");
    // The delivery path never appends to the append-only Session log or fabricates an event.
    expect(source).not.toContain("session.append(");
    for (const forbidden of ["assistant/message", "sessionLog.append", "\"user/message\""]) {
      expect(source).not.toContain(forbidden);
    }
    // No direct Session mutation primitive is used by the delivery path.
    const delivery = mod.__test.deliverAdvisorReview.toString();
    expect(delivery).not.toContain("Session");
    expect(delivery).toContain("session.prompt");
  });

  test("a delivery request never carries internal identifiers in the model text", async () => {
    const storage = makeStorage();
    const store = mod.__test.createAdvisorStore();
    openResult(store, storage);
    const { remote, calls } = stubRemote();
    await store.injectResult(remote, storage);
    const text = calls[0].content.map((part: any) => part.text).join("\n");
    for (const leaked of ["review-1", "session-origin", "chatgpt-web/light", "dsh-turn", "reviewId"]) {
      expect(text).not.toContain(leaked);
    }
  });
});
