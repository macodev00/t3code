import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";

/**
 * Prose mounted as one Android text view. Larger selectable paragraphs are the
 * `ReactTextView.setText` stalls measured on long settled threads.
 */
export const ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET = 720;

/**
 * Code lines mounted as one Android row. Past this, a fenced block is windowed
 * so a fling never builds the whole fence's text tree in a single frame.
 */
export const ANDROID_TRANSCRIPT_CODE_LINE_BUDGET = 16;

/** Gap between slices that are not a continuation of the same code fence. */
export const ANDROID_TRANSCRIPT_SLICE_GAP = 14;

export type AndroidTranscriptCodePart = "only" | "start" | "middle" | "end";

export type AndroidTranscriptSlice =
  | {
      readonly kind: "markdown";
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "code";
      readonly key: string;
      readonly text: string;
      readonly language: string | null;
      readonly codePart: AndroidTranscriptCodePart;
      readonly fullCode: string;
    };

interface TranscriptMessageEntry {
  readonly type: "message";
  readonly id: string;
  readonly createdAt: string;
  readonly message: {
    readonly role: string;
    readonly text: string;
  };
}

export interface AndroidAssistantSliceEntry<TSource extends TranscriptMessageEntry> {
  readonly type: "assistant-slice";
  readonly id: string;
  readonly createdAt: string;
  readonly source: TSource;
  readonly slice: AndroidTranscriptSlice;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}

interface MarkdownRange {
  readonly text: string;
  readonly start: number;
}

interface TranscriptBlock {
  readonly kind: "markdown" | "code";
  readonly text: string;
  readonly start: number;
  readonly language: string | null;
  readonly lineCount: number;
}

/**
 * Splits an expensive assistant message into bounded Android list rows.
 *
 * Short messages return null so they stay one row and keep the highlighted
 * code path. A streaming append does not renumber earlier slices: keys come
 * from source offsets, and each code window is a fixed line range.
 */
export function splitAssistantTranscriptSlices(
  markdown: string,
): readonly AndroidTranscriptSlice[] | null {
  if (
    markdown.length <= ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET &&
    !markdown.includes("```") &&
    !markdown.includes("~~~")
  ) {
    return null;
  }
  const normalized = markdown.replaceAll("\r\n", "\n");
  const blocks = collectTranscriptBlocks(normalized);
  if (!shouldSplitAssistantTranscript(normalized, blocks)) {
    return null;
  }

  const slices: AndroidTranscriptSlice[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      slices.push(...sliceCodeBlock(block));
      continue;
    }
    slices.push(...sliceMarkdownRegion(block.text, block.start));
  }

  return slices.length > 1 ? slices : null;
}

/**
 * Expands assistant messages that would mount an unbounded text tree.
 *
 * Non-Android feeds are returned unchanged, including the same array, so iOS
 * live-follow and scroll-to-end keep today's row identity. The first slice
 * reuses the message id; later slices append, which is the direction
 * `maintainScrollAtEnd` already follows.
 */
export function expandAndroidAssistantTranscriptRows<
  TEntry extends { readonly type: string; readonly id: string },
>(
  entries: readonly TEntry[],
  platform: string,
): readonly (TEntry | AndroidAssistantSliceEntry<Extract<TEntry, TranscriptMessageEntry>>)[] {
  if (platform !== "android") {
    return entries;
  }

  let changed = false;
  const rows: (TEntry | AndroidAssistantSliceEntry<Extract<TEntry, TranscriptMessageEntry>>)[] = [];
  for (const entry of entries) {
    const slices = slicesForEntry(entry);
    if (!slices) {
      rows.push(entry);
      continue;
    }
    changed = true;
    const source = entry as Extract<TEntry, TranscriptMessageEntry>;
    for (let index = 0; index < slices.length; index += 1) {
      const slice = slices[index];
      if (!slice) continue;
      rows.push({
        type: "assistant-slice",
        id: index === 0 ? source.id : `${source.id}:${slice.key}`,
        createdAt: source.createdAt,
        source,
        slice,
        isFirst: index === 0,
        isLast: index === slices.length - 1,
      });
    }
  }

  return changed ? rows : entries;
}

