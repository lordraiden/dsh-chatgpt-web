import { constants as fsConstants } from "node:fs";
import { open, lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";

export const DEFAULT_WORKSPACE_MAX_READ_BYTES = 1_048_576;
export const DEFAULT_WORKSPACE_MAX_WRITE_BYTES = 1_048_576;

const MAX_PATH_CHARS = 4096;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_PREVIEW_CHARS = 300;
const SKIPPED_SEARCH_DIRECTORIES = new Set([".git", "node_modules"]);

export type WorkspaceToolErrorCode =
  | "WORKSPACE_DISABLED"
  | "WORKSPACE_CONFIG_INVALID"
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_OUTSIDE_ROOT"
  | "WORKSPACE_SYMLINK"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_NOT_FILE"
  | "WORKSPACE_BINARY"
  | "WORKSPACE_TOO_LARGE"
  | "WORKSPACE_PARENT_NOT_FOUND"
  | "WORKSPACE_EXISTS"
  | "WORKSPACE_MATCH_NOT_FOUND"
  | "WORKSPACE_MATCH_AMBIGUOUS"
  | "WORKSPACE_ABORTED"
  | "WORKSPACE_LIMIT";

export class WorkspaceToolError extends HarnessError {
  override readonly name = "WorkspaceToolError";

  constructor(message: string, code: WorkspaceToolErrorCode, options?: ErrorOptions) {
    super(message, code, options);
    this.name = "WorkspaceToolError";
  }
}

export interface WorkspaceToolConfig {
  enabled: boolean;
  root: string;
  read: boolean;
  write: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
}

export interface WorkspaceToolExecution {
  signal: AbortSignal;
}

export interface WorkspaceToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: "text"; text: string }>;
  };
  execute: (args: unknown, exec: WorkspaceToolExecution) => Promise<unknown>;
}

interface WorkspaceTarget {
  absolutePath: string;
  displayPath: string;
}

interface SearchResult {
  path: string;
  kind: "path" | "content";
  line?: number;
  preview?: string;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceToolError("Workspace operation was cancelled.", "WORKSPACE_ABORTED");
  }
}

