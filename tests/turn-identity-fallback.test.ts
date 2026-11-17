/**
 * A turn whose provider identity is missing must not abort the turn.
 *
 * Observed live: a consolidation turn whose answer was already visible failed with
 * "ChatGPT conversation turn has no stable identity", because the Temporary Chat surface re-rendered
 * the turn list without the attribute the bridge expects. The identity is used for change detection
 * and duplicate detection, not as a protocol value, so the element's position is a stable-enough
 * substitute — the conversation is ordered and append-only, and the "position-turn-" prefix cannot
 * collide with a provider id.
 *
 * The function lives inside a `page.evaluate` callback (it runs in the page, so it cannot import), so
 * this test extracts the exact shipped source and executes it against a fake document. That keeps the
 * assertion behavioural: a future edit that throws again fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
const START = "const identities = (selector: string): string[] => {";
const END = "\n      };";
const start = SOURCE.indexOf(START);
const end = SOURCE.indexOf(END, start);

function identitiesFor(attributes: readonly (readonly [string, string | null])[]): string[] {
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start, end + END.length);
  const factory = new Function(
    "document",
    body.replace(START, "const identities = (selector) => {") + "\nreturn identities;",
  ) as (document: unknown) => (selector: string) => string[];
  const elements = attributes.map(([name, value]) => ({
    getAttribute: (requested: string) => (requested === name ? value : null),
  }));
  const document = { querySelectorAll: () => elements };
  return factory(document)(".turn");
}

describe("turn identity resolution", () => {
  test("keeps a provider identity when the surface exposes one", () => {
    expect(identitiesFor([
      ["data-testid", "conversation-turn-1"],
      ["data-testid", "conversation-turn-2"],
    ])).toEqual(["conversation-turn-1", "conversation-turn-2"]);
  });

  test("falls back to the position when the attribute is missing", () => {
    // The live failure: a re-rendered turn with no attribute. It must not throw.
    expect(identitiesFor([
      ["data-testid", "conversation-turn-1"],
      ["data-testid", null],
    ])).toEqual(["conversation-turn-1", "position-turn-1"]);
  });

  test("falls back when the attribute is not a turn identity", () => {
    expect(identitiesFor([["data-testid", "some-other-node"]])).toEqual(["position-turn-0"]);
  });

  test("a repeated provider identity is still refused", () => {
    expect(() => identitiesFor([
      ["data-testid", "conversation-turn-1"],
      ["data-testid", "conversation-turn-1"],
    ])).toThrow("duplicate conversation turn identities");
  });
});
