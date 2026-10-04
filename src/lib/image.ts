/**
 * Codex can persist unavailable historical images as a one-pixel PNG.
 * Replaying that sentinel as a real attachment produces an opaque black tile in ChatGPT
 * and consumes one attachment slot, but carries no visual information.
 * Treat every 1x1 PNG data URL as non-semantic transport state.
 */
export function isOnePixelPngDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return false;
  try {
    const png = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
    return png.length >= 24
      && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1
      && png.readUInt32BE(20) === 1;
  } catch {
    return false;
  }
}