/**
 * LegendList recycle pool for a slice. Pools stay separate so a plain code
 * window is not reconciled into a highlighted fence or a prose tree.
 */
export function androidTranscriptItemType(entry: {
  readonly type: string;
  readonly slice?: AndroidTranscriptSlice;
}): string | null {
  if (entry.type !== "assistant-slice" || !entry.slice) {
    return null;
  }
  if (entry.slice.kind === "markdown") {
    return "assistant-markdown-slice";
  }
  if (entry.slice.codePart === "only") {
    return "assistant-code-block";
  }
  if (entry.slice.codePart === "start") {
    return "assistant-code-head";
  }
  return "assistant-code-body";
}

/**
 * Markdown for slices the shared renderer can draw. Plain windows of a long
 * fence return null; those are one `Text`, not a token per span.
 */
export function assistantSliceMarkdown(slice: AndroidTranscriptSlice): string | null {
  if (slice.kind === "markdown") {
    return slice.text;
  }
  if (slice.codePart !== "only") {
    return null;
  }
  return fencedCodeMarkdown(slice.language, slice.text);
}

/**
 * Space after a slice row. Continued code windows share one card, so they do
 * not take the gap that separate blocks use. The last slice uses the message
 * row's own bottom margin instead.
 */
export function assistantSliceGap(slice: AndroidTranscriptSlice, isLast: boolean): number {
  if (isLast) {
    return 0;
  }
  if (slice.kind === "code" && (slice.codePart === "start" || slice.codePart === "middle")) {
    return 0;
  }
  return ANDROID_TRANSCRIPT_SLICE_GAP;
}

/**
 * Wraps a code window in a fence the markdown renderer already knows how to
 * draw. The fence is longer than any backtick run in the body so the body
 * cannot close it early.
 */
