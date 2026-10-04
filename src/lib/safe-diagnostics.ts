import { createHash } from "node:crypto";

function safeToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,96}$/.test(normalized) ? normalized : fallback;
}

export function safeErrorDescriptor(error: unknown): string {
  if (error === null || typeof error !== "object") return "name=Error code=unknown";

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    errorType?: unknown;
    status?: unknown;
  };

  const name = safeToken(candidate.name, "Error");
  const code = safeToken(candidate.code, "unknown");
  const errorType = safeToken(candidate.errorType, "");
  const status = typeof candidate.status === "number" && Number.isSafeInteger(candidate.status)
    ? candidate.status
    : undefined;

  return [
    `name=${name}`,
    `code=${code}`,
    ...(errorType ? [`type=${errorType}`] : []),
    ...(status === undefined ? [] : [`status=${status}`]),
  ].join(" ");
}

function payloadStringChars(value: unknown, depth = 0): number {
  if (depth > 32 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + payloadStringChars(item, depth + 1), 0);

  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    total += key.length + payloadStringChars(child, depth + 1);
  }
  return total;
}

export function toolCallDiagnosticSummary(
  calls: readonly {
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
  }[],
): string {
  const names = new Map<string, number>();
  let argumentChars = 0;
  let inputChars = 0;

  for (const call of calls) {
    const name = safeToken(call.name, "unknown");
    names.set(name, (names.get(name) ?? 0) + 1);
    argumentChars += payloadStringChars(call.arguments);
    inputChars += payloadStringChars(call.input);
  }

  const tools = [...names.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => count === 1 ? name : `${name}x${count}`)
    .join(",");

  return [
    `count=${calls.length}`,
    `tools=${tools || "none"}`,
    `argumentChars=${argumentChars}`,
    `inputChars=${inputChars}`,
  ].join(" ");
}

export function fingerprintDiagnosticValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeTextDescriptor(value: string): string {
  return `chars=${value.length} fp=${fingerprintDiagnosticValue(value)}`;
}
