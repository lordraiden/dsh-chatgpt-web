import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #190 — boundaries of the continuity layer.
 *
 * The durable layer must not dissolve the boundary the previous step established: the core stays
 * free of infrastructure and provider knowledge, the durable backend stays outside it, the one
 * deprecated compatibility digest has a single caller with a retirement trigger, and the stored
 * record keeps representing continuity only — never transport resources.
 */

const ROOT = join(import.meta.dir, "..");
const CORE_DIR = join(ROOT, "src", "web-chat", "core");
const PERSISTENCE_DIR = join(ROOT, "src", "web-chat", "persistence");

function sourcesIn(directory: string): Array<{ path: string; source: string }> {
  const walk = (current: string): string[] => readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
  return walk(directory).map((path) => ({ path: path.slice(ROOT.length + 1), source: readFileSync(path, "utf8") }));
}

describe("issue #190 — the core stays free of infrastructure", () => {
  test("no core module imports the durable backend, the plugin configuration or a provider", () => {
    for (const { path, source } of sourcesIn(CORE_DIR)) {
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../core/");
        expect(allowed, `${path} imports "${specifier}"; the core may only import node builtins or its own modules`).toBe(true);
        expect(specifier, `${path} imports the durable backend`).not.toContain("persistence");
        expect(specifier, `${path} imports plugin configuration`).not.toContain("config");
      }
    }
  });

  test("the durable backend is the only place under src/web-chat that touches the filesystem", () => {
    const persistence = sourcesIn(PERSISTENCE_DIR);
    expect(persistence.length).toBeGreaterThan(0);
    for (const { path, source } of persistence) {
      if (!path.endsWith("conversation-store-file.ts")) continue;
      expect(source, `${path} must use the plugin's atomic write helper`).toContain("atomicWriteFile");
      expect(source, `${path} must own the file reads`).toContain("readFileSync");
    }
    for (const { path, source } of sourcesIn(CORE_DIR)) {
      expect(source, `${path} must not touch the filesystem`).not.toMatch(/node:fs|readFileSync|writeFileSync/);
    }
  });

  test("the durable backend depends on the core, never the other way round", () => {
    for (const { path, source } of sourcesIn(PERSISTENCE_DIR)) {
      expect(source, `${path} must import the core contracts`).toContain('from "../core"');
      expect(source, `${path} must not import a provider`).not.toContain("adapters/");
    }
  });
});

describe("issue #190 — the deprecated digest has one caller and a retirement trigger", () => {
  test("legacyWebChatThreadKey is deprecated, documented and called from exactly one production module", () => {
    const definition = readFileSync(join(CORE_DIR, "conversation-key.ts"), "utf8");
    expect(definition).toContain("@deprecated");
    expect(definition).toContain("issue #192");

    const callers = sourcesIn(join(ROOT, "src"))
      .filter(({ path }) => path !== "src/web-chat/core/conversation-key.ts")
      .filter(({ source }) => /legacyWebChatThreadKey\s*\(/.test(source))
      .map(({ path }) => path);
    expect(callers).toEqual(["src/adapters/chatgpt-web/conversation-key.ts"]);
  });
});

describe("issue #190 — the stored record is continuity only", () => {
  test("the record shape is pinned: no transport resource and no credential field", () => {
    const source = readFileSync(join(CORE_DIR, "conversation-store.ts"), "utf8");
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
    for (const { path, source } of sourcesIn(CORE_DIR)) {
      // No parsing, indexing, splitting or property access on a handle: it is opaque provider state.
      expect(source, `${path} parses a provider handle`).not.toMatch(/JSON\.parse\([^)]*handle/);
      expect(source, `${path} inspects a provider handle`).not.toMatch(/handle\s*\.\s*[a-zA-Z]|handle\.(?:split|slice|substring|includes)\(/);
    }
  });
});