function parseConfig(config: WorkspaceToolConfig): WorkspaceToolConfig {
  if (!config.enabled) return config;

  const root = config.root.trim();
  if (!root) {
    throw new WorkspaceToolError(
      "Workspace tools are enabled but workspaceRoot is empty. Configure one explicit workspace root.",
      "WORKSPACE_CONFIG_INVALID",
    );
  }
  if (!Number.isSafeInteger(config.maxReadBytes) || config.maxReadBytes <= 0
    || !Number.isSafeInteger(config.maxWriteBytes) || config.maxWriteBytes <= 0) {
    throw new WorkspaceToolError(
      "Workspace size limits must be positive safe integers.",
      "WORKSPACE_CONFIG_INVALID",
    );
  }
  if (config.maxReadBytes > 16 * 1024 * 1024 || config.maxWriteBytes > 16 * 1024 * 1024) {
    throw new WorkspaceToolError(
      "Workspace size limits may not exceed 16 MiB.",
      "WORKSPACE_CONFIG_INVALID",
    );
  }
  return { ...config, root };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function relativeDisplayPath(rootPath: string, targetPath: string): string {
  const value = relative(rootPath, targetPath);
  return value === "" ? "." : value.split(sep).join("/");
}

async function assertNoSymlinkComponents(rootPath: string, candidatePath: string): Promise<void> {
  const rel = relative(rootPath, candidatePath);
  if (rel === "") return;

  let current = rootPath;
  for (const component of rel.split(sep)) {
    if (!component || component === ".") continue;
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new WorkspaceToolError(
          "Symlinked paths are not permitted by the workspace boundary.",
          "WORKSPACE_SYMLINK",
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if (isMissingError(error)) break;
      throw error;
    }
  }
}

async function resolveWorkspaceRoot(config: WorkspaceToolConfig): Promise<string> {
  const parsed = parseConfig(config);
  try {
    const root = await realpath(resolve(parsed.root));
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new WorkspaceToolError(
        "Configured workspaceRoot is not a directory.",
        "WORKSPACE_NOT_DIRECTORY",
      );
    }
    return root;
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    throw new WorkspaceToolError(
      "Configured workspaceRoot is unavailable: " + errorMessage(error),
      "WORKSPACE_CONFIG_INVALID",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

class WorkspaceBoundary {
  private readonly config: WorkspaceToolConfig;

  constructor(config: WorkspaceToolConfig) {
    this.config = parseConfig(config);
  }

  async resolve(
    input: string,
    options: { mustExist?: boolean; kind?: "file" | "directory" } = {},
  ): Promise<WorkspaceTarget> {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new WorkspaceToolError("Path must be a non-empty string.", "WORKSPACE_PATH_INVALID");
    }
    if (input.length > MAX_PATH_CHARS) {
      throw new WorkspaceToolError(
        "Path exceeds the " + MAX_PATH_CHARS + "-character limit.",
        "WORKSPACE_PATH_INVALID",
      );
    }
    if (input.includes("\0")) {
      throw new WorkspaceToolError("Path contains a NUL byte.", "WORKSPACE_PATH_INVALID");
    }

    const rootPath = await resolveWorkspaceRoot(this.config);
    const candidatePath = isAbsolute(input)
      ? resolve(input)
      : resolve(rootPath, input);

    if (!isWithinRoot(rootPath, candidatePath)) {
      throw new WorkspaceToolError(
        "The requested path escapes the configured workspace root.",
        "WORKSPACE_OUTSIDE_ROOT",
      );
    }

    await assertNoSymlinkComponents(rootPath, candidatePath);

    let info;
    try {
      info = await lstat(candidatePath);
    } catch (error) {
      if (isMissingError(error)) {
        if (options.mustExist) {
          throw new WorkspaceToolError(
            "The requested workspace path does not exist.",
            "WORKSPACE_NOT_FOUND",
          );
        }
        return {
          absolutePath: candidatePath,
          displayPath: relativeDisplayPath(rootPath, candidatePath),
        };
      }
      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new WorkspaceToolError(
        "Symlinked paths are not permitted by the workspace boundary.",
        "WORKSPACE_SYMLINK",
      );
    }

    if (options.kind === "file" && !info.isFile()) {
      throw new WorkspaceToolError(
        "The requested workspace path is not a regular file.",
        "WORKSPACE_NOT_FILE",
      );
    }
    if (options.kind === "directory" && !info.isDirectory()) {
      throw new WorkspaceToolError(
        "The requested workspace path is not a directory.",
        "WORKSPACE_NOT_DIRECTORY",
      );
    }

    return {
      absolutePath: candidatePath,
      displayPath: relativeDisplayPath(rootPath, candidatePath),
    };
  }

  async resolveRoot(): Promise<string> {
    return resolveWorkspaceRoot(this.config);
  }

  get maxReadBytes(): number {
    return this.config.maxReadBytes;
  }

  get maxWriteBytes(): number {
    return this.config.maxWriteBytes;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceToolError("Tool arguments must be an object.", "WORKSPACE_PATH_INVALID");
  }
  return value as Record<string, unknown>;
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new WorkspaceToolError(
      'Argument "' + name + '" must be a string.',
      "WORKSPACE_PATH_INVALID",
    );
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  return value === undefined ? fallback : value === true;
}

function integerArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new WorkspaceToolError(
      'Argument "' + name + '" must be an integer between ' + min + " and " + max + ".",
      "WORKSPACE_LIMIT",
    );
  }
  return Number(value);
}

function decodeUtf8(buffer: Buffer, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new WorkspaceToolError(
      "File " + displayPath + " is not valid UTF-8 text.",
      "WORKSPACE_BINARY",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function assertByteLimit(
  value: string,
  maxBytes: number,
  code: WorkspaceToolErrorCode,
  operation: string,
): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new WorkspaceToolError(
      operation + " exceeds the configured " + maxBytes + "-byte limit.",
      code,
    );
  }
  return bytes;
}

