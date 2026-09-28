import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";

/**
 * Prose mounted as one Android text view. Larger selectable paragraphs are the
 * stalls measured when a settled thread scrolls back into view.
 */
export const ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET = 720;

/**
 * Code lines mounted as one Android row. A longer fence is windowed so a fling
 * never builds that fence's whole text tree in a single frame.
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

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface FenceOpener {
  readonly char: "`" | "~";
  readonly length: number;
  readonly info: string;
}

interface ListMarkerInfo {
  readonly indent: number;
  readonly ordered: boolean;
  readonly number: number | null;
}

type HtmlBlockKind =
  | { readonly kind: "comment" }
  | { readonly kind: "processing" }
  | { readonly kind: "declaration" }
  | { readonly kind: "pre"; readonly tag: string }
  | { readonly kind: "block"; readonly tag: string };

interface MarkdownBlock {
  readonly kind: "markdown";
  readonly start: number;
  readonly end: number;
  /**
   * True only for a plain paragraph. Lists, quotes, tables, and HTML stay one
   * piece because each slice is parsed as its own Markdown document.
   */
  readonly inlineSplittable: boolean;
}

interface CodeBlock {
  readonly kind: "code";
  readonly start: number;
  readonly body: string;
  readonly language: string | null;
  readonly lineCount: number;
}

type TranscriptBlock = MarkdownBlock | CodeBlock;

interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface EmphasisDelimiter {
  readonly char: "*" | "_" | "~";
  readonly pos: number;
  origLen: number;
  len: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}

const HTML_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
]);

/**
 * Splits an expensive assistant message into bounded Android list rows.
 *
 * Each Markdown slice is a complete document: links, emphasis, inline code,
 * lists, blockquotes, tables, and HTML are never cut in half. A construct
 * longer than the budget stays one row. Short messages return null so they
 * keep the highlighted renderer. Keys come from source offsets, so a streaming
 * append does not renumber earlier slices.
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
  const blocks = parseTranscriptBlocks(normalized);
  if (!shouldSplitAssistantTranscript(normalized, blocks)) {
    return null;
  }
  const definitions = collectLinkReferenceDefinitions(normalized);
  const slices = assembleTranscriptSlices(normalized, blocks, definitions);
  return slices.length > 1 ? slices : null;
}

/**
 * Expands assistant messages that would mount an unbounded text tree.
 *
 * Non-Android feeds are returned unchanged, including the same array, so iOS
 * keeps today's row identity. The first slice reuses the message id; later
 * slices append, which is the direction live-follow already scrolls.
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
 * LegendList item type for a slice. The list prefers a same-type container, so
 * a plain code window is reused for another code window before a prose row.
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
 * Wraps a short code window in a fence the markdown renderer already knows how
 * to draw. The fence is longer than any backtick run in the body so the body
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
 * True when one list row would mount more text than a frame can afford.
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
 * Walks top-level Markdown blocks. Fences become code windows. Lists, quotes,
 * tables, and HTML stay intact. Only plain paragraphs may be cut later.
 */
