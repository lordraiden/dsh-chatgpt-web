import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexTool } from "../src/types";
import {
  authorizeCapability,
  capabilitySnapshotForEnvironment,
  projectChatGptCapabilities,
} from "../src/adapters/chatgpt-web/capability-projector";
import {
  BrokerCapabilityTransport,
  type CapabilityTransport,
  type CapabilityTransportBinding,
  type CapabilityToolResult,
} from "../src/adapters/chatgpt-web/capability-transport";
import {
  TurnBroker,
  callTurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import {
  chatGptGatewayAllowedToolNames,
} from "../src/adapters/chatgpt-web/mcp-server";

const echoTool: CodexTool = {
  name: "echo",
  namespace: "native",
  description: "Echo a structured value.",
  parameters: {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
    additionalProperties: false,
  },
};

const execTool: CodexTool = {
  name: "exec",
  namespace: "",
  description: "Run native JavaScript against authorized DSH tools.",
  freeform: true,
  parameters: {
    type: "object",
    additionalProperties: true,
  },
};

const hiddenTool: CodexTool = {
  name: "codex_tool_call",
  namespace: "",
  description: "Internal bridge capability that must never be exposed by the Zero Risk transport contract.",
  parameters: {
    type: "object",
    additionalProperties: false,
  },
};
const nestedTool: CodexTool = {
  name: "read_file",
  namespace: "",
  description: "Read a file through the native DSH tool registry.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const snapshot = projectChatGptCapabilities({
  sessionId: "session-10b",
  agentId: "agent-10b",
  turnId: "turn-10b",
  tools: [echoTool, execTool, hiddenTool, nestedTool],
});

const environment = capabilitySnapshotForEnvironment({
  cwd: "/workspace",
  roots: ["/workspace"],
  writableRoots: ["/workspace"],
  sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: ["/workspace"], networkAccess: true },
  tools: [echoTool, execTool, hiddenTool, nestedTool],
}, snapshot);

{
  const seen: Array<{ binding: CapabilityTransportBinding; wireName: string; snapshotId: string }> = [];
  const expected: CapabilityToolResult = {
    content: [
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/result.txt", name: "result" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ],
    structuredContent: { ok: true, items: [1, 2, 3] },
    isError: false,
    _meta: { source: "fake-dsh-runtime", trace: "10b" },
  };
  let revocations = 0;
  const transport = new BrokerCapabilityTransport({
    async invoke(binding, invocation) {
      seen.push({
        binding,
        wireName: invocation.wireName,
        snapshotId: invocation.snapshotId,
      });
      return expected;
    },
    revoke() {
      revocations += 1;
    },
  }).bind({
    bindingId: "binding_10b_test",
    snapshot,
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    agentId: snapshot.agentId,
    turnId: snapshot.turnId,
  });

  const actual = await transport.invoke({
    wireName: "native__echo",
    freeform: false,
    arguments: { value: "hello" },
  });
  assert.deepEqual(actual, expected);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.snapshotId, snapshot.snapshotId);
  assert.equal(seen[0]!.wireName, "native__echo");

  await assert.rejects(
    () => transport.invoke({
      wireName: "native__echo",
      freeform: true,
      input: "not a freeform echo call",
    }),
    /invocation mode does not match/i,
  );
  assert.equal(seen.length, 1, "mode mismatch must fail before reaching the dispatcher");

  await assert.rejects(
    () => transport.invoke({
      wireName: "bridge__forged",
      freeform: false,
      arguments: {},
    }),
    /not authorized/i,
  );
  assert.equal(seen.length, 1, "authorization must fail before reaching the transport dispatcher");

  await transport.revoke(new Error("turn cancelled"));
  assert.equal(revocations, 1);
  await assert.rejects(
    () => transport.invoke({
      wireName: "native__echo",
      freeform: false,
      arguments: { value: "late" },
    }),
    /revoked/i,
  );
  await transport.revoke();
  assert.equal(revocations, 1, "repeated revoke must be idempotent");

  assert.throws(
    () => new BrokerCapabilityTransport({
      async invoke() { return expected; },
      revoke() {},
    }).bind({
      bindingId: "binding_10b_test",
      snapshot,
      snapshotId: "different-snapshot",
      sessionId: snapshot.sessionId,
      agentId: snapshot.agentId,
      turnId: snapshot.turnId,
    }),
    /binding does not match/i,
  );
}

