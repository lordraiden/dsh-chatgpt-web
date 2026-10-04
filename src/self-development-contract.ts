export type SelfDevelopmentCapability =
  | "filesystem-read"
  | "filesystem-write"
  | "execution"
  | "git-read"
  | "diagnostics-read";

export interface SelfDevelopmentPolicy {
  readonly workspaceRoot: string;
  readonly writable: boolean;
  readonly capabilities: readonly SelfDevelopmentCapability[];
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly networkAccess: boolean;
  readonly approvalPolicy: "ask" | "never";
}

/**
 * Build the provider-facing statement of the DSH-owned self-development perimeter.
 * This is descriptive only: enforcement remains in DSH's agent-scoped tools,
 * sandbox and approval services.
 */
export function selfDevelopmentPolicyFromDshEnvironment(input: {
  workspaceRoot: string;
  sandboxMode: SelfDevelopmentPolicy["sandboxMode"];
  networkAccess?: boolean;
  approvalPolicy?: SelfDevelopmentPolicy["approvalPolicy"];
  availableTools?: readonly string[];
}): SelfDevelopmentPolicy {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) throw new Error("Self-development policy requires an explicit workspace root");
  const available = new Set(input.availableTools ?? []);
  const capabilities: SelfDevelopmentCapability[] = [];

  if (available.has("read") || available.has("glob") || available.has("grep")) {
    capabilities.push("filesystem-read");
  }
  if (available.has("write") || available.has("edit")) {
    capabilities.push("filesystem-write");
  }
  if (available.has("bash") || available.has("pwsh")) capabilities.push("execution");
  if (available.some(name => name === "git.status" || name === "git.diff" || name === "git.log" || name === "git.branch")) {
    capabilities.push("git-read");
  }
  if (available.some(name => name === "diagnostics.list" || name === "diagnostics.read" || name === "diagnostics.summary")) {
    capabilities.push("diagnostics-read");
  }

  return Object.freeze({
    workspaceRoot,
    writable: input.sandboxMode !== "read-only" && capabilities.includes("filesystem-write"),
    capabilities: Object.freeze(capabilities),
    sandboxMode: input.sandboxMode,
    networkAccess: input.networkAccess === true,
    approvalPolicy: input.approvalPolicy ?? "ask",
  });
}
