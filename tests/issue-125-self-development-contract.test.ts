import { describe, expect, test } from "bun:test";
import { selfDevelopmentPolicyFromDshEnvironment } from "../src/self-development-contract";

describe("issue #125 self-development capability contract", () => {
  test("requires one explicit workspace root", () => {
    expect(() => selfDevelopmentPolicyFromDshEnvironment({
      workspaceRoot: " ",
      sandboxMode: "read-only",
    })).toThrow("explicit workspace root");
  });

  test("projects read-only sessions without inventing write capability", () => {
    const policy = selfDevelopmentPolicyFromDshEnvironment({
      workspaceRoot: "/repo/dsh-chatgpt-web",
      sandboxMode: "read-only",
      availableTools: ["read", "glob", "grep", "bash"],
    });

    expect(policy.workspaceRoot).toBe("/repo/dsh-chatgpt-web");
    expect(policy.sandboxMode).toBe("read-only");
    expect(policy.writable).toBe(false);
    expect(policy.networkAccess).toBe(false);
    expect(policy.approvalPolicy).toBe("ask");
    expect(policy.capabilities).toEqual(expect.arrayContaining(["filesystem-read", "execution"]));
    expect(policy.capabilities).not.toContain("filesystem-write");
  });

  test("detects filesystem write separately from execution", () => {
    const policy = selfDevelopmentPolicyFromDshEnvironment({
      workspaceRoot: "/repo/dsh-chatgpt-web",
      sandboxMode: "workspace-write",
      availableTools: ["read", "write", "edit"],
    });

    expect(policy.writable).toBe(true);
    expect(policy.capabilities).toEqual(
      expect.arrayContaining(["filesystem-read", "filesystem-write"]),
    );
    expect(policy.capabilities).not.toContain("execution");
  });

  test("advertises Git and diagnostics only when their dedicated tools exist", () => {
    const policy = selfDevelopmentPolicyFromDshEnvironment({
      workspaceRoot: "/repo/dsh-chatgpt-web",
      sandboxMode: "workspace-write",
      availableTools: ["git.status", "git.diff", "diagnostics.list", "diagnostics.read"],
    });

    expect(policy.capabilities).toEqual(
      expect.arrayContaining(["git-read", "diagnostics-read"]),
    );
    expect(policy.capabilities).not.toContain("filesystem-read");
    expect(policy.capabilities).not.toContain("execution");
  });

  test("defaults approval to ask and does not imply network access", () => {
    const policy = selfDevelopmentPolicyFromDshEnvironment({
      workspaceRoot: "/repo/dsh-chatgpt-web",
      sandboxMode: "workspace-write",
      availableTools: ["read", "write", "bash"],
    });

    expect(policy.approvalPolicy).toBe("ask");
    expect(policy.networkAccess).toBe(false);
  });
});
