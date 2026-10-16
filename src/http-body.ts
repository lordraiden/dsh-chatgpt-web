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

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  const limits = requestBodyLimits();
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, limits.encoded, "Encoded request body");
  }

  const encoded = new Uint8Array(await request.arrayBuffer());
  assertWithinLimit(encoded.byteLength, limits.encoded, "Encoded request body");

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
  assertWithinLimit(decoded.byteLength, limits.decoded, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}
