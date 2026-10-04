import { strict as assert } from "node:assert";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptWebRetry } from "../src/adapters/chatgpt-web/retry-policy";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest } from "../src/types";


function parsedWithoutTrustedEnvironment(): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/light",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {},
    _dshContext: undefined,
  };
}

const classified = classifyChatGptWebRetry(new ChatGptWebAdapterError("temporary", {
  status: 503,
  errorType: "server_error",
  code: "temporary",
  retryable: true,
}));
assert.equal(classified.retryable, true);
assert.equal(classified.status, 503);

const store = new ChatGptThreadEnvironmentStore();
const parsed = parsedWithoutTrustedEnvironment();
assert.throws(
  () => store.resolve(parsed),
  /trusted Codex cwd|environment|sandbox mode/i,
);

console.log("Issue #77 targeted retry classification and continuity fail-closed contracts passed.");
