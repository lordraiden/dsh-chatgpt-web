import { createHash } from "node:crypto";
import { namespacedToolName, type CodexTool } from "../../types";

export type CapabilityLifecycle = "active" | "cancelled" | "retired" | "expired";

export interface CapabilitySnapshot {
  readonly snapshotId: string;
  /** Canonical DSH session identity; never the provider-private ChatGPT conversation identity. */
  readonly sessionId: string;
  /** Canonical DSH agent identity represented at this provider boundary. */
  readonly agentId: string;
  readonly turnId: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  /**
   * Immutable snapshot state. Runtime lifecycle is supplied out-of-band by the trusted turn
   * coordinator so cancellation/retirement can revoke an otherwise immutable snapshot.
   */
  readonly lifecycle: "active";
  readonly tools: readonly CodexTool[];
}

export interface CapabilityRequest {
  readonly wireName: string;
}

export interface CapabilityAuthorizationContext {
  readonly lifecycle: CapabilityLifecycle;
  readonly now?: number;
}

export interface BoundCapabilityEnvironment {
  readonly capabilitySnapshot: CapabilitySnapshot;
}

function stableTool(tool: CodexTool): unknown {
  return canonicalize({
    name: tool.name,
    namespace: tool.namespace ?? null,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.freeform !== undefined ? { freeform: tool.freeform } : {}),
    ...(tool.toolSearch !== undefined ? { toolSearch: tool.toolSearch } : {}),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map(key => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function cloneTools(tools: readonly CodexTool[]): readonly CodexTool[] {
  return freezeDeep(structuredClone(tools));
}

function canonicalToolSet(tools: readonly CodexTool[]): string[] {
  return tools.map(stableTool).map(canonicalJson).sort();
}

function canonicalIdentity(
  sessionId: string,
  agentId: string,
  turnId: string,
  tools: readonly CodexTool[],
): string {
  return createHash("sha256").update(canonicalJson({
    sessionId,
    agentId,
    turnId,
    tools: canonicalToolSet(tools),
  })).digest("hex");
}

function assertUniqueWireNames(tools: readonly CodexTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    const wireName = wireCapabilityName(tool);
    if (!wireName) throw new Error("Capability snapshot contains a tool with an empty wire name");
    if (seen.has(wireName)) {
      throw new Error("Capability snapshot contains duplicate wire capability: " + wireName);
    }
    seen.add(wireName);
  }
}

export function projectChatGptCapabilities(input: {
  sessionId: string;
  agentId?: string;
  turnId: string;
  tools: readonly CodexTool[];
  expiresAt?: number;
}): CapabilitySnapshot {
  const sessionId = input.sessionId.trim();
  const agentId = input.agentId?.trim() || "default";
  const turnId = input.turnId.trim();
  const createdAt = Date.now();
  if (!sessionId) throw new Error("Capability snapshot requires a DSH session identity");
  if (!agentId) throw new Error("Capability snapshot requires a DSH agent identity");
  if (!turnId) throw new Error("Capability snapshot requires a DSH turn identity");
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= createdAt)) {
    throw new Error("Capability snapshot expiry must be a future finite timestamp");
  }

  const tools = cloneTools(input.tools);
  assertUniqueWireNames(tools);
  const snapshot: CapabilitySnapshot = {
    snapshotId: canonicalIdentity(sessionId, agentId, turnId, tools),
    sessionId,
    agentId,
    turnId,
    createdAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    lifecycle: "active",
    tools,
  };
  return freezeDeep(snapshot);
}

export function wireCapabilityName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

/**
 * Verify that the snapshot is internally consistent. This is an integrity/consistency check,
 * not an authority grant: callers still need the trusted DSH turn binding and lifecycle state.
 */
export function assertCapabilitySnapshotIntegrity(snapshot: CapabilitySnapshot): void {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Capability snapshot is invalid");
  }
  if (typeof snapshot.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotId)) {
    throw new Error("Capability snapshot id is invalid");
  }
  if (
    typeof snapshot.sessionId !== "string"
    || typeof snapshot.agentId !== "string"
    || typeof snapshot.turnId !== "string"
    || !snapshot.sessionId.trim()
    || !snapshot.agentId.trim()
    || !snapshot.turnId.trim()
  ) {
    throw new Error("Capability snapshot identity is invalid");
  }
  if (!Number.isFinite(snapshot.createdAt)) {
    throw new Error("Capability snapshot creation time is invalid");
  }
  if (
    snapshot.expiresAt !== undefined
    && (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= snapshot.createdAt)
  ) {
    throw new Error("Capability snapshot expiry is invalid");
  }
  if (snapshot.lifecycle !== "active" || !Array.isArray(snapshot.tools)) {
    throw new Error("Capability snapshot lifecycle or tool set is invalid");
  }
  assertUniqueWireNames(snapshot.tools);
  const expected = canonicalIdentity(snapshot.sessionId, snapshot.agentId, snapshot.turnId, snapshot.tools);
  if (snapshot.snapshotId !== expected) {
    throw new Error("Capability snapshot integrity check failed");
  }
}

export function authorizeCapability(
  snapshot: CapabilitySnapshot,
  request: CapabilityRequest,
  context: CapabilityAuthorizationContext = { lifecycle: "active" },
): CodexTool {
  assertCapabilitySnapshotIntegrity(snapshot);
  const now = context.now ?? Date.now();
  if (context.lifecycle !== "active") {
    throw new Error("Capability snapshot " + snapshot.snapshotId + " is " + context.lifecycle);
  }
  if (snapshot.expiresAt !== undefined && now >= snapshot.expiresAt) {
    throw new Error("Capability snapshot " + snapshot.snapshotId + " has expired");
  }
  const tool = snapshot.tools.find(candidate => wireCapabilityName(candidate) === request.wireName);
  if (!tool) {
    throw new Error("Capability is not authorized for this turn: " + request.wireName);
  }
  return tool;
}

export function assertCapabilitySnapshotBinding(
  snapshot: CapabilitySnapshot,
  binding: {
    sessionId: string;
    agentId: string;
    turnId: string;
    snapshotId: string;
  },
): void {
  assertCapabilitySnapshotIntegrity(snapshot);
  if (
    snapshot.snapshotId !== binding.snapshotId
    || snapshot.sessionId !== binding.sessionId
    || snapshot.agentId !== binding.agentId
    || snapshot.turnId !== binding.turnId
  ) {
    throw new Error("Capability snapshot binding does not match the active DSH turn");
  }
}

export function capabilitySnapshotForEnvironment<T extends { tools: readonly CodexTool[] }>(
  environment: T,
  snapshot: CapabilitySnapshot,
): T & BoundCapabilityEnvironment {
  assertCapabilitySnapshotIntegrity(snapshot);
  const actualTools = canonicalToolSet(environment.tools);
  const projectedTools = canonicalToolSet(snapshot.tools);
  if (JSON.stringify(actualTools) !== JSON.stringify(projectedTools)) {
    throw new Error("Capability snapshot does not match the trusted Codex environment tool projection");
  }
  return Object.assign({}, environment, { capabilitySnapshot: snapshot }) as T & BoundCapabilityEnvironment;
}