async function readBoundedText(
  target: WorkspaceTarget,
  boundary: WorkspaceBoundary,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  assertNotAborted(signal);
  const info = await stat(target.absolutePath);
  if (!info.isFile()) {
    throw new WorkspaceToolError(
      "The requested workspace path is not a regular file.",
      "WORKSPACE_NOT_FILE",
    );
  }
  if (info.size > boundary.maxReadBytes) {
    throw new WorkspaceToolError(
      "File " + target.displayPath + " is " + info.size + " bytes, above the configured "
        + boundary.maxReadBytes + "-byte read limit.",
      "WORKSPACE_TOO_LARGE",
    );
  }
  const buffer = await readFile(target.absolutePath);
  assertNotAborted(signal);
  return {
    text: decodeUtf8(buffer, target.displayPath),
    bytes: buffer.byteLength,
  };
}

function renderText(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

async function executeRead(
  boundary: WorkspaceBoundary,
  argsValue: unknown,
  exec: WorkspaceToolExecution,
): Promise<Record<string, unknown>> {
  const args = asRecord(argsValue);
  const filePath = stringArg(args, "file_path")!;
  const startLine = integerArg(args, "start_line", 1, 1, 1_000_000);
  const maxLines = integerArg(args, "max_lines", Number.POSITIVE_INFINITY, 1, 100_000);
  const target = await boundary.resolve(filePath, { mustExist: true, kind: "file" });
  const { text, bytes } = await readBoundedText(target, boundary, exec.signal);

  const lines = text.split(/\r?\n/u);
  const offset = Math.min(startLine - 1, Math.max(0, lines.length - 1));
  const selected = Number.isFinite(maxLines)
    ? lines.slice(offset, offset + maxLines)
    : lines.slice(offset);
  const endLine = selected.length === 0 ? offset : offset + selected.length;

  return {
    path: target.displayPath,
    content: selected.join("\n"),
    start_line: offset + 1,
    end_line: endLine,
    total_lines: lines.length,
    truncated: endLine < lines.length,
    bytes,
  };
}

async function executeSearch(
  boundary: WorkspaceBoundary,
  argsValue: unknown,
  exec: WorkspaceToolExecution,
): Promise<Record<string, unknown>> {
  const args = asRecord(argsValue);
  const query = stringArg(args, "query", false) ?? "";
  const path = stringArg(args, "path", false) ?? ".";
  const caseSensitive = booleanArg(args, "case_sensitive", false);
  const maxResults = integerArg(args, "max_results", 50, 1, MAX_SEARCH_RESULTS);
  const target = await boundary.resolve(path, { mustExist: true });
  const rootPath = await boundary.resolveRoot();

  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const results: SearchResult[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const pushResult = (result: SearchResult): void => {
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }
    results.push(result);
  };

  const scanFile = async (fileTarget: WorkspaceTarget): Promise<void> => {
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }
    scannedFiles += 1;
    assertNotAborted(exec.signal);

    const pathMatch = caseSensitive
      ? fileTarget.displayPath.includes(query)
      : fileTarget.displayPath.toLocaleLowerCase().includes(needle);

    if (query.length === 0 || pathMatch) {
      pushResult({ path: fileTarget.displayPath, kind: "path" });
      if (results.length >= maxResults) return;
    }

    if (query.length === 0) return;

    let info;
    try {
      info = await stat(fileTarget.absolutePath);
    } catch {
      return;
    }
    if (info.size > boundary.maxReadBytes) return;

    let text: string;
    try {
      text = decodeUtf8(
        await readFile(fileTarget.absolutePath),
        fileTarget.displayPath,
      );
    } catch (error) {
      if (error instanceof WorkspaceToolError && error.code === "WORKSPACE_BINARY") return;
      throw error;
    }

    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) return;

    const line = text.slice(0, index).split(/\n/u).length;
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const lineEndRaw = text.indexOf("\n", index);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    let preview = text.slice(lineStart, lineEnd).replace(/\r$/u, "");
    if (preview.length > MAX_SEARCH_PREVIEW_CHARS) {
      preview = preview.slice(0, MAX_SEARCH_PREVIEW_CHARS - 1) + "…";
    }
    pushResult({
      path: fileTarget.displayPath,
      kind: "content",
      line,
      preview,
    });
  };

  const walk = async (current: WorkspaceTarget): Promise<void> => {
    assertNotAborted(exec.signal);
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }

    const info = await lstat(current.absolutePath);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      await scanFile(current);
      return;
    }
    if (!info.isDirectory()) return;

    const entries = await readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      if (scannedFiles >= MAX_SEARCH_FILES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const childAbsolute = join(current.absolutePath, entry.name);
      if (!isWithinRoot(rootPath, childAbsolute)) {
        throw new WorkspaceToolError(
          "Workspace traversal attempted to leave the configured root.",
          "WORKSPACE_OUTSIDE_ROOT",
        );
      }

      await walk({
        absolutePath: childAbsolute,
        displayPath: relativeDisplayPath(rootPath, childAbsolute),
      });
    }
  };

  await walk(target);
  return {
    root: target.displayPath,
    query,
    results,
    scanned_files: scannedFiles,
    truncated,
  };
}

