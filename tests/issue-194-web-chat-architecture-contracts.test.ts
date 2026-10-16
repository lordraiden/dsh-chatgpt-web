import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { WebChatExchangeLifecycle } from "../src/web-chat/core";
import { assertTextOnlyWebChatTurn } from "../src/web-chat/core/exchange";
import { decideWebChatRetry, webChatRetrySafetyOf } from "../src/web-chat/core/retry-authority";

/** Issue #194 — mechanically detectable provider-neutral WebChat architecture contracts. */
const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const CORE = join(SRC, "web-chat", "core");
const bunScanner = new Bun.Transpiler({ loader: "ts" });
const CONTRACTS = ["conversation.ts", "exchange.ts", "events.ts", "model.ts", "provider.ts"];
// Advisor is provider-neutral but belongs above the WebChat host/core boundary (architecture §20).
const OUT_OF_CORE_CONCEPTS = /\b(?:openai|chatgpt|qwen|deepseek|codex|advisor)\b|\bresponses\s+(?:api|compatibility)\b/i;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const regexPrefixWords = new Set(["await", "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield"]);
const regexPrefixOperators = new Set(["(", "[", "{", ",", ";", ":", "=", "==", "===", "!", "!=", "!==", "?", "=>", "&&", "||", "??", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">", "<=", ">=", "**", "/", "/=", "}"]);

function canStartRegex(previousToken: string | undefined): boolean {
  return previousToken === undefined || regexPrefixWords.has(previousToken) || regexPrefixOperators.has(previousToken);
}

/** End offset of a regular-expression literal, or the start offset when it is not closed. */
function regexLiteralEnd(source: string, start: number): number {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char.charCodeAt(0) === 92) {
      index += 1;
      continue;
    }
    if (char.charCodeAt(0) === 10 || char.charCodeAt(0) === 13) return start;
    if (char === "[" && !inCharacterClass) inCharacterClass = true;
    else if (char === "]" && inCharacterClass) inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[dgimsuvy]/.test(source[index]!)) index += 1;
      return index - 1;
    }
  }
  return start;
}

function skipQuoted(source: string, start: number, quote: "'" | '"'): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index]!.charCodeAt(0) === 92) index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function findTemplateExpressionEnd(source: string, start: number): number {
  let braceDepth = 0;
  let previousToken: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char.trim().length === 0) continue;
    if (char === "'" || char === '"') {
      index = skipQuoted(source, index, char) - 1;
      previousToken = "value";
      continue;
    }
    if (char === "`") {
      index = findTemplateLiteralEnd(source, index);
      previousToken = "value";
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source.charCodeAt(index) !== 10 && source.charCodeAt(index) !== 13) index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (char === "/" && canStartRegex(previousToken)) {
      const end = regexLiteralEnd(source, index);
      if (end > index) {
        index = end;
        previousToken = "value";
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(char)) {
      const begin = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      previousToken = source.slice(begin, index);
      index -= 1;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") {
      if (braceDepth === 0) return index;
      braceDepth -= 1;
    }
    previousToken = char;
  }
  return source.length;
}

function findTemplateLiteralEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index]!.charCodeAt(0) === 92) {
      index += 1;
      continue;
    }
    if (source[index] === "`") return index;
    if (source[index] === "$" && source[index + 1] === "{") {
      index = findTemplateExpressionEnd(source, index + 2);
    }
  }
  return source.length;
}

