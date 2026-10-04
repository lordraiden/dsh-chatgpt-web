export interface CapabilityBinding {
  /** TurnBroker-owned opaque correlation handle. */
  readonly bindingId: string;
  /** Snapshot identity supplied by the trusted DSH/provider runtime binding. */
  readonly snapshotId: string;
  /** Canonical DSH session identity supplied out of band from the model. */
  readonly sessionId: string;
  /** Canonical DSH agent identity supplied out of band from the model. */
  readonly agentId: string;
  /** Canonical DSH turn identity supplied out of band from the model. */
  readonly turnId: string;
}

/**
 * Transport-neutral structured DSH tool result. MCP or another transport may serialize it, but no
 * transport-specific layer owns the result semantics.
 */
export interface CapabilityToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}
