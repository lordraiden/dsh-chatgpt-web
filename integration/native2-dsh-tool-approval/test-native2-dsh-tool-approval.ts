import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { Context } from "@deepseek-ai/cordis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { runChatGptMcpServer } from "../../src/adapters/chatgpt-web/mcp-server.ts";
import { projectChatGptCapabilities } from "../../src/adapters/chatgpt-web/capability-projector.ts";
import {
  TurnBroker,
  callTurnBroker,
  type BrokerToolResult,
} from "../../src/adapters/chatgpt-web/turn-broker.ts";
import type { ChatGptTurnEnvironment } from "../../src/adapters/chatgpt-web/environment.ts";
import type { CodexTool } from "../../src/types.ts";

import ToolRuntime from "@deepseek-ai/dsh-tools";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ApprovalService, {
  type ApprovalOutcome,
  type ApprovalRequest,
} from "@deepseek-ai/dsh-user-approval";
import SandboxPolicyService from "@deepseek-ai/dsh-sandbox-policy";
import SandboxedFileSystem from "@deepseek-ai/dsh-fs-sandbox";
import { apply as applyFsTools } from "@deepseek-ai/dsh-tool-fs";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

const ROOT = resolve(import.meta.dir);
const TEST_WORKSPACE = join(ROOT, `.workspace-${randomUUID()}`);
const OUTSIDE_PATH = join(ROOT, `.outside-${randomUUID()}.txt`);
const SOCKET_PATH = `/tmp/dsh-cgw-${randomUUID().replaceAll("-", "").slice(0, 20)}.sock`;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function mcpJson(result: { content?: unknown[] }): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find(value => (
    value
    && typeof value === "object"
    && (value as Record<string, unknown>).type === "text"
    && typeof (value as Record<string, unknown>).text === "string"
  )) as Record<string, unknown> | undefined;
  assert.ok(textPart, "MCP result did not contain a text content part");
  return asRecord(JSON.parse(String(textPart.text)));
}

function sessionEvents(session: {
  seq: number;
  eventAt(seq: number): { type: string; data: unknown } | undefined;
}): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event) events.push(event);
  }
  return events;
}

