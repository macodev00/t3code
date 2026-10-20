export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** An @ search that is already open. Spaces extend it; a later scan does not rediscover it. */
export interface ComposerPathSearch {
  readonly text: string;
  readonly trigger: ComposerTrigger & { kind: "path" };
  /** Far end of the query, which can sit past the caret. */
  readonly queryEnd: number;
}

const PATH_QUERY_HARD_BOUNDARY = /[\r\n\t\uFFFC]/u;

/** Continue an open @ search across spaces. Null when this cursor is not an edit of that search. */
export function continueComposerPathTrigger(
  text: string,
  cursorInput: number,
  previous: ComposerPathSearch | null | undefined,
): (ComposerTrigger & { kind: "path" }) | null {
  if (previous?.trigger.kind !== "path") return null;
  const cursor = clampCursor(text, cursorInput);
  const start = previous.trigger.rangeStart;
  const queryEnd = previous.queryEnd + text.length - previous.text.length;
  if (
    text[start] !== "@" ||
    cursor <= start ||
    cursor > queryEnd ||
    text.slice(0, start + 1) !== previous.text.slice(0, start + 1) ||
    text.slice(queryEnd) !== previous.text.slice(previous.queryEnd)
  ) {
    return null;
  }
  const query = text.slice(start + 1, cursor);
  if (PATH_QUERY_HARD_BOUNDARY.test(query)) return null;
  return { kind: "path", query, rangeStart: start, rangeEnd: cursor };
}

/** A whitespace-delimited token that should open its own menu instead of extending an @ search. */
export function isFreshComposerTriggerToken(
  token: string,
  text: string,
  tokenStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  if (token.startsWith("@")) return true;
  if (token.startsWith("/")) {
    return token.length > 0 && !isPathWord(text, tokenStart, cursor, isWhitespaceChar);
  }
  if (/^#(?:[\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.test(token)) return true;
  if (/^\p{Sc}/u.test(token)) return true;
  return false;
}

/** Remember how far an open @ query reaches, including when the caret moves inside it. */
export function rememberComposerPathSearch(
  text: string,
  candidate: ComposerTrigger | null,
  previous: ComposerPathSearch | null,
): ComposerPathSearch | null {
  if (candidate === null || candidate.kind !== "path") return null;
  const trigger: ComposerTrigger & { kind: "path" } = {
    kind: "path",
    query: candidate.query,
    rangeStart: candidate.rangeStart,
    rangeEnd: candidate.rangeEnd,
  };
  if (previous && previous.trigger.rangeStart === trigger.rangeStart) {
    const shiftedEnd = previous.queryEnd + text.length - previous.text.length;
    return {
      text,
      trigger,
      queryEnd: Math.max(trigger.rangeEnd, Math.min(text.length, shiftedEnd)),
    };
  }
  return { text, trigger, queryEnd: trigger.rangeEnd };
}

/**
 * A slash word with a second slash, such as `/tmp/build.sh`, is a path, not a
 * command. The whole word counts, so a caret before the second slash still sees it.
 */
export function isPathWord(
  text: string,
  wordStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespaceChar(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
  activePathSearch?: ComposerPathSearch | null,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch && isPathWord(text, lineStart, cursor, isWhitespaceChar ?? isWhitespace)) {
      return null;
    }
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  let tokenStart = tokenIdx + 1;
  // $, /, and # stop at the first space. Only an already-open @ search continues.
  if (
    !isFreshComposerTriggerToken(text.slice(tokenStart, cursor), text, tokenStart, cursor, wsCheck)
  ) {
    const continued = continueComposerPathTrigger(text, cursor, activePathSearch);
    if (continued !== null && continued.rangeStart < tokenStart) {
      tokenStart = continued.rangeStart;
    }
  }

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@") || PATH_QUERY_HARD_BOUNDARY.test(token.slice(1))) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
