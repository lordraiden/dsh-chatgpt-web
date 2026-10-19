import { zstdDecompressSync } from "node:zlib";

/** Default ceiling for the encoded request body. Operators exposing the API can lower it (issue #247). */
const DEFAULT_MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
/** A decoded body may legitimately be larger than its encoded form (compression). */
const DEFAULT_DECODED_MULTIPLIER = 2;

/**
 * A request body that exceeded the configured limit.
 *
 * Typed on purpose: an exposed service must answer an oversized request with 413, not with a generic
 * 400/500, and a caller must be able to tell the two apart (`server.ts` maps this to
 * `request_too_large`).
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly scope: string, readonly limitBytes: number) {
    super(`${scope} exceeds the configured limit of ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * The active body limits.
 *
 * `DSH_CHATGPT_WEB_MAX_REQUEST_BYTES` overrides the encoded ceiling; the decoded ceiling is twice it.
 * The generous default is deliberate: the DSH/Codex route carries large canonical contexts, so
 * lowering it is an operator decision for an exposed deployment.
 */
export function requestBodyLimits(): { encoded: number; decoded: number } {
  const raw = process.env.DSH_CHATGPT_WEB_MAX_REQUEST_BYTES;
  const configured = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  const encoded = Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ENCODED_REQUEST_BYTES;
  return { encoded, decoded: encoded * DEFAULT_DECODED_MULTIPLIER };
}

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new RequestBodyTooLargeError(label, limit);
}

/** A per-request ceiling for endpoints whose payload has a stricter natural bound. */
export interface RequestBodyReadOptions {
  /** Encoded ceiling in bytes; defaults to the process-wide encoded limit. */
  readonly encodedLimitBytes?: number;
  /** Decoded ceiling in bytes; defaults to twice the effective encoded limit. */
  readonly decodedLimitBytes?: number;
}

/**
 * Read at most `limit` bytes from a request body.
 *
 * The declared `Content-Length` is checked first, so a wildly oversized body is refused before any
 * of it is buffered. When the header is absent (chunked transfer), the read stops the moment the
 * running total would exceed the limit and cancels the stream — the caller never pays for a body it
 * cannot accept.
 */
async function readEncodedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, limit, "Encoded request body");
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      // Stop exactly at the ceiling rather than buffering the rest and checking afterwards.
      assertWithinLimit(total, limit, "Encoded request body");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  reader.releaseLock();

  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function readJsonRequestBody(
  request: Request,
  options: RequestBodyReadOptions = {},
): Promise<unknown> {
  const limits = requestBodyLimits();
  const encodedLimit = options.encodedLimitBytes ?? limits.encoded;
  const decodedLimit = options.decodedLimitBytes ?? encodedLimit * 2;

  const encoded = await readEncodedBody(request, encodedLimit);

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    if (typeof Bun !== "undefined" && typeof Bun.zstdDecompress === "function") {
      decoded = await Bun.zstdDecompress(encoded);
    } else {
      // Node >=22.15 exposes native zstd in node:zlib (the package requires Node >=22.19.0).
      const inflated = zstdDecompressSync(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength));
      decoded = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
    }
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  assertWithinLimit(decoded.byteLength, decodedLimit, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}
