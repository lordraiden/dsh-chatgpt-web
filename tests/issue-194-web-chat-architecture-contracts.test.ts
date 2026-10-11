import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { WebChatExchangeLifecycle } from "../src/web-chat/core";
import { assertTextOnlyWebChatTurn } from "../src/web-chat/core/exchange";
import { decideWebChatRetry, webChatRetrySafetyOf } from "../src/web-chat/core/retry-authority";
import { dshFailureSemanticsForSubmission } from "../src/web-chat/host/dsh-integration";

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

  test("DSH routing authority remains at the host boundary", () => {
    const integration = codeOnly(readFileSync(join(SRC, "web-chat", "host", "dsh-integration.ts"), "utf8"));
    expect(integration).toContain("createWebChatHostResolver");
    expect(integration).toContain("createWebChatDriverResolver");
    expect(integration).not.toMatch(/registerAdapter|ctx\.llm\s*\.\s*register|publicProviderRegistry/i);
    for (const file of coreFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, `${relative(ROOT, file)} claims host routing`).not.toMatch(/registerAdapter|ctx\.llm|publicProviderRegistry|selectProviderRoute/i);
    }
  });
});

describe("issue #194 — one retry authority after submission", () => {
  test("WebChat and DSH both refuse submitted, ambiguous, and partial turns", () => {
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
      expect(dshFailureSemanticsForSubmission({ phase: snapshot.phase, partialOutputObserved: item.partial }).retryable)
        .toBe(false);
    }
  });
});