async function executeWrite(
  boundary: WorkspaceBoundary,
  argsValue: unknown,
  exec: WorkspaceToolExecution,
): Promise<Record<string, unknown>> {
  const args = asRecord(argsValue);
  const filePath = stringArg(args, "file_path")!;
  const content = stringArg(args, "content")!;
  const bytes = assertByteLimit(
    content,
    boundary.maxWriteBytes,
    "WORKSPACE_TOO_LARGE",
    "Write",
  );

  assertNotAborted(exec.signal);
  const target = await boundary.resolve(filePath);
  const rootPath = await boundary.resolveRoot();
  if (target.absolutePath === rootPath) {
    throw new WorkspaceToolError(
      "The workspace root is a directory and cannot be written as a file.",
      "WORKSPACE_NOT_FILE",
    );
  }

  const existing = await lstat(target.absolutePath).catch(error => {
    if (isMissingError(error)) return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile()) {
      throw new WorkspaceToolError(
        "The target path is not a regular file.",
        "WORKSPACE_NOT_FILE",
      );
    }
    throw new WorkspaceToolError(
      "The target file already exists. Use fs.edit for an existing file.",
      "WORKSPACE_EXISTS",
    );
  }

  const parentPath = dirname(target.absolutePath);
  try {
    const parentInfo = await lstat(parentPath);
    if (!parentInfo.isDirectory()) {
      throw new WorkspaceToolError(
        "The parent path is not a directory.",
        "WORKSPACE_PARENT_NOT_FOUND",
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    if (isMissingError(error)) {
      throw new WorkspaceToolError(
        "The parent directory does not exist. Workspace write does not create directories implicitly.",
        "WORKSPACE_PARENT_NOT_FOUND",
      );
    }
    throw error;
  }

  await assertNoSymlinkComponents(rootPath, parentPath);

  const noFollow = typeof (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW === "number"
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      target.absolutePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceToolError(
        "The target file already exists. Use fs.edit for an existing file.",
        "WORKSPACE_EXISTS",
      );
    }
    throw error;
  }

  try {
    assertNotAborted(exec.signal);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    try { await handle.close(); } catch {}
    try { await rm(target.absolutePath, { force: true }); } catch {}
    throw error;
  }
  await handle.close();

  return {
    path: target.displayPath,
    operation: "create",
    bytes,
  };
}

function replaceLiteral(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { text: string; count: number } {
  if (oldString.length === 0) {
    throw new WorkspaceToolError(
      "old_string must be non-empty.",
      "WORKSPACE_MATCH_NOT_FOUND",
    );
  }
  if (oldString === newString) {
    throw new WorkspaceToolError(
      "old_string and new_string must differ.",
      "WORKSPACE_MATCH_NOT_FOUND",
    );
  }

  let count = 0;
  let cursor = 0;
  while (true) {
    const index = text.indexOf(oldString, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + oldString.length;
    if (!replaceAll) break;
  }

  if (count === 0) {
    throw new WorkspaceToolError(
      "old_string was not found in the target file.",
      "WORKSPACE_MATCH_NOT_FOUND",
    );
  }
  if (!replaceAll) {
    const second = text.indexOf(oldString, cursor);
    if (second >= 0) {
      throw new WorkspaceToolError(
        "old_string occurs more than once. Use replace_all=true or provide a more specific old_string.",
        "WORKSPACE_MATCH_AMBIGUOUS",
      );
    }
  }

  return {
    text: replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString),
    count,
  };
}

async function executeEdit(
  boundary: WorkspaceBoundary,
  argsValue: unknown,
  exec: WorkspaceToolExecution,
): Promise<Record<string, unknown>> {
  const args = asRecord(argsValue);
  const filePath = stringArg(args, "file_path")!;
  const oldString = stringArg(args, "old_string")!;
  const newString = stringArg(args, "new_string")!;
  const replaceAll = booleanArg(args, "replace_all", false);

  const target = await boundary.resolve(filePath, { mustExist: true, kind: "file" });
  const current = await readBoundedText(target, boundary, exec.signal);
  const replaced = replaceLiteral(current.text, oldString, newString, replaceAll);
  const newBytes = assertByteLimit(
    replaced.text,
    boundary.maxWriteBytes,
    "WORKSPACE_TOO_LARGE",
    "Edit",
  );

  assertNotAborted(exec.signal);

  const noFollow = typeof (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW === "number"
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      target.absolutePath,
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollow,
    );
  } catch (error) {
    throw new WorkspaceToolError(
      "The target file could not be opened safely for editing.",
      "WORKSPACE_SYMLINK",
      { cause: error instanceof Error ? error : undefined },
    );
  }

  try {
    await handle.writeFile(replaced.text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  return {
    path: target.displayPath,
    operation: "edit",
    replacements: replaced.count,
    bytes: newBytes,
  };
}

function renderRead(_args: unknown, value: unknown) {
  const result = value as Record<string, unknown>;
  return renderText(
    "<path>" + String(result.path) + "</path>\n"
      + "<content>\n" + String(result.content) + "\n</content>\n"
      + "<lines>" + String(result.start_line) + "-" + String(result.end_line)
      + " of " + String(result.total_lines) + "</lines>",
  );
}

function renderSearch(_args: unknown, value: unknown) {
  const result = value as {
    query: string;
    results: SearchResult[];
    truncated: boolean;
  };
  if (result.results.length === 0) return renderText("No workspace matches.");

  const lines = result.results.map(match => {
    const location = match.line === undefined
      ? match.path
      : match.path + ":" + match.line;
    const preview = match.preview === undefined ? "" : " — " + match.preview;
    return location + preview;
  });

  return renderText(
    "<query>" + result.query + "</query>\n"
      + "<matches>\n" + lines.join("\n") + "\n</matches>\n"
      + (result.truncated ? "<truncated>true</truncated>" : "<truncated>false</truncated>"),
  );
}

function renderWrite(_args: unknown, value: unknown) {
  const result = value as Record<string, unknown>;
  return renderText(
    "Created <path>" + String(result.path) + "</path> (" + String(result.bytes) + " bytes).",
  );
}

function renderEdit(_args: unknown, value: unknown) {
  const result = value as Record<string, unknown>;
  const count = Number(result.replacements);
  return renderText(
    "Edited <path>" + String(result.path) + "</path> ("
      + count + " replacement" + (count === 1 ? "" : "s") + ").",
  );
}

function definition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  output: Record<string, unknown>,
  execute: (args: unknown, exec: WorkspaceToolExecution) => Promise<unknown>,
  render: (args: unknown, value: unknown) => Array<{ type: "text"; text: string }>,
): WorkspaceToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: output,
      render,
    },
    execute,
  };
}

