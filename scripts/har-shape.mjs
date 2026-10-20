#!/usr/bin/env node
/**
 * HAR shape analyser — bounded, secret-free structural report of one recorded signed-in turn.
 *
 * Why this exists: onboarding a consumer-web provider starts with a HAR of one signed-in turn, and the
 * maintainer must extract the API endpoints, the request body key trees, the streaming shape and its
 * termination signal, candidate model ids, mode/effort parameters and whether a stable account id
 * appears. That analysis produced the Qwen Code protocol **by hand three times** (doc/qwen-code.md §2).
 * This script is that analysis, once, as a command. It is not a protocol decision: every finding is
 * evidence a human still confirms, and nothing here may be used to invent a provider protocol
 * (AGENTS.md → *Agent decision discipline*).
 *
 * ## The safety rule (binding)
 *
 * A HAR is a file full of cookies and bearer tokens, so the report must be safe to paste into an issue:
 *
 * - **No header, query, body or frame VALUE is ever printed**, except values that are structurally
 *   safe by construction: HTTP methods, status codes, content types, JSON key names and value *types*,
 *   SSE event names, model ids, and short enumerated termination-field values.
 * - Header names, query-parameter names and body field names **are** printed — those are the shape.
 * - Cookie, `authorization`, token, session and CSRF values therefore cannot appear: their fields are
 *   named, never valued.
 * - Unknown-looking long alphanumeric strings (the shape of a token that is not in a token-named
 *   field) are redacted as well, so a token that "looks like a normal id" does not leak either.
 * - Account-like values are **fingerprinted**, never printed: onboarding §5.3 and AGENTS.md →
 *   *Security and privacy* forbid raw account identities in diagnostics. A model id is not an
 *   identity, so it is printed — it has to be configured.
 * - Error paths follow the same rule: messages name the file by basename only, and an unexpected
 *   failure is reduced to `name=… code=…`, never a stack trace and never a raw value.
 *
 * ## One scrubber, not two
 *
 * The URL/whitespace/bounds policy is the repository's single non-secret diagnostic helper,
 * `nonSecretDiagnosticText` (`src/lib/safe-diagnostics.ts`), and fingerprints come from
 * `fingerprintDiagnosticValue`. This script adds only the one rule the HAR contract needs on top —
 * redacting identifier-shaped long strings — and never relaxes the shared helper. It has **zero npm
 * dependencies**; Node's built-in TypeScript stripping (already relied on by the container bootstrap,
 * `docker/bootstrap-config.ts`) is what lets plain Node import the shared `.ts` sanitizer.
 *
 * Usage:
 *
 *   node scripts/har-shape.mjs <har-file> [--json] [--top N] [--depth N] [--frames N]
 *
 *   --json      machine-readable report on stdout
 *   --top N     endpoints shown / examined (default 8)
 *   --depth N   JSON body key-tree depth (default 6)
 *   --frames N  distinct SSE frame shapes shown per endpoint (default 8)
 *
 * Exit codes: 0 report produced, 1 not a readable HAR, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fingerprintDiagnosticValue,
  nonSecretDiagnosticText,
  safeErrorDescriptor,
} from "../src/lib/safe-diagnostics.ts";

const USAGE =
  "Usage: node scripts/har-shape.mjs <har-file> [--json] [--top N] [--depth N] [--frames N]";

const DEFAULT_TOP = 8;
const DEFAULT_DEPTH = 6;
const DEFAULT_FRAMES = 8;
const DEFAULT_BODY_LINES = 80;
const MAX_HEADER_NAMES = 24;
const MAX_BODIES_PER_ENDPOINT = 8;
const MAX_JSON_CHARS = 4_000_000;
const MAX_RESPONSE_JSON_CHARS = 2_000_000;
const MAX_IDENTIFIER_VALUES = 24;
const MAX_ENDPOINT_LABEL = 72;
const MAX_ENUM_VALUES = 12;

/** Field names that name a model / deployment, i.e. something the catalogue has to configure. */
const MODEL_KEY = /^(?:models?|model_?id|model_?name|model_?key|deployment|deployment_?id|deployment_?name|engine)$/i;

/** Field names that could bind an account. Values of these are fingerprinted, never printed. */
const ACCOUNT_KEY =
  /^(?:account(?:_?id)?|user(?:_?id)?|uid|sub|org(?:_?id)?|organization(?:_?id)?|tenant(?:_?id)?|workspace(?:_?id)?|member(?:_?id)?|email|e-?mail|username|login|team(?:_?id)?)$/i;

/** Field names whose changing value can terminate a stream. */
const TERMINATION_KEY =
  /^(?:status|phase|state|action|type|event|finish_?reason|stop_?reason|done|ended|complete|completed|terminated|keep_?alive|stream_?end)$/i;

/** A string that carries no structural meaning and looks like a credential. */
const TOKEN_LIKE = /^(?:[A-Za-z0-9+/_=-]{20,}|[A-Za-z0-9+/_=-]{12,}(?:\.[A-Za-z0-9+/_=-]{12,})+)$/;

const MESSAGES_KEY = /^(?:messages?|contents?|history|turns?|conversation)$/i;
const TURN_PATH = /(?:complet|chat|generat|message|responses?|conversation|prompt|turn)/i;
const SAFE_PRINTABLE = /^[\x20-\x7E]{1,64}$/;

class HarShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarShapeError";
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------------------------------

/**
 * True when a whole value looks like an unreferenced credential rather than a name, an enum value or
 * a model id. Deliberately conservative about length: a real token is long, a status word is not.
 */
export function isTokenShaped(value) {
  if (typeof value !== "string") return false;
  if (value.length > 512) return true;
  return TOKEN_LIKE.test(value);
}

/**
 * A readable identifier made of words (`pull_requests_total_count`, `response.created`) is a field
 * name even when it is long enough to trip the token heuristic. A random id or a credential is not.
 */
function readableName(name) {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*$/.test(name)) return false;
  return name.split(/[_.-]/).every((segment) =>
    /^[A-Za-z]+$/.test(segment) ||
    (segment.length <= 6 && /^[0-9]+$/.test(segment)) ||
    (segment.length <= 8 && /^[A-Za-z]+[0-9]+$/.test(segment)));
}

