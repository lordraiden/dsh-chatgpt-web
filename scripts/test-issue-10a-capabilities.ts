import assert from "node:assert/strict";
import type { CodexTool } from "../src/types";
import {
  assertCapabilitySnapshotBinding,
  assertCapabilitySnapshotIntegrity,
  authorizeCapability,
  capabilitySnapshotForEnvironment,
  projectChatGptCapabilities,
} from "../src/adapters/chatgpt-web/capability-projector";

const tool: CodexTool = {
  name: "exec_command",
  namespace: "codex",
  description: "Run a command",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};
const secondTool: CodexTool = {
  name: "view_image",
  namespace: "",
  description: "View an image",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const canonicalEnvironmentTool = structuredClone(tool);

const snapshot = projectChatGptCapabilities({
  sessionId: "session-1",
  agentId: "agent-1",
  turnId: "turn-1",
  tools: [tool, secondTool],
});
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.tools), true);
assert.equal(Object.isFrozen(snapshot.tools[0]), true);
assert.equal(Object.isFrozen(snapshot.tools[0]!.parameters), true);
assert.doesNotThrow(() => assertCapabilitySnapshotIntegrity(snapshot));
assert.doesNotThrow(() => authorizeCapability(snapshot, { wireName: "codex__exec_command" }));
assert.doesNotThrow(() => authorizeCapability(snapshot, { wireName: "view_image" }));
assert.throws(() => authorizeCapability(snapshot, { wireName: "codex/exec_command" }), /not authorized/);
assert.throws(() => authorizeCapability(snapshot, { wireName: "shell_command" }), /not authorized/);
assert.throws(
  () => authorizeCapability(snapshot, { wireName: "codex__exec_command" }, { lifecycle: "retired" }),
  /retired/,
);

const source = [tool];
const isolated = projectChatGptCapabilities({
  sessionId: "session-2",
  agentId: "agent-2",
  turnId: "turn-2",
  tools: source,
});
source.push(secondTool);
tool.parameters.properties = { cmd: { type: "string", minLength: 1 } };
assert.equal(isolated.tools.length, 1);
assert.equal(
  (isolated.tools[0]!.parameters.properties as Record<string, unknown>).cmd !== undefined,
  true,
);
assert.throws(() => authorizeCapability(isolated, { wireName: "view_image" }), /not authorized/);

const originalNow = Date.now;
Date.now = () => 1_700_000_000_000;
try {
  const reordered = projectChatGptCapabilities({
    sessionId: "session-2",
    agentId: "agent-2",
    turnId: "turn-2",
    tools: [{
      ...canonicalEnvironmentTool,
      parameters: {
        additionalProperties: false,
        required: ["cmd"],
        type: "object",
        properties: { cmd: { type: "string" } },
      },
    }],
  });
  const reorderedEquivalent = projectChatGptCapabilities({
    sessionId: "session-2",
    agentId: "agent-2",
    turnId: "turn-2",
    tools: [{
      ...canonicalEnvironmentTool,
      parameters: {
        properties: { cmd: { type: "string" } },
        type: "object",
        required: ["cmd"],
        additionalProperties: false,
      },
    }],
  });
  assert.equal(reordered.snapshotId, reorderedEquivalent.snapshotId);
  
} finally {
  Date.now = originalNow;
}

const differentTurn = projectChatGptCapabilities({
  sessionId: "session-2",
  agentId: "agent-2",
  turnId: "turn-3",
  tools: [{
    ...canonicalEnvironmentTool,
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
      additionalProperties: false,
    },
  }],
});
assert.notEqual(differentTurn.snapshotId, isolated.snapshotId);

const flattenedCollision: CodexTool = {
  ...canonicalEnvironmentTool,
  namespace: "",
  name: "codex__exec_command",
};
assert.throws(
  () => projectChatGptCapabilities({
    sessionId: "collision",
    agentId: "agent",
    turnId: "turn",
    tools: [canonicalEnvironmentTool, flattenedCollision],
  }),
  /duplicate wire capability/,
);

const expiring = projectChatGptCapabilities({
  sessionId: "session-3",
  turnId: "turn-4",
  tools: [canonicalEnvironmentTool],
  expiresAt: Date.now() + 1000,
});
assert.throws(
  () => authorizeCapability(
    expiring,
    { wireName: "codex__exec_command" },
    { lifecycle: "active", now: expiring.expiresAt! },
  ),
  /expired/,
);

const laterExpiry = projectChatGptCapabilities({
  sessionId: "session-3",
  turnId: "turn-4",
  tools: [canonicalEnvironmentTool],
  expiresAt: expiring.expiresAt! + 60_000,
});
assert.notEqual(laterExpiry.snapshotId, expiring.snapshotId);

const expiryTampered = {
  ...structuredClone(expiring),
  expiresAt: expiring.expiresAt! + 60_000,
};
assert.throws(
  () => assertCapabilitySnapshotIntegrity(expiryTampered as typeof expiring),
  /integrity check failed/,
);

const creationTimeTampered = {
  ...structuredClone(expiring),
  createdAt: expiring.createdAt - 1,
};
assert.throws(
  () => assertCapabilitySnapshotIntegrity(creationTimeTampered as typeof expiring),
  /integrity check failed/,
);

const tampered = structuredClone(snapshot) as typeof snapshot;
(tampered.tools[0]!.parameters as Record<string, unknown>).tampered = true;
assert.throws(
  () => assertCapabilitySnapshotIntegrity(tampered),
  /integrity check failed/,
);
assert.throws(
  () => assertCapabilitySnapshotBinding(tampered, {
    sessionId: tampered.sessionId,
    agentId: tampered.agentId,
    turnId: tampered.turnId,
    snapshotId: tampered.snapshotId,
  }),
  /integrity check failed/,
);

const environment = {
  cwd: "/workspace",
  roots: ["/workspace"],
  writableRoots: ["/workspace"],
  sandboxPolicy: { type: "workspaceWrite" as const, networkAccess: true },
  tools: [secondTool, canonicalEnvironmentTool],
};
const bound = capabilitySnapshotForEnvironment(environment, snapshot);
assert.equal(bound.capabilitySnapshot.snapshotId, snapshot.snapshotId);
assert.throws(
  () => capabilitySnapshotForEnvironment({ ...environment, tools: [canonicalEnvironmentTool] }, snapshot),
  /does not match/,
);
assert.throws(
  () => assertCapabilitySnapshotBinding(snapshot, {
    sessionId: "other-session",
    agentId: snapshot.agentId,
    turnId: snapshot.turnId,
    snapshotId: snapshot.snapshotId,
  }),
  /binding does not match/,
);

console.log("Issue #10-A capability projection tests passed.");