function codeOnly(source: string): string {
  const output = [...source];
  let quote: "'" | '"' | "`" | undefined;
  let previousToken: string | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char.charCodeAt(0) === 92) index += 1;
      else if (char === quote) {
        quote = undefined;
        previousToken = "value";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char.trim().length === 0) continue;
    if (char === "/" && source[index + 1] === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < source.length && source.charCodeAt(index) !== 10 && source.charCodeAt(index) !== 13) {
        output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 2;
          break;
        }
        if (source.charCodeAt(index) !== 10 && source.charCodeAt(index) !== 13) output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === "/" && canStartRegex(previousToken)) {
      const end = regexLiteralEnd(source, index);
      if (end > index) {
        index = end;
        previousToken = "value";
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      previousToken = source.slice(start, index);
      index -= 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      index += 1;
      while (index < source.length && /[0-9.]/.test(source[index]!)) index += 1;
      previousToken = "value";
      index -= 1;
      continue;
    }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (["===", "!==", ">>>", "**=", "&&=", "||=", "??="].includes(three)) {
      previousToken = three;
      index += 2;
    } else if (["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "**", "++", "--", "/="].includes(two)) {
      previousToken = two;
      index += 1;
    } else previousToken = char;
  }
  return output.join("");
}

function hasOutOfCoreConcepts(source: string): boolean {
  return OUT_OF_CORE_CONCEPTS.test(codeOnly(source));
}

interface SourceToken {
  readonly kind: "identifier" | "string" | "template" | "regex" | "punctuation";
  readonly value: string;
}

function sourceTokens(source: string): SourceToken[] {
  const code = codeOnly(source);
  const tokens: SourceToken[] = [];
  for (let index = 0; index < code.length;) {
    const char = code[index]!;
    if (char.trim().length === 0) {
      index += 1;
      continue;
    }
    if (char === "/" && canStartRegex(tokens.at(-1)?.value)) {
      const end = regexLiteralEnd(code, index);
      if (end > index) {
        tokens.push({ kind: "regex", value: code.slice(index, end + 1) });
        index = end + 1;
        continue;
      }
    }
    if (char === "`") {
      const end = findTemplateLiteralEnd(code, index);
      for (let cursor = index + 1; cursor < end;) {
        if (code[cursor]!.charCodeAt(0) === 92) {
          cursor += 2;
          continue;
        }
        if (code[cursor] === "$" && code[cursor + 1] === "{") {
          const expressionStart = cursor + 2;
          const expressionEnd = findTemplateExpressionEnd(code, expressionStart);
          tokens.push(...sourceTokens(code.slice(expressionStart, expressionEnd)));
          cursor = expressionEnd + 1;
        } else cursor += 1;
      }
      tokens.push({ kind: "template", value: "template" });
      index = end + 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index + 1;
      index = skipQuoted(code, index, quote);
      tokens.push({ kind: "string", value: code.slice(start, index - 1) });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < code.length && /[A-Za-z0-9_$]/.test(code[index]!)) index += 1;
      tokens.push({ kind: "identifier", value: code.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: char });
    index += 1;
  }
  return tokens;
}

function imports(source: string): string[] {
  const tokens = sourceTokens(source);
  // Bun's parser sees runtime imports, including template expressions. It omits TypeScript-only
  // imports, so the token pass handles type declarations and import() type queries.
  const found = bunScanner.scan(source).imports.map(item => item.path);
  const addTypeModule = (start: number): void => {
    for (let index = start + 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.value === ";"
        || (token.kind === "identifier" && (token.value === "import" || token.value === "export"))) return;
      if (token.kind === "identifier" && token.value === "from" && tokens[index + 1]?.kind === "string") {
        found.push(tokens[index + 1]!.value);
        return;
      }
      if (token.kind === "identifier" && token.value === "require"
        && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
        found.push(tokens[index + 2]!.value);
        return;
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "identifier" || tokens[index - 1]?.value === ".") continue;
    if (token.value === "import") {
      if (tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
        found.push(tokens[index + 2]!.value);
      } else if (tokens[index + 1]?.value === "type"
        || (tokens[index + 1]?.kind === "identifier" && tokens[index + 2]?.value === "=")) {
        addTypeModule(index);
      }
    } else if (token.value === "export" && tokens[index + 1]?.value === "type") {
      addTypeModule(index);
    }
  }
  return [...new Set(found)];
}

