import { expect, test } from "bun:test";
import { setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";

function fakeThinkButton(pressed: "true" | "false") {
  return {
    filter() { return this; },
    async count() { return 1; },
    first() { return this; },
    async getAttribute(name: string) {
      return name === "aria-pressed" ? pressed : null;
    },
    async click() {},
  };
}

test("Luna Think control is located at page scope, not restricted to the prompt form", async () => {
  let requestedRole = "";
  let requestedName = "";
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      requestedRole = role;
      requestedName = options.name;
      return fakeThinkButton("false");
    },
  };

  await setChatGptThinkMode(page as never, false);

  expect(requestedRole).toBe("button");
  expect(requestedName).toBe("Think");
});
