import {
  formatFilePathPosition,
  splitFilePathPosition,
} from "@t3tools/client-runtime/markdown-links";

import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  let output = value.replace(
    kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN,
    "",
  );
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw, kind);
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, urlMatches);
  return [...urlMatches, ...pathMatches].toSorted((a, b) => a.start - b.start);
}

export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const position = splitFilePathPosition(rawPath);
  const { path } = position;

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  return formatFilePathPosition({ ...position, path: resolvedPath });
}

/**
 * Collapses `.` and `..` on a markdown file-link path before workspace membership
 * is decided. The collapse is lexical and does not read the filesystem.
 *
 * POSIX `/`, a Windows drive root (`C:\` or `C:/`), a backslash UNC share
 * (`\\server\share`), and a forward-slash UNC share (`//server/share`) stay
 * intact, and `..` does not climb above them. A `:line` or `:line:column`
 * suffix is preserved. A path with no `.` or `..` segment is returned unchanged.
 */
export function collapseLexicalDotSegments(pathWithPosition: string): string {
  const position = splitFilePathPosition(pathWithPosition);
  if (!position.path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    return pathWithPosition;
  }
  return formatFilePathPosition({
    ...position,
    path: collapseDotSegments(position.path),
  });
}

/**
 * Removes `.` and `..` under the path's root. A complete UNC share is recognized
 * before a single `/`, so `//server/share/dir/..` stays on that share. An
 * incomplete UNC path is returned unchanged.
 */
function collapseDotSegments(path: string): string {
  const unc = uncSharePrefix(path);
  if ((path.startsWith("//") || path.startsWith("\\\\")) && !unc) return path;

  const trailing = /[\\/]$/.test(path);
  let prefix = "";
  let rest = path;
  let separator: "/" | "\\" = path.includes("\\") ? "\\" : "/";
  let rooted = false;

  if (unc) {
    prefix = unc.prefix;
    separator = unc.separator;
    rooted = true;
    rest = path.slice(prefix.length);
  } else {
    const drive = /^[A-Za-z]:/.exec(path);
    if (drive?.[0]) {
      prefix = drive[0];
      const driveSeparator = path.charAt(prefix.length);
      rooted = driveSeparator === "/" || driveSeparator === "\\";
      separator = driveSeparator === "\\" || (!rooted && path.includes("\\")) ? "\\" : "/";
      rest = path.slice(prefix.length);
    } else if (path.startsWith("/")) {
      prefix = "/";
      separator = "/";
      rooted = true;
      rest = path.slice(1);
    } else if (path.startsWith("~/") || path.startsWith("~\\")) {
      separator = path.charAt(1) === "\\" ? "\\" : "/";
      prefix = path.slice(0, 2);
      rooted = true;
      rest = path.slice(2);
    }
  }

  const segments: string[] = [];
  for (const segment of rest.split(/[\\/]/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (!rooted) segments.push("..");
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    if (prefix === "/") return "/";
    if (/^[A-Za-z]:$/.test(prefix)) return rooted ? `${prefix}${separator}` : prefix;
    if (prefix.startsWith("//") || prefix.startsWith("\\\\")) return `${prefix}${separator}`;
    if (prefix === "~/" || prefix === "~\\") return prefix;
    return prefix.length > 0 ? prefix : trailing ? `.${separator}` : ".";
  }

  const body = segments.join(separator);
  const joined =
    prefix.length === 0
      ? body
      : prefix.endsWith("/") || prefix.endsWith("\\")
        ? `${prefix}${body}`
        : rooted
          ? `${prefix}${separator}${body}`
          : `${prefix}${body}`;
  return trailing ? `${joined}${separator}` : joined;
}

/** `\\server\share` or `//server/share` when both names are real path segments. */
function uncSharePrefix(
  path: string,
): { readonly prefix: string; readonly separator: "/" | "\\" } | null {
  if (!path.startsWith("//") && !path.startsWith("\\\\")) return null;
  const body = path.slice(2);
  const serverEnd = body.search(/[\\/]/);
  if (serverEnd <= 0) return null;
  const server = body.slice(0, serverEnd);
  const afterServer = body.slice(serverEnd + 1);
  const shareEnd = afterServer.search(/[\\/]/);
  const share = shareEnd === -1 ? afterServer : afterServer.slice(0, shareEnd);
  if (server === "." || server === ".." || share.length === 0 || share === "." || share === "..") {
    return null;
  }
  return {
    prefix: path.slice(0, 2 + server.length + 1 + share.length),
    separator: body.charAt(serverEnd) as "/" | "\\",
  };
}
