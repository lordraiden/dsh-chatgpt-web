import { createHash } from "node:crypto";
import type { CodexTool } from "../../types";

export type CapabilityLifecycle = "active" | "cancelled" | "retired" | "expired";

export interface CapabilitySnapshot {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly lifecycle: "active";
  readonly tools: readonly CodexTool[];
}

export interface CapabilityRequest { readonly wireName: string; }
export interface CapabilityAuthorizationContext { readonly lifecycle: CapabilityLifecycle; readonly now?: number; }
export interface BoundCapabilityEnvironment { readonly capabilitySnapshot: CapabilitySnapshot; }

function stableTool(tool: CodexTool): unknown {
  return { name: tool.name, namespace: tool.namespace ?? null, description: tool.description, parameters: tool.parameters,
    ...(tool.freeform === true ? { freeform: true } : {}), ...(tool.toolSearch === true ? { toolSearch: true } : {}) };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function cloneTools(tools: readonly CodexTool[]): readonly CodexTool[] { return freezeDeep(structuredClone(tools)); }

function canonicalIdentity(sessionId: string, agentId: string, turnId: string, tools: readonly CodexTool[]): string {
  const canonical = JSON.stringify({ sessionId, agentId, turnId,
    tools: [...tools].map(stableTool).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  return createHash("sha256").update(canonical).digest("hex");
}

export function projectChatGptCapabilities(input: {
  sessionId: string; agentId?: string; turnId: string; tools: readonly CodexTool[]; expiresAt?: number;
}): CapabilitySnapshot {
  if (!input.sessionId.trim()) throw new Error("Capability snapshot requires a DSH session identity");
  if (!input.turnId.trim()) throw new Error("Capability snapshot requires a DSH turn identity");
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()))
    throw new Error("Capability snapshot expiry must be a future finite timestamp");
  const sessionId = input.sessionId, agentId = input.agentId?.trim() || "default", turnId = input.turnId;
  const tools = cloneTools(input.tools);
  const snapshot: CapabilitySnapshot = { snapshotId: canonicalIdentity(sessionId, agentId, turnId, tools),
    sessionId, agentId, turnId, createdAt: Date.now(), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    lifecycle: "active", tools };
  return freezeDeep(snapshot);
}

export function wireCapabilityName(tool: CodexTool): string {
  const namespace = tool.namespace?.trim();
  return namespace ? `${namespace}/${tool.name}` : tool.name;
}

export function authorizeCapability(snapshot: CapabilitySnapshot, request: CapabilityRequest,
  context: CapabilityAuthorizationContext = { lifecycle: "active" }): CodexTool {
  const now = context.now ?? Date.now();
  if (context.lifecycle !== "active") throw new Error(`Capability snapshot ${snapshot.snapshotId} is ${context.lifecycle}`);
  if (snapshot.expiresAt !== undefined && now >= snapshot.expiresAt) throw new Error(`Capability snapshot ${snapshot.snapshotId} has expired`);
  const tool = snapshot.tools.find(candidate => wireCapabilityName(candidate) === request.wireName);
  if (!tool) throw new Error(`Capability is not authorized for this turn: ${request.wireName}`);
  return tool;
}

export function assertCapabilitySnapshotBinding(snapshot: CapabilitySnapshot, binding: { sessionId: string; agentId: string; turnId: string; snapshotId: string }): void {
  if (snapshot.snapshotId !== binding.snapshotId || snapshot.sessionId !== binding.sessionId || snapshot.agentId !== binding.agentId || snapshot.turnId !== binding.turnId)
    throw new Error("Capability snapshot binding does not match the active DSH turn");
}

export function capabilitySnapshotForEnvironment<T extends { tools: readonly CodexTool[] }>(environment: T, snapshot: CapabilitySnapshot): T & BoundCapabilityEnvironment {
  const same = JSON.stringify(environment.tools.map(stableTool)) === JSON.stringify(snapshot.tools.map(stableTool));
  if (!same) throw new Error("Capability snapshot does not match the trusted Codex environment tool projection");
  return Object.assign({}, environment, { capabilitySnapshot: snapshot }) as T & BoundCapabilityEnvironment;
}