/** A header name, query-parameter name or JSON key, safe to print. */
function printableName(name) {
  const text = String(name);
  if (text.length === 0) return "[empty-name]";
  if (isTokenShaped(text) && !readableName(text)) return "[redacted-name]";
  if (!SAFE_PRINTABLE.test(text)) return "[unprintable-name]";
  return text;
}

/**
 * A model id, printed because a catalogue row has to configure it. It still goes through the shared
 * helper and is still refused if it is token-shaped or not an identifier.
 */
function printableModelId(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = nonSecretDiagnosticText(value);
  if (text.length === 0 || text.length > 64) return "[redacted]";
  if (isTokenShaped(text)) return "[redacted]";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(text)) return "[redacted]";
  return text;
}

/** A short, non-secret scalar a human may read (status/phase/action values). */
function safeEnumValue(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    return text.length <= 12 ? text : null;
  }
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 32) return null;
  if (!/^[A-Za-z0-9_.:+-]+$/.test(value)) return null;
  if (isTokenShaped(value)) return null;
  if (/^\d{13,}$/.test(value)) return null;
  return value;
}

function printableContentType(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length > 80) return "[unprintable-content-type]";
  if (!/^[\x20-\x7E]+$/.test(value)) return "[unprintable-content-type]";
  return value;
}

// ---------------------------------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------------------------------

/**
 * Collapse volatile path segments so repeated calls group together:
 * `/coder/api/v2/task/3419b232-…/status` and `/coder/api/v2/task/other-id/status` are one shape.
 * A UUID, a long id-shaped segment and a numeric id (>= 4 digits) become `:id`; `v2` stays `v2`.
 */
export function normalizePath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return "/";
  return pathname
    .split("/")
    .map((segment) => {
      if (segment.length === 0 || /^[.:~-]+$/.test(segment)) return segment;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
      if (/^\d{4,}$/.test(segment)) return ":id";
      if (isTokenShaped(segment)) return ":id";
      if (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

function printableHost(host) {
  const text = String(host);
  if (text.length === 0) return "[empty-host]";
  if (text.length > 128) return "[redacted-host]";
  if (isTokenShaped(text) && !readableName(text)) return "[redacted-host]";
  return text;
}

function parseEntryUrl(raw) {
  try {
    const url = new URL(raw);
    const queryNames = [];
    for (const name of url.searchParams.keys()) {
      if (!queryNames.includes(name)) queryNames.push(name);
    }
    return {
      host: printableHost(url.host),
      path: url.pathname || "/",
      queryNames,
      malformed: false,
    };
  } catch {
    // Never echo an unparsable URL: it is the one place a one-time code can survive outside headers.
    return { host: "[unparsable-url]", path: "/[unparsable-url]", queryNames: [], malformed: true };
  }
}

// ---------------------------------------------------------------------------------------------------
// JSON key-tree shape (values never stored)
// ---------------------------------------------------------------------------------------------------

function makeShape(value, depth, maxDepth) {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return { kind: "array", length: value.length, element: null, truncated: true };
    const samples = [];
    for (let index = 0; index < value.length && index < 3; index += 1) {
      samples.push(makeShape(value[index], depth + 1, maxDepth));
    }
    return {
      kind: "array",
      length: value.length,
      element: samples.length > 0 ? samples.slice(1).reduce((merged, node) => mergeNodes(merged, node), samples[0]) : null,
    };
  }
  if (typeof value === "object") {
    const fields = new Map();
    if (depth >= maxDepth) return { kind: "object", fields, truncated: true };
    for (const [key, child] of Object.entries(value)) {
      fields.set(printableName(key), { node: makeShape(child, depth + 1, maxDepth), optional: false });
    }
    return { kind: "object", fields };
  }
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  return { kind: "unknown" };
}

function nodeKind(node) {
  return node && typeof node.kind === "string" ? node.kind : "unknown";
}

function mergeNodes(a, b) {
  if (!a) return b;
  if (!b) return a;
  const kindA = nodeKind(a);
  const kindB = nodeKind(b);
  if (kindA === "object" && kindB === "object") {
    const fields = new Map();
    for (const [name, entry] of a.fields) {
      const other = b.fields.get(name);
      fields.set(name, {
        node: other ? mergeNodes(entry.node, other.node) : entry.node,
        optional: other ? entry.optional : true,
      });
    }
    for (const [name, entry] of b.fields) {
      if (!a.fields.has(name)) fields.set(name, { node: entry.node, optional: true });
    }
    return { kind: "object", fields, truncated: a.truncated === true && b.truncated === true };
  }
  if (kindA === "array" && kindB === "array") {
    return {
      kind: "array",
      length: Math.max(a.length ?? 0, b.length ?? 0),
      element: mergeNodes(a.element, b.element),
      truncated: a.truncated === true && b.truncated === true,
    };
  }
  if (kindA === kindB) return a.truncated || b.truncated ? { ...a, truncated: true } : a;
  const kinds = [];
  for (const kind of [...(kindA === "union" ? a.kinds : [kindA]), ...(kindB === "union" ? b.kinds : [kindB])]) {
    if (!kinds.includes(kind) && kind !== "null") kinds.push(kind);
  }
  return { kind: "union", kinds: kinds.length > 0 ? kinds : ["null"] };
}

function kindLabel(node) {
  const kind = nodeKind(node);
  if (kind === "union") return node.kinds.join("|");
  if (kind === "array") return "array";
  return kind;
}

/**
 * One-line key shape, used to collapse SSE frames. Leaves are names only; a nested object/array shows
 * its structure, an array's element shows its type. Values never appear here.
 */
export function compactShape(node) {
  const kind = nodeKind(node);
  if (kind === "object") {
    if (node.fields.size === 0) return node.truncated ? "{…}" : "{}";
    const parts = [];
    for (const [name, entry] of node.fields) {
      const childKind = nodeKind(entry.node);
      if (childKind === "object" || childKind === "array" || childKind === "union") {
        parts.push(`${name}: ${compactShape(entry.node)}`);
      } else {
        parts.push(name);
      }
    }
    return `{${parts.join(", ")}}`;
  }
  if (kind === "array") {
    if (!node.element) return node.truncated ? "[…]" : "[]";
    const elementKind = nodeKind(node.element);
    return elementKind === "object" || elementKind === "array" || elementKind === "union"
      ? `[${compactShape(node.element)}]`
      : `[${kindLabel(node.element)}]`;
  }
  if (kind === "union") return node.kinds.join("|");
  return kind;
}

function shapeToJson(node) {
  if (!node) return null;
  const kind = nodeKind(node);
  if (kind === "object") {
    const fields = {};
    for (const [name, entry] of node.fields) {
      fields[name] = { optional: entry.optional === true, shape: shapeToJson(entry.node) };
    }
    return { kind, truncated: node.truncated === true, fields };
  }
  if (kind === "array") {
    return { kind, truncated: node.truncated === true, length: node.length ?? 0, element: shapeToJson(node.element) };
  }
  if (kind === "union") return { kind, kinds: [...node.kinds] };
  return { kind };
}

function renderShapeLines(root, budget) {
  const lines = [];
  const push = (text) => {
    if (lines.length < budget.remaining) lines.push(text);
    else budget.more += 1;
  };

  const walk = (node, name, pad) => {
    const kind = nodeKind(node);
    if (kind === "object") {
      if (node.truncated === true) {
        push(`${pad}${name} (depth limit)`);
        return;
      }
      if (node.fields.size === 0) {
        push(`${pad}${name}: {}`);
        return;
      }
      push(`${pad}${name}`);
      for (const [field, entry] of node.fields) {
        walk(entry.node, `${field}${entry.optional ? "?" : ""}`, pad + "  ");
      }
      return;
    }
    if (kind === "array") {
      const suffix = node.truncated ? " (depth limit)" : "";
      if (!node.element) {
        push(`${pad}${name}: array[${node.length}]${suffix}`);
        return;
      }
      const elementKind = kindLabel(node.element);
      push(`${pad}${name}: array[${node.length}] of ${elementKind}${suffix}`);
      if (node.element) {
        const nested = nodeKind(node.element);
        if (nested === "object" || nested === "array" || nested === "union") {
          walk(node.element, "[0]", pad + "  ");
        }
      }
      return;
    }
    push(`${pad}${name}: ${kindLabel(node)}`);
  };

  if (nodeKind(root) === "object" && root.truncated !== true) {
    for (const [field, entry] of root.fields) walk(entry.node, `${field}${entry.optional ? "?" : ""}`, "");
  } else {
    walk(root, "body", "");
  }
  return { lines, more: budget.more };
}

// ---------------------------------------------------------------------------------------------------
// SSE shape
// ---------------------------------------------------------------------------------------------------

/** Split a `text/event-stream` body into parsed `data:` payloads; values are parsed, never printed. */
export function parseSseText(text) {
  const frames = [];
  const eventNames = [];
  let doneMarkers = 0;
  let dataLines = 0;
  let unparsable = 0;
  let empty = 0;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const data = /^data:(.*)$/.exec(rawLine);
    if (!data) {
      const event = /^event:(.*)$/.exec(rawLine);
      if (event) {
        const name = safeEnumValue(event[1].trim());
        if (name && !eventNames.includes(name)) eventNames.push(name);
      }
      continue;
    }
    dataLines += 1;
    const payload = data[1].trim();
    if (payload.length === 0) {
      empty += 1;
      continue;
    }
    if (payload === "[DONE]" || payload === "[done]") {
      doneMarkers += 1;
      continue;
    }
    try {
      frames.push(JSON.parse(payload));
    } catch {
      unparsable += 1;
    }
  }

  return { frames, eventNames, doneMarkers, dataLines, unparsable, empty };
}

function walkScalars(value, path, visit, depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkScalars(value[index], `${path}[${index}]`, visit, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkScalars(child, path.length > 0 ? `${path}.${key}` : key, visit, depth + 1);
    }
    return;
  }
  visit(path, value);
}