const coreFiles = filesUnder(CORE);
// Provider directories are discovered as first-level adapter subdirectories, so future providers
// participate without adding a ChatGPT-specific path to the test.
function adapterProviderDirectories(): string[] {
  return readdirSync(join(SRC, "adapters"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SRC, "adapters", entry.name));
}


describe("issue #194 — provider and common-contract boundaries", () => {
  test("dependency scanning catches side-effect imports without parsing comments or string contents", () => {
    const source = [
      '// import "../adapters/ignored-provider/comment";',
      'const url = "https://example.invalid// still part of the string";',
      'const regex = /[//]/; import type { RegexType } from "../adapters/chatgpt-web/regex";',
      'const template = `prefix ${import("../adapters/qwen-web/template")}`;',
      'type TemplateType = `prefix${import("../adapters/qwen-web/template-type").Thing}`;',
      'import "../adapters/chatgpt-web/side-effects";',
      'export * from "../adapters/qwen-web/re-export";',
      'void import("../adapters/deepseek-web/dynamic");',
      'type Imported = import("../adapters/codex-web/types").Thing;',
    ].join("\n");
    expect(imports(source).sort()).toEqual([
      "../adapters/chatgpt-web/regex",
      "../adapters/chatgpt-web/side-effects",
      "../adapters/codex-web/types",
      "../adapters/deepseek-web/dynamic",
      "../adapters/qwen-web/re-export",
      "../adapters/qwen-web/template",
      "../adapters/qwen-web/template-type",
    ].sort());
    const code = codeOnly(source);
    expect(code).toContain('"https://example.invalid// still part of the string"');
    expect(code).toContain('from "../adapters/chatgpt-web/regex"');
    expect(code).not.toContain("ignored-provider");
  });

  test("core imports neither adapters nor concrete provider implementations", () => {
    for (const file of coreFiles) {
      for (const specifier of imports(readFileSync(file, "utf8"))) {
        expect(specifier, `${relative(ROOT, file)} imports ${specifier}`).not.toMatch(/(?:^|\/)adapters(?:\/|$)/i);
      }
    }
  });

  test("provider implementations do not import sibling provider implementations", () => {
    const providers = adapterProviderDirectories();
    for (const directory of providers) {
      const ownName = directory.split(/[\\/]/).at(-1)!;
      for (const file of filesUnder(directory)) {
        for (const specifier of imports(readFileSync(file, "utf8"))) {
          const resolved = resolve(dirname(file), specifier);
          const normalized = specifier.replace(/\\/g, "/");
          for (const other of providers) {
            const otherName = other.split(/[\\/]/).at(-1)!;
            if (otherName === ownName) continue;
            expect(
              normalized === otherName || normalized.startsWith(`${otherName}/`)
                || normalized.includes(`/adapters/${otherName}/`)
                || resolved.startsWith(other),
              `${relative(ROOT, file)} imports sibling provider ${specifier}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("common conversation and text contracts contain no browser Page or DOM types", () => {
    for (const name of CONTRACTS) {
      const file = join(CORE, name);
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, `${name} leaks a browser Page type`).not.toMatch(/\b(?:Page|Locator|Browser|BrowserContext|Element|HTMLElement|Document)\b/);
      expect(source, `${name} leaks DOM globals or selectors`).not.toMatch(/\b(?:document|window)\b|querySelector|innerText|textContent/);
    }
  });

  test("common contracts keep provider-owned and higher-layer concepts outside Core", () => {
    for (const name of ["OpenAI", "ChatGPT", "Qwen", "DeepSeek", "Codex", "Advisor", "Responses API", "Responses compatibility"]) {
      expect(hasOutOfCoreConcepts(name), `${name} must remain outside common contracts`).toBe(true);
    }
    expect(hasOutOfCoreConcepts("provider-neutral contract; MCP is an unsupported request option"))
      .toBe(false);
    for (const name of CONTRACTS) {
      const source = readFileSync(join(CORE, name), "utf8");
      expect(hasOutOfCoreConcepts(source), `${name} leaks an out-of-core concept`).toBe(false);
    }
  });

  test("core does not parse or derive provider-private conversation handles", () => {
    const conversation = codeOnly(readFileSync(join(CORE, "conversation.ts"), "utf8"));
    expect(conversation).toMatch(/WebChatConversationHandle\s*=\s*string\s*&/);
    expect(conversation).toMatch(/typeof value !== "string" \|\| value\.length === 0/);
    expect(conversation).not.toMatch(/JSON\.parse|split\s*\(|decodeURIComponent|Buffer\.|handle\.[A-Za-z_$]/);
  });

  test("the common turn contract has no ChatGPT-private capability semantics", () => {
    const source = codeOnly(readFileSync(join(CORE, "exchange.ts"), "utf8"));
    expect(source).not.toMatch(/chatgpt|codex|advisor|capability/i);
  });

  test("unsupported non-text content is refused rather than silently projected to text", () => {
    expect(() => assertTextOnlyWebChatTurn({ userText: "hello", model: "m", files: [{ id: "f" }] }))
      .toThrow(/unsupported request features: files/);
  });

  test("provider routing authority remains at the host boundary", () => {
    const integration = codeOnly(readFileSync(join(SRC, "web-chat", "host", "provider-host.ts"), "utf8"));
    expect(integration).toContain("resolveWebChatProviderConfig");
    expect(integration).toContain("inspectWebChatProvider");
    expect(integration).not.toMatch(/registerAdapter|ctx\.llm\s*\.\s*register|publicProviderRegistry/i);
    for (const file of coreFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, `${relative(ROOT, file)} claims host routing`).not.toMatch(/registerAdapter|ctx\.llm|publicProviderRegistry|selectProviderRoute/i);
    }
  });
});

describe("issue #194 — one retry authority after submission", () => {
  test("WebChat refuses submitted, ambiguous, and partial turns", () => {
    const cases = [
      { state: "SUBMISSION_AMBIGUOUS", partial: false },
      { state: "SUBMITTED", partial: false },
      { state: "STREAMING", partial: true },
    ] as const;
    for (const item of cases) {
      const exchange = new WebChatExchangeLifecycle({
        exchangeId: `issue-194-${item.state}`,
        conversationKey: `issue-194-conversation-${item.state}`,
        epoch: 1,
        maxSubmits: 3,
      });
      exchange.markPreparing();
      exchange.markTransportReady();
      exchange.markSubmitting();
      if (item.state === "SUBMISSION_AMBIGUOUS") exchange.markSendActivated();
      else {
        exchange.markSubmitted();
        if (item.state === "STREAMING") exchange.markStreaming();
      }
      const snapshot = exchange.snapshot();
      expect(snapshot.state).toBe(item.state);
      const observation = { snapshot, partialOutputObserved: item.partial };
      expect(webChatRetrySafetyOf(observation)).not.toBe("retry_safe");
      expect(decideWebChatRetry(observation).allowed).toBe(false);
    }
  });
});

/**
 * Merged architecture-boundary scans.
 *
 * The three `*-boundaries` suites (issues #189, #190, #191) audit the same mechanically detectable
 * ownership boundaries as the contracts above, from the core, the durable continuity layer and the
 * transport seam. They are consolidated here — one architecture-boundary suite, every distinct
 * assertion preserved — instead of three separate chain entries.
 */
const BOUNDARY_CORE_DIR = join(SRC, "web-chat", "core");
const BOUNDARY_PERSISTENCE_DIR = join(SRC, "web-chat", "persistence");
const BOUNDARY_TRANSPORT_DIR = join(SRC, "web-chat", "transport");

function boundaryCoreFiles(): string[] {
  return filesUnder(BOUNDARY_CORE_DIR);
}

const boundaryCoreSources = (): Array<{ path: string; source: string }> => boundaryCoreFiles().map((path) => ({
  path: path.slice(ROOT.length + 1),
  source: readFileSync(path, "utf8"),
}));

function boundarySourcesIn(directory: string): Array<{ path: string; source: string }> {
  return filesUnder(directory).map((path) => ({ path: path.slice(ROOT.length + 1), source: readFileSync(path, "utf8") }));
}

describe("issue #189 — the core imports nothing outside itself", () => {
  test("every core import is a node builtin or a module inside the core", () => {
    for (const { path, source } of boundaryCoreSources()) {
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const isBuiltin = specifier.startsWith("node:");
        const isInsideCore = specifier.startsWith("./") || specifier.startsWith("../");
        expect(
          isBuiltin || isInsideCore,
          `${path} imports "${specifier}"; the core may only import node builtins or its own modules`,
        ).toBe(true);
        if (isInsideCore) {
          expect(
            specifier.startsWith("./") || specifier.startsWith("../core/"),
            `${path} imports "${specifier}" outside the core directory`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("issue #189 — the core carries no provider, browser or routing knowledge", () => {
  test("no forbidden concept appears in any core module", () => {
    const forbidden = [
      { pattern: /playwright/i, why: "an automation library is a provider transport detail" },
      { pattern: /\bLocator\b/, why: "a DOM locator is a provider transport detail" },
      { pattern: /\bBrowserContext\b/, why: "a browser context is a transport resource, not the core" },
      { pattern: /data-testid|querySelector|innerText/, why: "DOM selectors are provider-owned" },
      { pattern: /ctx\.llm|registerAdapter|LlmAdapter\b/, why: "the host runtime owns provider routing" },
      { pattern: /\bCodexParsedRequest\b|\bGenerateOptions\b|\bStreamChunk\b|\bAppConfig\b/, why: "host wire shapes are not the common contract" },
      { pattern: /chatgpt|qwen|deepseek/i, why: "a provider name in the core means provider knowledge leaked" },
      { pattern: /\/v1\/|https?:\/\//, why: "endpoint schemas belong to the driver" },
      // The rule catches credential *access or storage*, not the names themselves: the core must be
      // able to refuse to persist them (conversation-store.ts owns that refusal).
      { pattern: /\.cookie\s*[(=]|document\.cookie|navigator\.credentials|controlToken\s*[:=]|storageState\s*[:=]|_authToken\s*[:=]/, why: "credentials and session material never reach the core" },
    ];
    for (const { path, source } of boundaryCoreSources()) {
      for (const { pattern, why } of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern} — ${why}`).toBe(false);
      }
    }
  });
});

describe("issue #189 — the core is not a store, a registry or a transcript", () => {
  test("no persistence, no transcript API, no opaque-handle interpretation", () => {
    const forbidden = [
      /node:fs|writeFileSync|readFileSync/,
      /localStorage|sessionStorage|indexedDB/,
      /JSON\.parse/,
      /appendToTranscript|createWebChatTranscript|transcript\s*[:=]|\.append\(\s*\{\s*role/,
    ];
    for (const { path, source } of boundaryCoreSources()) {
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern}; the core must keep no state`).toBe(false);
      }
    }
  });

  test("the published core surface is pinned, and holds no store/registry/catalog owner", () => {
    const indexPath = join(BOUNDARY_CORE_DIR, "index.ts");
    const source = readFileSync(indexPath, "utf8");
    const exported = [...source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter((entry) => entry.length > 0)
      .sort();

    const EXPECTED_CORE_SURFACE = [
      "WEB_CHAT_ERROR_CATEGORIES",
      "WEB_CHAT_EXCHANGE_EVENT_TYPES",
      "WebChatAccountBinding",
      "WebChatAccountBindingId",
      "WebChatAccountInspection",
      "WebChatAffinityKeyInput",
      "WebChatContinuationIntent",
      "WebChatContinuationOutcome",
      "WebChatContinuationPlan",
      "WebChatContinuationRequest",
      "WebChatConversation",
      "WebChatConversationAffinity",
      "WebChatConversationAssessment",
      "WebChatConversationAssessmentInput",
      "WebChatConversationCreateInput",
      "WebChatConversationDraft",
      "WebChatConversationHandle",
      "WebChatConversationIdentity",
      "WebChatConversationInitialization",
      "WebChatConversationRecord",
      "WebChatConversationReplayInput",
      "WebChatConversationResumeInput",
      "WebChatConversationSelection",
      "WebChatConversationStatus",
      "WebChatConversationStore",
      "WebChatConversationStoreOptions",
      "WebChatDriverResolver",
      "WebChatDshSessionIdentity",
      "WebChatError",
      "WebChatErrorCategory",
      "WebChatErrorOptions",
      "WebChatExchange",
      "WebChatExchangeCancelledEvent",
      "WebChatExchangeCompletedEvent",
      "WebChatExchangeErrorEvent",
      "WebChatExchangeEvent",
      "WebChatExchangeEventType",
      "WebChatExchangeLifecycle",
      "WebChatExchangeLifecycleOptions",
      "WebChatExchangeReadyEvent",
      "WebChatExchangeSnapshot",
      "WebChatExchangeState",
      "WebChatExchangeSubmittedEvent",
      "WebChatExchangeTextDeltaEvent",
      "WebChatLogicalSettlement",
      "WebChatModelDescriptor",
      "WebChatPhysicalSettlement",
      "WebChatProviderDriver",
      "WebChatProviderHealth",
      "WebChatProviderReplayState",
      "WebChatReasoningMode",
      "WebChatReplayMessage",
      "WebChatReplayStateOwner",
      "WebChatRetryDecision",
      "WebChatRetryObservation",
      "WebChatRetryPolicy",
      "WebChatRetryRefusal",
      "WebChatRetrySafety",
      "WebChatSubmissionPhase",
      "WebChatTurnCandidate",
      "WebChatTurnIdentity",
      "WebChatTurnInput",
      "assertCurrentWebChatGeneration",
      "assertNoWebChatSecrets",
      "assertTextOnlyWebChatTurn",
      "assertWebChatReplayStateOwner",
      "beginWebChatConversationAttempt",
      "commitWebChatConversationDraft",
      "confirmWebChatConversation",
      "createMemoryConversationStore",
      "createWebChatDriverResolver",
      "decideWebChatRetry",
      "isWebChatError",
      "isWebChatExchangeEventType",
      "isWebChatInitializationCurrent",
      "isWebChatModelDescriptor",
      "isWebChatProviderReplayState",
      "legacyWebChatThreadKey",
      "rejectUnsupportedWebChatFeatures",
      "resolveWebChatContinuation",
      "validateWebChatConversationRecord",
      "webChatAccountBindingId",
      "webChatAffinityKey",
      "webChatContinuationIdentity",
      "webChatConversationHandle",
      "webChatError",
      "webChatReplayStateOwnedBy",
      "webChatRetrySafetyOf",
    ];
    // Code-unit sort, exactly what the parser's `.sort()` produces.
    expect(exported).toEqual([...EXPECTED_CORE_SURFACE].sort());

    // The pin is what keeps the core small: no durable implementation, no transcript, no catalog
    // and no provider registry. The conversation-store seam is the one allowed state surface —
    // architecture §18 puts `core/conversation-store.ts` in the core — and it is a port plus its
    // in-memory reference implementation: it holds no module state and performs no I/O.
    const CONVERSATION_STORE_SEAM = new Set([
      "WebChatConversationStore",
      "WebChatConversationStoreOptions",
      "createMemoryConversationStore",
    ]);
    for (const name of exported.filter((entry) => !CONVERSATION_STORE_SEAM.has(entry))) {
      expect(
        /store|transcript|persist|catalog|registry|register|append/i.test(name),
        `the core exports "${name}", which owns state or provider policy`,
      ).toBe(false);
    }
  });
});

describe("issue #189 — dependency direction", () => {
  test("provider code imports the core, and the core never imports provider code", () => {
    const providerFiles = [
      join(ROOT, "src", "adapters", "chatgpt-web", "conversation-key.ts"),
      join(ROOT, "src", "adapters", "chatgpt-web", "web-chat-bridge.ts"),
    ];
    for (const path of providerFiles) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} must import the core`).toContain("web-chat/core");
    }
    for (const { path, source } of boundaryCoreSources()) {
      expect(source, `${path} must not import provider code`).not.toContain("adapters/");
      expect(source, `${path} must not import provider code`).not.toContain("chatgpt-web");
    }
  });
});

describe("issue #190 — the core stays free of infrastructure", () => {
  test("no core module imports the durable backend, the provider configuration or a provider", () => {
    for (const { path, source } of boundarySourcesIn(BOUNDARY_CORE_DIR)) {
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../core/");
        expect(allowed, `${path} imports "${specifier}"; the core may only import node builtins or its own modules`).toBe(true);
        expect(specifier, `${path} imports the durable backend`).not.toContain("persistence");
        expect(specifier, `${path} imports the provider configuration`).not.toContain("config");
      }
    }
  });

  test("the durable backend is the only place under src/web-chat that touches the filesystem", () => {
    const persistence = boundarySourcesIn(BOUNDARY_PERSISTENCE_DIR);
    expect(persistence.length).toBeGreaterThan(0);
    for (const { path, source } of persistence) {
      if (!path.endsWith("conversation-store-file.ts")) continue;
      expect(source, `${path} must use the shared atomic write helper`).toContain("atomicWriteFile");
      expect(source, `${path} must own the file reads`).toContain("readFileSync");
    }
    for (const { path, source } of boundarySourcesIn(BOUNDARY_CORE_DIR)) {
      expect(source, `${path} must not touch the filesystem`).not.toMatch(/node:fs|readFileSync|writeFileSync/);
    }
  });

  test("the durable backend depends on the core, never the other way round", () => {
    for (const { path, source } of boundarySourcesIn(BOUNDARY_PERSISTENCE_DIR)) {
      expect(source, `${path} must import the core contracts`).toContain('from "../core"');
      expect(source, `${path} must not import a provider`).not.toContain("adapters/");
    }
  });
});

describe("issue #190 — the deprecated digest has one caller and a retirement trigger", () => {
  test("legacyWebChatThreadKey is deprecated, documented and called from exactly one production module", () => {
    const definition = readFileSync(join(BOUNDARY_CORE_DIR, "conversation-key.ts"), "utf8");
    expect(definition).toContain("@deprecated");
    expect(definition).toContain("issue #192");

    const callers = boundarySourcesIn(SRC)
      .filter(({ path }) => path !== "src/web-chat/core/conversation-key.ts")
      .filter(({ source }) => /legacyWebChatThreadKey\s*\(/.test(source))
      .map(({ path }) => path);
    expect(callers).toEqual(["src/adapters/chatgpt-web/conversation-key.ts"]);
  });
});

describe("issue #190 — the stored record is continuity only", () => {
  test("the record shape is pinned: no transport resource and no credential field", () => {
    const source = readFileSync(join(BOUNDARY_CORE_DIR, "conversation-store.ts"), "utf8");
    const block = source.slice(source.indexOf("const RECORD_KEYS = new Set(["));
    const pinned = [...block.slice(0, block.indexOf("])")).matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]!).sort();
    expect(pinned).toEqual([
      "checkpoint",
      "createdAt",
      "generation",
      "handle",
      "identity",
      "initialization",
      "lastConfirmedTurn",
      "revision",
      "status",
      "updatedAt",
    ]);
    for (const forbidden of ["page", "context", "lease", "surface", "transport", "browser"]) {
      expect(pinned, `the record may not carry a "${forbidden}" field`).not.toContain(forbidden);
    }
  });

  test("the store never interprets the provider handle", () => {
    for (const { path, source } of boundarySourcesIn(BOUNDARY_CORE_DIR)) {
      // No parsing, indexing, splitting or property access on a handle: it is opaque provider state.
      expect(source, `${path} parses a provider handle`).not.toMatch(/JSON\.parse\([^)]*handle/);
      expect(source, `${path} inspects a provider handle`).not.toMatch(/handle\s*\.\s*[a-zA-Z]|handle\.(?:split|slice|substring|includes)\(/);
    }
  });
});

describe("issue #191 — the exchange contract never describes a transport mechanism", () => {
  const forbidden = [
    { pattern: /\bPage\b|playwright|BrowserContext|\bLocator\b/, why: "a browser API is a transport detail" },
    { pattern: /querySelector|data-testid|innerText|composer\b/i, why: "DOM selectors and DOM structure are provider-local" },
    { pattern: /fetch\s*\(|https?:\/\/|\/v1\//, why: "endpoints belong to the provider transport" },
    { pattern: /chatgpt|qwen|deepseek/i, why: "a provider name in the common layer means provider knowledge leaked" },
    { pattern: /node:fs|readFileSync|writeFileSync/, why: "the exchange layer owns no files" },
  ];

  test("no forbidden concept appears in the core or in the transport seam", () => {
    for (const { path, source } of [...boundarySourcesIn(BOUNDARY_CORE_DIR), ...boundarySourcesIn(BOUNDARY_TRANSPORT_DIR)]) {
      for (const { pattern, why } of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern} — ${why}`).toBe(false);
      }
    }
  });

  test("the transport seam reports semantics only", () => {
    const source = readFileSync(join(BOUNDARY_TRANSPORT_DIR, "text-transport.ts"), "utf8");
    for (const method of ["ready", "submit", "stream", "settle"]) {
      expect(source, `the transport seam must expose ${method}()`).toContain(`${method}(`);
    }
    expect(source, "the transport seam must expose an optional abort()").toContain("abort?(");
    // The seam returns core semantic types, not provider DTOs.
    expect(source).toContain("WebChatSubmissionPhase");
    expect(source).toContain("WebChatPhysicalSettlement");
    expect(source).toContain("WebChatExchangeEvent");
  });
});

describe("issue #191 — dependency direction", () => {
  test("the core never imports the transport layer", () => {
    for (const { path, source } of boundarySourcesIn(BOUNDARY_CORE_DIR)) {
      expect(source, `${path} must not import the transport layer`).not.toMatch(/from\s+"[^"]*transport/);
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../core/");
        expect(allowed, `${path} imports "${specifier}"`).toBe(true);
      }
    }
  });

  test("the transport layer imports the core and no provider code", () => {
    for (const { path, source } of boundarySourcesIn(BOUNDARY_TRANSPORT_DIR)) {
      if (path.endsWith("index.ts")) {
        // The layer's barrel only re-exports its own modules.
        expect(source, `${path} must re-export the transport modules`).toContain('from "./');
      } else {
        expect(source, `${path} must import the core`).toMatch(/from "\.\.\/core(\/|")/);
      }
      expect(source, `${path} must not import provider code`).not.toContain("adapters/");
    }
  });

  test("the exchange contract keeps using the issue #189 vocabulary unchanged", () => {
    const source = readFileSync(join(BOUNDARY_CORE_DIR, "exchange.ts"), "utf8");
    expect(source).toContain("export interface WebChatTurnInput");
    expect(source).toContain("export interface WebChatExchange {");
    expect(source).toContain("stream(): AsyncIterable<WebChatExchangeEvent>");
    // What issue #191 added is lifecycle facts, not a second exchange vocabulary.
    expect(source).toContain("snapshot(): WebChatExchangeSnapshot");
    expect(source).toContain("retrySafety(): WebChatRetrySafety");
    expect(source).not.toContain("export interface WebChatExchangeEvent");
  });
});
