/**
 * Issue #357 — the doctor proves an OpenAI-compatible integration without a real workload.
 *
 * "Can an OpenAI-compatible client use this service?" was tribal knowledge: which base-URL shape,
 * which model id, which token budget, and — the part this suite pins — how to prove the wiring before
 * a real call fails. Such a client sends every structured call as a `chat/completions` request
 * carrying a `response_format` JSON schema and authenticated with the service's API key, so the
 * doctor's probe sends exactly that shape to the local service and reports what came back.
 *
 * The classification is the contract, and it is deliberately asymmetric:
 *
 * - an absent service or a missing key is `skipped`, never a failure — a doctor run must not fail
 *   because the integration is not deployed;
 * - a refusal, a non-JSON body or an empty answer is `error`;
 * - a served turn whose reply is not JSON is `warning`, because this bridge carries the schema as
 *   text and cannot enforce it (issue #354) — the wiring works, the soft mode does not guarantee it.
 *
 * The HTTP call is mocked throughout: no live service, no real browser turn, and no secret in any
 * report the check can produce.
 */
import { describe, expect, test } from "bun:test";

import {
  STRUCTURED_OUTPUT_PROBE_IDENTITY,
  STRUCTURED_OUTPUT_PROBE_MODEL,
  formatDoctorReport,
  structuredOutputProbeCheck,
  structuredOutputProbeRequest,
  runDoctor,
  type DoctorCheck,
} from "../src/doctor";
import { defaultConfig, saveConfig } from "../src/config";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/** A key long enough for the server's own minimum, so the probe treats it as usable. */
const API_KEY = "test-api-key-0123456789abcdef";
const BASE_URL = "http://127.0.0.1:17841";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** One `chat.completion` body, as the service returns it. */
function completion(content: string, usage?: Record<string, number>): Record<string, unknown> {
  return {
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 1,
    model: STRUCTURED_OUTPUT_PROBE_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** A `fetch` that answers with one body and records the call it received. */
function answering(body: unknown, status = 200): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("issue #357 — the structured-output probe's request shape", () => {
  test("it is the structured request an OpenAI-compatible client sends: json_schema, model, small output budget", () => {
    const request = structuredOutputProbeRequest(STRUCTURED_OUTPUT_PROBE_MODEL);
    expect(request.model).toBe("chatgpt-web/luna");
    expect(request.stream).toBe(false);
    expect(request.max_completion_tokens).toBe(64);
    expect(request.user).toBe(STRUCTURED_OUTPUT_PROBE_IDENTITY);
    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "dsh_doctor_probe",
        strict: true,
        schema: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    });
    expect(Array.isArray(request.messages)).toBe(true);
    expect(JSON.stringify(request)).not.toContain(API_KEY);
  });

  test("the probe posts it to /v1/chat/completions with the key in the Authorization header", async () => {
    const { impl, calls } = answering(completion('{"status":"ok"}'));
    const check = await structuredOutputProbeCheck({
      baseUrl: `${BASE_URL}/`,
      apiKey: API_KEY,
      fetchImpl: impl,
    });

    expect(check.status).toBe("ok");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(call?.init.method).toBe("POST");
    expect(headersOf(call!.init).authorization).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(call!.init)["content-type"]).toBe("application/json");
    // The credential travels in the header, never in the body.
    expect(call?.init.body).toBe(JSON.stringify(structuredOutputProbeRequest(STRUCTURED_OUTPUT_PROBE_MODEL)));
    expect(String(call?.init.body)).not.toContain(API_KEY);
  });
});

