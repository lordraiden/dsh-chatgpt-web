import { zstdDecompressSync } from "node:zlib";

const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");
  }

  const encoded = new Uint8Array(await request.arrayBuffer());
  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");

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
  assertWithinLimit(decoded.byteLength, MAX_DECODED_REQUEST_BYTES, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}