function parseTranscriptBlocks(markdown: string): readonly TranscriptBlock[] {
  const lines = sourceLines(markdown);
  const blocks: TranscriptBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || isBlankLine(line.text)) {
      index += 1;
      continue;
    }
    const fence = openingFence(line.text);
    if (fence) {
      const consumed = consumeFence(lines, index, fence);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    if (isAtxHeading(line.text) || isThematicBreak(line.text)) {
      blocks.push(markdownSpan(line, line, false));
      index += 1;
      continue;
    }
    if (isBlockquoteLine(line.text)) {
      const consumed = consumeBlockquote(lines, index);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    if (listMarker(line.text)) {
      const consumed = consumeList(lines, index);
      blocks.push(...consumed.blocks);
      index = consumed.next;
      continue;
    }
    if (isLinkReferenceDefinition(line.text)) {
      const consumed = consumeLinkDefinition(lines, index);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    const html = htmlBlockKind(line.text);
    if (html) {
      const consumed = consumeHtmlBlock(lines, index, html);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    const next = lines[index + 1]?.text ?? null;
    if (next !== null && isTableStart(line.text, next)) {
      const consumed = consumeTable(lines, index);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    if (isIndentedCodeLine(line.text)) {
      const consumed = consumeIndentedCode(lines, index);
      blocks.push(consumed.block);
      index = consumed.next;
      continue;
    }
    const consumed = consumeParagraph(lines, index);
    blocks.push(consumed.block);
    index = consumed.next;
  }
  return blocks;
}

/**
 * Turns parsed blocks into row slices. Markdown on either side of a fence is
 * packed separately so a fence cannot be swallowed by a prose range.
 */
function assembleTranscriptSlices(
  markdown: string,
  blocks: readonly TranscriptBlock[],
  definitions: string,
): AndroidTranscriptSlice[] {
  const slices: AndroidTranscriptSlice[] = [];
  let markdownSpans: TextRange[] = [];
  const flushMarkdown = () => {
    if (markdownSpans.length === 0) return;
    slices.push(...packMarkdownSpans(markdown, markdownSpans, definitions));
    markdownSpans = [];
  };
  for (const block of blocks) {
    if (block.kind === "code") {
      flushMarkdown();
      slices.push(...sliceCodeBlock(block));
      continue;
    }
    markdownSpans.push(...expandMarkdownBlock(markdown, block));
  }
  flushMarkdown();
  return slices;
}

/**
 * Breaks a plain paragraph on inline-safe whitespace. Every other block is
 * one span, even when it is longer than the budget.
 */
function expandMarkdownBlock(markdown: string, block: MarkdownBlock): readonly TextRange[] {
  if (!block.inlineSplittable) {
    return [{ start: block.start, end: block.end }];
  }
  const text = markdown.slice(block.start, block.end);
  return splitPlainParagraph(text).map((range) => ({
    start: block.start + range.start,
    end: block.start + range.end,
  }));
}

/**
 * Packs neighboring Markdown spans up to the char budget. An oversized span
 * is emitted alone so a long list item or quote is not joined to more text.
 */
function packMarkdownSpans(
  markdown: string,
  spans: readonly TextRange[],
  definitions: string,
): AndroidTranscriptSlice[] {
  const slices: AndroidTranscriptSlice[] = [];
  let groupStart = -1;
  let groupEnd = -1;
  const flush = () => {
    if (groupStart < 0) return;
    pushMarkdownSlice(slices, markdown, groupStart, groupEnd, definitions);
    groupStart = -1;
    groupEnd = -1;
  };
  for (const span of spans) {
    const spanLength = emittedLength(markdown, span.start, span.end);
    if (spanLength > ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      flush();
      pushMarkdownSlice(slices, markdown, span.start, span.end, definitions);
      continue;
    }
    if (groupStart < 0) {
      groupStart = span.start;
      groupEnd = span.end;
      continue;
    }
    const combined = emittedLength(markdown, groupStart, span.end);
    if (combined > ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      flush();
      groupStart = span.start;
      groupEnd = span.end;
      continue;
    }
    groupEnd = span.end;
  }
  flush();
  return slices;
}

/**
 * Emits one Markdown slice, appending link reference definitions the slice
 * does not already contain so `[text][id]` still resolves after a split.
 */
function pushMarkdownSlice(
  slices: AndroidTranscriptSlice[],
  markdown: string,
  start: number,
  end: number,
  definitions: string,
): void {
  const text = withLinkDefinitions(trimEdgeNewlines(markdown.slice(start, end)), definitions);
  if (text.trim().length === 0) return;
  slices.push({
    kind: "markdown",
    key: `md:${start}`,
    text,
  });
}

/**
 * Windows a fence into fixed line ranges. The first window stops changing once
 * it fills, so scrolling back reuses that row instead of the rest of the file.
 */
function sliceCodeBlock(block: CodeBlock): readonly AndroidTranscriptSlice[] {
  if (block.body.length === 0) {
    return [];
  }
  const lines = block.body.split("\n");
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
    fullCode: block.body,
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
 * Splits one paragraph into ranges that each parse as their own paragraph.
 * Points inside links, emphasis, inline code, or raw HTML are not used. When
 * no safe point exists, the open construct stays whole.
 */
function splitPlainParagraph(text: string): readonly TextRange[] {
  if (text.length <= ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
    return [{ start: 0, end: text.length }];
  }
  const points = inlineSafeBreaks(text);
  const ranges: TextRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      ranges.push({ start: cursor, end: text.length });
      break;
    }
    let best = -1;
    for (const point of points) {
      if (point <= cursor) continue;
      if (point > cursor + ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) break;
      best = point;
    }
    const next = best === -1 ? nextSafeBreak(points, cursor, text.length) : best;
    const end = next <= cursor || next > text.length ? text.length : next;
    ranges.push({ start: cursor, end });
    if (end >= text.length) break;
    cursor = end;
  }
  return ranges;
}

/**
 * First safe break after the budget, or the end of the paragraph when the
 * remainder is one unbreakable construct.
 */
function nextSafeBreak(points: readonly number[], cursor: number, length: number): number {
  for (const point of points) {
    if (point > cursor + ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET) {
      return point;
    }
  }
  return length;
}

/**
 * Whitespace indexes where the following text can start a new Markdown document
 * without opening a block the original paragraph did not have.
 */
function inlineSafeBreaks(text: string): readonly number[] {
  const blocked = protectedIntervals(text);
  const points: number[] = [];
  let index = 0;
  while (index < text.length) {
    if (!isInlineWhitespace(text[index] ?? "")) {
      index += 1;
      continue;
    }
    let next = index + 1;
    while (next < text.length && isInlineWhitespace(text[next] ?? "")) {
      next += 1;
    }
    if (
      next < text.length &&
      !insideProtected(blocked, next) &&
      !newlineWouldStartBlock(text, next)
    ) {
      points.push(next);
    }
    index = next;
  }
  return points;
}

/**
 * True when `index` sits strictly inside a link, code span, emphasis run, or tag.
 * The edges themselves are safe: the construct stays entirely on one side.
 */
function insideProtected(intervals: readonly TextRange[], index: number): boolean {
  for (const interval of intervals) {
    if (interval.start >= index) break;
    if (index > interval.start && index < interval.end) return true;
  }
  return false;
}

/**
 * True when a slice starting at `index` would turn a wrapped line into a list,
 * quote, heading, fence, or other block. Those breaks stay with the line above.
 */
function newlineWouldStartBlock(text: string, index: number): boolean {
  if (index === 0 || text[index - 1] !== "\n") return false;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
  if (isBlankLine(line)) return false;
  if (openingFence(line) || isAtxHeading(line) || isThematicBreak(line)) return true;
  if (isBlockquoteLine(line) || htmlBlockKind(line) !== null) return true;
  if (listMarker(line) || isIndentedCodeLine(line)) return true;
  return isLinkReferenceDefinition(line);
}

/**
 * Regions that must stay inside one slice. Later scanners skip earlier regions
 * so a bracket inside inline code is not treated as a link.
 */
function protectedIntervals(text: string): readonly TextRange[] {
  const intervals: TextRange[] = [];
  collectCodeSpans(text, intervals);
  collectLinks(text, intervals);
  collectHtmlAndAutolinks(text, intervals);
  collectEmphasis(text, intervals);
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  return intervals;
}

/**
 * Records CommonMark code spans. An unclosed span protects the rest of the
 * paragraph so the next slice cannot start between the backticks.
 */
function collectCodeSpans(text: string, intervals: TextRange[]): void {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let length = 0;
    while (text[index + length] === "`") length += 1;
    let cursor = index + length;
    let closed = false;
    while (cursor < text.length) {
      if (text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let run = 0;
      while (text[cursor + run] === "`") run += 1;
      if (run === length) {
        intervals.push({ start: index, end: cursor + run });
        index = cursor + run;
        closed = true;
        break;
      }
      cursor += run;
    }
    if (!closed) {
      intervals.push({ start: index, end: text.length });
      return;
    }
  }
}

/**
 * Records inline links and images, including the destination through the
 * closing `)`. An unclosed `](` protects the tail so the URL is not cut.
 */
function collectLinks(text: string, intervals: TextRange[]): void {
  let index = 0;
  while (index < text.length) {
    const skip = coveringEnd(intervals, index);
    if (skip !== -1) {
      index = skip;
      continue;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    const image = text[index] === "!" && text[index + 1] === "[";
    if (image || text[index] === "[") {
      const open = image ? index + 1 : index;
      const end = endOfLink(text, open, intervals);
      if (end > open + 1) {
        intervals.push({ start: image ? index : open, end });
        index = end;
        continue;
      }
    }
    index += 1;
  }
}

/**
 * End offset of the link that opens at `openIndex`, or `openIndex` when the
 * brackets never close. Reference and shortcut links stop at their last `]`.
 */
function endOfLink(text: string, openIndex: number, blocked: readonly TextRange[]): number {
  let depth = 1;
  let index = openIndex + 1;
  while (index < text.length) {
    const skip = coveringEnd(blocked, index);
    if (skip !== -1) {
      index = skip;
      continue;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "[") depth += 1;
    else if (text[index] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }
  if (index >= text.length || text[index] !== "]") return openIndex;
  const after = index + 1;
  if (text[after] === "(") {
    const destinationEnd = endOfLinkDestination(text, after);
    return destinationEnd === -1 ? text.length : destinationEnd;
  }
  if (text[after] === "[") {
    let cursor = after + 1;
    while (cursor < text.length && text[cursor] !== "]" && text[cursor] !== "\n") {
      cursor += 1;
    }
    return cursor >= text.length || text[cursor] !== "]" ? text.length : cursor + 1;
  }
  return after;
}

/**
 * Offset just after the `)` that closes a link destination, or -1 when the
 * parenthesis never closes. Quoted titles may contain parentheses.
 */
function endOfLinkDestination(text: string, parenIndex: number): number {
  let depth = 1;
  let index = parenIndex + 1;
  let quote: '"' | "'" | null = null;
  while (index < text.length && depth > 0) {
    const character = text[index];
    if (quote) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    if ((character === '"' || character === "'") && depth === 1) {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    index += 1;
  }
  return depth === 0 ? index : -1;
}

/**
 * Records autolinks and raw HTML tags. A paired element stays together so
 * `<em>` is not left in a different slice from `</em>`.
 */
function collectHtmlAndAutolinks(text: string, intervals: TextRange[]): void {
  let index = 0;
  while (index < text.length) {
    const skip = coveringEnd(intervals, index);
    if (skip !== -1) {
      index = skip;
      continue;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] !== "<") {
      index += 1;
      continue;
    }
    const rest = text.slice(index);
    const autolink =
      /^<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+>/.exec(rest) ?? /^<[^>\s]+@[^>\s]+>/.exec(rest);
    if (autolink) {
      intervals.push({ start: index, end: index + autolink[0].length });
      index += autolink[0].length;
      continue;
    }
    const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>\n]*\/?>/.exec(rest);
    if (!tag) {
      index += 1;
      continue;
    }
    const name = (tag[1] ?? "").toLowerCase();
    const closingOrEmpty = rest.startsWith("</") || tag[0].endsWith("/>");
    if (closingOrEmpty) {
      intervals.push({ start: index, end: index + tag[0].length });
      index += tag[0].length;
      continue;
    }
    const close = `</${name}>`;
    const closeAt = rest.toLowerCase().indexOf(close, tag[0].length);
    const end = closeAt === -1 ? index + tag[0].length : index + closeAt + close.length;
    intervals.push({ start: index, end });
    index = end;
  }
}

/**
 * Records matched emphasis and strikethrough. Unmatched `*` or `_` stays
 * literal and does not block a split.
 */
function collectEmphasis(text: string, intervals: TextRange[]): void {
  const delimiters: EmphasisDelimiter[] = [];
  let index = 0;
  while (index < text.length) {
    const skip = coveringEnd(intervals, index);
    if (skip !== -1) {
      index = skip;
      continue;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    const character = text[index];
    if (character !== "*" && character !== "_" && character !== "~") {
      index += 1;
      continue;
    }
    let length = 0;
    while (text[index + length] === character) length += 1;
    if (character === "~" && length < 2) {
      index += length;
      continue;
    }
    const flanking = delimiterFlanking(character, text[index - 1], text[index + length]);
    if (flanking.canOpen || flanking.canClose) {
      delimiters.push({
        char: character,
        pos: index,
        origLen: length,
        len: length,
        canOpen: flanking.canOpen,
        canClose: flanking.canClose,
      });
    }
    index += length;
  }

  const stack: EmphasisDelimiter[] = [];
  for (const delimiter of delimiters) {
    if (delimiter.canClose) {
      let stackIndex = stack.length - 1;
      while (stackIndex >= 0 && delimiter.len > 0) {
        const opener = stack[stackIndex];
        if (
          !opener ||
          opener.char !== delimiter.char ||
          !opener.canOpen ||
          opener.len === 0 ||
          !emphasisCanMatch(opener, delimiter)
        ) {
          stackIndex -= 1;
          continue;
        }
        const use = delimiter.char === "~" ? 2 : Math.min(opener.len, delimiter.len);
        if (opener.len < use || delimiter.len < use) {
          stackIndex -= 1;
          continue;
        }
        const openStart = opener.pos + opener.len - use;
        const closeEnd = delimiter.pos + (delimiter.origLen - delimiter.len) + use;
        intervals.push({ start: openStart, end: closeEnd });
        opener.len -= use;
        delimiter.len -= use;
        stack.splice(stackIndex + 1);
        if (opener.len === 0) stack.splice(stackIndex, 1);
        else stackIndex -= 1;
      }
    }
    if (delimiter.len > 0 && delimiter.canOpen) stack.push(delimiter);
  }
}

/**
 * CommonMark flanking rules. Underscores inside words are not emphasis.
 * `before` and `after` are the characters just outside the delimiter run.
 */
function delimiterFlanking(
  character: "*" | "_" | "~",
  before: string | undefined,
  after: string | undefined,
): { readonly canOpen: boolean; readonly canClose: boolean } {
  const beforeSpace = isUnicodeSpace(before);
  const afterSpace = isUnicodeSpace(after);
  const beforePunctuation = !beforeSpace && isAsciiPunctuation(before);
  const afterPunctuation = !afterSpace && isAsciiPunctuation(after);
  const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
  if (character === "_") {
    return {
      canOpen: left && (!right || beforePunctuation),
      canClose: right && (!left || afterPunctuation),
    };
  }
  return { canOpen: left, canClose: right };
}

/**
 * Applies CommonMark's multiple-of-three rule so `***` is not paired with a
 * delimiter that would leave an odd unmatched run.
 */
function emphasisCanMatch(opener: EmphasisDelimiter, closer: EmphasisDelimiter): boolean {
  if (opener.char === "~") return opener.origLen >= 2 && closer.origLen >= 2;
  if (!(opener.canOpen && opener.canClose && closer.canOpen && closer.canClose)) {
    return true;
  }
  const sum = opener.origLen + closer.origLen;
  return !(sum % 3 === 0 && opener.origLen % 3 !== 0 && closer.origLen % 3 !== 0);
}

/**
 * End of the protected region containing `index`, or -1 when `index` is free.
 */
function coveringEnd(intervals: readonly TextRange[], index: number): number {
  let end = -1;
  for (const interval of intervals) {
    if (index >= interval.start && index < interval.end && interval.end > end) {
      end = interval.end;
    }
  }
  return end;
}

/**
 * Lines of `markdown` with offsets. The trailing newline belongs to the line
 * so a later slice can include the break that separated two blocks.
 */
function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: markdown.slice(start), start, end: markdown.length });
      break;
    }
    lines.push({ text: markdown.slice(start, newline), start, end: newline + 1 });
    start = newline + 1;
  }
  return lines;
}

