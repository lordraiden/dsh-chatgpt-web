import { describe, expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../src/config";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import type { ProviderAdapter } from "../src/adapters/base";
import { startServer } from "../src/server";

const FS_READ = {
  name: "fs.read",
  description: "Read a bounded UTF-8 text file inside the configured workspace.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: { type: "string" },
    },
    required: ["file_path"],
  },
};

describe("issue #127 browser-only native DSH tool handoff", () => {
  test("browser-only stays pure chat by default but native DSH explicitly enables local tools", () => {
    const config = {
      ...defaultConfig(),
      mode: "browser-only" as const,
    };

    expect(providerConfig(config).chatgptWeb?.localToolsEnabled).toBe(false);
    expect(providerConfig(config, { localToolsEnabled: true }).chatgptWeb?.localToolsEnabled).toBe(true);

    const parsed = {
      modelId: "gpt-5.6-sol",
      context: {
        messages: [{
          role: "user",
          content: "read the test file",
          timestamp: Date.now(),
        }],
        tools: [FS_READ],
      },
      stream: true,
      options: { reasoning: "high" },
      _dshContext: {
        threadId: "issue-127-thread",
        turnId: "issue-127-turn",
      },
    } as unknown as CodexParsedRequest;

    const prompt = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      "turn_issue_127_123456789",
    );

    expect(prompt.text).toContain("Emit exactly one <dsh_tool_call>");
    expect(prompt.text).toContain("native DSH tool mode");
    expect(prompt.text).toContain("<dsh_tool_schemas_json>");
    expect(prompt.text).toContain("\"fs.read\"");
    expect(prompt.text).toContain("\"file_path\"");
  });

  test("native DSH private ingress enables browser-local tools while Responses remains read-only", async () => {
    const config = {
      ...defaultConfig(),
      mode: "browser-only" as const,
      port: 0,
      controlToken: "issue-127-browser-only-native-tools-control-token",
      solAvailable: true,
      proAvailable: false,
      capabilityState: {
        solAvailable: "supported" as const,
        proAvailable: "unsupported" as const,
      },
    };

    const localToolsSeen: boolean[] = [];
    const toolNamesSeen: string[][] = [];
    const adapterFactory = (provider: { chatgptWeb?: { localToolsEnabled?: boolean } }): ProviderAdapter => ({
      name: "issue-127-browser-only-native-tools",
      runTurn: async (
        parsed: CodexParsedRequest,
        _incoming,
        emit: (event: AdapterEvent) => void,
      ) => {
        localToolsSeen.push(provider.chatgptWeb?.localToolsEnabled === true);
        toolNamesSeen.push((parsed.context.tools ?? []).map(tool => tool.name));
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    });

    const running = startServer(config, { adapterFactory });

    try {
      const nativeParsed = parseRequest({
        model: "chatgpt-web/light",
        input: "read .dsh121-local-test.txt",
        stream: false,
      });
      const nativeRoute = (await import("../src/server")).routeChatGptWebRequest(nativeParsed, config);
      nativeParsed.modelId = nativeRoute.backendModel;

      nativeParsed._dshContext = {
        dshSessionId: "issue-127-session",
        threadId: "issue-127-thread",
        turnId: "issue-127-turn",
      };

      const baseUrl = `http://127.0.0.1:${running.port}`;
      const plainNativeResponse = await fetch(`${baseUrl}/internal/native-llm`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          request: nativeParsed,
        }),
      });
      expect(plainNativeResponse.status).toBe(200);
      await plainNativeResponse.text();

      nativeParsed.context.tools = [FS_READ];
      const nativeResponse = await fetch(`${baseUrl}/internal/native-llm`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          request: nativeParsed,
        }),
      });

      expect(nativeResponse.status).toBe(200);
      await nativeResponse.text();

      const responseIngress = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt-web/light",
          input: "hello",
          stream: false,
        }),
      });

      expect(responseIngress.status).toBe(200);
      await responseIngress.text();

      expect(localToolsSeen).toEqual([false, true, false]);
      expect(toolNamesSeen[0]).toEqual(["fs.read"]);
      expect(toolNamesSeen[1]).toEqual([]);
    } finally {
      await running.stop(true);
    }
  });
});
// CI validation marker: native turns without tools must remain outside capability wait.