{
  const fakeResults: string[] = [];
  class InMemoryCapabilityTransport implements CapabilityTransport {
    constructor(private readonly currentSnapshot: typeof snapshot) {}

    bind(binding: CapabilityTransportBinding) {
      if (binding.snapshotId !== this.currentSnapshot.snapshotId) {
        throw new Error("fake transport binding snapshot mismatch");
      }
      return {
        binding,
        snapshot: binding.snapshot,
        authorize: (request: { wireName: string }) => authorizeCapability(binding.snapshot, request),
        invoke: async (request: {
          wireName: string;
          freeform: boolean;
          arguments?: Record<string, unknown>;
          input?: string;
        }) => {
          const tool = authorizeCapability(binding.snapshot, { wireName: request.wireName });
          fakeResults.push(tool.name);
          return { content: [{ type: "text", text: `fake:${tool.name}` }] };
        },
        revoke: async () => {},
      };
    }
  }

  const fake = new InMemoryCapabilityTransport(snapshot).bind({
    bindingId: "binding_10b_fake",
    snapshot,
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    agentId: snapshot.agentId,
    turnId: snapshot.turnId,
  });
  assert.deepEqual(
    await fake.invoke({ wireName: "native__echo", freeform: false, arguments: { value: "x" } }),
    { content: [{ type: "text", text: "fake:echo" }] },
  );
  await assert.rejects(
    () => fake.invoke({ wireName: "bridge__forged", freeform: false, arguments: {} }),
    /not authorized/i,
  );
  assert.deepEqual(fakeResults, ["echo"]);
  console.log("ok transport authorization is independent of MCP");
}

{
  const nativeAllowed = chatGptGatewayAllowedToolNames(snapshot, "native");
  assert.deepEqual(nativeAllowed.sort(), ["codex_tool_call", "exec", "read_file"].sort());
  assert.equal(nativeAllowed.includes("forged_tool"), false);

  const safeAllowed = chatGptGatewayAllowedToolNames(snapshot, "safe");
  assert.deepEqual(safeAllowed, ["read_file"]);
  assert.equal(safeAllowed.includes("forged_tool"), false);
  assert.equal(safeAllowed.includes("codex_tool_call"), false);
  assert.equal(safeAllowed.includes("exec"), false);
  assert.equal(safeAllowed.includes("native__echo"), false);
  console.log("ok gateway allowlist is derived from the immutable snapshot and contract policy");
}