function leafName(path) {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\d+\]$/, "");
}

function collectTerminationFields(frames) {
  const fields = new Map();
  for (const frame of frames) {
    walkScalars(frame, "", (path, value) => {
      if (!TERMINATION_KEY.test(leafName(path))) return;
      let entry = fields.get(path);
      if (!entry) {
        entry = { values: new Map(), suppressed: 0 };
        fields.set(path, entry);
      }
      const safe = safeEnumValue(value);
      if (safe === null) {
        entry.suppressed += 1;
        return;
      }
      entry.values.set(safe, (entry.values.get(safe) ?? 0) + 1);
    });
  }

  return [...fields.entries()].map(([path, entry]) => ({
    path,
    values: [...entry.values.entries()].slice(0, MAX_ENUM_VALUES).map(([value, count]) => ({ value, count })),
    suppressed: entry.suppressed,
    distinct: entry.values.size,
    changes: entry.values.size > 1,
  }));
}

function frameShapes(frames) {
  const counts = new Map();
  for (const frame of frames) {
    const shape = compactShape(makeShape(frame, 0, 4));
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts.entries()].map(([shape, count]) => ({ shape, count }));
}

// ---------------------------------------------------------------------------------------------------
// Identifier fields (model ids printed, account ids fingerprinted)
// ---------------------------------------------------------------------------------------------------

function collectIdentifierValues(value, path, bucket) {
  if (typeof value === "string") {
    if (bucket.length < MAX_IDENTIFIER_VALUES) bucket.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && bucket.length < MAX_IDENTIFIER_VALUES; index += 1) {
      collectIdentifierValues(value[index], `${path}[${index}]`, bucket);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of ["id", "name", "value"]) {
      if (typeof value[key] === "string") {
        if (bucket.length < MAX_IDENTIFIER_VALUES) bucket.push({ path: `${path}.${key}`, value: value[key] });
        return;
      }
    }
  }
}

function collectFields(value, path, buckets, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && index < 16; index += 1) {
      collectFields(value[index], `${path}[${index}]`, buckets, depth + 1);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    if (MODEL_KEY.test(key)) collectIdentifierValues(child, childPath, buckets.models);
    else if (ACCOUNT_KEY.test(key)) collectIdentifierValues(child, childPath, buckets.accounts);
    collectFields(child, childPath, buckets, depth + 1);
  }
}

function emptyBuckets() {
  return { models: [], accounts: [] };
}

// ---------------------------------------------------------------------------------------------------
// HAR reading
// ---------------------------------------------------------------------------------------------------

