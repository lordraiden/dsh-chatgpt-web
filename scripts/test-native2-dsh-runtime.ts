/**
 * Native2 -> DSH runtime integration test.
 *
 * This crosses the real MCP boundary instead of calling the plugin transport helpers
 * directly:
 *
 *   Codex Native2 MCP -> codex_tool_inventory -> codex_tool_call -> TurnBroker
 *   -> ctx.tools.execute -> DSH approval/sandbox -> TurnBroker -> MCP result
 *
 * DSH packages are loaded from the installed runtime instead of becoming plugin
 * dependencies. This keeps the test an explicit runtime integration seam.
 *
 * Run:
 *   bun run build
 *   DSH_RUNTIME_ROOT=/path/to/@deepseek-ai/dsh bun test ./scripts/test-native2-dsh-runtime.ts
 *
 * DSH_RUNTIME_ROOT defaults to the sibling lib/node_modules/@deepseek-ai/dsh
 * under the current Node/Bun installation prefix.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { projectChatGptCapabilities } from "../src/adapters/chatgpt-web/capability-projector";
import {
  callTurnBroker,
  TurnBroker,
} from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

interface LoadedDsh {
  Context: any;
  SystemPrompt: any;
  ToolRuntime: any;
  SessionProjectionRegistry: any;
  turnBoundaryProjectionDefinition: any;
  SandboxPolicyService: any;
  SandboxedFileSystem: any;
  FsPolicy: any;
  ToolFs: any;
  ApprovalService: any;
}

interface FakeAgent {
  id: string;
  session: {
    id: string;
    header: {
      version: number;
      id: string;
      createdAt: number;
      cwd: string;
      isSeeded: boolean;
    };
    inheritedEventCount: number;
    firstLiveSeq: number;
    readonly seq: number;
    eventAt: (seq: number) => { type: string; seq: number; time: number; data: Record<string, unknown> } | undefined;
    snapshotEvents: (fromSeq?: number, toSeqExclusive?: number) => Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }>;
    append: (type: string, data: Record<string, unknown>) => { type: string; seq: number; time: number; data: Record<string, unknown> };
  };
}

function runtimeRoot(): string {
  const configured = process.env.DSH_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  return resolve(dirname(process.execPath), "..", "lib", "node_modules", "@deepseek-ai", "dsh");
}

async function importRuntimeModule<T = any>(runtime: string, packageName: string): Promise<T> {
  const requireFromRuntime = createRequire(join(runtime, "package.json"));
  const entry = requireFromRuntime.resolve(packageName);
  return await import(pathToFileURL(entry).href) as T;
}

async function loadDsh(runtime: string): Promise<LoadedDsh> {
  const [
    cordis,
    systemPrompt,
    tools,
    sessionProjection,
    agentLoop,
    sandboxPolicy,
    fsSandbox,
    fsObservationPolicy,
    toolFs,
    approval,
  ] = await Promise.all([
    importRuntimeModule<any>(runtime, "@deepseek-ai/cordis"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-system-prompt"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-tools"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-session-projection"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-agent-loop"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-sandbox-policy"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-fs-sandbox"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-fs-observation-policy"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-tool-fs"),
    importRuntimeModule<any>(runtime, "@deepseek-ai/dsh-user-approval"),
  ]);

  return {
    Context: cordis.Context,
    SystemPrompt: systemPrompt.default ?? systemPrompt,
    ToolRuntime: tools.default ?? tools,
    SessionProjectionRegistry: sessionProjection.default ?? sessionProjection,
    turnBoundaryProjectionDefinition: agentLoop.turnBoundaryProjectionDefinition,
    SandboxPolicyService: sandboxPolicy.default ?? sandboxPolicy,
    SandboxedFileSystem: fsSandbox.default ?? fsSandbox,
    FsPolicy: fsObservationPolicy.default ?? fsObservationPolicy,
    ToolFs: toolFs.default ?? toolFs,
    ApprovalService: approval.default ?? approval,
  };
}

function createFakeAgent(workspaceRoot: string): FakeAgent {
  const id = "native2-dsh-agent";
  const events: Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> = [
    { type: "turn/start", seq: 0, time: 0, data: { turn: 1 } },
  ];

  return {
    id,
    session: {
      id: "native2-dsh-session",
      header: {
        version: 0,
        id,
        createdAt: 0,
        cwd: workspaceRoot,
        isSeeded: false,
      },
      inheritedEventCount: 0,
      firstLiveSeq: 0,
      get seq() {
        return events.length;
      },
      eventAt: (seq) => events[seq],
      snapshotEvents: (
        fromSeq = 0,
        toSeqExclusive = events.length,
      ) => events.slice(fromSeq, toSeqExclusive),
      append: (type, data) => {
        const event = {
          type,
          seq: events.length,
          time: events.length,
          data,
        };
        events.push(event);
        return event;
      },
    },
  };
}

function mcpText(result: any): string {
  const firstText = result?.content?.find?.((item: any) => item?.type === "text");
  return typeof firstText?.text === "string" ? firstText.text : "";
}

function structured<T>(result: any): T {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as T;
  }
  const text = mcpText(result);
  if (!text) throw new Error("MCP result did not contain structured content");
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const dshRoot = runtimeRoot();
  if (!existsSync(join(dshRoot, "package.json"))) {
    throw new Error(
      "DSH runtime not found. Set DSH_RUNTIME_ROOT to the installed @deepseek-ai/dsh package root.",
    );
  }

  const thisFile = fileURLToPath(import.meta.url);
  const cliPath = process.env.DSH_CHATGPT_WEB_CLI?.trim()
    ? resolve(process.env.DSH_CHATGPT_WEB_CLI)
    : resolve(dirname(thisFile), "..", "lib", "cli.js");

  if (!existsSync(cliPath)) {
    throw new Error(
      "Built dsh-chatgpt-web CLI not found at " + cliPath + "; run bun run build first",
    );
  }

  const dsh = await loadDsh(dshRoot);
  const ctx = new dsh.Context();
  const root = mkdtempSync(join(tmpdir(), "dsh-native2-runtime-"));
  const workspaceRoot = join(root, "workspace");
  const outsideRoot = mkdtempSync(join(homedir(), ".dsh-native2-outside-"));
  mkdirSync(workspaceRoot);
  const outsidePath = join(outsideRoot, "native2-approved.txt");
  const socketPath = join(root, "broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  const agent = createFakeAgent(workspaceRoot);

  let resolveApproval!: (outcome: "allowed-once" | "rejected") => void;
  const approvalDecision = new Promise<"allowed-once" | "rejected">((resolveDecision) => {
    resolveApproval = resolveDecision;
  });

  let approvalRequested = false;
  let resolveApprovalRequested!: () => void;
  let rejectApprovalRequested!: (error: Error) => void;
  const approvalWait = new Promise<void>((resolveWait, rejectWait) => {
    resolveApprovalRequested = resolveWait;
    rejectApprovalRequested = rejectWait;
  });
  const approvalTimer = setTimeout(() => {
    if (!approvalRequested) {
      rejectApprovalRequested(new Error("Timed out waiting for DSH approval/request"));
    }
  }, 10_000);

  try {
    await ctx.plugin(dsh.SystemPrompt);
    await ctx.plugin(dsh.ToolRuntime);
    await ctx.plugin(dsh.SessionProjectionRegistry);
    ctx.sessionProjections.register(dsh.turnBoundaryProjectionDefinition);
    await ctx.plugin(dsh.SandboxPolicyService, { mode: "workspace-write" });
    await ctx.plugin(dsh.SandboxedFileSystem, { cwd: workspaceRoot });
    await ctx.plugin(dsh.FsPolicy);
    await ctx.plugin(dsh.ApprovalService, { policy: "ask" });

    ctx.on("approval/request", () => {
      approvalRequested = true;
      clearTimeout(approvalTimer);
      resolveApprovalRequested();
      return approvalDecision;
    });

    await ctx.plugin(dsh.ToolFs);

    const writeSchema = ctx.tools.schemas().find((tool: any) => tool.name === "write");
    assert.ok(writeSchema, "the native DSH runtime must register the write tool");
    assert.deepEqual(
      writeSchema.parameters?.properties?.sandbox_permissions?.enum,
      ["workspace-write", "danger-full-access"],
      "the DSH write tool must expose the shared sandbox escalation contract",
    );

    const snapshot = projectChatGptCapabilities({
      sessionId: agent.session.id,
      agentId: agent.id,
      turnId: "native2-dsh-turn",
      tools: ctx.tools.schemas() as any,
    });

    const environment: ChatGptTurnEnvironment = {
      cwd: workspaceRoot,
      roots: [workspaceRoot],
      writableRoots: [workspaceRoot],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspaceRoot],
        networkAccess: false,
      },
      tools: structuredClone(snapshot.tools) as any,
      capabilitySnapshot: snapshot,
    };

    const turnToken = await broker.register(
      environment,
      60_000,
      "native2-dsh",
      false,
    );

    await broker.listen();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cliPath,
        "mcp",
        "--contract",
        "native",
        "--broker-socket",
        socketPath,
      ],
      stderr: "inherit",
    });
    const client = new Client(
      { name: "native2-dsh-integration-test", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);

      const serverTools = await client.listTools();
      const advertisedNames = serverTools.tools.map((tool: any) => tool.name);
      assert.ok(advertisedNames.includes("codex_tool_inventory"));
      assert.ok(advertisedNames.includes("codex_tool_call"));

      const inventoryResult = await client.callTool({
        name: "codex_tool_inventory",
        arguments: {
          turn_token: turnToken,
          query: "write",
          offset: 0,
          limit: 20,
          include_schema: true,
        },
      });
      assert.equal(inventoryResult.isError, undefined);

      const inventory = structured<{
        tools: Array<{
          wire_name: string;
          name: string;
          parameters?: Record<string, any>;
        }>;
        total: number;
        next_offset: number | null;
      }>(inventoryResult);

      const writeTool = inventory.tools.find(tool => tool.wire_name === "write");
      assert.ok(writeTool, "codex_tool_inventory must expose the DSH write tool");
      assert.equal(writeTool?.name, "write");
      assert.deepEqual(
        writeTool?.parameters?.properties
          ? Object.keys(writeTool.parameters.properties).sort()
          : [],
        Object.keys(writeSchema.parameters.properties).sort(),
        "inventory schema must come from the DSH tool registry projection",
      );

      const binding1 = await callTurnBroker<{
        bindingId: string;
        capabilityBinding: {
          bindingId: string;
          snapshotId: string;
          sessionId: string;
          agentId: string;
          turnId: string;
        };
        environment: ChatGptTurnEnvironment;
      }>(
        socketPath,
        {
          method: "claim",
          token: turnToken,
          activityId: "activity_native2_binding_01",
          contract: "native",
        },
      );

      assert.equal(binding1.bindingId, binding1.capabilityBinding.bindingId);
      assert.equal(binding1.capabilityBinding.snapshotId, snapshot.snapshotId);
      assert.equal(binding1.capabilityBinding.sessionId, snapshot.sessionId);
      assert.equal(binding1.capabilityBinding.agentId, snapshot.agentId);
      assert.equal(binding1.capabilityBinding.turnId, snapshot.turnId);

      await callTurnBroker(socketPath, {
        method: "activity_complete",
        token: turnToken,
        activityId: "activity_native2_binding_01",
      });

      const callPromise = client.callTool({
        name: "codex_tool_call",
        arguments: {
          turn_token: turnToken,
          wire_name: "write",
          arguments: {
            file_path: outsidePath,
            content: "native2 approval path",
            sandbox_permissions: "danger-full-access",
            justification: "The integration test intentionally writes outside the workspace to verify DSH approval.",
          },
        },
      });

      const [toolRequest] = await broker.nextToolBatch(turnToken);
      assert.ok(toolRequest, "codex_tool_call must arrive at the TurnBroker owner");
      assert.equal(toolRequest.wireName, "write");
      assert.deepEqual(toolRequest.arguments, {
        file_path: outsidePath,
        content: "native2 approval path",
        sandbox_permissions: "danger-full-access",
        justification: "The integration test intentionally writes outside the workspace to verify DSH approval.",
      });

      const dshExecution = ctx.tools.execute({
        signal: new AbortController().signal,
        callId: toolRequest.callId,
        name: toolRequest.wireName,
        arguments: toolRequest.arguments ?? {},
        agent: agent as any,
      });

      await approvalWait;
      assert.equal(approvalRequested, true);
      assert.equal(
        existsSync(outsidePath),
        false,
        "outside-workspace write must not happen before approval",
      );

      resolveApproval("allowed-once");

      const dshResult = await dshExecution;
      assert.equal(dshResult.isError, false);
      assert.equal(readFileSync(outsidePath, "utf8"), "native2 approval path");

      await broker.completeTool(turnToken, toolRequest.callId, {
        content: dshResult.content,
        ...(dshResult.isError ? { isError: true } : {}),
      });

      const callResult = await callPromise;
      assert.equal(callResult.isError, undefined);

      const callPayload = structured<{ content?: unknown[] }>(callResult);
      assert.deepEqual(callPayload.content, dshResult.content);

      const binding2 = await callTurnBroker<{
        bindingId: string;
        capabilityBinding: {
          bindingId: string;
          snapshotId: string;
          sessionId: string;
          agentId: string;
          turnId: string;
        };
      }>(
        socketPath,
        {
          method: "claim",
          token: turnToken,
          activityId: "activity_native2_binding_02",
          contract: "native",
        },
      );

      assert.equal(
        binding2.bindingId,
        binding1.bindingId,
        "the TurnBroker must preserve the original binding across Native2 MCP calls",
      );
      assert.equal(binding2.capabilityBinding.snapshotId, snapshot.snapshotId);

      await callTurnBroker(socketPath, {
        method: "activity_complete",
        token: turnToken,
        activityId: "activity_native2_binding_02",
      });

      console.log([
        "Native2 DSH runtime integration: PASS",
        "  codex_tool_inventory -> DSH write tool: PASS",
        "  codex_tool_call -> TurnBroker -> DSH ctx.tools.execute: PASS",
        "  immutable turn binding preserved: PASS",
        "  approval policy ask intercepted before filesystem mutation: PASS",
        "  outside-workspace write published only after allowed-once approval: PASS",
      ].join("\n"));
    } finally {
      await client.close().catch(() => undefined);
    }

    broker.revoke(turnToken);
  } finally {
    clearTimeout(approvalTimer);
    await broker.close();
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
