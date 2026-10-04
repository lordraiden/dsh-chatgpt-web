import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createWorkspaceToolDefinitions,
  WorkspaceToolError,
  type WorkspaceToolDefinition,
} from "../src/workspace-tools";

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-chatgpt-web-issue-121-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true }));
  }
});

function tools(root: string, overrides: Partial<{
  read: boolean;
  write: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
}> = {}): WorkspaceToolDefinition[] {
  return createWorkspaceToolDefinitions({
    enabled: true,
    root,
    read: overrides.read ?? true,
    write: overrides.write ?? true,
    maxReadBytes: overrides.maxReadBytes ?? 1024 * 1024,
    maxWriteBytes: overrides.maxWriteBytes ?? 1024 * 1024,
  });
}

function tool(definitions: WorkspaceToolDefinition[], name: string): WorkspaceToolDefinition {
  const found = definitions.find(definition => definition.name === name);
  if (!found) throw new Error("Missing tool " + name);
  return found;
}

function exec() {
  return { signal: new AbortController().signal };
}

async function expectWorkspaceError(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error("Expected workspace tool failure");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceToolError);
    expect((error as WorkspaceToolError).code).toBe(code);
  }
}

describe("issue #121 bounded workspace filesystem tools", () => {
  test("disabled workspace registers no tools and read/write policy gates the surface", () => {
    const disabled = createWorkspaceToolDefinitions({
      enabled: false,
      root: "",
      read: true,
      write: true,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
    });
    expect(disabled).toEqual([]);

    const readOnly = createWorkspaceToolDefinitions({
      enabled: true,
      root: "/tmp/workspace",
      read: true,
      write: false,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
    });
    expect(readOnly.map(item => item.name)).toEqual(["fs.read", "fs.search"]);

    const writeOnly = createWorkspaceToolDefinitions({
      enabled: true,
      root: "/tmp/workspace",
      read: false,
      write: true,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
    });
    expect(writeOnly.map(item => item.name)).toEqual(["fs.write", "fs.edit"]);
  });

  test("reads a valid UTF-8 file inside the workspace", async () => {
    const root = await createRoot();
    await writeFile(join(root, "hello.txt"), "one\ntwo\nthree\n", "utf8");

    const result = await tool(tools(root), "fs.read").execute(
      { file_path: "hello.txt", start_line: 2, max_lines: 2 },
      exec(),
    );

    expect(result).toMatchObject({
      path: "hello.txt",
      content: "two\nthree\n",
      start_line: 2,
      end_line: 3,
      total_lines: 4,
      truncated: true,
    });
  });

  test("writes a new file but never overwrites an existing file", async () => {
    const root = await createRoot();
    const write = tool(tools(root), "fs.write");

    await write.execute({ file_path: "new.txt", content: "created" }, exec());
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created");

    await expectWorkspaceError(
      () => write.execute({ file_path: "new.txt", content: "replacement" }, exec()),
      "WORKSPACE_EXISTS",
    );
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created");
  });

  test("edits an existing file with unique-match protection", async () => {
    const root = await createRoot();
    const path = join(root, "edit.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const edit = tool(tools(root), "fs.edit");
    const result = await edit.execute(
      { file_path: "edit.txt", old_string: "beta", new_string: "delta" },
      exec(),
    );

    expect(result).toMatchObject({
      path: "edit.txt",
      operation: "edit",
      replacements: 1,
    });
    expect(await readFile(path, "utf8")).toBe("alpha\ndelta\ngamma\n");

    await writeFile(path, "x\nx\n", "utf8");
    await expectWorkspaceError(
      () => edit.execute({ file_path: "edit.txt", old_string: "x", new_string: "y" }, exec()),
      "WORKSPACE_MATCH_AMBIGUOUS",
    );
    expect(await readFile(path, "utf8")).toBe("x\nx\n");
  });

  test("rejects parent traversal before filesystem access", async () => {
    const root = await createRoot();
    const outside = resolve(root, "..", "outside.txt");
    await writeFile(outside, "outside", "utf8");

    await expectWorkspaceError(
      () => tool(tools(root), "fs.read").execute({ file_path: "../outside.txt" }, exec()),
      "WORKSPACE_OUTSIDE_ROOT",
    );
  });

  test("rejects absolute paths outside the configured root", async () => {
    const root = await createRoot();
    const outside = resolve(root, "..", "absolute-outside.txt");
    await writeFile(outside, "outside", "utf8");

    await expectWorkspaceError(
      () => tool(tools(root), "fs.read").execute({ file_path: outside }, exec()),
      "WORKSPACE_OUTSIDE_ROOT",
    );
  });

  test("rejects a symlink that would escape the workspace", async () => {
    if (process.platform === "win32") return;

    const root = await createRoot();
    const outside = await createRoot();
    const outsideFile = join(outside, "secret.txt");
    const link = join(root, "secret-link.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, link);

    await expectWorkspaceError(
      () => tool(tools(root), "fs.read").execute({ file_path: "secret-link.txt" }, exec()),
      "WORKSPACE_SYMLINK",
    );
  });

  test("enforces read and write byte limits", async () => {
    const root = await createRoot();
    await writeFile(join(root, "large.txt"), "12345", "utf8");

    await expectWorkspaceError(
      () => tool(tools(root, { maxReadBytes: 4 }), "fs.read").execute({ file_path: "large.txt" }, exec()),
      "WORKSPACE_TOO_LARGE",
    );

    await expectWorkspaceError(
      () => tool(tools(root, { maxWriteBytes: 4 }), "fs.write").execute({ file_path: "new.txt", content: "12345" }, exec()),
      "WORKSPACE_TOO_LARGE",
    );
  });

  test("returns structured, actionable failure codes", async () => {
    const root = await createRoot();

    try {
      await tool(tools(root), "fs.read").execute({ file_path: "../missing.txt" }, exec());
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceToolError);
      expect((error as WorkspaceToolError).code).toBe("WORKSPACE_OUTSIDE_ROOT");
      expect((error as WorkspaceToolError).message).toContain("escapes the configured workspace root");
    }
  });

  test("searches paths and file contents with bounded results", async () => {
    const root = await createRoot();
    await writeFile(join(root, "alpha.ts"), "const needle = true;\n", "utf8");
    await writeFile(join(root, "beta.md"), "nothing here\n", "utf8");
    await writeFile(join(root, "needle-name.txt"), "other\n", "utf8");

    const result = await tool(tools(root), "fs.search").execute(
      { query: "needle", max_results: 10 },
      exec(),
    ) as {
      results: Array<{ path: string; kind: string; line?: number }>;
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "alpha.ts", kind: "content", line: 1 }),
      expect.objectContaining({ path: "needle-name.txt", kind: "path" }),
    ]));
  });
});
