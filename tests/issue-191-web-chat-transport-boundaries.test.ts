import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #191 — boundaries of the exchange lifecycle and the transport seam.
 *
 * The common exchange contract must be usable by any provider transport without ever describing
 * one: no browser page, no selector, no endpoint, no provider DTO, and no concrete transport
 * implementation inside the core. The dependency direction is transport -> core, never the reverse.
 */

const ROOT = join(import.meta.dir, "..");
const CORE_DIR = join(ROOT, "src", "web-chat", "core");
const TRANSPORT_DIR = join(ROOT, "src", "web-chat", "transport");

function sourcesIn(directory: string): Array<{ path: string; source: string }> {
  const walk = (current: string): string[] => readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
  return walk(directory).map((path) => ({ path: path.slice(ROOT.length + 1), source: readFileSync(path, "utf8") }));
}

describe("issue #191 — the exchange contract never describes a transport mechanism", () => {
  const forbidden = [
    { pattern: /\bPage\b|playwright|BrowserContext|\bLocator\b/, why: "a browser API is a transport detail" },
    { pattern: /querySelector|data-testid|innerText|composer\b/i, why: "DOM selectors and DOM structure are provider-local" },
    { pattern: /fetch\s*\(|https?:\/\/|\/v1\//, why: "endpoints belong to the provider transport" },
    { pattern: /chatgpt|qwen|deepseek/i, why: "a provider name in the common layer means provider knowledge leaked" },
    { pattern: /node:fs|readFileSync|writeFileSync/, why: "the exchange layer owns no files" },
  ];

  test("no forbidden concept appears in the core or in the transport seam", () => {
    for (const { path, source } of [...sourcesIn(CORE_DIR), ...sourcesIn(TRANSPORT_DIR)]) {
      for (const { pattern, why } of forbidden) {
        expect(pattern.test(source), `${path} matches ${pattern} — ${why}`).toBe(false);
      }
    }
  });

  test("the transport seam reports semantics only", () => {
    const source = readFileSync(join(TRANSPORT_DIR, "text-transport.ts"), "utf8");
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
    for (const { path, source } of sourcesIn(CORE_DIR)) {
      expect(source, `${path} must not import the transport layer`).not.toMatch(/from\s+"[^"]*transport/);
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../core/");
        expect(allowed, `${path} imports "${specifier}"`).toBe(true);
      }
    }
  });

  test("the transport layer imports the core and no provider code", () => {
    for (const { path, source } of sourcesIn(TRANSPORT_DIR)) {
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
    const source = readFileSync(join(CORE_DIR, "exchange.ts"), "utf8");
    expect(source).toContain("export interface WebChatTurnInput");
    expect(source).toContain("export interface WebChatExchange {");
    expect(source).toContain("stream(): AsyncIterable<WebChatExchangeEvent>");
    // What issue #191 added is lifecycle facts, not a second exchange vocabulary.
    expect(source).toContain("snapshot(): WebChatExchangeSnapshot");
    expect(source).toContain("retrySafety(): WebChatRetrySafety");
    expect(source).not.toContain("export interface WebChatExchangeEvent");
  });
});
