import { isTableDelimiterRow } from "./wideMarkdownBlocks";

/**
 * Fallback LegendList uses for unmeasured thread-feed rows. Tall markdown
 * (especially GFM tables) is an order of magnitude larger; seeding a real
 * height before those rows mount avoids a multi-screen offset correction.
 */
export const THREAD_FEED_ESTIMATED_ITEM_SIZE = 180;

// NativeMarkdownBlock table cells: paddingVertical 8, borderTop 1.
const TABLE_CELL_VERTICAL_PADDING = 16;
const TABLE_CELL_BORDER = 1;
// Fenced code block contentContainerStyle paddingVertical 12.
const CODE_BLOCK_VERTICAL_PADDING = 24;
const MESSAGE_CHROME_HEIGHT = 8;
const FENCE_OPEN = /^( {0,3})(```|~~~)/;

export function estimateThreadFeedMessageHeight(input: {
  readonly text: string;
  readonly contentWidth: number;
  readonly bodyLineHeight: number;
  readonly codeBlockLineHeight: number;
}): number | undefined {
  if (input.text.length === 0 || input.contentWidth <= 0) {
    return undefined;
  }
  if (
    input.text.length < 400 &&
    !input.text.includes("|") &&
    !input.text.includes("```") &&
    !input.text.includes("~~~")
  ) {
    return undefined;
  }
  const height = measureThreadFeedMarkdownHeight(input);
  return height > THREAD_FEED_ESTIMATED_ITEM_SIZE * 2 ? Math.round(height) : undefined;
}

/** Replace only generic estimates so a later onLayout measurement can still win. */
export function shouldReplaceThreadFeedItemSize(
  knownSize: number | undefined,
  estimate: number | undefined,
): estimate is number {
  if (estimate === undefined) {
    return false;
  }
  return knownSize === undefined || knownSize <= THREAD_FEED_ESTIMATED_ITEM_SIZE * 2;
}

function measureThreadFeedMarkdownHeight(input: {
  readonly text: string;
  readonly contentWidth: number;
  readonly bodyLineHeight: number;
  readonly codeBlockLineHeight: number;
}): number {
  const lines = input.text.split("\n");
  const charsPerLine = Math.max(8, Math.floor(input.contentWidth / 8));
  let height = MESSAGE_CHROME_HEIGHT;
  let index = 0;

  while (index < lines.length) {
    const fence = FENCE_OPEN.exec(lines[index] ?? "");
    if (fence) {
      const marker = fence[2] ?? "```";
      index += 1;
      let codeLines = 0;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(marker)) {
        codeLines += 1;
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      height += CODE_BLOCK_VERTICAL_PADDING + codeLines * input.codeBlockLineHeight;
      continue;
    }

    if ((lines[index] ?? "").includes("|")) {
      const start = index;
      while (index < lines.length && (lines[index] ?? "").trim() !== "") {
        index += 1;
      }
      const block = lines.slice(start, index);
      if (block.some(isTableDelimiterRow)) {
        let tableRows = 0;
        for (const line of block) {
          if (line.includes("|") && !isTableDelimiterRow(line)) {
            tableRows += 1;
          }
        }
        height +=
          tableRows * (TABLE_CELL_VERTICAL_PADDING + input.bodyLineHeight + TABLE_CELL_BORDER);
        continue;
      }
      index = start;
    }

    const line = lines[index] ?? "";
    if (line.trim() === "") {
      height += input.bodyLineHeight * 0.4;
    } else {
      height += input.bodyLineHeight * Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    index += 1;
  }

  return height;
}