{
  const brokerRoot = mkdtempSync(join(tmpdir(), "dsh-chatgpt-web-10b-"));
  const socketPath = join(brokerRoot, "broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  let currentToken: string | undefined;

  try {
    currentToken = await broker.register(environment, 5_000, "trace-10b");
    const claim = await callTurnBroker<{
      bindingId: string;
      activityId: string;
      environment: typeof environment & { expiresAt?: number };
    }>(socketPath, {
      method: "claim",
      token: currentToken,
      activityId: "activity_10b_duplicate_delivery",
      contract: "native",
    });
    assert.equal(claim.environment.capabilitySnapshot?.snapshotId, snapshot.snapshotId);

    const pending = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claim.bindingId,
      capabilitySnapshotId: snapshot.snapshotId,
      wireName: "native__echo",
      freeform: false,
      arguments: { value: "duplicate" },
    });

    const first = await broker.nextToolBatch(currentToken);
    assert.equal(first.length, 1);
    const replay = await broker.nextToolBatch(currentToken);
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.callId, first[0]!.callId);
    assert.equal(replay[0]!.wireName, first[0]!.wireName);

    const result: BrokerToolResult = {
      content: [{ type: "text", text: "done" }],
      structuredContent: { ok: true },
      _meta: { call: first[0]!.callId },
    };
    broker.completeTool(currentToken, first[0]!.callId, result);
    assert.deepEqual(await pending, result);

    await assert.rejects(
      () => callTurnBroker(socketPath, {
        method: "invoke",
        bindingId: claim.bindingId,
        capabilitySnapshotId: "wrong-snapshot",
        wireName: "native__echo",
        freeform: false,
        arguments: { value: "widen" },
      }),
      /does not match the active immutable capability snapshot/i,
    );

    const cancelledInvocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claim.bindingId,
      capabilitySnapshotId: snapshot.snapshotId,
      wireName: "native__echo",
      freeform: false,
      arguments: { value: "cancelled" },
    });
    await new Promise(resolve => setImmediate(resolve));
    await broker.revoke(currentToken, new Error("cancelled turn"));
    await assert.rejects(cancelledInvocation, /cancelled turn|revoked|turn binding/i);

    const staleToken = await broker.register(environment, 25, "trace-10b-stale");
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(
      () => callTurnBroker(socketPath, {
        method: "claim",
        token: staleToken,
        activityId: "activity_10b_stale_binding",
        contract: "native",
      }),
      /invalid, expired, or revoked|already finished/i,
    );

    const shutdownToken = await broker.register(environment, 5_000, "trace-10b-shutdown");
    const shutdownClaim = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: shutdownToken,
      activityId: "activity_10b_shutdown",
      contract: "native",
    });
    const shutdownInvocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: shutdownClaim.bindingId,
      capabilitySnapshotId: snapshot.snapshotId,
      wireName: "native__echo",
      freeform: false,
      arguments: { value: "shutdown" },
    });
    await new Promise(resolve => setImmediate(resolve));
    await broker.close();
    await assert.rejects(shutdownInvocation, /broker|turn|socket/i);
    currentToken = undefined;

    console.log("ok broker duplicate/reconnect identity, stale binding, cancellation and shutdown");
  } finally {
    if (currentToken) {
      try { broker.revoke(currentToken); } catch {}
    }
    await broker.close();
  }
}

{
  const staleSnapshot = projectChatGptCapabilities({
    sessionId: "session-stale",
    agentId: "agent-stale",
    turnId: "turn-stale",
    tools: [echoTool],
    expiresAt: Date.now() + 50,
  });
  const staleEnvironment = capabilitySnapshotForEnvironment({
    ...environment,
    tools: [echoTool],
  }, staleSnapshot);
  const transport = new BrokerCapabilityTransport({
    async invoke() {
      return { content: [{ type: "text", text: "should-not-run" }] };
    },
    revoke() {},
  }).bind({
    bindingId: "binding_stale",
    snapshot: staleSnapshot,
    snapshotId: staleSnapshot.snapshotId,
    sessionId: staleSnapshot.sessionId,
    agentId: staleSnapshot.agentId,
    turnId: staleSnapshot.turnId,
  });
  await new Promise(resolve => setTimeout(resolve, 75));
  await assert.rejects(
    () => transport.invoke({ wireName: "echo", freeform: false, arguments: { value: "late" } }),
    /expired/i,
  );
  assert.equal(staleEnvironment.capabilitySnapshot?.snapshotId, staleSnapshot.snapshotId);
  console.log("ok expired snapshot rejects late transport calls");
}

{
  const fakeMcpResponse = {
    content: [
      { type: "text", text: "transport text" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ],
    structuredContent: { data: { answer: 42 } },
    isError: true,
    _meta: { mime: "mixed" },
  } satisfies BrokerToolResult;
  const loopback = new BrokerCapabilityTransport({
    async invoke() {
      return fakeMcpResponse;
    },
    revoke() {},
  }).bind({
    bindingId: "binding_structured",
    snapshot,
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    agentId: snapshot.agentId,
    turnId: snapshot.turnId,
  });
  assert.deepEqual(
    await loopback.invoke({ wireName: "native__echo", freeform: false, arguments: { value: "structured" } }),
    fakeMcpResponse,
  );
  console.log("ok structured results cross the transport unchanged");
}

console.log("Issue #10-B capability transport tests passed.");