/**
 * One Markdown span covering `from` through `to`, inclusive of those lines.
 */
function markdownSpan(from: SourceLine, to: SourceLine, inlineSplittable: boolean): MarkdownBlock {
  return {
    kind: "markdown",
    start: from.start,
    end: to.end,
    inlineSplittable,
  };
}

/**
 * Reads a fence through its closer, or through the end while a reply is still
 * streaming. The body excludes the fence markers.
 */
function consumeFence(
  lines: readonly SourceLine[],
  start: number,
  opener: FenceOpener,
): { readonly block: CodeBlock; readonly next: number } {
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length && !isClosingFence(lines[index]?.text ?? "", opener)) {
    body.push(lines[index]?.text ?? "");
    index += 1;
  }
  if (index < lines.length) index += 1;
  return {
    block: {
      kind: "code",
      start: lines[start]?.start ?? 0,
      body: body.join("\n"),
      language: fenceLanguage(opener),
      lineCount: body.length,
    },
    next: index,
  };
}

/**
 * Reads a blockquote through its last `>` line, including lazy continuation
 * that would still belong to the quote in one document.
 */
function consumeBlockquote(
  lines: readonly SourceLine[],
  start: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]?.text ?? "";
    if (isBlockquoteLine(line)) {
      index += 1;
      continue;
    }
    if (isBlankLine(line)) {
      const next = nextNonBlank(lines, index + 1);
      if (next !== null && isBlockquoteLine(lines[next]?.text ?? "")) {
        index += 1;
        continue;
      }
      break;
    }
    const following = lines[index + 1]?.text ?? null;
    if (interruptsParagraph(line, following)) break;
    index += 1;
  }
  const last = lines[index - 1] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, false),
    next: index,
  };
}