function jsonSummary(error) {
  if (error instanceof Error && /position (\d+)/.test(error.message)) {
    return `not valid JSON (at character ${/position (\d+)/.exec(error.message)[1]})`;
  }
  return "not valid JSON";
}

/**
 * Read one HAR file. Every failure is this script's own text: a basename, a reason, an exit code.
 * The path itself is not echoed because a private filesystem path is not a public diagnostic.
 */
export function readHarFile(path) {
  const name = basename(path);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
    const reason = code === "ENOENT" ? "file not found" : code === "EACCES" ? "permission denied" : `unreadable (${code || "unknown"})`;
    throw new HarShapeError(`cannot read "${name}": ${reason}`);
  }
  if (text.length > 64 * 1024 * 1024) {
    throw new HarShapeError(`"${name}" is too large to analyse (over 64 MB)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HarShapeError(`"${name}" is ${jsonSummary(error)} — export a HAR from the browser's Network panel`);
  }
  const document = parseHarDocument(parsed);
  return { name, document };
}

export function parseHarDocument(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarShapeError("this is not a HAR archive: expected an object with log.entries[]");
  }
  const log = parsed.log;
  if (log === null || typeof log !== "object" || !Array.isArray(log.entries)) {
    throw new HarShapeError("this is not a HAR archive: missing log.entries[]");
  }
  if (log.entries.length === 0) {
    throw new HarShapeError("this HAR contains no requests (log.entries[] is empty)");
  }
  return { entries: log.entries };
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (!header || typeof header.name !== "string") continue;
    if (header.name.toLowerCase() === wanted && typeof header.value === "string") return header.value;
  }
  return "";
}

function headerNames(headers) {
  if (!Array.isArray(headers)) return [];
  const names = [];
  for (const header of headers) {
    if (!header || typeof header.name !== "string") continue;
    const name = printableName(header.name);
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_HEADER_NAMES) break;
  }
  return names;
}

function bodyContentType(entry) {
  const postData = entry.request.postData;
  if (postData && typeof postData.mimeType === "string" && postData.mimeType.length > 0) {
    return printableContentType(postData.mimeType);
  }
  return printableContentType(headerValue(entry.request.headers, "content-type"));
}

