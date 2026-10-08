import { describe, expect, test } from "bun:test";
import { selectCanonicalWebComposer } from "../src/adapters/web-composer-resolver";

const candidate = (overrides: Partial<Parameters<typeof selectCanonicalWebComposer>[0][number]> = {}) => ({
  id: "primary",
  selectorPriority: 0,
  visible: true,
  editable: true,
  enabled: true,
  area: 1_000,
  ...overrides,
});

describe("web composer resolver", () => {
  test("selects the canonical usable editor from duplicate DOM matches", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "stale-placeholder", visible: false, area: 0 }),
      candidate({ id: "active-editor" }),
    ])).toBe("active-editor");
  });

  test("rejects non-editable, disabled, and zero-area candidates", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "readonly", editable: false }),
      candidate({ id: "disabled", enabled: false }),
      candidate({ id: "placeholder", area: 0 }),
    ])).toBeUndefined();
  });

  test("prefers provider selector priority over DOM order", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "fallback", selectorPriority: 4 }),
      candidate({ id: "primary", selectorPriority: 0 }),
    ])).toBe("primary");
  });

  test("fails closed when one selector exposes multiple usable editors", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "conversation-a", area: 100 }),
      candidate({ id: "conversation-b", area: 10_000 }),
    ])).toBeUndefined();
  });

  test("prefers one higher-priority candidate over fallback-selector duplicates", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "fallback", selectorPriority: 4 }),
      candidate({ id: "primary", selectorPriority: 0 }),
    ])).toBe("primary");
  });

  test("returns no candidate while the web chat is still hydrating", () => {
    expect(selectCanonicalWebComposer([
      candidate({ id: "hydrating", visible: true, editable: false, area: 100 }),
      candidate({ id: "hidden", visible: false, area: 0 }),
    ])).toBeUndefined();
  });
});