/**
 * Reads one top-level list as a sequence of items. Items stay whole, including
 * nested lists, indented continuation, and lazy lines, and may be packed later.
 */
function consumeList(
  lines: readonly SourceLine[],
  start: number,
): { readonly blocks: readonly MarkdownBlock[]; readonly next: number } {
  const base = listMarker(lines[start]?.text ?? "");
  if (!base) return { blocks: [], next: start + 1 };
  const blocks: MarkdownBlock[] = [];
  let index = start;
  while (index < lines.length) {
    while (index < lines.length && isBlankLine(lines[index]?.text ?? "")) {
      const next = nextNonBlank(lines, index + 1);
      const nextMarker = next === null ? null : listMarker(lines[next]?.text ?? "");
      if (nextMarker && nextMarker.indent === base.indent) {
        index += 1;
        continue;
      }
      return { blocks, next: index };
    }
    const marker = listMarker(lines[index]?.text ?? "");
    if (!marker || marker.indent !== base.indent) break;
    const itemStart = index;
    index += 1;
    while (index < lines.length) {
      const line = lines[index]?.text ?? "";
      if (isBlankLine(line)) {
        const next = nextNonBlank(lines, index + 1);
        if (next !== null && leadingIndent(lines[next]?.text ?? "") > base.indent) {
          index += 1;
          continue;
        }
        break;
      }
      if (leadingIndent(line) > base.indent) {
        index += 1;
        continue;
      }
      // Same-indent markers start the next item. Other lines that would not
      // interrupt a paragraph are lazy continuation and stay with this item.
      const sibling = listMarker(line);
      if (sibling && sibling.indent <= base.indent) break;
      const following = lines[index + 1]?.text ?? null;
      if (interruptsParagraph(line, following)) break;
      index += 1;
    }
    const last = lines[index - 1] ?? lines[itemStart];
    const first = lines[itemStart] ?? last;
    if (first && last) blocks.push(markdownSpan(first, last, false));
  }
  return { blocks, next: index };
}

