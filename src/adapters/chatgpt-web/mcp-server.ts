import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { BrokerCapabilityTransport, type BoundCapabilityTransport } from "./capability-transport";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
  transport: BoundCapabilityTransport;
}

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
]);

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 10_000;
// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP server
// must settle first so an abandoned native tool call is returned as an MCP error instead of
// letting the tunnel tear down and poison its long-lived stdio transport.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(snapshot: ChatGptTurnEnvironment["capabilitySnapshot"], name: string): CodexTool | undefined {
  return snapshot?.tools.find(tool => !tool.namespace && tool.name === name);
}

function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function safeVisibleTools(snapshot: NonNullable<ChatGptTurnEnvironment["capabilitySnapshot"]>, contract: ChatGptMcpContract): CodexTool[] {
  if (contract === "native") return [...snapshot.tools];
  const bridgeNamespaces = new Set(snapshot.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return snapshot.tools.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && !(tool.name === "exec" && !tool.namespace)
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

export function chatGptGatewayAllowedToolNames(
  snapshot: NonNullable<ChatGptTurnEnvironment["capabilitySnapshot"]>,
  contract: ChatGptMcpContract,
): string[] {
  return safeVisibleTools(snapshot, contract)
    .filter(tool => !tool.namespace && gatewayToolNameIsValid(tool.name))
    .map(tool => tool.name);
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return tool.name === "wait_agent"
    && (tool.namespace === "multi_agent_v1" || tool.namespace === "multi_agent_v2");
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function browserToolDescription(tool: CodexTool): string {
  const waitRule = "ChatGPT Web transport rule: wait for exactly 10 seconds per call, then release the MCP channel so spawned Web agents can use their own tools. Repeat with the same target ids until a terminal status is returned.";
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${waitRule}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${waitRule} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: "Required transport-safe polling interval. Use exactly 10000 and repeat the same targets until completion.",
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
): number {
  const remaining = environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS
    : Math.max(1, environment.expiresAt - now);
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, remaining);
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(snapshot: NonNullable<ChatGptTurnEnvironment["capabilitySnapshot"]>): CodexTool | undefined {
  const tool = exactTool(snapshot, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\nChatGPT Web transport rule: wait for exactly 10 seconds per call, then release the MCP channel so spawned Web agents can use their own tools. Repeat with the same target ids until a terminal status is returned.`;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  tools: GatewayToolDescriptor[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const allowedTools = ${JSON.stringify(options.tools)};`,
    `const needle = ${JSON.stringify(needle)};`,
    "const available = allowedTools.filter(tool => ALL_TOOLS.some(candidate => candidate?.name === tool.name));",
    "const matches = available.filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  allowedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || !allowedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not authorized for this turn: ${nestedToolName}`);
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const allowedNames = new Set(${JSON.stringify(allowedNames)});`,
    "if (!allowedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not authorized for this turn\");",
    "if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const nestedTool = tools[nestedToolName];",
    "if (typeof nestedTool !== \"function\") throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. The model still owns its JavaScript; only the tool registry it receives is a
 * transparent proxy whose two wait functions validate their transport-bound argument before dispatch.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string, allowedNames: string[]): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const allowedNames = new Set(${JSON.stringify(allowedNames)});`,
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set([...Reflect.ownKeys(source)].filter(name => allowedNames.has(name)));",
    "  if (typeof ALL_TOOLS !== \"undefined\" && Array.isArray(ALL_TOOLS)) {",
    "    for (const tool of ALL_TOOLS) if (typeof tool?.name === \"string\" && allowedNames.has(tool.name)) registryNames.add(tool.name);",
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (!registryNames.has(name)) return undefined;",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    "    if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
  allowedNames: string[],
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const allowedNames = new Set(${JSON.stringify(allowedNames)});`,
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => allowedNames.has(name) && nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
}): Promise<void> {
  const contract = options.contract ?? "native";
  const server = new McpServer(
    { name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION },
    contract === "safe" ? { instructions: ZERO_RISK_MCP_INSTRUCTIONS } : undefined,
  );

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      const claimed = await callTurnBroker<{
        bindingId: string;
        environment: ChatGptTurnEnvironment & { expiresAt?: number };
      }>(
        options.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract },
        contract === "safe" ? null : 5_000,
        extra.signal,
      );
      const snapshot = claimed.environment.capabilitySnapshot;
      if (!snapshot) throw new Error("Codex turn claim did not include an immutable capability snapshot");
      const transport = new BrokerCapabilityTransport({
        invoke: (binding, invocation, signal) => callTurnBroker<BrokerToolResult>(
          options.brokerSocketPath,
          {
            method: "invoke",
            bindingId: binding.bindingId,
            capabilitySnapshotId: binding.snapshotId,
            wireName: invocation.wireName,
            freeform: invocation.freeform,
            ...(invocation.freeform
              ? { input: invocation.input ?? "" }
              : { arguments: invocation.arguments ?? {} }),
          },
          chatGptMcpInvocationTimeout(claimed.environment),
          signal,
        ),
        revoke: binding => callTurnBroker(options.brokerSocketPath, {
          method: "release",
          bindingId: binding.bindingId,
        }),
      }).bind({
        bindingId: claimed.bindingId,
        snapshot,
        snapshotId: snapshot.snapshotId,
        sessionId: snapshot.sessionId,
        agentId: snapshot.agentId,
        turnId: snapshot.turnId,
      });
      return { ...claimed, activityId, transport };
    } catch (error) {
      try {
        await settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex Native claim failed and its broker activity could not be retired",
        );
      }
      throw error;
    }
  };

  const settleTurnActivity = async (turnToken: string, activityId: string): Promise<void> => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "activity_complete",
          token: turnToken,
          activityId,
        }, 5_000);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new AggregateError(
      [firstError],
      "Codex Native broker activity cleanup failed after an idempotent retry",
    );
  };

  const withClaimedTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    const claimed = await claimTurn(toolName, turnToken, extra);
    try {
      return await action(claimed);
    } finally {
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await settleTurnActivity(turnToken, claimed.activityId);
    }
  };

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const invoke = async (
    transport: BoundCapabilityTransport,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ) => {
    const timeoutMs = chatGptMcpInvocationTimeout(bound);
    try {
      const response = await transport.invoke({
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, signal);
      return asMcpResult(response);
    } catch (error) {
      // A cancelled/timed-out MCP request no longer has a consumer for the native result. Revoke
      // the whole turn capability so the broker drops the pending invocation and every later call
      // from that abandoned ChatGPT response fails explicitly against its retired binding.
      try {
        await transport.revoke(error instanceof Error ? error : new Error(String(error)));
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        console.error(
          `[chatgpt-web-mcp] ${toolName} did not complete within ${timeoutMs}ms; retired its turn binding`,
        );
        return result({
          code: "codex_tool_timeout",
          tool: toolName,
          timeout_ms: timeoutMs,
          retryable: false,
          message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding was retired; do not retry it in this ChatGPT response.`,
        }, true);
      }
      throw error;
    }
  };

  const invokeNestedNative = (
    transport: BoundCapabilityTransport,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ) => {
    const gateway = bound.capabilitySnapshot ? execGateway(bound.capabilitySnapshot) : undefined;
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    const allowedNames = bound.capabilitySnapshot
      ? safeVisibleTools(bound.capabilitySnapshot, contract)
        .filter(tool => !tool.namespace && gatewayToolNameIsValid(tool.name))
        .map(tool => tool.name)
      : [];
    return invoke(transport, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, allowedNames),
    }, signal);
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_exec",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { cmd, workdir, yield_time_ms, max_output_tokens, tty } = input;
        const bound = claimed.environment;
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
        };
        const tool = exactTool(bound.capabilitySnapshot!, "exec_command") ?? exactTool(bound.capabilitySnapshot!, "shell_command");
        if (tool) {
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          return invoke(claimed.transport, bound, tool, { arguments: args }, extra.signal);
        }
        const gateway = execGateway(bound.capabilitySnapshot!);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        return invoke(claimed.transport, bound, gateway, {
          input: execCommandGatewayProgram(
            execCommandArguments,
            shellCommandArguments,
            chatGptGatewayAllowedToolNames(bound.capabilitySnapshot!, contract),
          ),
        }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_stdin",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound.capabilitySnapshot!, "write_stdin");
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        return tool
          ? invoke(claimed.transport, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.transport, bound, "write_stdin", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_apply_patch",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound.capabilitySnapshot!, "apply_patch");
        if (!tool) return invokeNestedNative(claimed.transport, bound, "apply_patch", true, { input: patch }, extra.signal);
        return tool.freeform
          ? invoke(claimed.transport, bound, tool, { input: patch }, extra.signal)
          : invoke(claimed.transport, bound, tool, { arguments: { input: patch } }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_view_image",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound.capabilitySnapshot!, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.transport, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.transport, bound, "view_image", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: contract === "safe"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_inventory",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { query, offset, limit, include_schema } = input;
        const bound = claimed.environment;
        const needle = query?.trim().toLowerCase();
        const directMatches = safeVisibleTools(bound.capabilitySnapshot!, contract).filter(tool => !needle || [
          wireName(tool),
          tool.name,
          tool.namespace ?? "",
          tool.description,
        ].join("\n").toLowerCase().includes(needle));
        const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        }));
        let nestedTotal = 0;
        let nestedPage: Array<Record<string, unknown>> = [];
        const gateway = execGateway(bound.capabilitySnapshot!);
        if (gateway) {
          const directWireNames = new Set(directMatches.map(wireName));
          const gatewayTools = safeVisibleTools(bound.capabilitySnapshot!, contract)
            .filter(tool => !tool.namespace
              && gatewayToolNameIsValid(tool.name)
              && !directWireNames.has(wireName(tool)))
            .map(tool => ({ name: tool.name, description: tool.description }));
          const nestedOffset = Math.max(0, offset - directMatches.length);
          const nestedLimit = Math.max(0, limit - directPage.length);
          if (gatewayTools.length > 0 && nestedLimit > 0) {
            const response = await invoke(claimed.transport, bound, gateway, {
              input: gatewayToolCatalogProgram({
                query,
                offset: nestedOffset,
                limit: nestedLimit,
                tools: gatewayTools,
              }),
            }, extra.signal);
            const catalog = gatewayToolCatalogPage(response, new Set(directWireNames));
            nestedTotal = catalog.total;
            nestedPage = catalog.tools.map(tool => ({
              wire_name: tool.name,
              name: tool.name,
              namespace: null,
              description: gatewayToolDescription(tool),
              kind: "gateway",
              ...(include_schema ? {
                parameters: {
                  type: "object",
                  additionalProperties: true,
                  description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
                },
              } : {}),
            }));
          }
        }
        const page = [...directPage, ...nestedPage];
        const total = directMatches.length + nestedTotal;
        return result({
          tools: page,
          total,
          next_offset: offset + page.length < total ? offset + page.length : null,
        });
      },
    ),
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle."),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (toolInput, extra) => {
      const { wire_name, arguments: args, input } = toolInput;
      const requestId = turnReference(contract, toolInput);
      if (contract === "native" && wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (input !== undefined) {
          throw new Error("Compaction control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Compaction control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
        const bound = claimed.environment;
        const tool = safeVisibleTools(bound.capabilitySnapshot!, contract)
          .find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound.capabilitySnapshot!);
          const hiddenOuterTool = bound.capabilitySnapshot!.tools.some(candidate => wireName(candidate) === wire_name);
          if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
            throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
          }
          if (input !== undefined && args && Object.keys(args).length > 0) {
            throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
          }
          if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
            throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          }
          const invocationArguments = args ?? {};
          assertGatewayToolArguments(wire_name, invocationArguments);
          return invoke(claimed.transport, bound, gateway, {
            input: execGatewayProgram(wire_name, input !== undefined, {
              ...(input !== undefined ? { input } : { arguments: invocationArguments }),
            }, chatGptGatewayAllowedToolNames(bound.capabilitySnapshot!, contract)),
          }, extra.signal);
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.transport, bound, tool, {
            input: tool === execGateway(bound.capabilitySnapshot!)
              ? transportBoundRawExecProgram(
                input,
                wireName(tool),
                chatGptGatewayAllowedToolNames(bound.capabilitySnapshot!, contract),
              )
              : input,
          }, extra.signal);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = args ?? {};
        assertBrowserToolArguments(tool, invocationArguments);
        return invoke(claimed.transport, bound, tool, { arguments: invocationArguments }, extra.signal);
      });
    },
  );

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
