import assert from "node:assert/strict";
import { authorizeCapability, capabilitySnapshotForEnvironment, projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";

const tool = {
  name: "exec_command",
  namespace: "codex",
  description: "Run a command",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
};
const secondTool = {
  name: "view_image",
  namespace: "",
  description: "View an image",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const snapshot = projectChatGptCapabilities({ sessionId: "session-1", agentId: "agent-1", turnId: "turn-1", tools: [tool, secondTool] });
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.tools), true);
assert.equal(Object.isFrozen(snapshot.tools[0]), true);
assert.equal(Object.isFrozen(snapshot.tools[0]!.parameters), true);
assert.doesNotThrow(() => authorizeCapability(snapshot, { wireName: "codex/exec_command" }));
assert.doesNotThrow(() => authorizeCapability(snapshot, { wireName: "view_image" }));
assert.throws(() => authorizeCapability(snapshot, { wireName: "shell_command" }), /not authorized/);
assert.throws(() => authorizeCapability(snapshot, { wireName: "codex/exec_command" }, { lifecycle: "retired" }), /retired/);

const source = [tool];
const isolated = projectChatGptCapabilities({ sessionId: "session-2", agentId: "agent-2", turnId: "turn-2", tools: source });
source.push(secondTool);
assert.equal(isolated.tools.length, 1);
assert.throws(() => authorizeCapability(isolated, { wireName: "view_image" }), /not authorized/);

const reordered = projectChatGptCapabilities({ sessionId: "session-2", agentId: "agent-2", turnId: "turn-2", tools: [tool] });
assert.equal(reordered.snapshotId, isolated.snapshotId);
const differentTurn = projectChatGptCapabilities({ sessionId: "session-2", agentId: "agent-2", turnId: "turn-3", tools: [tool] });
assert.notEqual(differentTurn.snapshotId, isolated.snapshotId);

const expiring = projectChatGptCapabilities({ sessionId: "session-3", turnId: "turn-4", tools: [tool], expiresAt: Date.now() + 1000 });
assert.throws(() => authorizeCapability(expiring, { wireName: "codex/exec_command" }, { lifecycle: "active", now: expiring.expiresAt! }), /expired/);

const environment = {
  cwd: "/workspace", roots: ["/workspace"], writableRoots: ["/workspace"],
  sandboxPolicy: { type: "workspaceWrite" as const, networkAccess: true }, tools: [tool, secondTool],
};
const bound = capabilitySnapshotForEnvironment(environment, snapshot);
assert.equal(bound.capabilitySnapshot.snapshotId, snapshot.snapshotId);
assert.throws(() => capabilitySnapshotForEnvironment({ ...environment, tools: [tool] }, snapshot), /does not match/);

console.log("Issue #10-A capability projection tests passed.");
