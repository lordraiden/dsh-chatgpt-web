import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isTokenShaped, normalizePath } from "../scripts/har-shape.mjs";

/**
 * The HAR shape analyser (scripts/har-shape.mjs).
 *
 * Every fixture here is synthetic, and every synthetic cookie/token/prompt value is asserted absent
 * from what a terminal would receive: that is the contract of the tool, and it is the only reason it
 * may be run on a real capture. The fixtures also mirror what a real onboarding capture contains —
 * a JSON turn, an SSE turn, a mixed capture with assets, a malformed archive.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "har-shape.mjs");

/** Values that must never cross into stdout or stderr, in any test. */
const SYNTH = {
  cookie: "SYNTHCOOKIEVALUE0123456789",
  authToken: "SYNTHAUTHTOKEN0123456789abcdef",
  queryValue: "SYNTHQUERYVALUEDONOTPRINT",
  traceValue: "SYNTHTRACEVALUEDONOTPRINT",
  prompt: "SYNTHETIC-PROMPT-TEXT",
  system: "SYNTHETIC-SYSTEM-PROMPT",
  answer: "SYNTHETIC-ANSWER-TEXT",
  bodyValue: "SYNTHETIC-BODY-VALUE",
  account: "ACCT-SYNTH-0001",
  accountToken: "acct_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  chatId: "SYNTH-CHAT-ID-0001",
  responseId: "SYNTH-RESPONSE-ID-0002",
  toolToken: "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef",
  jwtLike: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeHar(name: string, entries: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "har-shape-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify({ log: { version: "1.2", creator: { name: "synthetic" }, entries } }));
  return path;
}

function writeRaw(name: string, text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "har-shape-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

interface EntryOptions {
  method?: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  requestText?: string;
  responseText?: string;
  responseBody?: unknown;
  responseMime?: string;
  status?: number;
}

function entry(options: EntryOptions) {
  const headers = Object.entries(options.requestHeaders ?? {}).map(([name, value]) => ({ name, value }));
  const request: Record<string, unknown> = { method: options.method ?? "GET", url: options.url, headers };
  if (options.requestBody !== undefined || options.requestText !== undefined) {
    const text = options.requestText ?? JSON.stringify(options.requestBody);
    request.postData = { mimeType: "application/json", text };
    headers.push({ name: "content-type", value: "application/json" });
  }
  const responseText = options.responseText !== undefined
    ? options.responseText
    : JSON.stringify(options.responseBody ?? {});
  return {
    request,
    response: {
      status: options.status ?? 200,
      headers: [],
      content: { mimeType: options.responseMime ?? "application/json", text: responseText, size: responseText.length },
    },
  };
}

function run(path: string, ...args: string[]) {
  const result = spawnSync("node", [SCRIPT, path, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function combined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function expectNoSecrets(text: string) {
  for (const [name, value] of Object.entries(SYNTH)) {
    expect({ name, leaked: text.includes(value) }).toEqual({ name, leaked: false });
  }
}

describe("HAR shape analyser — JSON turn", () => {
  function jsonTurnHar() {
    return writeHar("json-turn.har", [
      entry({
        method: "GET",
        url: "https://api.example.test/v1/models",
        responseBody: { data: [{ id: "vendor/model-x" }] },
      }),
      entry({
        method: "POST",
        url: `https://api.example.test/v1/chat?api_key=${SYNTH.queryValue}&trace=${SYNTH.traceValue}`,
        requestHeaders: {
          cookie: `session=${SYNTH.cookie}`,
          authorization: `Bearer ${SYNTH.authToken}`,
        },
        requestBody: {
          model: "vendor/model-x",
          messages: [
            { role: "system", content: SYNTH.system },
            { role: "user", content: SYNTH.prompt },
          ],
          temperature: 0.7,
          custom: SYNTH.bodyValue,
          accountId: SYNTH.account,
          metadata: { sessionToken: SYNTH.authToken },
        },
        responseBody: { choices: [{ message: { role: "assistant", content: SYNTH.answer } }] },
      }),
    ]);
  }

  test("reports the endpoint, body key tree and turn verdict without printing a value", () => {
    const result = run(jsonTurnHar());
    expect(result.code).toBe(0);

    // Endpoint shape: method + path, query parameter names only.
    expect(result.stdout).toContain("POST api.example.test/v1/chat");
    expect(result.stdout).toContain("api_key");
    expect(result.stdout).toContain("trace");
    expect(result.stdout).toContain("(values dropped)");
    expectNoSecrets(combined(result));

    // Body key tree: names and types, not values.
    expect(result.stdout).toContain("model: string");
    expect(result.stdout).toContain("messages: array[2] of object");
    expect(result.stdout).toContain("role: string");
    expect(result.stdout).toContain("content: string");
    expect(result.stdout).toContain("temperature: number");

    // The model id is the one identifier the report prints on purpose.
    expect(result.stdout).toContain("vendor/model-x");
    // The account id is fingerprinted, never printed.
    expect(result.stdout).not.toContain(SYNTH.account);
    expect(result.stdout).toMatch(/sha256:[0-9a-f]{12}/);

    // Header names are safe; their values are not present anywhere.
    expect(result.stdout).toContain("cookie");
    expect(result.stdout).toContain("authorization");

    // Verdict and missing observations.
    expect(result.stdout).toContain("this looks like the turn call");
    expect(result.stdout).toContain("messages-like array");
    expect(result.stdout).toContain("no SSE frames captured");
  });

  test("--json is machine-readable, bounded and just as secret-free", () => {
    const result = run(jsonTurnHar(), "--json", "--top", "1");
    expect(result.code).toBe(0);
    expectNoSecrets(combined(result));

    const report = JSON.parse(result.stdout);
    expect(report.har.entries).toBe(2);
    // The bounded frequency table was cut to one row, and the turn candidate is still present.
    expect(report.endpoints).toHaveLength(2);
    const turn = report.endpoints.find((endpoint: { method: string }) => endpoint.method === "POST");
    expect(turn.queryParameters).toEqual(["api_key", "trace"]);
    expect(turn.requestBodies[0].shape.kind).toBe("object");
    expect(report.modelCandidates.map((candidate: { value: string }) => candidate.value)).toContain("vendor/model-x");
    expect(report.accountCandidates[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(report)).not.toContain(SYNTH.account);
  });
});

describe("HAR shape analyser — SSE turn", () => {
  function sseHar() {
    const frames = [
      `data: {"response.created":{"chat_id":"${SYNTH.chatId}","parent_id":"SYNTH-PARENT","response_id":"${SYNTH.responseId}"}}`,
      `data: {"choices":[{"delta":{"role":"assistant","content":"${SYNTH.answer}","phase":"answer","status":"typing"}}],"response_id":"${SYNTH.responseId}","timestamp":1}`,
      `data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer","status":"finished"}}],"response_id":"${SYNTH.responseId}","timestamp":2}`,
      "data: [DONE]",
      "",
    ].join("\n");
    return writeHar("sse-turn.har", [
      entry({
        method: "POST",
        url: "https://api.example.test/v1/chat/completions?model_id=hidden",
        requestBody: {
          model: "vendor/model-x",
          stream: true,
          messages: [{ role: "user", content: SYNTH.prompt }],
        },
        responseMime: "text/event-stream; charset=utf-8",
        responseText: frames,
      }),
    ]);
  }

  test("collapses frames into key shapes, finds [DONE] and the changing termination field", () => {
    const result = run(sseHar());
    expect(result.code).toBe(0);
    expectNoSecrets(combined(result));

    expect(result.stdout).toContain("distinct frame shapes");
    expect(result.stdout).toContain("response.created");
    expect(result.stdout).toContain("delta");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("typing");
    expect(result.stdout).toContain("finished");
    expect(result.stdout).toContain("[DONE]-like marker: present");
    expect(result.stdout).toContain("termination-signal candidates");
    // Frame shape shows names, never the content value.
    expect(result.stdout).not.toContain(SYNTH.answer);
    expect(result.stdout).not.toContain(SYNTH.chatId);
  });

  test("reports a missing [DONE] as an observation and names the changing field", () => {
    const frames = [
      'data: {"choices":[{"delta":{"status":"typing","content":"x"}}]}',
      'data: {"choices":[{"delta":{"status":"finished","content":""}}]}',
      "",
    ].join("\n");
    const path = writeHar("sse-no-done.har", [
      entry({
        method: "POST",
        url: "https://api.example.test/v1/chat/completions",
        requestBody: { model: "vendor/model-x", messages: [{ role: "user", content: "hi" }] },
        responseMime: "text/event-stream",
        responseText: frames,
      }),
    ]);
    const result = run(path);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[DONE]-like marker: not present");
    expect(result.stdout).toContain("no [DONE]-like marker");
    expect(result.stdout).toContain("choices[0].delta.status");
  });
});

describe("HAR shape analyser — mixed capture and bounding", () => {
  function mixedHar() {
    const entries = [];
    for (let index = 0; index < 8; index += 1) {
      entries.push(
        entry({
          url: `https://api.example.test/static/asset-${index}.js`,
          responseText: "",
        }),
      );
    }
    entries.push(
      entry({
        method: "POST",
        url: "https://api.example.test/v1/chat/completions",
        requestBody: { model: "vendor/model-x", messages: [{ role: "user", content: SYNTH.prompt }] },
        responseMime: "text/event-stream",
        responseText: 'data: {"choices":[{"delta":{"status":"finished","content":"x"}}]}\ndata: [DONE]\n',
      }),
    );
    return writeHar("mixed.har", entries);
  }

  test("a rare turn endpoint is still found when it is outside the top-N frequency table", () => {
    const result = run(mixedHar(), "--top", "2");
    expect(result.code).toBe(0);
    expectNoSecrets(combined(result));

    // The table is bounded to the top 2 endpoint shapes…
    expect(result.stdout).toContain("ENDPOINTS (top 2 of 9 by frequency)");
    // …but the turn call is still a candidate and still gets a detail section.
    expect(result.stdout).toContain("POST api.example.test/v1/chat/completions");
    expect(result.stdout).toContain("DETAIL — POST api.example.test/v1/chat/completions");
  });

  test("a huge body is bounded by depth and array length", () => {
    const messages = Array.from({ length: 4000 }, (_, index) => ({
      role: "user",
      content: `LONGVALUE-${index}-${"z".repeat(60)}`,
    }));
    const path = writeHar("huge.har", [
      entry({
        method: "POST",
        url: "https://api.example.test/v1/chat",
        requestBody: { model: "vendor/model-x", messages },
        responseText: "",
      }),
    ]);
    const result = run(path);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThan(12_000);
    expect(result.stdout).toContain("array[4000]");
    expect(result.stdout).not.toContain("LONGVALUE-");
    expectNoSecrets(combined(result));
  });
});

describe("HAR shape analyser — tokens that look like ids", () => {
  test("redacts a token-shaped model value and never prints account-like values", () => {
    const path = writeHar("token-ids.har", [
      entry({
        method: "POST",
        url: "https://api.example.test/v1/chat",
        requestBody: {
          model: SYNTH.toolToken,
          messages: [{ role: "user", content: "hi" }],
          account: { id: SYNTH.accountToken },
          status: SYNTH.jwtLike,
        },
        responseText: "",
      }),
    ]);
    const result = run(path);
    expect(result.code).toBe(0);
    expectNoSecrets(combined(result));
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).toMatch(/sha256:[0-9a-f]{12}/);
    // The long JWT-shaped value is not an "enumerated short value" and must not be shown either.
    expect(result.stdout).not.toContain("dozjgNryP4J3jVmNHl0w5N");
  });
});

describe("HAR shape analyser — failures are actionable and secret-free", () => {
  test("a non-JSON file fails without a stack trace", () => {
    const path = writeRaw("broken.har", `{"log": {"entries": [ {"secret": "${SYNTH.queryValue}" } `);
    const result = run(path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(result.stderr).toContain("broken.har");
    expect(result.stderr).not.toContain("    at ");
    expectNoSecrets(result.stderr);
  });

  test("a JSON file that is not a HAR says exactly what is missing", () => {
    const missingEntries = run(writeRaw("no-entries.har", JSON.stringify({ log: {} })));
    expect(missingEntries.code).toBe(1);
    expect(missingEntries.stderr).toContain("missing log.entries[]");

    const empty = run(writeRaw("empty-entries.har", JSON.stringify({ log: { entries: [] } })));
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("contains no requests");

    const noUrl = run(writeHar("no-url.har", [{ request: { method: "GET" }, response: { status: 200 } }]));
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toContain("entry 1 has no request.url");
    expectNoSecrets(noUrl.stderr);
  });

  test("a missing file, a missing argument and an unknown option are usage errors, not crashes", () => {
    const missing = run(join(tmpdir(), "definitely-not-here.har"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("file not found");
    expect(missing.stderr).toContain("definitely-not-here.har");

    const noArgument = spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(noArgument.status).toBe(2);
    expect(noArgument.stderr).toContain("missing HAR path");
    expect(noArgument.stderr).toContain("Usage:");

    const unknown = spawnSync("node", [SCRIPT, "whatever.har", "--nope"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown option --nope");
    expect(unknown.stderr).toContain("Usage:");
  });
});

describe("HAR shape analyser — pure helpers", () => {
  test("normalizePath keeps versions and names but collapses ids", () => {
    expect(normalizePath("/coder/api/v2/task/3419b232-3ca9-45c9-a6da-51fd46ba9161/status"))
      .toBe("/coder/api/v2/task/:id/status");
    expect(normalizePath("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizePath("/items/12345")).toBe("/items/:id");
    // A token in a path segment is shape, not evidence: collapse it like any other id.
    expect(normalizePath(`/session/${SYNTH.jwtLike}/messages`)).toBe("/session/:id/messages");
  });

  test("isTokenShaped recognises long identifiers but not status words", () => {
    expect(isTokenShaped("typing")).toBe(false);
    expect(isTokenShaped("keep_alive")).toBe(false);
    expect(isTokenShaped("response.created")).toBe(false);
    expect(isTokenShaped(SYNTH.jwtLike)).toBe(true);
    expect(isTokenShaped(SYNTH.toolToken)).toBe(true);
  });
});