describe("issue #357 — the probe's pass/fail/skip classification", () => {
  test("a JSON answer is ok, with the measured latency and the service's estimate labelled", async () => {
    const { impl } = answering(completion('{"status":"ok"}', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }));
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.id).toBe("structured-output-probe");
    expect(check.status).toBe("ok");
    expect(check.message).toMatch(/answered in \d/);
    expect(check.message).toContain("JSON chat completion");
    expect(check.detail).toContain("soft mode");
    expect(check.detail).toContain("issue #354");
    expect(check.detail).toContain("estimate, not a measurement");
    expect(check.detail).toContain("prompt 12");
    expect(check.detail).toContain("completion 8");
    expect(check.detail).toContain("total 20");
  });

  test("a served turn whose reply is not JSON is a warning, not a failure", async () => {
    const { impl } = answering(completion("Sure! Here is the JSON you asked for:"));
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("warning");
    expect(check.message).toContain("was not JSON");
    expect(check.detail).toContain("must tolerate prose");
  });

  test("a missing usage block is reported as absent, never as zero", async () => {
    const { impl } = answering(completion('{"status":"ok"}'));
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no usage block");
  });

  test("an HTTP refusal is an error that names the status and the service's code", async () => {
    const { impl } = answering({ error: { message: "Unauthorized", code: "invalid_api_key" } }, 401);
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    expect(check.message).toContain("HTTP 401");
    expect(check.detail).toContain("invalid_api_key");
    expect(check.detail).toContain("issue #354");
  });

  test("a body that is not JSON is an error", async () => {
    const impl = (async () => new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    expect(check.message).toContain("not JSON");
  });

  test("a body without a chat completion is an error", async () => {
    const { impl } = answering({ object: "something.else" });
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    expect(check.message).toContain("without a chat completion body");
  });

  test("an empty answer is an error", async () => {
    const { impl } = answering(completion("   "));
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    expect(check.message).toContain("empty answer");
  });

  test("a failed turn carried in the body is an error, not an empty success", async () => {
    const { impl } = answering({
      id: "chatcmpl-probe",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      error: { message: "the provider failed", code: "upstream_stall_timeout" },
    });
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    expect(check.message).toContain("upstream_stall_timeout");
  });

  test("no API key skips the check without touching the network", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, fetchImpl: impl });

    expect(check.status).toBe("skipped");
    expect(check.message).toContain("no API key is configured");
    expect(called).toBe(false);
  });

  test("an unusable key skips with its own reason", async () => {
    const check = await structuredOutputProbeCheck({
      baseUrl: BASE_URL,
      apiKeyProblem: "the configured API key is unusable (shorter than the minimum the service accepts)",
    });

    expect(check.status).toBe("skipped");
    expect(check.message).toContain("unusable");
  });

  test("an unreachable service is skipped, never a failed doctor run", async () => {
    const impl = (async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:17841") as Error & { code: string };
      error.code = "ECONNREFUSED";
      throw error;
    }) as unknown as typeof fetch;
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("skipped");
    expect(check.message).toContain("not reachable");
    expect(check.message).toContain("ECONNREFUSED");
  });

  test("a probe that never answers is a warning, not a failure", async () => {
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5, fetchImpl: impl });

    expect(check.status).toBe("warning");
    expect(check.message).toContain("did not answer within");
  });
});

describe("issue #357 — the probe never prints a secret", () => {
  test("a refusal that echoes the key back does not leak it into the report", async () => {
    const { impl } = answering({ error: { message: `bad key ${API_KEY}`, code: API_KEY } }, 401);
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    expect(check.status).toBe("error");
    const report = formatDoctorReport({ ok: false, checks: [check] });
    expect(JSON.stringify(check)).not.toContain(API_KEY);
    expect(report).not.toContain(API_KEY);
    // The echoed "code" is not printed either: it is not a code, it is the secret.
    expect(check.detail).not.toContain(API_KEY);
  });

  test("the successful path never prints the key, the request body or the model's text", async () => {
    const { impl } = answering(completion('{"status":"ok"}'));
    const check = await structuredOutputProbeCheck({ baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: impl });

    const report = formatDoctorReport({ ok: true, checks: [check] });
    expect(report).not.toContain(API_KEY);
    expect(report).not.toContain("Reply with exactly");
    expect(report).not.toContain("dsh_output_schema_json");
  });
});

describe("issue #357 — the doctor report renders a skipped check honestly", () => {
  test("a skipped check is not an error, prints no repair command, and keeps the report ready", () => {
    const skipped: DoctorCheck = {
      id: "structured-output-probe",
      status: "skipped",
      message: "structured-output probe skipped: no API key is configured",
    };
    const report = formatDoctorReport({ ok: true, checks: [skipped] });

    expect(report).toContain("– structured-output probe skipped");
    expect(report).toContain("Doctor result: ready");
    expect(report).not.toContain("Next step:");
  });

  test("runDoctor wires the probe and skips it when the deployment has no key", async () => {
    const savedHome = captureChatGptWebHome();
    const savedKey = process.env.DSH_CHATGPT_WEB_API_KEY;
    const home = useTemporaryChatGptWebHome("issue-357-doctor-", { clearFreeHome: true });
    delete process.env.DSH_CHATGPT_WEB_API_KEY;
    try {
      saveConfig(defaultConfig());
      const report = await runDoctor();
      const probe = report.checks.filter(check => check.id === "structured-output-probe");
      expect(probe).toHaveLength(1);
      expect(probe[0]?.status).toBe("skipped");
      expect(probe[0]?.message).toContain("no API key is configured");
    } finally {
      if (savedKey === undefined) delete process.env.DSH_CHATGPT_WEB_API_KEY;
      else process.env.DSH_CHATGPT_WEB_API_KEY = savedKey;
      restoreChatGptWebHome(savedHome, home);
    }
  });

  test("runDoctor omits the probe when a caller asks it not to run one", async () => {
    const savedHome = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("issue-357-doctor-off-", { clearFreeHome: true });
    try {
      saveConfig(defaultConfig());
      const report = await runDoctor({ structuredOutputProbe: false });
      expect(report.checks.some(check => check.id === "structured-output-probe")).toBe(false);
    } finally {
      restoreChatGptWebHome(savedHome, home);
    }
  });
});
