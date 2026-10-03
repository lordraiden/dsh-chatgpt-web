import {
  assertCapabilitySnapshotBinding,
  authorizeCapability,
  type CapabilityRequest,
  type CapabilitySnapshot,
} from "./capability-projector";
import type { CodexTool } from "../../types";

export interface CapabilityTransportBinding {
  readonly bindingId: string;
  readonly snapshot: CapabilitySnapshot;
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
}

export interface CapabilityTransportInvocation {
  readonly wireName: string;
  readonly freeform: boolean;
  readonly arguments?: Record<string, unknown>;
  readonly input?: string;
}

export interface AuthorizedCapabilityInvocation extends CapabilityTransportInvocation {
  readonly tool: CodexTool;
  readonly snapshotId: string;
}

export interface CapabilityToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

/**
 * Transport mechanics are deliberately injected. The dispatcher may be MCP, an in-memory test
 * double, or another Phase 1 transport; authorization always happens against the #10-A snapshot
 * before this callback is reached.
 */
export interface CapabilityTransportDispatcher {
  invoke(
    binding: CapabilityTransportBinding,
    invocation: AuthorizedCapabilityInvocation,
    signal?: AbortSignal,
  ): Promise<CapabilityToolResult>;
  revoke(binding: CapabilityTransportBinding, reason?: Error): Promise<void> | void;
}

export interface BoundCapabilityTransport {
  readonly binding: CapabilityTransportBinding;
  readonly snapshot: CapabilitySnapshot;
  authorize(request: CapabilityRequest): CodexTool;
  invoke(
    request: CapabilityTransportInvocation,
    signal?: AbortSignal,
  ): Promise<CapabilityToolResult>;
  revoke(reason?: Error): Promise<void>;
}

export interface CapabilityTransport {
  bind(binding: CapabilityTransportBinding): BoundCapabilityTransport;
}

function normalizeBinding(binding: CapabilityTransportBinding): CapabilityTransportBinding {
  if (!binding.bindingId || !/^[A-Za-z0-9_-]{8,256}$/.test(binding.bindingId)) {
    throw new Error("capability transport binding id is invalid");
  }
  assertCapabilitySnapshotBinding(binding.snapshot, {
    sessionId: binding.sessionId,
    agentId: binding.agentId,
    turnId: binding.turnId,
    snapshotId: binding.snapshotId,
  });
  if (binding.snapshot.lifecycle !== "active") {
    throw new Error("capability transport binding snapshot is not active");
  }
  if (binding.snapshot.expiresAt !== undefined && binding.snapshot.expiresAt <= Date.now()) {
    throw new Error("capability transport binding snapshot is expired");
  }
  return Object.freeze({ ...binding });
}

function invocationRequest(request: CapabilityTransportInvocation): CapabilityRequest {
  if (typeof request.wireName !== "string" || request.wireName.trim().length === 0 || request.wireName.length > 1_000) {
    throw new Error("capability transport wire name is invalid");
  }
  if (request.freeform) {
    if (request.input === undefined || typeof request.input !== "string") {
      throw new Error("freeform capability transport invocation requires string input");
    }
    if (request.arguments !== undefined) {
      throw new Error("freeform capability transport invocation cannot include structured arguments");
    }
  } else {
    if (request.input !== undefined) {
      throw new Error("structured capability transport invocation cannot include freeform input");
    }
    if (request.arguments !== undefined && (typeof request.arguments !== "object" || request.arguments === null || Array.isArray(request.arguments))) {
      throw new Error("structured capability transport arguments are invalid");
    }
  }
  return { wireName: request.wireName };
}

export class BrokerCapabilityTransport implements CapabilityTransport {
  constructor(private readonly dispatcher: CapabilityTransportDispatcher) {}

  bind(rawBinding: CapabilityTransportBinding): BoundCapabilityTransport {
    const binding = normalizeBinding(rawBinding);
    let revoked = false;
    const assertLive = (): void => {
      if (revoked) throw new Error("capability transport binding is revoked");
    };
    const authorize = (request: CapabilityRequest): CodexTool => {
      assertLive();
      return authorizeCapability(binding.snapshot, request, { lifecycle: "active" });
    };

    return {
      binding,
      snapshot: binding.snapshot,
      authorize,
      invoke: async (request, signal) => {
        const capabilityRequest = invocationRequest(request);
        const tool = authorize(capabilityRequest);
        if (request.freeform !== (tool.freeform === true)) {
          throw new Error(
            `capability transport invocation mode does not match the authorized tool: ${capabilityRequest.wireName}`,
          );
        }
        assertLive();
        return this.dispatcher.invoke(binding, {
          ...request,
          wireName: capabilityRequest.wireName,
          tool,
          snapshotId: binding.snapshotId,
        }, signal);
      },
      revoke: async reason => {
        if (revoked) return;
        revoked = true;
        await this.dispatcher.revoke(binding, reason);
      },
    };
  }
}
