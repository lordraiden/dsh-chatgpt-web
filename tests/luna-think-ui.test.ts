import { expect, test } from "bun:test";
import { setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";

function fakeThinkButton(pressed: "true" | "false") {
  const self = {
    filter() { return this; },
    or() { return this; },
    first() { return this; },
    async count() { return 1; },
    async getAttribute(name: string) {
      return name === "aria-pressed" ? pressed : null;
    },
    async click() {},
    async isVisible() { return true; },
  };
  return self;
}

test("Luna Think control is located at page scope, not restricted to the prompt form", async () => {
  let requestedRole = "";
  let requestedName = "";
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      requestedRole = role;
      requestedName = options.name;
      return fakeThinkButton("true");
    },
  };

  await setChatGptThinkMode(page as never, true);

  expect(requestedRole).toBe("button");
  expect(requestedName).toBe("Think");
});

test("Luna Think can be selected from the Free/Go + menu fallback", async () => {
  let roleCalls = 0;
  let thinkClicked = false;

  const thinkOption = {
    filter() { return this; },
    or() { return this; },
    first() { return this; },
    async count() { return 1; },
    async waitFor() {},
    async click() { thinkClicked = true; },
  };

  const plusButton = {
    filter() { return this; },
    last() { return this; },
    async count() { return 1; },
    async click() { roleCalls += 1; },
  };

  const page = {
    getByRole(role: string) {
      if (role === "button") {
        return {
          ...thinkOption,
          async count() { return 0; },
        };
      }
      if (role === "menuitem" || role === "menuitemradio" || role === "option") {
        return thinkOption;
      }
      throw new Error(`unexpected role: ${role}`);
    },
    getByText() {
      return thinkOption;
    },
    locator() {
      return plusButton;
    },
    keyboard: {
      async press() {},
    },
  };

  await setChatGptThinkMode(page as never, true);

  expect(roleCalls).toBe(1);
  expect(thinkClicked).toBe(true);
});
