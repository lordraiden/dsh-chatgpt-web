import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sanitizeQwenChatStorageState,
  storeQwenChatSession,
  validateQwenChatSessionStorageState,
} from "../src/adapters/qwen-chat";
import { AuthImportRefusal } from "../src/auth-import-errors";

/**
 * Issue #333 — the Qwen Chat session layout and the per-domain capture rule.
 *
 * The Qwen account family is shared with Qwen Code, but cookies and localStorage are not: a capture
 * made at `coder.qwen.ai` cannot authenticate `chat.qwen.ai` unless its `qwen.ai` cookie is a
 * parent-domain cookie. The importer refuses that capture *before* any browser starts, and this file
 * pins both the refusal and the accepted shapes with synthetic values only.
 */

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const FUTURE = Math.floor(Date.UTC(2027, 0, 1) / 1_000);
const PAST = Math.floor(Date.UTC(2026, 0, 1) / 1_000);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "qwen-chat-session-"));
  directories.push(directory);
  return directory;
}

function capture(input: {
  readonly domains: readonly string[];
  readonly expires?: number;
  readonly origins?: readonly string[];
}): unknown {
  return {
    cookies: input.domains.map((domain, index) => ({
      name: `cookie-${index}`,
      value: "SYNTHETIC-VALUE",
      domain,
      path: "/",
      expires: input.expires ?? FUTURE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })),
    origins: (input.origins ?? []).map(origin => ({
      origin,
      localStorage: [{ name: "qwen_access_token_state", value: "SYNTHETIC-STATE" }],
    })),
  };
}

describe("issue #333 — a Qwen Chat capture must contain a chat-capable cookie", () => {
  test("a parent-domain .qwen.ai cookie is accepted", () => {
    const accepted = validateQwenChatSessionStorageState(capture({ domains: [".qwen.ai"] }), NOW);
    expect(accepted.cookies).toHaveLength(1);
    expect(accepted.cookies[0]!.domain).toBe(".qwen.ai");
  });

  test("a host-only chat.qwen.ai cookie is accepted", () => {
    expect(validateQwenChatSessionStorageState(capture({ domains: ["chat.qwen.ai"] }), NOW).cookies)
      .toHaveLength(1);
  });

  test("a coder.qwen.ai-only capture is refused as the per-domain trap it is", () => {
    let error: unknown;
    try {
      validateQwenChatSessionStorageState(capture({ domains: ["coder.qwen.ai"] }), NOW);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthImportRefusal);
    expect((error as AuthImportRefusal).code).toBe("import_foreign_domain");
    expect((error as AuthImportRefusal).message).toContain("cookies are per-domain");
    expect((error as AuthImportRefusal).message).toContain("chat.qwen.ai");
  });

  test("a capture with no cookies, or only expired ones, names the next step", () => {
    expect(() => validateQwenChatSessionStorageState(capture({ domains: [] }), NOW))
      .toThrow(/no cookies at all/);
    expect(() => validateQwenChatSessionStorageState(capture({ domains: [".qwen.ai"], expires: PAST }), NOW))
      .toThrow(/expired/);
  });

  test("sanitisation keeps this site's storage origin and drops the other product's", () => {
    const sanitized = sanitizeQwenChatStorageState(capture({
      domains: [".qwen.ai", ".example.com"],
      origins: ["https://chat.qwen.ai", "https://auth.qwen.ai", "https://coder.qwen.ai"],
    }));
    expect(sanitized.cookies.map(cookie => cookie.domain)).toEqual([".qwen.ai"]);
    expect(sanitized.origins.map(origin => origin.origin)).toEqual([
      "https://chat.qwen.ai",
      "https://auth.qwen.ai",
    ]);
  });
});

describe("issue #333 — a stored Qwen Chat session lives in its own provider directory", () => {
  test("the writer stores the capture under providers/qwen-chat with a verified marker", () => {
    const home = temporaryHome();
    const path = storeQwenChatSession(capture({
      domains: [".qwen.ai"],
      origins: ["https://chat.qwen.ai"],
    }), home);
    expect(path).toBe(join(home, "providers", "qwen-chat", "storage-state.json"));
    expect(existsSync(path)).toBe(true);
    const markerPath = `${path}.verified.json`;
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version?: number;
      authenticated?: boolean;
      verifiedAt?: unknown;
    };
    expect(marker.version).toBe(1);
    expect(marker.authenticated).toBe(true);
    expect(typeof marker.verifiedAt).toBe("string");
    // The written state is sanitized: no foreign origin survives.
    const written = JSON.parse(readFileSync(path, "utf8")) as { origins?: { origin?: string }[] };
    expect(written.origins?.map(origin => origin.origin)).toEqual(["https://chat.qwen.ai"]);
  });

  test("one provider's directory is never another's", () => {
    const home = temporaryHome();
    const path = storeQwenChatSession(capture({ domains: [".qwen.ai"] }), home);
    expect(path).toContain(join("providers", "qwen-chat"));
    expect(path).not.toContain(join("providers", "qwen-code"));
  });
});