/**
 * Reads a link reference definition, including an indented title line.
 */
function consumeLinkDefinition(
  lines: readonly SourceLine[],
  start: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start + 1;
  while (index < lines.length && /^(?: {2,}|\t)\S/.test(lines[index]?.text ?? "")) {
    index += 1;
  }
  const last = lines[index - 1] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, false),
    next: index,
  };
}

/**
 * Reads one HTML block. Pre, script, and style run through their closing tag.
 * Other block tags stop at the closer or at the next blank line.
 */
function consumeHtmlBlock(
  lines: readonly SourceLine[],
  start: number,
  kind: HtmlBlockKind,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start;
  if (kind.kind === "comment") {
    index = consumeUntilIncludes(lines, start, "-->");
  } else if (kind.kind === "processing") {
    index = consumeUntilIncludes(lines, start, "?>");
  } else if (kind.kind === "declaration") {
    index = consumeUntilIncludes(lines, start, ">");
  } else if (kind.kind === "pre") {
    index = consumeUntilIncludes(lines, start, `</${kind.tag}>`);
  } else {
    const close = `</${kind.tag}>`;
    if ((lines[start]?.text ?? "").toLowerCase().includes(close)) {
      index = start + 1;
    } else {
      index = start + 1;
      while (index < lines.length && !isBlankLine(lines[index]?.text ?? "")) {
        const includes = (lines[index]?.text ?? "").toLowerCase().includes(close);
        index += 1;
        if (includes) break;
      }
    }
  }
  const last = lines[Math.max(start, index - 1)] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, false),
    next: index,
  };
}

