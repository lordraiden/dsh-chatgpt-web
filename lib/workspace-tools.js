import { constants as fsConstants } from "node:fs";
import { open, lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";

const MAX_PATH_CHARS = 4096;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 10000;
const MAX_SEARCH_PREVIEW_CHARS = 300;
const SKIPPED = new Set([".git", "node_modules"]);

export class WorkspaceToolError extends HarnessError {
  name = "WorkspaceToolError";
  constructor(message, code, options) {
    super(message, code, options);
    this.name = "WorkspaceToolError";
  }
}

function aborted(signal) {
  if (signal?.aborted) throw new WorkspaceToolError("Workspace operation was cancelled.", "WORKSPACE_ABORTED");
}
function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function display(root, target) {
  const value = relative(root, target);
  return value === "" ? "." : value.split(sep).join("/");
}
async function noSymlink(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(sep)) {
    if (!part || part === ".") continue;
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WorkspaceToolError("Symlinked paths are not permitted by the workspace boundary.", "WORKSPACE_SYMLINK");
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if (missing(error)) break;
      throw error;
    }
  }
}
async function rootDir(config) {
  const root = String(config.root ?? "").trim();
  if (!config.enabled || !root) throw new WorkspaceToolError("Workspace tools are enabled but workspaceRoot is empty.", "WORKSPACE_CONFIG_INVALID");
  const absolute = await realpath(resolve(root));
  if (!(await stat(absolute)).isDirectory()) throw new WorkspaceToolError("Configured workspaceRoot is not a directory.", "WORKSPACE_NOT_DIRECTORY");
  return absolute;
}
async function targetOf(config, input, options={}) {
  if (typeof input !== "string" || !input.trim() || input.length > MAX_PATH_CHARS || input.includes("\0")) {
    throw new WorkspaceToolError("Path is invalid.", "WORKSPACE_PATH_INVALID");
  }
  const root = await rootDir(config);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!within(root, candidate)) throw new WorkspaceToolError("The requested path escapes the configured workspace root.", "WORKSPACE_OUTSIDE_ROOT");
  await noSymlink(root, candidate);
  let info;
  try { info = await lstat(candidate); }
  catch (error) {
    if (missing(error)) {
      if (options.mustExist) throw new WorkspaceToolError("The requested workspace path does not exist.", "WORKSPACE_NOT_FOUND");
      return { absolutePath: candidate, displayPath: display(root, candidate), root };
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw new WorkspaceToolError("Symlinked paths are not permitted by the workspace boundary.", "WORKSPACE_SYMLINK");
  if (options.kind === "file" && !info.isFile()) throw new WorkspaceToolError("The requested workspace path is not a regular file.", "WORKSPACE_NOT_FILE");
  if (options.kind === "directory" && !info.isDirectory()) throw new WorkspaceToolError("The requested workspace path is not a directory.", "WORKSPACE_NOT_DIRECTORY");
  return { absolutePath: candidate, displayPath: display(root, candidate), root };
}
function argsObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceToolError("Tool arguments must be an object.", "WORKSPACE_PATH_INVALID");
  return value;
}
function stringArg(args, name, required=true) {
  if (args[name] === undefined && !required) return undefined;
  if (typeof args[name] !== "string") throw new WorkspaceToolError('Argument "' + name + '" must be a string.', "WORKSPACE_PATH_INVALID");
  return args[name];
}
function intArg(args, name, fallback, min, max) {
  if (args[name] === undefined) return fallback;
  if (!Number.isInteger(args[name]) || args[name] < min || args[name] > max) throw new WorkspaceToolError('Argument "' + name + '" must be an integer between ' + min + " and " + max + ".", "WORKSPACE_LIMIT");
  return Number(args[name]);
}
function boolArg(args, name, fallback) { return args[name] === undefined ? fallback : args[name] === true; }
function utf8(buffer, path) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (error) { throw new WorkspaceToolError("File " + path + " is not valid UTF-8 text.", "WORKSPACE_BINARY", { cause: error }); }
}
function bytes(text) { return Buffer.byteLength(text, "utf8"); }
async function boundedText(target, config, signal) {
  aborted(signal);
  const info = await stat(target.absolutePath);
  if (!info.isFile()) throw new WorkspaceToolError("The requested workspace path is not a regular file.", "WORKSPACE_NOT_FILE");
  if (info.size > config.maxReadBytes) throw new WorkspaceToolError("File " + target.displayPath + " exceeds the configured read limit.", "WORKSPACE_TOO_LARGE");
  const buffer = await readFile(target.absolutePath);
  aborted(signal);
  return { text: utf8(buffer, target.displayPath), bytes: buffer.byteLength };
}
function renderText(text) { return [{ type: "text", text }]; }
async function readTool(boundary, argsValue, exec, config) {
  const args = argsObject(argsValue);
  const filePath = stringArg(args, "file_path");
  const start = intArg(args, "start_line", 1, 1, 1000000);
  const max = intArg(args, "max_lines", Number.POSITIVE_INFINITY, 1, 100000);
  const target = await targetOf(config, filePath, { mustExist: true, kind: "file" });
  const { text, bytes: size } = await boundedText(target, config, exec.signal);
  const lines = text.split(/\r?\n/u);
  const offset = Math.min(start - 1, Math.max(0, lines.length - 1));
  const selected = Number.isFinite(max) ? lines.slice(offset, offset + max) : lines.slice(offset);
  const end = selected.length === 0 ? offset : offset + selected.length;
  const separator = text.includes("\r\n") ? "\r\n" : "\n";
  const content = selected.join(separator) + (selected.length > 0 && (end < lines.length || text.endsWith(separator)) ? separator : "");
  return { path: target.displayPath, content, start_line: offset + 1, end_line: end, total_lines: lines.length, truncated: end < lines.length, bytes: size };
}
async function searchTool(boundary, argsValue, exec, config) {
  const args = argsObject(argsValue);
  const query = stringArg(args, "query", false) ?? "";
  const path = stringArg(args, "path", false) ?? ".";
  const sensitive = boolArg(args, "case_sensitive", false);
  const max = intArg(args, "max_results", 50, 1, MAX_SEARCH_RESULTS);
  const target = await targetOf(config, path, { mustExist: true });
  const needle = sensitive ? query : query.toLocaleLowerCase();
  const results = [];
  let scanned = 0, truncated = false;
  const add = result => { if (results.length >= max) { truncated = true; return; } results.push(result); };
  const scan = async file => {
    if (results.length >= max) { truncated = true; return; }
    scanned++; aborted(exec.signal);
    const pathHit = sensitive ? file.displayPath.includes(query) : file.displayPath.toLocaleLowerCase().includes(needle);
    if (!query || pathHit) { add({ path: file.displayPath, kind: "path" }); if (results.length >= max) return; }
    if (!query) return;
    const info = await stat(file.absolutePath).catch(() => undefined);
    if (!info || !info.isFile() || info.size > config.maxReadBytes) return;
    let text;
    try { text = utf8(await readFile(file.absolutePath), file.displayPath); }
    catch (error) { if (error instanceof WorkspaceToolError && error.code === "WORKSPACE_BINARY") return; throw error; }
    const haystack = sensitive ? text : text.toLocaleLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) return;
    const line = text.slice(0, index).split(/\n/u).length;
    let preview = text.slice(text.lastIndexOf("\n", index - 1) + 1, text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index)).replace(/\r$/u, "");
    if (preview.length > MAX_SEARCH_PREVIEW_CHARS) preview = preview.slice(0, MAX_SEARCH_PREVIEW_CHARS - 1) + "…";
    add({ path: file.displayPath, kind: "content", line, preview });
  };
  const walk = async current => {
    aborted(exec.signal);
    if (results.length >= max || scanned >= MAX_SEARCH_FILES) { truncated = true; return; }
    const info = await lstat(current.absolutePath);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) return scan(current);
    if (!info.isDirectory()) return;
    const entries = await readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= max || scanned >= MAX_SEARCH_FILES) { truncated = true; return; }
      if (entry.isDirectory() && SKIPPED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const child = join(current.absolutePath, entry.name);
      if (!within(targetRoot, child)) throw new WorkspaceToolError("Workspace traversal attempted to leave the configured root.", "WORKSPACE_OUTSIDE_ROOT");
      await walk({ absolutePath: child, displayPath: display(targetRoot, child) });
    }
  };
  const targetRoot = target.root;
  await walk(target);
  return { root: target.displayPath, query, results, scanned_files: scanned, truncated };
}
async function writeTool(boundary, argsValue, exec, config) {
  const args = argsObject(argsValue);
  const filePath = stringArg(args, "file_path");
  const content = stringArg(args, "content");
  const size = bytes(content);
  if (size > config.maxWriteBytes) throw new WorkspaceToolError("Write exceeds the configured byte limit.", "WORKSPACE_TOO_LARGE");
  aborted(exec.signal);
  const target = await targetOf(config, filePath);
  if (target.absolutePath === target.root) throw new WorkspaceToolError("The workspace root is a directory.", "WORKSPACE_NOT_FILE");
  const existing = await lstat(target.absolutePath).catch(error => missing(error) ? undefined : Promise.reject(error));
  if (existing) throw new WorkspaceToolError("The target file already exists. Use fs.edit for an existing file.", "WORKSPACE_EXISTS");
  const parent = dirname(target.absolutePath);
  const parentInfo = await lstat(parent).catch(error => missing(error) ? undefined : Promise.reject(error));
  if (!parentInfo?.isDirectory()) throw new WorkspaceToolError("The parent directory does not exist.", "WORKSPACE_PARENT_NOT_FOUND");
  await noSymlink(target.root, parent);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try { handle = await open(target.absolutePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o644); }
  catch (error) { if (error?.code === "EEXIST") throw new WorkspaceToolError("The target file already exists.", "WORKSPACE_EXISTS"); throw error; }
  try { aborted(exec.signal); await handle.writeFile(content, "utf8"); await handle.sync(); }
  catch (error) { await handle.close().catch(() => {}); await rm(target.absolutePath, { force: true }).catch(() => {}); throw error; }
  await handle.close();
  return { path: target.displayPath, operation: "create", bytes: size };
}
async function editTool(boundary, argsValue, exec, config) {
  const args = argsObject(argsValue);
  const filePath = stringArg(args, "file_path");
  const oldString = stringArg(args, "old_string");
  const newString = stringArg(args, "new_string");
  const replaceAll = boolArg(args, "replace_all", false);
  const target = await targetOf(config, filePath, { mustExist: true, kind: "file" });
  const current = await boundedText(target, config, exec.signal);
  if (!oldString) throw new WorkspaceToolError("old_string must be non-empty.", "WORKSPACE_MATCH_NOT_FOUND");
  if (oldString === newString) throw new WorkspaceToolError("old_string and new_string must differ.", "WORKSPACE_MATCH_NOT_FOUND");
  const first = current.text.indexOf(oldString);
  if (first < 0) throw new WorkspaceToolError("old_string was not found in the target file.", "WORKSPACE_MATCH_NOT_FOUND");
  const second = current.text.indexOf(oldString, first + oldString.length);
  if (!replaceAll && second >= 0) throw new WorkspaceToolError("old_string occurs more than once.", "WORKSPACE_MATCH_AMBIGUOUS");
  const replaced = replaceAll ? current.text.split(oldString).join(newString) : current.text.slice(0, first) + newString + current.text.slice(first + oldString.length);
  const newSize = bytes(replaced);
  if (newSize > config.maxWriteBytes) throw new WorkspaceToolError("Edit exceeds the configured byte limit.", "WORKSPACE_TOO_LARGE");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try { handle = await open(target.absolutePath, fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollow); }
  catch (error) { throw new WorkspaceToolError("The target file could not be opened safely for editing.", "WORKSPACE_SYMLINK", { cause: error }); }
  try { aborted(exec.signal); await handle.writeFile(replaced, "utf8"); await handle.sync(); } finally { await handle.close(); }
  return { path: target.displayPath, operation: "edit", replacements: replaceAll ? current.text.split(oldString).length - 1 : 1, bytes: newSize };
}
function definition(name, description, parameters, schema, execute) {
  return { name, description, parameters, output: { schema, render: (_args, value) => renderText(JSON.stringify(value)) }, execute };
}
export function createWorkspaceToolDefinitions(config) {
  if (!config.enabled) return [];
  const boundary = config;
  const defs = [];
  if (config.read) {
    defs.push(definition("fs.read", "Read a bounded UTF-8 text file inside the explicitly configured workspace.", {
      type: "object", additionalProperties: false,
      properties: { file_path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, max_lines: { type: "integer", minimum: 1, maximum: 100000 } },
      required: ["file_path"]
    }, { type: "object" }, (args, exec) => readTool(boundary, args, exec, config)));
    defs.push(definition("fs.search", "Search workspace file paths and UTF-8 text.", {
      type: "object", additionalProperties: false,
      properties: { query: { type: "string" }, path: { type: "string" }, case_sensitive: { type: "boolean" }, max_results: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS } }
    }, { type: "object" }, (args, exec) => searchTool(boundary, args, exec, config)));
  }
  if (config.write) {
    defs.push(definition("fs.write", "Create a new UTF-8 text file inside the workspace.", {
      type: "object", additionalProperties: false,
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"]
    }, { type: "object" }, (args, exec) => writeTool(boundary, args, exec, config)));
    defs.push(definition("fs.edit", "Edit an existing UTF-8 text file by literal replacement.", {
      type: "object", additionalProperties: false,
      properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["file_path", "old_string", "new_string"]
    }, { type: "object" }, (args, exec) => editTool(boundary, args, exec, config)));
  }
  return defs;
}
export function registerWorkspaceTools(ctx, config) {
  const defs = createWorkspaceToolDefinitions(config);
  for (const tool of defs) ctx.tools.register(tool);
  return defs.map(tool => tool.name);
}
