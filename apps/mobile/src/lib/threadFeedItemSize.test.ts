import { describe, expect, it } from "vite-plus/test";

import {
  estimateThreadFeedMessageHeight,
  shouldReplaceThreadFeedItemSize,
  THREAD_FEED_ESTIMATED_ITEM_SIZE,
} from "./threadFeedItemSize";

const sizing = {
  contentWidth: 390,
  bodyLineHeight: 23,
  codeBlockLineHeight: 18,
} as const;

function tableMarkdown(rowCount: number): string {
  const rows = Array.from(
    { length: rowCount },
    (_, index) => `| skill-${index} | User | ~1k tokens |`,
  );
  return ["| Skill | Scope | Cost |", "| --- | --- | --- |", ...rows].join("\n");
}

describe("estimateThreadFeedMessageHeight", () => {
  it("leaves ordinary short replies on LegendList's generic estimate", () => {
    expect(
      estimateThreadFeedMessageHeight({
        ...sizing,
        text: "Done. The test is green.",
      }),
    ).toBeUndefined();
  });

  it("does not treat a pipe in a sentence as a table", () => {
    expect(
      estimateThreadFeedMessageHeight({
        ...sizing,
        text: "Use a | b in a sentence\nand keep going for a few more words.",
      }),
    ).toBeUndefined();
  });

  it("sizes a Claude /context-scale skills table far above the generic row estimate", () => {
    const height = estimateThreadFeedMessageHeight({
      ...sizing,
      text: ["Skills", tableMarkdown(115), "", "MCP tools", tableMarkdown(170)].join("\n\n"),
    });
    expect(height).toBeGreaterThan(THREAD_FEED_ESTIMATED_ITEM_SIZE * 20);
    expect(height).toBeGreaterThan(8_000);
  });

  it("counts stacked GFM tables without treating delimiter rows as cells", () => {
    const oneTable = estimateThreadFeedMessageHeight({
      ...sizing,
      text: tableMarkdown(20),
    });
    const twoTables = estimateThreadFeedMessageHeight({
      ...sizing,
      text: `${tableMarkdown(20)}\n\n${tableMarkdown(20)}`,
    });
    expect(oneTable).toBeGreaterThan(THREAD_FEED_ESTIMATED_ITEM_SIZE * 2);
    expect(twoTables).toBeGreaterThan((oneTable ?? 0) * 1.8);
  });

  it("sizes a tall fenced code block instead of assuming 180px", () => {
    const body = Array.from({ length: 80 }, (_, index) => `const row${index} = ${index};`).join(
      "\n",
    );
    const height = estimateThreadFeedMessageHeight({
      ...sizing,
      text: ["```ts", body, "```"].join("\n"),
    });
    expect(height).toBeGreaterThan(THREAD_FEED_ESTIMATED_ITEM_SIZE * 4);
  });
});

describe("shouldReplaceThreadFeedItemSize", () => {
  it("seeds unmeasured rows and generic 180px placeholders", () => {
    expect(shouldReplaceThreadFeedItemSize(undefined, 9_000)).toBe(true);
    expect(shouldReplaceThreadFeedItemSize(THREAD_FEED_ESTIMATED_ITEM_SIZE, 9_000)).toBe(true);
    expect(shouldReplaceThreadFeedItemSize(THREAD_FEED_ESTIMATED_ITEM_SIZE * 2, 9_000)).toBe(true);
  });

  it("does not overwrite a later layout measurement", () => {
    expect(shouldReplaceThreadFeedItemSize(12_400, 9_000)).toBe(false);
    expect(shouldReplaceThreadFeedItemSize(400, undefined)).toBe(false);
  });
});
