import { expect, it } from "vite-plus/test";

import { nextFenceKey } from "./stableFenceKey";

it("gives settled fences with the same opening a different key", () => {
  const language = "ts";
  const shared = `const value = 1;\n${"x".repeat(24)}`;
  const first = `${shared}${"a".repeat(40)}`;
  const second = `${shared}${"b".repeat(40)}`;
  expect(first.length).toBe(second.length);
  expect(first.slice(0, 32)).toBe(second.slice(0, 32));
  expect(first).not.toBe(second);

  const afterFirst = nextFenceKey(null, language, first);
  const afterSecond = nextFenceKey(afterFirst, language, second);

  expect(afterFirst.key).toBe(`${language}:${first}`);
  expect(afterSecond.key).toBe(`${language}:${second}`);
  expect(afterSecond.key).not.toBe(afterFirst.key);
});

it("keeps the key while the same fence streams longer", () => {
  let state = nextFenceKey(null, "ts", "const");
  const initialKey = state.key;
  state = nextFenceKey(state, "ts", "const value");
  state = nextFenceKey(state, "ts", "const value = 1;");
  expect(state.key).toBe(initialKey);
});

it("replaces the key when a streamed fence is swapped for another", () => {
  let streamed = nextFenceKey(null, "ts", "const");
  streamed = nextFenceKey(streamed, "ts", "const value = 1;\nreturn value;");
  const swapped = nextFenceKey(streamed, "ts", "let other = 2;\nreturn other;");
  expect(swapped.key).toBe("ts:let other = 2;\nreturn other;");
  expect(swapped.key).not.toBe(streamed.key);
});