async function runNative2Integration(): Promise<void> {
  mkdirSync(TEST_WORKSPACE, { recursive: true });

  const ctx = new Context();
  const broker = TurnBroker.forSocket(SOCKET_PATH);
  await broker.listen();

  let disposeApproval: (() => void) | undefined;
  let resolveApproval: ((outcome: ApprovalOutcome) => void) | undefined;
  let approvalSeenResolve!: (request: ApprovalRequest) => void;
  const approvalSeen = new Promise<ApprovalRequest>(resolveSeen => {
    approvalSeenResolve = resolveSeen;
  });

  try {
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(SessionStore);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(ApprovalService, { policy: "ask" });
    await ctx.plugin(SandboxPolicyService, {
      mode: "workspace-write",
      workspaceRoot: TEST_WORKSPACE,
    });
    await ctx.plugin(SandboxedFileSystem, { cwd: TEST_WORKSPACE });
    applyFsTools(ctx, {\n      readLimit: 2000,\n      readMaxLineLength: 2000,\n      readMaxBytes: 50 * 1024,\n      readStreamMinSize: 10 * 1024 * 1024,\n    });

    disposeApproval = ctx.on("approval/request", request => {
      approvalSeenResolve(request as ApprovalRequest);
      return new Promise<ApprovalOutcome>(resolveOutcome => {
        resolveApproval = resolveOutcome;
      });
    });

    const session = ctx.sessions.create(SessionId(`native2-${randomUUID()}`), {
      meta: { cwd: TEST_WORKSPACE },
    });
    session.append("turn/start", { turn: 1 });

    const agent = { session } as unknown as Agent;
    const assembly = await ctx.systemPrompt.assemble({ agent });
    const approvalContext = assembly.contexts.find(context => context.name === "approval:policy");
    assert.equal(
      approvalContext?.text,
      "Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.",
    );

    const schemas = ctx.tools.schemas();
    const writeSchema = schemas.find(schema => schema.name === "write");
    assert.ok(writeSchema, "native DSH write tool is not registered");
    const writeTool: CodexTool = {
      name: writeSchema.name,
      description: writeSchema.description,
      parameters: writeSchema.parameters,
    };
    assert.match(JSON.stringify(writeTool.parameters), /sandbox_permissions/);
    assert.match(JSON.stringify(writeTool.parameters), /justification/);

    const snapshot = projectChatGptCapabilities({
      sessionId: String(session.id),
      agentId: "native2-agent",
      turnId: "native2-turn",
      tools: [writeTool],
    });

    const environment: ChatGptTurnEnvironment = {
      cwd: TEST_WORKSPACE,
      roots: [TEST_WORKSPACE],
      writableRoots: [TEST_WORKSPACE],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [TEST_WORKSPACE],
        networkAccess: false,
      },
      tools: [writeTool],
      capabilitySnapshot: snapshot,
    };

    const token = await broker.register(environment, 60_000, "native2-e2e");
    const initialClaim = await callTurnBroker<{
      bindingId: string;
      activityId: string;
      capabilityBinding: {
        bindingId: string;
        snapshotId: string;
        sessionId: string;
        agentId: string;
        turnId: string;
      };
    }>(
      SOCKET_PATH,
      {
        method: "claim",
        token,
        activityId: `activity_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        contract: "native",
      },
    );

    assert.equal(initialClaim.capabilityBinding.snapshotId, snapshot.snapshotId);
    assert.equal(initialClaim.capabilityBinding.sessionId, snapshot.sessionId);
    assert.equal(initialClaim.capabilityBinding.agentId, snapshot.agentId);
    assert.equal(initialClaim.capabilityBinding.turnId, snapshot.turnId);
    assert.equal(initialClaim.bindingId, initialClaim.capabilityBinding.bindingId);

    await callTurnBroker(
      SOCKET_PATH,
      {
        method: "activity_complete",
        token,
        activityId: initialClaim.activityId,
      },
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "test-native2-dsh-tool-approval.ts"), "--native2-mcp", SOCKET_PATH],
    });
    const client = new Client(
      { name: "native2-dsh-tool-approval", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    try {
      const inventory = mcpJson(await client.callTool({
        name: "codex_tool_inventory",
        arguments: {
          turn_token: token,
          query: "write",
          offset: 0,
          limit: 20,
          include_schema: true,
        },
      }));

      const inventoryTools = Array.isArray(inventory.tools) ? inventory.tools : [];
      const inventoryWrite = inventoryTools.find(value => (
        asRecord(value).wire_name === "write"
      ));
      assert.ok(inventoryWrite, "write tool is missing from codex_tool_inventory");
      assert.equal(asRecord(inventoryWrite).kind, "function");

      const argumentsToSend = {
        file_path: OUTSIDE_PATH,
        content: "native2 approval gate",
        sandbox_permissions: "danger-full-access",
        justification: "integration test must prove an out-of-workspace write waits for approval",
      };

      const callPromise = client.callTool({
        name: "codex_tool_call",
        arguments: {
          turn_token: token,
          wire_name: "write",
          arguments: argumentsToSend,
        },
      });

      const toolRequests = await broker.nextToolBatch(token);

      assert.equal(toolRequests.length, 1);
      const request = toolRequests[0]!;
      assert.equal(request.wireName, "write");
      assert.equal(typeof request.callId, "string");
      assert.deepEqual(request.arguments, argumentsToSend);
      assert.equal(existsSync(OUTSIDE_PATH), false);

      const toolExecution = ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(String(request.callId)),
        name: "write",
        arguments: request.arguments,
        agent,
      });

      const approvalRequest = await approvalSeen;
      assert.equal(approvalRequest.toolName, "write");
      assert.equal(String(approvalRequest.callId), String(request.callId));

      const eventsBeforeApproval = sessionEvents(session);
      assert.ok(eventsBeforeApproval.some(event => event.type === "approval/asked"));
      assert.ok(!eventsBeforeApproval.some(event => event.type === "approval/decided"));
      assert.equal(typeof resolveApproval, "function");

      let settledBeforeApproval = false;
      void toolExecution.then(
        () => { settledBeforeApproval = true; },
        () => { settledBeforeApproval = true; },
      );

      await Promise.resolve();
      assert.equal(settledBeforeApproval, false);
      assert.equal(existsSync(OUTSIDE_PATH), false);

      resolveApproval!("allowed-once");
      const dshResult = await toolExecution;
      assert.equal(dshResult.isError, false);
      assert.equal(existsSync(OUTSIDE_PATH), true);

      const brokerResult: BrokerToolResult = {
        content: dshResult.content,
        ...(dshResult.isError ? { isError: true } : {}),
      };
      await broker.completeTool(token, String(request.callId), brokerResult);

      const result = mcpJson(await callPromise);
      assert.match(JSON.stringify(result), /Created file/);

      const bindingAfterInvocation = await callTurnBroker<{
        bindingId: string;
        activityId: string;
        capabilityBinding: {
          bindingId: string;
          snapshotId: string;
          sessionId: string;
          agentId: string;
          turnId: string;
        };
      }>(
        SOCKET_PATH,
        {
          method: "claim",
          token,
          activityId: `activity_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          contract: "native",
        },
      );

      assert.equal(bindingAfterInvocation.bindingId, initialClaim.bindingId);
      assert.equal(bindingAfterInvocation.capabilityBinding.bindingId, initialClaim.capabilityBinding.bindingId);
      assert.equal(bindingAfterInvocation.capabilityBinding.snapshotId, initialClaim.capabilityBinding.snapshotId);
      assert.equal(bindingAfterInvocation.capabilityBinding.sessionId, initialClaim.capabilityBinding.sessionId);
      assert.equal(bindingAfterInvocation.capabilityBinding.agentId, initialClaim.capabilityBinding.agentId);
      assert.equal(bindingAfterInvocation.capabilityBinding.turnId, initialClaim.capabilityBinding.turnId);

      await callTurnBroker(
        SOCKET_PATH,
        {
          method: "activity_complete",
          token,
          activityId: bindingAfterInvocation.activityId,
        },
      );
    } finally {
      await client.close();
    }
  } finally {
    disposeApproval?.();
    try {
      rmSync(OUTSIDE_PATH, { force: true });
    } catch {}
    try {
      rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(SOCKET_PATH, { force: true });
    } catch {}
    await ctx.fiber.dispose();
  }
}

if (process.argv[2] === "--native2-mcp") {
  await runChatGptMcpServer({
    brokerSocketPath: process.argv[3] ?? SOCKET_PATH,
    contract: "native",
  });
} else {
  await runNative2Integration();
}
