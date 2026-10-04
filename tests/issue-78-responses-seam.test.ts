import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createChatGptWebRouteAuthority,
  requireChatGptWebRoute,
} from "../src/chatgpt-web-authority";
import type { IncomingMeta, ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import {
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";
import {
  compactRequest,
  modelsRequest,
  responseRequest,
  routeChatGptWebRequest,
} from "../src/server";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("issue #78 Responses compatibility seam audit", () => {
  test("Responses modules stay outside browser/retry/capability execution authorities", () => {
    const responseFiles = [
      "src/responses/compaction.ts",
      "src/responses/parser.ts",
      "src/responses/reasoning-envelope.ts",
      "src/responses/schema.ts",
      "src/responses/state.ts",
      "src/bridge.ts",
    ];

    const forbiddenImports = [
      "provider-core",
      "browser-worker",
      "turn-execution",
      "turn-broker",
      "retry-policy",
      "capability-projector",
      "capability-transport",
      "thread-environment",
      "web-surface-transport",
    ];

    for (const file of responseFiles) {
      const source = read(file);
      for (const moduleName of forbiddenImports) {
        expect(source).not.toContain('from "' + moduleName);
        expect(source).not.toContain("from '" + moduleName);
        expect(source).not.toContain("/" + moduleName + '"');
        expect(source).not.toContain("/" + moduleName + "'");
      }
    }
  });

  test("repository-wide Responses imports remain confined to explicit ingress/bridge/transport consumers", () => {
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });
    const sourceFiles = walk(resolve(root, "src"));
    const responseDir = resolve(root, "src/responses");
    const allowedConsumers = new Set([
      resolve(root, "src/server.ts"),
      resolve(root, "src/bridge.ts"),
      resolve(root, "src/native-passthrough.ts"),
    ]);

    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      if (file.startsWith(responseDir)) continue;
      if (allowedConsumers.has(file)) continue;
      expect(source).not.toMatch(/from ["'][^"']*\/responses\//);
    }

    for (const file of sourceFiles.filter(path => path.startsWith(responseDir))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(?:provider-core|browser-worker|turn-execution|turn-broker|retry-policy|capability-projector|capability-transport|thread-environment|web-surface-transport)/);
    }
  });

  test("Responses is an ingress over the shared ChatGPT Web adapter", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    const calls: unknown[] = [];
    const adapterFactory = (): ProviderAdapter => ({
      name: "test-chatgpt-web",
      runTurn: async (parsed: CodexParsedRequest, _incoming: IncomingMeta, emit: (event: AdapterEvent) => void) => {
        calls.push(parsed);
        emit({ type: "text_delta", text: "parity answer", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    });

    const unary = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/light", input: "hello", stream: false }),
      }),
      config,
      adapterFactory,
    );
    expect(unary.status).toBe(200);
    expect((await unary.json()).status).toBe("completed");

    const streamed = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/light", input: "hello", stream: true }),
      }),
      config,
      adapterFactory,
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toContain("parity answer");
    expect(calls).toHaveLength(2);
  });

  test("Responses and native DSH resolve the same route authority", () => {
    const matrix = [
      { model: "chatgpt-web/light", sol: true, pro: false },
      { model: "chatgpt-web/medium", sol: true, pro: false },
      { model: "chatgpt-web/high", sol: true, pro: false },
      { model: "chatgpt-web/extra-high", sol: true, pro: true },
      { model: "chatgpt-web/pro", sol: true, pro: true },
      { model: "chatgpt-web/luna", sol: false, pro: false },
      { model: "chatgpt-web/think", sol: false, pro: false },
    ] as const;

    for (const entry of matrix) {
      const config = {
        ...defaultConfig(),
        solAvailable: entry.sol,
        proAvailable: entry.pro,
        capabilityState: {
          solAvailable: (entry.sol ? "supported" : "unsupported") as "supported" | "unsupported",
          proAvailable: (entry.pro ? "supported" : "unsupported") as "supported" | "unsupported",
        },
      };
      const authority = createChatGptWebRouteAuthority(config);
      const expected = (() => {
        try { return requireChatGptWebRoute(entry.model, authority).slug; }
        catch { return "rejected"; }
      })();
      let native = "rejected";
      try {
        const parsed = parseRequest({ model: entry.model, input: "hello" });
        native = routeChatGptWebRequest(parsed, config).slug;
      } catch {
        native = "rejected";
      }
      expect(native).toBe(expected);
    }
  });

  test("Unknown Web capability fails closed before the adapter is selected", async () => {
    const config = {
      ...defaultConfig(),
      capabilityState: { solAvailable: "unknown" as const, proAvailable: "unknown" as const },
    };
    let adapterCalls = 0;
    const response = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/light", input: "hello", stream: false }),
      }),
      config,
      () => {
        adapterCalls += 1;
        return { name: "must-not-run", runTurn: async () => {} };
      },
    );
    expect(response.status).toBe(400);
    expect(adapterCalls).toBe(0);
  });

  test("Web model catalog remains available when native Codex models are unavailable or malformed", async () => {
    const config = defaultConfig();
    const unavailable = await modelsRequest(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer test-token" } }),
      config,
      async () => { throw new Error("native Codex unavailable"); },
    );
    expect(unavailable.status).toBe(200);
    const unavailableBody = await unavailable.json() as { models?: Array<{ slug?: string }> };
    expect(unavailableBody.models?.length).toBeGreaterThan(0);
    expect(unavailableBody.models?.every(model => model.slug?.startsWith("chatgpt-web/"))).toBe(true);

    const malformed = await modelsRequest(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer test-token" } }),
      config,
      async () => new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(malformed.status).toBe(200);
    const malformedBody = await malformed.json() as { models?: Array<{ slug?: string }> };
    expect(malformedBody.models?.every(model => model.slug?.startsWith("chatgpt-web/"))).toBe(true);
  });

  test("Native Codex requests stay outside the Web adapter on Responses and compact", async () => {
    const config = defaultConfig();
    let adapterCalls = 0;
    const adapterFactory = () => {
      adapterCalls += 1;
      throw new Error("Web adapter must not be selected for native Codex passthrough");
    };
    const originalFetch = globalThis.fetch;
    const mockedFetch = (async (request: Request) => {
      const body = request.method === "POST" ? await request.text() : "";
      return Response.json({ ok: true, endpoint: new URL(request.url).pathname, ...(body ? { body } : {}) });
    }) as typeof globalThis.fetch;
    globalThis.fetch = mockedFetch;
    try {
      for (const model of ["gpt-5.6-codex", "gpt-5.6-codex-mini", "chatgpt-work/pro", "work/pro"]) {
        const response = await responseRequest(
          new Request("http://127.0.0.1/v1/responses", {
            method: "POST",
            headers: { authorization: "Bearer test-token", "content-type": "application/json" },
            body: JSON.stringify({ model, input: "hello", stream: false }),
          }),
          config,
          adapterFactory,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).endpoint).toBe("/backend-api/codex/responses");
      }

      const compact = await compactRequest(
        new Request("http://127.0.0.1/v1/responses/compact", {
          method: "POST",
          headers: { authorization: "Bearer test-token", "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-codex", input: [] }),
        }),
        config,
        adapterFactory,
      );
      expect(compact.status).toBe(200);
      expect((await compact.json()).endpoint).toBe("/backend-api/codex/responses/compact");
      expect(adapterCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Web Responses compaction reuses the same adapter ingress and never creates a second execution core", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    let calls = 0;
    const adapterFactory = (): ProviderAdapter => ({
      name: "test-chatgpt-web",
      runTurn: async (_parsed: CodexParsedRequest, _incoming: IncomingMeta, emit: (event: AdapterEvent) => void) => {
        calls += 1;
        emit({ type: "text_delta", text: "compaction summary", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    });
    const response = await compactRequest(
      new Request("http://127.0.0.1/v1/responses/compact", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old history" }] }],
        }),
      }),
      config,
      adapterFactory,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { output?: Array<{ type?: string; encrypted_content?: string; content?: Array<{ text?: string }> }> };
    expect(body.output).toHaveLength(2);
    expect(body.output?.[1]?.type).toBe("message");
    expect(body.output?.[1]?.content?.[0]?.text).toContain("compaction summary");
    expect(typeof body.output?.[0]?.encrypted_content).toBe("string");
    expect(calls).toBe(1);
  });

  test("previous_response_id state survives restart only as compatibility input", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-chatgpt-web-78-"));
    try {
      const writer = Bun.spawnSync(
        [
          "bun", "-e",
          [
            'import { rememberResponseState, flushResponseState } from "./src/responses/state.ts";',
            'rememberResponseState({input:[{type:"message",role:"user",content:[{type:"input_text",text:"first"}]}],store:false},{id:"resp_persist_78",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"answer"}]}]},{force:true});',
            "flushResponseState();",
          ].join("\n"),
        ],
        { cwd: root, env: { ...process.env, DSH_CHATGPT_FREE_HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      expect(writer.exitCode).toBe(0);

      const reader = Bun.spawnSync(
        [
          "bun", "-e",
          [
            'import { expandPreviousResponseInput } from "./src/responses/state.ts";',
            'const body={model:"chatgpt-web/luna",previous_response_id:"resp_persist_78",input:[{type:"message",role:"user",content:[{type:"input_text",text:"next"}]}]};',
            "console.log(JSON.stringify(expandPreviousResponseInput(body)));",
          ].join("\n"),
        ],
        { cwd: root, env: { ...process.env, DSH_CHATGPT_FREE_HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      expect(reader.exitCode).toBe(0);
      const expanded = JSON.parse(new TextDecoder().decode(reader.stdout)) as { input?: unknown[] };
      expect(expanded.input).toHaveLength(3);
      expect(JSON.stringify(expanded.input)).toContain("first");
      expect(JSON.stringify(expanded.input)).toContain("answer");
      expect(JSON.stringify(expanded.input)).toContain("next");
      expect(expanded).not.toHaveProperty("capabilities");
      expect(expanded).not.toHaveProperty("sandbox");
      expect(expanded).not.toHaveProperty("provider");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unavailable previous_response_id fails before Web adapter execution", async () => {
    const config = {
      ...defaultConfig(),
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported" as const, proAvailable: "unsupported" as const },
    };
    let adapterCalls = 0;
    const response = await responseRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          previous_response_id: "resp_missing_78",
          input: "next",
          stream: false,
        }),
      }),
      config,
      () => {
        adapterCalls += 1;
        return {
          name: "must-not-run",
          runTurn: async () => {},
        };
      },
    );
    expect(response.status).toBe(409);
    expect(adapterCalls).toBe(0);
  });

  test("Malformed persisted continuation state fails closed", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-chatgpt-web-78-corrupt-"));
    try {
      writeFileSync(join(home, "responses-state.json"), "{corrupt", "utf8");
      const result = Bun.spawnSync(
        [
          "bun", "-e",
          [
            'import { expandPreviousResponseInput } from "./src/responses/state.ts";',
            'const body={model:"chatgpt-web/luna",previous_response_id:"resp_corrupt",input:"next"};',
            'console.log(JSON.stringify({same:expandPreviousResponseInput(body)===body}));',
          ].join("\n"),
        ],
        { cwd: root, env: { ...process.env, DSH_CHATGPT_FREE_HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout).trim()).toBe('{"same":true}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("previous_response_id state remains cache-only and cannot carry authority fields", () => {
    const request = {
      model: "chatgpt-web/luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }],
      store: false,
    };
    rememberResponseState(
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }], store: false },
      {
        id: "resp_issue_78",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
          provider: "attacker",
          capabilities: ["root"],
          sandbox: "dangerFullAccess",
        }],
      },
      { force: true },
    );
    const expanded = expandPreviousResponseInput({ ...request, previous_response_id: "resp_issue_78" }) as Record<string, unknown>;
    expect(Array.isArray(expanded.input)).toBe(true);
    expect(expanded).not.toHaveProperty("provider");
    expect(expanded).not.toHaveProperty("capabilities");
    expect(expanded).not.toHaveProperty("sandbox");
  });
});