/**
 * Advances past the line that contains `needle`, or to the end of the input.
 */
function consumeUntilIncludes(lines: readonly SourceLine[], start: number, needle: string): number {
  let index = start;
  while (index < lines.length) {
    const includes = (lines[index]?.text ?? "").toLowerCase().includes(needle.toLowerCase());
    index += 1;
    if (includes) break;
  }
  return index;
}

/**
 * Reads a GFM table from its header through the last pipe row. The delimiter
 * row stays with the header so the table still parses.
 */
function consumeTable(
  lines: readonly SourceLine[],
  start: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start + 2;
  while (
    index < lines.length &&
    !isBlankLine(lines[index]?.text ?? "") &&
    (lines[index]?.text ?? "").includes("|")
  ) {
    index += 1;
  }
  const last = lines[index - 1] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, false),
    next: index,
  };
}

/**
 * Reads an indented code block. It stays Markdown, not a fenced window, so the
 * shared renderer can still show it as code.
 */
function consumeIndentedCode(
  lines: readonly SourceLine[],
  start: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]?.text ?? "";
    if (isIndentedCodeLine(line)) {
      index += 1;
      continue;
    }
    if (isBlankLine(line)) {
      const next = nextNonBlank(lines, index + 1);
      if (next !== null && isIndentedCodeLine(lines[next]?.text ?? "")) {
        index += 1;
        continue;
      }
    }
    break;
  }
  const last = lines[index - 1] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, false),
    next: index,
  };
}

