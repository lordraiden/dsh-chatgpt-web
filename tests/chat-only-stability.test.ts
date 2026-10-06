import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";

const adapterSource = readFileSync(
  new URL("../src/adapters/chatgpt-web/index.ts", import.meta.url),
  "utf8",
);

describe("chat-only 1.0.8 stability baseline", () => {
  test("common ChatGPT Web routes remain tool-disabled in stability mode", () => {
    const capabilities = {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
    };

    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, effort, capabilities);
      expect(mode.localTools).toBe(false);
    }

    const luna = resolveChatGptWebModelMode(
      CHATGPT_WEB_LUNA_MODEL_ID,
      "low",
      { ...capabilities, solAvailable: false },
    );
    expect(luna.localTools).toBe(false);
  });

  test("terminal non-retryable failure path settles ProviderCore only once", () => {
    const marker = 'providerTurn.markLogicalSettled("failed");';
    const failRound = "session.failRound(roundKey, turnError);";
    const end = adapterSource.indexOf(failRound);
    expect(end).toBeGreaterThan(0);

    const start = adapterSource.lastIndexOf(marker, end);
    expect(start).toBeGreaterThan(0);

    const tail = adapterSource.slice(start, end + failRound.length);
    expect(tail.split(marker).length - 1).toBe(1);
  });

  test("runTurn exposes a safe high-level chat-only diagnostic", () => {
    expect(adapterSource).toContain(
      "console.info(`[chatgpt-web] runTurn model=\${parsed.modelId} chatOnly=true`);",
    );
  });
});
