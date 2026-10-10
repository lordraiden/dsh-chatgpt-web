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

// `createdAt` is part of the canonical identity, so two projections that must compare equal pin
// the same creation time instead of racing the wall clock (the previous flake: the two
// `Date.now()` reads straddled a millisecond and the ids differed).
const CREATED_AT = 1_700_000_000_000;
const reordered = projectChatGptCapabilities({
  sessionId: "session-2",
  agentId: "agent-2",
  turnId: "turn-2",
  createdAt: CREATED_AT,
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
  createdAt: CREATED_AT,
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
// The clock is why the old comparison raced: the same canonical inputs at a different creation
// time are a different snapshot, which is the identity rule this assertion exists to pin.
const recreatedLater = projectChatGptCapabilities({
  sessionId: "session-2",
  agentId: "agent-2",
  turnId: "turn-2",
  createdAt: CREATED_AT + 1,
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
assert.notEqual(recreatedLater.snapshotId, reordered.snapshotId);
assert.equal(recreatedLater.createdAt, CREATED_AT + 1);
console.log("ok capability snapshot identity is key-order stable and clock-explicit");

{
  // The constructor and the integrity/authorization validators must enforce the SAME creation-time
  // invariant: a fractional or unsafe timestamp may not be constructed and then refused later.
  const base = { sessionId: "session-clock", agentId: "agent-clock", turnId: "turn-clock", tools: [canonicalEnvironmentTool] };
  for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => projectChatGptCapabilities({ ...base, createdAt: invalid }),
      /createdAt must be a non-negative safe integer/,
      `createdAt ${invalid} must be refused at construction`,
    );
  }
  const explicit = projectChatGptCapabilities({ ...base, createdAt: CREATED_AT });
  assert.equal(explicit.createdAt, CREATED_AT);
  assert.doesNotThrow(() => assertCapabilitySnapshotIntegrity(explicit));
  assert.doesNotThrow(() => authorizeCapability(explicit, { wireName: "codex__exec_command" }));
  const fromClock = projectChatGptCapabilities(base);
  assert.ok(Number.isSafeInteger(fromClock.createdAt) && fromClock.createdAt > 0);
  console.log("ok capability snapshot creation time is a safe integer everywhere");
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
