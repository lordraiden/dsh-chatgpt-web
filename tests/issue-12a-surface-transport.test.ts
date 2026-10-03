import { expect, test } from "bun:test";
import {
  ChatGptWebSurfaceTransport,
  type WebSurfaceInspection,
  type WebSurfaceTransportBackend,
  type WebSurfaceTurn,
} from "../src/adapters/chatgpt-web/web-surface-transport";

function fakeTurn(): WebSurfaceTurn {
  return {
    traceId: "trace-64",
    modelId: "gpt-5.6-luna",
    capabilities: {
      localToolsEnabled: false,
      solAvailable: false,
      proAvailable: false,
    },
    prepare: async () => ({
      text: "hello",
      images: [],
      release: () => {},
    }),
    onTextDelta: () => {},
  } as unknown as WebSurfaceTurn;
}

test("WebSurfaceTransport exposes semantic lifecycle inputs without exposing browser mechanics", async () => {
  const calls: string[] = [];
  const inspection: WebSurfaceInspection = {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/",
    solAvailable: false,
    proAvailable: false,
  };
  const backend: WebSurfaceTransportBackend = {
    run(turn) {
      calls.push(`run:${turn.traceId}`);
      turn.onPhysicalSurfaceBound?.({
        resourceId: "surface-1",
        browserContextId: "context-1",
        pageId: "page-1",
        profileId: "profile-1",
        accountId: "account-1",
      });
      turn.onSurfaceReady?.();
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      return Promise.resolve("answer");
    },
    verifyConnector(traceId) {
      calls.push(`verify:${traceId ?? "generated"}`);
      return Promise.resolve("verified");
    },
    inspectSession(detectCapabilities) {
      calls.push(`inspect:${detectCapabilities}`);
      return Promise.resolve(inspection);
    },
    smokeTest() {
      calls.push("smoke");
      return Promise.resolve({ effort: "low", response: "ok" });
    },
    close() {
      calls.push("close");
      return Promise.resolve();
    },
  };
  const transport = new ChatGptWebSurfaceTransport(backend);
  let bound = 0;
  let ready = 0;
  let sendActivated = 0;
  let submitted = 0;

  const turn = fakeTurn();
  turn.onPhysicalSurfaceBound = () => { bound += 1; };
  turn.onSurfaceReady = () => { ready += 1; };
  turn.onSendActivated = () => { sendActivated += 1; };
  turn.onSubmitted = () => { submitted += 1; };

  await expect(transport.run(turn)).resolves.toBe("answer");
  await expect(transport.verifyConnector("trace-verify")).resolves.toBe("verified");
  await expect(transport.inspectSession(true)).resolves.toEqual(inspection);
  await expect(transport.smokeTest()).resolves.toEqual({ effort: "low", response: "ok" });
  await expect(transport.close()).resolves.toBeUndefined();

  expect(bound).toBe(1);
  expect(ready).toBe(1);
  expect(sendActivated).toBe(1);
  expect(submitted).toBe(1);
  expect(calls).toEqual([
    "run:trace-64",
    "verify:trace-verify",
    "inspect:true",
    "smoke",
    "close",
  ]);
});

test("the transport boundary is lifecycle/semantic, not a second authority", () => {
  const backend: WebSurfaceTransportBackend = {
    run: () => Promise.resolve("ok"),
    verifyConnector: () => Promise.resolve("ok"),
    inspectSession: async () => ({
      authenticated: true,
      temporary: true,
      url: "https://chatgpt.com/",
    }),
    smokeTest: async () => ({ effort: "low", response: "ok" }),
    close: () => Promise.resolve(),
  };
  const transport = new ChatGptWebSurfaceTransport(backend);
  expect(transport).toBeInstanceOf(ChatGptWebSurfaceTransport);
  expect(typeof transport.run).toBe("function");
  expect(typeof transport.close).toBe("function");
});