/**
 * Reads a paragraph. A setext underline is kept with its text line. A following
 * block that would interrupt the paragraph starts the next span instead.
 */
function consumeParagraph(
  lines: readonly SourceLine[],
  start: number,
): { readonly block: MarkdownBlock; readonly next: number } {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]?.text ?? "";
    if (isBlankLine(line)) break;
    // Setext wins over a thematic break. The underline stays on the heading
    // so a later slice cannot turn `---` into a horizontal rule.
    if (isSetextUnderline(line)) {
      index += 1;
      const last = lines[index - 1] ?? lines[start];
      return {
        block: markdownSpan(lines[start] ?? last!, last!, false),
        next: index,
      };
    }
    const following = lines[index + 1]?.text ?? null;
    if (interruptsParagraph(line, following)) break;
    index += 1;
  }
  const last = lines[index - 1] ?? lines[start];
  return {
    block: markdownSpan(lines[start] ?? last!, last!, true),
    next: index,
  };
}

/**
 * True when `line` starts a new block in the middle of a paragraph. Ordered
 * lists other than `1` do not interrupt, matching CommonMark.
 */
function interruptsParagraph(line: string, nextLine: string | null): boolean {
  if (openingFence(line) || isAtxHeading(line) || isThematicBreak(line)) return true;
  if (isBlockquoteLine(line) || htmlBlockKind(line) !== null) return true;
  if (nextLine !== null && isTableStart(line, nextLine)) return true;
  const marker = listMarker(line);
  if (!marker) return false;
  return !marker.ordered || marker.number === 1;
}

/**
 * Link reference definitions in the message. Copies are appended to slices that
 * do not already hold them, so a reference link stays clickable after a split.
 * Lines inside fences are skipped.
 */
function collectLinkReferenceDefinitions(markdown: string): string {
  const lines = sourceLines(markdown);
  const definitions: string[] = [];
  let fence: FenceOpener | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.text ?? "";
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const opener = openingFence(line);
    if (opener) {
      fence = opener;
      continue;
    }
    if (!isLinkReferenceDefinition(line)) continue;
    const block = [line];
    while (/^(?: {2,}|\t)\S/.test(lines[index + 1]?.text ?? "")) {
      index += 1;
      block.push(lines[index]?.text ?? "");
    }
    definitions.push(block.join("\n"));
  }
  return definitions.join("\n");
}

/**
 * Appends `definitions` when the slice does not already contain them.
 * Definitions are not rendered, so the extra lines do not show up in the row.
 */
function withLinkDefinitions(text: string, definitions: string): string {
  if (definitions.length === 0 || text.includes(definitions)) return text;
  return `${text}\n\n${definitions}`;
}

/**
 * Opening fence (`\`\`\`` or `~~~`) with at most three spaces of indent.
 * A backtick fence whose info string contains a backtick is prose, not a fence.
 */
function openingFence(line: string): FenceOpener | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2] ?? "";
  const info = match[3] ?? "";
  const character = marker[0];
  if (character !== "`" && character !== "~") return null;
  if (character === "`" && info.includes("`")) return null;
  return { char: character, length: marker.length, info };
}

/**
 * True when `line` closes `opener`. The closing line is only the marker, and
 * it must be at least as long as the opener of the same character.
 */
function isClosingFence(line: string, opener: FenceOpener): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  const marker = match?.[2] ?? "";
  return marker.length >= opener.length && marker[0] === opener.char;
}

/**
 * Language info word from an opening fence. Empty info stays null so the
 * header can fall back to a generic code label.
 */
function fenceLanguage(opener: FenceOpener): string | null {
  const info = opener.info.trim();
  if (info.length === 0) return null;
  const word = info.split(/[ \t]+/)[0] ?? "";
  if (word.length === 0 || word.includes(opener.char)) return null;
  return word;
}