function looksJson(text, contentType) {
  if (/json/i.test(contentType)) return true;
  const trimmed = typeof text === "string" ? text.trimStart() : "";
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function analyseRequestBody(entry, depth) {
  const postData = entry.request.postData;
  if (!postData || typeof postData !== "object") return null;
  const contentType = bodyContentType(entry);
  const shapeOf = { contentType, shape: null, params: [], note: "" };

  if (Array.isArray(postData.params) && postData.params.length > 0) {
    const names = [];
    for (const param of postData.params) {
      if (!param || typeof param.name !== "string") continue;
      const name = printableName(param.name);
      if (!names.includes(name)) names.push(name);
      if (names.length >= MAX_HEADER_NAMES) break;
    }
    shapeOf.params = names;
    return shapeOf;
  }

  if (typeof postData.text !== "string" || postData.text.length === 0) return shapeOf;
  if (postData.text.length > MAX_JSON_CHARS) {
    shapeOf.note = `body too large to shape (${postData.text.length} characters)`;
    return shapeOf;
  }
  if (!looksJson(postData.text, contentType)) {
    shapeOf.note = `body not shaped (${contentType || "unknown content type"})`;
    return shapeOf;
  }
  try {
    shapeOf.shape = makeShape(JSON.parse(postData.text), 0, depth);
    shapeOf.note = "";
  } catch {
    shapeOf.note = "body looks like JSON but did not parse";
  }
  return shapeOf;
}

function analyseResponse(entry, depth) {
  const response = entry.response && typeof entry.response === "object" ? entry.response : {};
  const content = response.content && typeof response.content === "object" ? response.content : {};
  const contentType = printableContentType(content.mimeType);
  const encoding = typeof content.encoding === "string" ? content.encoding : "";
  const text = typeof content.text === "string" ? content.text : "";
  const result = {
    status: Number.isSafeInteger(response.status) ? response.status : null,
    contentType,
    hasContent: text.length > 0,
    shape: null,
    sse: null,
    note: "",
  };

  if (encoding.length > 0 && encoding !== "utf8") {
    result.note = `content encoded as ${printableName(encoding)} (not decoded)`;
    return result;
  }
  if (text.length === 0) return result;

  const looksSse = /event-stream/i.test(contentType) || /^\s*(?:data|event):/m.test(text);
  if (looksSse) {
    result.sse = parseSseText(text);
    result.sse.shapes = frameShapes(result.sse.frames);
    result.sse.terminationFields = collectTerminationFields(result.sse.frames);
    delete result.sse.frames;
    return result;
  }

  if (looksJson(text, contentType) && text.length <= MAX_RESPONSE_JSON_CHARS) {
    try {
      result.shape = makeShape(JSON.parse(text), 0, Math.min(depth, 4));
    } catch {
      result.note = "response looks like JSON but did not parse";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------

function addToSet(set, value) {
  if (value === null || value === undefined || value === "") return;
  set.add(value);
}

function mergeSse(target, source) {
  if (!source) return target;
  const merged = target ?? {
    responses: 0,
    dataLines: 0,
    doneMarkers: 0,
    unparsable: 0,
    eventNames: [],
    shapeCounts: new Map(),
    termination: new Map(),
  };
  merged.responses += 1;
  merged.dataLines += source.dataLines;
  merged.doneMarkers += source.doneMarkers;
  merged.unparsable += source.unparsable;
  for (const name of source.eventNames) if (!merged.eventNames.includes(name)) merged.eventNames.push(name);
  for (const shape of source.shapes ?? []) {
    merged.shapeCounts.set(shape.shape, (merged.shapeCounts.get(shape.shape) ?? 0) + shape.count);
  }
  for (const field of source.terminationFields ?? []) {
    let entry = merged.termination.get(field.path);
    if (!entry) {
      entry = { values: new Map(), suppressed: 0 };
      merged.termination.set(field.path, entry);
    }
    entry.suppressed += field.suppressed;
    for (const value of field.values) {
      entry.values.set(value.value, (entry.values.get(value.value) ?? 0) + value.count);
    }
  }
  return merged;
}

/**
 * Turn a HAR document into the bounded, secret-free report model. Pure: no I/O, no clock, no network.
 * `options` is `{ top, depth, frames, maxBodyLines }` with the CLI defaults applied by the caller.
 */
export function analyzeHar(document, options = {}) {
  const settings = {
    top: options.top ?? DEFAULT_TOP,
    depth: options.depth ?? DEFAULT_DEPTH,
    frames: options.frames ?? DEFAULT_FRAMES,
    maxBodyLines: options.maxBodyLines ?? DEFAULT_BODY_LINES,
  };
  const entries = document.entries;
  const groups = new Map();
  const hosts = new Set();
  let malformedUrls = 0;
  let entriesWithoutResponseContent = 0;

  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || entry.request === null || typeof entry.request !== "object") {
      throw new HarShapeError(`this is not a HAR archive: entry ${index + 1} has no request`);
    }
    if (typeof entry.request.url !== "string" || entry.request.url.length === 0) {
      throw new HarShapeError(`this is not a HAR archive: entry ${index + 1} has no request.url`);
    }
    const url = parseEntryUrl(entry.request.url);
    if (url.malformed) malformedUrls += 1;
    hosts.add(url.host);
    const method = typeof entry.request.method === "string" && /^[A-Za-z]{1,10}$/.test(entry.request.method)
      ? entry.request.method.toUpperCase()
      : "?";
    const key = `${method}|${url.host}|${normalizePath(url.path)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        method,
        host: url.host,
        path: normalizePath(url.path),
        requests: 0,
        queryNames: new Set(),
        statuses: new Set(),
        requestContentTypes: new Set(),
        responseContentTypes: new Set(),
        headerNames: new Set(),
        requestBodies: [],
        requestShapes: null,
        responseShapes: null,
        sse: null,
        models: [],
        accounts: [],
        missingResponseContent: 0,
      };
      groups.set(key, group);
    }

    group.requests += 1;
    for (const name of url.queryNames) addToSet(group.queryNames, printableName(name));
    for (const name of headerNames(entry.request.headers)) addToSet(group.headerNames, name);

    const response = analyseResponse(entry, settings.depth);
    addToSet(group.statuses, response.status);
    addToSet(group.responseContentTypes, response.contentType);
    if (!response.hasContent) {
      entriesWithoutResponseContent += 1;
      group.missingResponseContent += 1;
    }
    if (response.shape) group.responseShapes = mergeNodes(group.responseShapes, response.shape);
    else if (response.sse) group.sse = mergeSse(group.sse, response.sse);

    const body = analyseRequestBody(entry, settings.depth);
    if (body) {
      addToSet(group.requestContentTypes, body.contentType);
      if (group.requestBodies.length < MAX_BODIES_PER_ENDPOINT) group.requestBodies.push(body);
      if (body.shape) group.requestShapes = mergeNodes(group.requestShapes, body.shape);
    }

    // Identifier values are read from the parsed body only; they are never part of the key tree.
    const buckets = emptyBuckets();
    const requestText = entry.request.postData && typeof entry.request.postData.text === "string"
      ? entry.request.postData.text
      : "";
    if (requestText.length > 0 && requestText.length <= MAX_JSON_CHARS && looksJson(requestText, bodyContentType(entry))) {
      try {
        collectFields(JSON.parse(requestText), "", buckets);
      } catch {
        // The shape path already reports an unparsable body; nothing to collect.
      }
    }
    const responseText = entry.response && entry.response.content && typeof entry.response.content.text === "string"
      ? entry.response.content.text
      : "";
    const responseContentType = entry.response && entry.response.content && typeof entry.response.content.mimeType === "string"
      ? entry.response.content.mimeType
      : "";
    if (responseText.length > 0 && !/event-stream/i.test(responseContentType) && looksJson(responseText, responseContentType)) {
      try {
        collectFields(JSON.parse(responseText), "", buckets);
      } catch {
        // Same: unparsable answers contribute no identifiers.
      }
    }
    for (const candidate of buckets.models) {
      const value = printableModelId(candidate.value);
      if (value === null) continue;
      if (!group.models.some((existing) => existing.path === candidate.path && existing.value === value)) {
        group.models.push({ path: candidate.path, value });
        if (group.models.length >= MAX_IDENTIFIER_VALUES) break;
      }
    }
    for (const candidate of buckets.accounts) {
      if (candidate.value.trim().length === 0) continue;
      const fingerprint = fingerprintDiagnosticValue(candidate.value);
      const existing = group.accounts.find((account) => account.path === candidate.path && account.fingerprint === fingerprint);
      if (existing) existing.occurrences += 1;
      else group.accounts.push({ path: candidate.path, fingerprint, occurrences: 1 });
    }
  });

  const endpoints = [...groups.values()].map((group) => finishEndpoint(group, settings));
  endpoints.sort((a, b) => b.requests - a.requests || a.method.localeCompare(b.method) || a.host.localeCompare(b.host) || a.path.localeCompare(b.path));

  const candidates = endpoints.filter((endpoint) => endpoint.score >= 3);
  const modelCandidates = [];
  const accountCandidates = [];
  for (const endpoint of endpoints) {
    for (const model of endpoint.models) {
      modelCandidates.push({ ...model, endpoint: endpointKey(endpoint) });
    }
    for (const account of endpoint.accounts) {
      accountCandidates.push({ ...account, endpoint: endpointKey(endpoint) });
    }
  }

  const missing = missingObservations(endpoints, candidates, entriesWithoutResponseContent, malformedUrls, modelCandidates, accountCandidates);

  return {
    har: {
      name: "",
      entries: entries.length,
      hosts: [...hosts],
      endpointShapes: endpoints.length,
      malformedUrls,
    },
    options: settings,
    endpoints,
    turnCandidates: candidates.slice(0, settings.top).map((endpoint) => ({
      method: endpoint.method,
      host: endpoint.host,
      path: endpoint.path,
      requests: endpoint.requests,
      score: endpoint.score,
      reasons: endpoint.reasons,
    })),
    modelCandidates,
    accountCandidates,
    missingObservations: missing,
    notes: [
      "Shape report only: every candidate is evidence to confirm by hand; do not invent a protocol from it.",
      "Account-like values are fingerprints (AGENTS.md → Security and privacy); model ids are printed because a catalogue row configures them.",
    ],
  };
}

function endpointKey(endpoint) {
  return `${endpoint.method} ${endpoint.host}${endpoint.path}`;
}

function finishEndpoint(group, settings) {
  const reasons = [];
  let score = 0;

  const sse = group.sse
    ? {
        responses: group.sse.responses,
        dataLines: group.sse.dataLines,
        doneMarkers: group.sse.doneMarkers,
        unparsable: group.sse.unparsable,
        eventNames: group.sse.eventNames,
        shapes: [...group.sse.shapeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, settings.frames)
          .map(([shape, count]) => ({ shape, count })),
        shapeTotal: group.sse.shapeCounts.size,
        terminationFields: [...group.sse.termination.entries()]
          .map(([path, entry]) => ({
            path,
            values: [...entry.values.entries()].slice(0, MAX_ENUM_VALUES).map(([value, count]) => ({ value, count })),
            suppressed: entry.suppressed,
            distinct: entry.values.size,
            changes: entry.values.size > 1,
          }))
          .sort((a, b) => {
            const depth = (path) => path.split(".").length;
            return Number(b.changes) - Number(a.changes) ||
              depth(a.path) - depth(b.path) ||
              b.distinct - a.distinct ||
              a.path.localeCompare(b.path);
          })
          .slice(0, 10),
      }
    : null;

  if (sse && sse.responses > 0) {
    score += 3;
    reasons.push(
      sse.dataLines > 0
        ? `streaming response with ${sse.dataLines} data frame(s)`
        : "streaming (text/event-stream) response",
    );
  }

  const messageKeys = [];
  collectMessagesKeys(group.requestShapes, [], messageKeys);
  if (messageKeys.length > 0) {
    score += 2;
    reasons.push(`request body has a messages-like array \`${messageKeys[0]}\``);
  }
  if (group.method === "POST") {
    score += 1;
    reasons.push("POST request");
  }
  if (TURN_PATH.test(group.path)) {
    score += 1;
    reasons.push("path names a chat/completion surface");
  }
  if (group.models.length > 0) {
    score += 1;
    reasons.push(`request body names model-like field \`${group.models[0].path}\``);
  }

  return {
    method: group.method,
    host: group.host,
    path: group.path,
    requests: group.requests,
    queryNames: [...group.queryNames],
    statuses: [...group.statuses],
    requestContentTypes: [...group.requestContentTypes],
    responseContentTypes: [...group.responseContentTypes],
    requestHeaderNames: [...group.headerNames],
    requestBodies: group.requestBodies.map((body) => ({
      contentType: body.contentType,
      params: body.params,
      note: body.note,
      shape: body.shape,
    })),
    requestShape: group.requestShapes,
    responseShape: group.responseShapes,
    sse,
    models: group.models,
    accounts: group.accounts,
    missingResponseContent: group.missingResponseContent,
    score,
    reasons,
  };
}

function collectMessagesKeys(node, path, out) {
  if (!node) return;
  const kind = nodeKind(node);
  if (kind === "object") {
    for (const [name, entry] of node.fields) {
      const nextPath = [...path, name];
      if (MESSAGES_KEY.test(name) && nodeKind(entry.node) === "array") {
        out.push(nextPath.join("."));
      }
      collectMessagesKeys(entry.node, nextPath, out);
    }
    return;
  }
  if (kind === "array" && node.element) collectMessagesKeys(node.element, [...path, "[0]"], out);
}

function missingObservations(endpoints, candidates, entriesWithoutResponseContent, malformedUrls, models, accounts) {
  const missing = [];
  const sseEndpoints = endpoints.filter((endpoint) => endpoint.sse && endpoint.sse.responses > 0);

  if (candidates.length === 0) {
    missing.push("no endpoint looks like a turn call — no SSE/streaming response and no messages-like request body were captured");
  }
  if (sseEndpoints.length === 0) {
    missing.push("no SSE frames captured — the streaming format and its termination signal are unmeasured");
  } else {
    const done = sseEndpoints.some((endpoint) => endpoint.sse.doneMarkers > 0);
    if (!done) {
      const changing = [...new Set(sseEndpoints.flatMap((endpoint) =>
        endpoint.sse.terminationFields.filter((field) => field.changes).map((field) => field.path)))].slice(0, 3);
      missing.push(
        changing.length > 0
          ? `no [DONE]-like marker — termination appears to come from a changing field: ${changing.map((path) => `\`${path}\``).join(", ")}; confirm by hand`
          : "no [DONE]-like marker — termination must come from a status/phase/action field change",
      );
    }
    const termination = sseEndpoints.some((endpoint) => endpoint.sse.terminationFields.length > 0);
    if (!termination) missing.push("no status/phase/action field observed in the frames — termination is unproven");
  }
  if (!endpoints.some((endpoint) => endpoint.requestShape || endpoint.requestBodies.some((body) => body.params.length > 0))) {
    missing.push("no JSON request body captured — the request shape is unmeasured");
  }
  if (models.length === 0) {
    missing.push("no model-like field in any captured request or response body");
  }
  if (accounts.length === 0) {
    missing.push("no stable account-id field observed — account binding stays a recorded decision, not a discovery");
  }
  if (entriesWithoutResponseContent > 0) {
    missing.push(`${entriesWithoutResponseContent} response bod${entriesWithoutResponseContent === 1 ? "y was" : "ies were"} not captured — those answers are unknown`);
  }
  if (malformedUrls > 0) {
    missing.push(`${malformedUrls} request URL(s) could not be parsed — they were grouped as [unparsable-url] and their values are not shown`);
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------------------------------

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function header(lines, title) {
  if (lines.length > 0) lines.push("");
  lines.push(title);
}

export function formatReport(report) {
  const lines = [];
  lines.push(`HAR shape report — ${report.har.name}`);
  lines.push(
    `${report.har.entries} entries · ${report.har.hosts.length} host(s) · ${report.har.endpointShapes} endpoint shape(s)`,
  );
  lines.push(
    "Values are never printed. Field/header/query names, types, statuses, content types, model ids and",
  );
  lines.push(
    "short enumerated field values only; account-like values are fingerprints; token-shaped strings redacted.",
  );

  header(lines, `TURN-CALL CANDIDATES (${report.turnCandidates.length})`);
  if (report.turnCandidates.length === 0) {
    lines.push("  none — no endpoint shows streaming or a messages-like request body");
  } else {
    report.turnCandidates.forEach((candidate, index) => {
      lines.push(`  ${index + 1}) ${candidate.method} ${candidate.host}${candidate.path}  (${candidate.requests} request${candidate.requests === 1 ? "" : "s"})`);
      lines.push(`     this looks like the turn call: ${candidate.reasons.join("; ")}`);
    });
  }

  header(lines, `ENDPOINTS (top ${Math.min(report.options.top, report.endpoints.length)} of ${report.endpoints.length} by frequency)`);
  const shown = report.endpoints.slice(0, report.options.top);
  const rows = shown.map((endpoint) => [
    String(endpoint.requests),
    endpoint.method,
    truncate(`${endpoint.host}${endpoint.path}`, MAX_ENDPOINT_LABEL),
    endpoint.statuses.map(String).join(",") || "—",
    truncate(endpoint.responseContentTypes.join(", ") || "—", 42),
  ]);
  const labels = ["count", "method", "endpoint", "status", "response type"];
  const widths = labels.map((label) => label.length);
  for (const row of rows) for (let index = 0; index < row.length; index += 1) widths[index] = Math.max(widths[index], row[index].length);
  lines.push(`  ${labels[0].padEnd(widths[0])}  ${labels[1].padEnd(widths[1])}  ${labels[2].padEnd(widths[2])}  ${labels[3].padEnd(widths[3])}  ${labels[4]}`);
  for (const row of rows) {
    lines.push(`  ${row[0].padStart(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3].padEnd(widths[3])}  ${row[4]}`);
  }

  const candidateEndpoints = report.endpoints.filter((endpoint) => endpoint.score >= 3).slice(0, 5);
  const candidateKeys = new Set(candidateEndpoints.map(endpointKey));
  const extraEndpoints = [];
  for (const endpoint of shown) {
    if (candidateKeys.has(endpointKey(endpoint))) continue;
    if ((endpoint.requestShape || endpoint.responseShape) && extraEndpoints.length < 3) extraEndpoints.push(endpoint);
  }

  for (const endpoint of [...candidateEndpoints, ...extraEndpoints]) {
    header(lines, `DETAIL — ${endpoint.method} ${endpoint.host}${endpoint.path}  (${endpoint.requests} request${endpoint.requests === 1 ? "" : "s"})`);
    lines.push(`  query parameters: ${endpoint.queryNames.length > 0 ? endpoint.queryNames.join(", ") : "none"}${endpoint.queryNames.length > 0 ? " (values dropped)" : ""}`);
    if (endpoint.requestHeaderNames.length > 0) {
      lines.push(`  request headers (names only): ${endpoint.requestHeaderNames.join(", ")}`);
    }
    lines.push(`  response: ${endpoint.statuses.map(String).join(", ") || "no status"} ${endpoint.responseContentTypes.join(", ")}`);

    const bodies = endpoint.requestBodies;
    if (bodies.length === 0) {
      lines.push("  request body: none captured");
    } else {
      const first = bodies[0];
      const label = first.contentType ? ` (${first.contentType})` : "";
      if (first.params.length > 0) {
        lines.push(`  request body${label}: form parameters (names only): ${first.params.join(", ")}`);
      }
      if (first.shape) {
        const budget = { remaining: report.options.maxBodyLines, more: 0 };
        const rendered = renderShapeLines(first.shape, budget);
        lines.push(`  request body keys${label} (depth ≤ ${report.options.depth}):`);
        for (const line of rendered.lines) lines.push(`    ${line}`);
        if (rendered.more > 0) lines.push(`    … (${rendered.more} more line(s); raise --depth to see less truncation)`);
      }
      if (first.note) lines.push(`  request body note: ${first.note}`);
      if (bodies.length > 1) lines.push(`  (${bodies.length} request bodies compared; keys present in only some are marked ?)`);
    }

    if (endpoint.models.length > 0) {
      lines.push("  model-like fields:");
      for (const model of endpoint.models) lines.push(`    ${model.path} = ${model.value}`);
    }
    if (endpoint.accounts.length > 0) {
      lines.push("  account-like fields (fingerprints, never raw identities):");
      for (const account of endpoint.accounts) {
        lines.push(`    ${account.path} = sha256:${account.fingerprint}${account.occurrences > 1 ? ` (seen ${account.occurrences}×)` : ""}`);
      }
    }

    if (endpoint.responseShape) {
      const budget = { remaining: Math.min(24, report.options.maxBodyLines), more: 0 };
      const rendered = renderShapeLines(endpoint.responseShape, budget);
      lines.push("  response body keys:");
      for (const line of rendered.lines) lines.push(`    ${line}`);
      if (rendered.more > 0) lines.push(`    … (${rendered.more} more line(s))`);
    }

    if (endpoint.sse) {
      const sse = endpoint.sse;
      lines.push(`  streaming (${sse.responses} streaming response${sse.responses === 1 ? "" : "s"}):`);
      lines.push(
        `    frames: ${sse.dataLines} data line(s) parsed into ${sse.shapes.reduce((total, shape) => total + shape.count, 0)} frame(s)` +
          (sse.unparsable > 0 ? `; ${sse.unparsable} payload(s) did not parse` : ""),
      );
      if (sse.eventNames.length > 0) lines.push(`    SSE event names: ${sse.eventNames.join(", ")}`);
      lines.push(`    distinct frame shapes${sse.shapeTotal > sse.shapes.length ? ` (top ${sse.shapes.length} of ${sse.shapeTotal})` : ""}:`);
      for (const shape of sse.shapes) lines.push(`      ${shape.count} × ${shape.shape}`);
      lines.push(
        sse.doneMarkers > 0
          ? `    [DONE]-like marker: present (${sse.doneMarkers}×)`
          : "    [DONE]-like marker: not present",
      );
      if (sse.terminationFields.length === 0) {
        lines.push("    termination-signal candidates: none (no changing status/phase/action/type field)");
      } else {
        lines.push("    termination-signal candidates:");
        for (const field of sse.terminationFields) {
          const values = field.values.map((value) => `${value.value} (${value.count})`).join(", ");
          const suppressed = field.suppressed > 0 ? `; ${field.suppressed} value(s) not shown (not identifier-safe)` : "";
          lines.push(`      ${field.path}: ${values || "no printable value"}${suppressed}${field.changes ? " ← changes" : ""}`);
        }
      }
    }
  }

  header(lines, "SUMMARY");
  if (report.turnCandidates.length > 0) {
    for (const candidate of report.turnCandidates) {
      lines.push(`  ${candidate.method} ${candidate.host}${candidate.path} looks like the turn call (${candidate.reasons.join("; ")})`);
    }
  } else {
    lines.push("  no turn call identified");
  }
  if (report.modelCandidates.length > 0) {
    lines.push(`  model ids seen: ${report.modelCandidates.map((model) => `${model.value} (${model.path})`).join(", ")}`);
  } else {
    lines.push("  model ids seen: none");
  }
  if (report.accountCandidates.length > 0) {
    lines.push(
      `  account-like ids seen: ${report.accountCandidates.map((account) => `${account.path} = sha256:${account.fingerprint}`).join(", ")}`,
    );
  } else {
    lines.push("  account-like ids seen: none");
  }

  header(lines, "MISSING OBSERVATIONS");
  if (report.missingObservations.length === 0) {
    lines.push("  none — the capture covers the request, the stream and its termination");
  } else {
    for (const observation of report.missingObservations) lines.push(`  - ${observation}`);
  }

  header(lines, "NOTES");
  for (const note of report.notes) lines.push(`  - ${note}`);

  return `${lines.join("\n")}\n`;
}

export function reportToJson(report) {
  // The frequency table is bounded by `--top`, but a turn call is never dropped from the machine
  // view just because assets were more frequent: candidates are always included.
  const visible = report.endpoints.slice(0, report.options.top);
  const visibleKeys = new Set(visible.map(endpointKey));
  const machineEndpoints = [
    ...visible,
    ...report.endpoints.filter((endpoint) => endpoint.score >= 3 && !visibleKeys.has(endpointKey(endpoint))).slice(0, 5),
  ];
  return {
    har: report.har,
    options: report.options,
    endpoints: machineEndpoints.map((endpoint) => ({
      method: endpoint.method,
      host: endpoint.host,
      path: endpoint.path,
      requests: endpoint.requests,
      queryParameters: endpoint.queryNames,
      statuses: endpoint.statuses,
      requestContentTypes: endpoint.requestContentTypes,
      responseContentTypes: endpoint.responseContentTypes,
      requestHeaderNames: endpoint.requestHeaderNames,
      requestBodies: endpoint.requestBodies.map((body) => ({
        contentType: body.contentType,
        formParameters: body.params,
        note: body.note,
        shape: shapeToJson(body.shape),
      })),
      responseShape: shapeToJson(endpoint.responseShape),
      streaming: endpoint.sse
        ? {
            responses: endpoint.sse.responses,
            dataLines: endpoint.sse.dataLines,
            doneMarkers: endpoint.sse.doneMarkers,
            eventNames: endpoint.sse.eventNames,
            frameShapes: endpoint.sse.shapes,
            terminationFields: endpoint.sse.terminationFields.map((field) => ({
              path: field.path,
              values: field.values,
              suppressed: field.suppressed,
              changes: field.changes,
            })),
          }
        : null,
      modelFields: endpoint.models,
      accountFields: endpoint.accounts,
      score: endpoint.score,
      reasons: endpoint.reasons,
    })),
    turnCandidates: report.turnCandidates,
    modelCandidates: report.modelCandidates,
    accountCandidates: report.accountCandidates,
    missingObservations: report.missingObservations,
    notes: report.notes,
  };
}

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

function parseCount(raw, flag, fallback, minimum, maximum) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} expects a whole number`);
  const value = Number(raw);
  if (value < minimum || value > maximum) throw new UsageError(`${flag} must be between ${minimum} and ${maximum}`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    path: "",
    json: false,
    help: false,
    top: DEFAULT_TOP,
    depth: DEFAULT_DEPTH,
    frames: DEFAULT_FRAMES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--top" || argument === "--depth" || argument === "--frames") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${argument} expects a value`);
      index += 1;
      if (argument === "--top") options.top = parseCount(value, argument, DEFAULT_TOP, 1, 50);
      if (argument === "--depth") options.depth = parseCount(value, argument, DEFAULT_DEPTH, 1, 12);
      if (argument === "--frames") options.frames = parseCount(value, argument, DEFAULT_FRAMES, 1, 50);
    } else if (/^--(?:top|depth|frames)=/.test(argument)) {
      const [flag, value] = argument.split("=", 2);
      if (flag === "--top") options.top = parseCount(value, flag, DEFAULT_TOP, 1, 50);
      if (flag === "--depth") options.depth = parseCount(value, flag, DEFAULT_DEPTH, 1, 12);
      if (flag === "--frames") options.frames = parseCount(value, flag, DEFAULT_FRAMES, 1, 50);
    } else if (argument.startsWith("-")) {
      throw new UsageError(`unknown option ${argument}`);
    } else if (options.path.length === 0) {
      options.path = argument;
    } else {
      throw new UsageError(`unexpected extra argument ${argument}`);
    }
  }
  return options;
}

/**
 * Run the CLI. Returns an exit code; never throws. `stdout`/`stderr` are injected so a test can assert
 * on exactly what a terminal would receive.
 */
export function main(argv, io = {}) {
  const writeOut = io.stdout ?? ((line) => process.stdout.write(line));
  const writeErr = io.stderr ?? ((line) => process.stderr.write(line));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeErr(`har-shape: ${error instanceof Error ? error.message : "invalid arguments"}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    writeOut(`${USAGE}\n`);
    return 0;
  }
  if (options.path.length === 0) {
    writeErr(`har-shape: missing HAR path\n${USAGE}\n`);
    return 2;
  }
  try {
    const { name, document } = readHarFile(options.path);
    const report = analyzeHar(document, options);
    report.har.name = name;
    if (options.json) {
      writeOut(`${JSON.stringify(reportToJson(report), null, 2)}\n`);
    } else {
      writeOut(formatReport(report));
    }
    return 0;
  } catch (error) {
    if (error instanceof HarShapeError) {
      writeErr(`har-shape: ${error.message}\n`);
      return 1;
    }
    writeErr(`har-shape: internal failure ${safeErrorDescriptor(error)}\n`);
    return 1;
  }
}

const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  process.exitCode = main(process.argv.slice(2));
}