export function createWorkspaceToolDefinitions(
  config: WorkspaceToolConfig,
): WorkspaceToolDefinition[] {
  if (!config.enabled) return [];

  const boundary = new WorkspaceBoundary(config);
  const definitions: WorkspaceToolDefinition[] = [];

  if (config.read) {
    definitions.push(
      definition(
        "fs.read",
        "Read a bounded UTF-8 text file inside the explicitly configured workspace. Paths outside the workspace, symlinks, binary files, and oversized files are rejected.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: {
              type: "string",
              description: "Workspace-relative path to a regular UTF-8 text file.",
            },
            start_line: {
              type: "integer",
              minimum: 1,
              description: "1-based line to start from. Defaults to 1.",
            },
            max_lines: {
              type: "integer",
              minimum: 1,
              maximum: 100000,
              description: "Maximum number of lines to return. Defaults to the remaining file.",
            },
          },
          required: ["file_path"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            start_line: { type: "integer" },
            end_line: { type: "integer" },
            total_lines: { type: "integer" },
            truncated: { type: "boolean" },
            bytes: { type: "integer" },
          },
          required: [
            "path", "content", "start_line", "end_line",
            "total_lines", "truncated", "bytes",
          ],
        },
        (args, exec) => executeRead(boundary, args, exec),
        renderRead,
      ),
      definition(
        "fs.search",
        "Search workspace file paths and UTF-8 text using a bounded literal substring search. Symlinks, .git, and node_modules traversal are excluded.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "Literal substring to find. Empty finds file paths.",
            },
            path: {
              type: "string",
              description: "Workspace-relative directory or file to search. Defaults to the workspace root.",
            },
            case_sensitive: {
              type: "boolean",
              description: "Whether matching is case-sensitive. Defaults to false.",
            },
            max_results: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
              description: "Maximum results to return. Defaults to 50.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            root: { type: "string" },
            query: { type: "string" },
            results: { type: "array" },
            scanned_files: { type: "integer" },
            truncated: { type: "boolean" },
          },
          required: ["root", "query", "results", "scanned_files", "truncated"],
        },
        (args, exec) => executeSearch(boundary, args, exec),
        renderSearch,
      ),
    );
  }

  if (config.write) {
    definitions.push(
      definition(
        "fs.write",
        "Create a new UTF-8 text file inside the explicitly configured workspace. Existing files are never overwritten by this tool.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: {
              type: "string",
              description: "Workspace-relative path for the new file.",
            },
            content: {
              type: "string",
              description: "UTF-8 text content.",
            },
          },
          required: ["file_path", "content"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            operation: { type: "string", enum: ["create"] },
            bytes: { type: "integer" },
          },
          required: ["path", "operation", "bytes"],
        },
        (args, exec) => executeWrite(boundary, args, exec),
        renderWrite,
      ),
      definition(
        "fs.edit",
        "Edit an existing UTF-8 text file by literal replacement. By default old_string must match exactly once; set replace_all=true for all occurrences.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: {
              type: "string",
              description: "Workspace-relative path to the existing file.",
            },
            old_string: {
              type: "string",
              description: "Literal text to replace; must be non-empty.",
            },
            new_string: {
              type: "string",
              description: "Literal replacement text; may be empty.",
            },
            replace_all: {
              type: "boolean",
              description: "Replace every occurrence instead of requiring exactly one. Defaults to false.",
            },
          },
          required: ["file_path", "old_string", "new_string"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            operation: { type: "string", enum: ["edit"] },
            replacements: { type: "integer" },
            bytes: { type: "integer" },
          },
          required: ["path", "operation", "replacements", "bytes"],
        },
        (args, exec) => executeEdit(boundary, args, exec),
        renderEdit,
      ),
    );
  }

  return definitions;
}

export interface WorkspaceToolsContext {
  tools: {
    register(definition: WorkspaceToolDefinition): unknown;
  };
}

export function registerWorkspaceTools(
  ctx: WorkspaceToolsContext,
  config: WorkspaceToolConfig,
): string[] {
  const definitions = createWorkspaceToolDefinitions(config);
  for (const tool of definitions) ctx.tools.register(tool);
  return definitions.map(tool => tool.name);
}