/**
 * Top-level list marker, or null for thematic breaks and ordinary prose.
 * The marker's indent is how continuation lines are recognized.
 */
function listMarker(line: string): ListMarkerInfo | null {
  if (isThematicBreak(line)) return null;
  const match = /^( {0,3})([-+*]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!match) return null;
  const marker = match[2] ?? "";
  const ordered = /^\d/.test(marker);
  return {
    indent: (match[1] ?? "").length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : null,
  };
}

/**
 * Count of leading spaces, with a tab counted as four. Blank lines are not
 * continuation; callers handle those separately.
 */
function leadingIndent(line: string): number {
  let count = 0;
  for (const character of line) {
    if (character === " ") count += 1;
    else if (character === "\t") count += 4;
    else break;
  }
  return count;
}

/**
 * True for a GFM header row followed by a delimiter row.
 */
function isTableStart(line: string, nextLine: string): boolean {
  return line.includes("|") && isTableDelimiter(nextLine);
}

/**
 * True for a GFM delimiter row of one or more dashed cells.
 */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

/**
 * True for an ATX heading. A `#` glued to the next word is not a heading.
 */
function isAtxHeading(line: string): boolean {
  return /^( {0,3})#{1,6}(?:[ \t]+.*|[ \t]*)$/.test(line);
}

/**
 * True for a setext underline. Used on the lines after heading text, where it
 * is a heading rather than a thematic break.
 */
function isSetextUnderline(line: string): boolean {
  return /^( {0,3})(?:=+|-+)[ \t]*$/.test(line);
}

/**
 * True for a thematic break of three or more `-`, `*`, or `_`.
 */
function isThematicBreak(line: string): boolean {
  return /^( {0,3})([-*_])(?:\s*\2){2,}\s*$/.test(line);
}

/**
 * True when `line` opens or continues a blockquote.
 */
function isBlockquoteLine(line: string): boolean {
  return /^( {0,3})>/.test(line);
}

/**
 * True for a four-space indented code line. Fence detection allows only three.
 */
function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4}|\t)\S/.test(line);
}

/**
 * True for a link reference definition at the start of a line.
 */
function isLinkReferenceDefinition(line: string): boolean {
  return /^( {0,3})\[[^\]\n]+\]:[ \t]*\S/.test(line);
}

/**
 * Classifies a CommonMark HTML block opener, or null for inline tags.
 */
function htmlBlockKind(line: string): HtmlBlockKind | null {
  if (!/^( {0,3})</.test(line)) return null;
  const trimmed = line.trimStart();
  if (trimmed.startsWith("<!--")) return { kind: "comment" };
  if (trimmed.startsWith("<?")) return { kind: "processing" };
  if (trimmed.startsWith("<!")) return { kind: "declaration" };
  const match = /^<\/?([A-Za-z][A-Za-z0-9]*)\b/.exec(trimmed);
  if (!match) return null;
  const tag = (match[1] ?? "").toLowerCase();
  if (tag === "pre" || tag === "script" || tag === "style") return { kind: "pre", tag };
  if (HTML_BLOCK_TAGS.has(tag)) return { kind: "block", tag };
  return null;
}

/**
 * Index of the next line that is not blank, or null at the end of the message.
 */
function nextNonBlank(lines: readonly SourceLine[], start: number): number | null {
  for (let index = start; index < lines.length; index += 1) {
    if (!isBlankLine(lines[index]?.text ?? "")) return index;
  }
  return null;
}

/**
 * True when `line` has no visible characters.
 */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * True for spaces, tabs, and newlines. These are the only split candidates.
 */
function isInlineWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n";
}

/**
 * True for ASCII whitespace, including the missing character past either end.
 */
function isUnicodeSpace(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

/**
 * True for ASCII punctuation. Unicode punctuation is left as ordinary text.
 */
function isAsciiPunctuation(character: string | undefined): boolean {
  return !!character && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(character);
}

/**
 * Length of the slice text after edge newlines are removed. That is the text
 * the row actually mounts.
 */
function emittedLength(markdown: string, start: number, end: number): number {
  return trimEdgeNewlines(markdown.slice(start, end)).length;
}

/**
 * Removes blank lines from the edges of a slice without stripping the indent
 * a list item or indented code block needs.
 */
function trimEdgeNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") start += 1;
  while (end > start && text[end - 1] === "\n") end -= 1;
  return text.slice(start, end);
}