export function fencedCodeMarkdown(language: string | null, code: string): string {
  let longestRun = 0;
  let run = 0;
  for (const character of code) {
    if (character === "`") {
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const info = language ? language.replace(/[\r\n`]/g, "") : "";
  return `${fence}${info}\n${code}\n${fence}`;
}

const assistantSliceCache = new Map<string, readonly AndroidTranscriptSlice[] | null>();
const ASSISTANT_SLICE_CACHE_LIMIT = 200;

/**
 * Returns slice rows for an assistant message, or null when the entry should
 * stay as it is. User, reasoning, and non-message rows are never split.
 * Results are cached by the raw message text so a streaming tail does not
 * re-scan every earlier message.
 */
function slicesForEntry(entry: {
  readonly type: string;
  readonly id: string;
}): readonly AndroidTranscriptSlice[] | null {
  if (!isAssistantMessageEntry(entry)) {
    return null;
  }
  const raw = entry.message.text;
  const cached = assistantSliceCache.get(raw);
  if (cached !== undefined) {
    return cached;
  }
  const text = renderAssistantCitationsAsText(raw);
  const slices = text.trim().length === 0 ? null : splitAssistantTranscriptSlices(text);
  assistantSliceCache.delete(raw);
  assistantSliceCache.set(raw, slices);
  while (assistantSliceCache.size > ASSISTANT_SLICE_CACHE_LIMIT) {
    const oldest = assistantSliceCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    assistantSliceCache.delete(oldest);
  }
  return slices;
}

/**
 * Narrows a feed entry to an assistant message with the fields slicing reads.
 */
function isAssistantMessageEntry(entry: {
  readonly type: string;
  readonly id: string;
}): entry is TranscriptMessageEntry {
  if (
    entry.type !== "message" ||
    !("createdAt" in entry) ||
    typeof entry.createdAt !== "string" ||
    !("message" in entry)
  ) {
    return false;
  }
  const message = entry.message;
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    !("text" in message)
  ) {
    return false;
  }
  return message.role === "assistant" && typeof message.text === "string";
}

/**
 * True when one list row would mount more text than a 120 Hz frame can afford.
 * One short fence stays on the highlighted path; a second fence or a long
 * fence is enough to split.
 */
function shouldSplitAssistantTranscript(
  markdown: string,
  blocks: readonly TranscriptBlock[],
): boolean {
  if (markdown.length > ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
    return true;
  }
  let codeBlocks = 0;
  for (const block of blocks) {
    if (block.kind !== "code") {
      continue;
    }
    codeBlocks += 1;
    if (block.lineCount > ANDROID_TRANSCRIPT_CODE_LINE_BUDGET) {
      return true;
    }
  }
  return codeBlocks >= 2;
}

/**
 * Walks top-level fences. Indented code and prose stay in markdown regions so
 * a later char budget can split them without breaking a fence in half.
 */
function collectTranscriptBlocks(markdown: string): readonly TranscriptBlock[] {
  const lines = markdown.split("\n");
  const blocks: TranscriptBlock[] = [];
  let offset = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const opener = fenceMarker(line);
    if (!opener) {
      const start = offset;
      const region: string[] = [];
      while (lineIndex < lines.length && !fenceMarker(lines[lineIndex] ?? "")) {
        region.push(lines[lineIndex] ?? "");
        offset += (lines[lineIndex] ?? "").length + 1;
        lineIndex += 1;
      }
      const text = region.join("\n").replace(/\n+$/, "");
      if (text.trim().length > 0) {
        blocks.push({
          kind: "markdown",
          text,
          start,
          language: null,
          lineCount: 0,
        });
      }
      continue;
    }

    const fenceStart = offset;
    const language = fenceLanguage(line, opener);
    offset += line.length + 1;
    lineIndex += 1;
    const body: string[] = [];
    while (lineIndex < lines.length && !isClosingFence(lines[lineIndex] ?? "", opener)) {
      body.push(lines[lineIndex] ?? "");
      offset += (lines[lineIndex] ?? "").length + 1;
      lineIndex += 1;
    }
    if (lineIndex < lines.length) {
      offset += (lines[lineIndex] ?? "").length + 1;
      lineIndex += 1;
    }
    const text = body.join("\n");
    blocks.push({
      kind: "code",
      text,
      start: fenceStart,
      language,
      lineCount: text.length === 0 ? 0 : body.length,
    });
  }

  return blocks;
}

/**
 * Breaks a prose region on paragraph boundaries, then on lines, so no markdown
 * slice carries more than the char budget into one selectable text view.
 */
function sliceMarkdownRegion(text: string, regionStart: number): readonly AndroidTranscriptSlice[] {
  const slices: AndroidTranscriptSlice[] = [];
  let buffer = "";
  let bufferStart = regionStart;

  const flush = () => {
    if (buffer.trim().length === 0) {
      buffer = "";
      return;
    }
    slices.push({
      kind: "markdown",
      key: `md:${bufferStart}`,
      text: buffer,
    });
    buffer = "";
  };

  for (const paragraph of paragraphRanges(text, regionStart)) {
    if (paragraph.text.length > ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      flush();
      // A table split on a row boundary no longer parses as a table. Keep it
      // whole; one wide table is cheaper than a broken one, and code fences
      // are what the scroll trace was mounting.
      if (isMarkdownTable(paragraph.text)) {
        slices.push({
          kind: "markdown",
          key: `md:${paragraph.start}`,
          text: paragraph.text,
        });
        continue;
      }
      let pieceStart = paragraph.start;
      for (const piece of hardSplitText(paragraph.text)) {
        slices.push({
          kind: "markdown",
          key: `md:${pieceStart}`,
          text: piece,
        });
        pieceStart += piece.length;
      }
      continue;
    }

    const combined = buffer.length === 0 ? paragraph.text : `${buffer}\n\n${paragraph.text}`;
    if (buffer.length > 0 && combined.length > ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      flush();
      buffer = paragraph.text;
      bufferStart = paragraph.start;
      continue;
    }
    if (buffer.length === 0) {
      bufferStart = paragraph.start;
    }
    buffer = combined;
  }
  flush();
  return slices;
}

/**
 * Windows a fence into fixed line ranges. The first window's text stops
 * changing once it fills, so scrolling back reuses that row instead of
 * remounting the rest of the file.
 */
function sliceCodeBlock(block: TranscriptBlock): readonly AndroidTranscriptSlice[] {
  const lines = block.text.length === 0 ? [] : block.text.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const windows: string[] = [];
  for (let index = 0; index < lines.length; index += ANDROID_TRANSCRIPT_CODE_LINE_BUDGET) {
    windows.push(lines.slice(index, index + ANDROID_TRANSCRIPT_CODE_LINE_BUDGET).join("\n"));
  }
  return windows.map((text, index) => ({
    kind: "code" as const,
    key: `code:${block.start}:${index}`,
    text,
    language: block.language,
    codePart: codeWindowPart(index, windows.length),
    fullCode: block.text,
  }));
}

/**
 * Names a code window so the first piece can show the header and the last
 * piece can close the card. A fence that fits in one window stays "only".
 */
function codeWindowPart(index: number, count: number): AndroidTranscriptCodePart {
  if (count <= 1) {
    return "only";
  }
  if (index === 0) {
    return "start";
  }
  if (index === count - 1) {
    return "end";
  }
  return "middle";
}

/**
 * Paragraphs with offsets into the original region. Blank lines are the split
 * points; they are not themselves slices.
 */
function paragraphRanges(text: string, regionStart: number): readonly MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && text[cursor] === "\n") {
      cursor += 1;
    }
    if (cursor >= text.length) {
      break;
    }
    const start = cursor;
    const nextBreak = text.indexOf("\n\n", cursor);
    const end = nextBreak === -1 ? text.length : nextBreak;
    ranges.push({ text: text.slice(start, end), start: regionStart + start });
    cursor = end + 2;
  }
  return ranges;
}

/**
 * True for a GFM table. Those stay one slice so a row split cannot drop the
 * header rule and turn the rest into plain paragraphs.
 */
function isMarkdownTable(text: string): boolean {
  let hasPipe = false;
  let hasRule = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("|")) {
      hasPipe = true;
    }
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) {
      hasRule = true;
    }
  }
  return hasPipe && hasRule;
}

/**
 * Splits one over-long paragraph on line breaks, then spaces, then a hard cut,
 * so a single line cannot exceed the markdown char budget.
 */
function hardSplitText(text: string): readonly string[] {
  if (text.length <= ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
    return [text];
  }
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const remaining = text.slice(cursor);
    if (remaining.length <= ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      pieces.push(remaining);
      break;
    }
    const window = remaining.slice(0, ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET);
    const lineBreak = window.lastIndexOf("\n");
    const spaceBreak = window.lastIndexOf(" ");
    const splitAt = lineBreak > 0 ? lineBreak + 1 : spaceBreak > 0 ? spaceBreak + 1 : window.length;
    pieces.push(remaining.slice(0, splitAt));
    cursor += splitAt;
  }
  return pieces;
}

/**
 * Opening fence marker (`\`\`\`` or `~~~`), including a leading indent of up
 * to three spaces. Four-space indented code is left for the prose splitter.
 */
function fenceMarker(line: string): { readonly char: "`" | "~"; readonly length: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[2] ?? "";
  const first = marker[0];
  if (first !== "`" && first !== "~") {
    return null;
  }
  return { char: first, length: marker.length };
}

/**
 * Language info word from an opening fence. Empty info stays null so the
 * header can fall back to a generic code label.
 */
function fenceLanguage(
  line: string,
  opener: { readonly char: "`" | "~"; readonly length: number },
): string | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  const info = (match?.[3] ?? "").trim();
  if (info.length === 0) {
    return null;
  }
  const word = info.split(/\s+/)[0] ?? "";
  if (word.length === 0 || word.includes(opener.char)) {
    return null;
  }
  return word;
}

/**
 * True when `line` closes `opener`. The closing line is only the marker, and
 * it must be at least as long as the opener of the same character.
 */
function isClosingFence(
  line: string,
  opener: { readonly char: "`" | "~"; readonly length: number },
): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  const marker = match?.[2] ?? "";
  return marker.length >= opener.length && marker[0] === opener.char;
}
