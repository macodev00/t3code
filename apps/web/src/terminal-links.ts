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

/**
 * Resolves a path link against `cwd` for the file viewer.
 *
 * `~/` expands from the home directory implied by `cwd` before `.` and `..`
 * collapse. The collapse is lexical and does not read the filesystem, so a
 * link such as `../other/notes.md` becomes a host path instead of a
 * workspace-relative path that still contains `..`. A `:line` or
 * `:line:column` suffix is not part of the collapse.
 */
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

  return formatFilePathPosition({ ...position, path: collapseLexicalPath(resolvedPath) });
}

/**
 * Collapses `.` and `..` without reading the filesystem.
 * `..` stops at a POSIX root, a Windows drive root, or a UNC share.
 * A path with no dot segments is returned unchanged, separators included.
 */
function collapseLexicalPath(path: string): string {
  if (!hasLexicalDotSegment(path)) return path;

  const root = splitLexicalRoot(path);
  const segments: string[] = [];
  for (const segment of root.segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      const parent = segments.at(-1);
      if (parent !== undefined && parent !== "..") {
        segments.pop();
      } else if (!root.rooted) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  return joinLexicalPath(root, segments);
}

/** True when some path segment is exactly `.` or `..`, not a dotted filename. */
function hasLexicalDotSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

interface LexicalRoot {
  readonly prefix: string;
  readonly separator: "/" | "\\";
  readonly rooted: boolean;
  readonly segments: readonly string[];
  readonly trailingSeparator: boolean;
}

/** Splits a path into the root that `..` may not climb past, plus its segments. */
function splitLexicalRoot(path: string): LexicalRoot {
  const trailingSeparator = /[\\/]$/.test(path);
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(path);
  if (unc?.[0]) {
    return {
      prefix: unc[0],
      separator: "\\",
      rooted: true,
      segments: path.slice(unc[0].length).split(/[\\/]/),
      trailingSeparator,
    };
  }

  const drive = /^[A-Za-z]:/.exec(path);
  if (drive?.[0]) {
    const separatorChar = path.charAt(drive[0].length);
    const rooted = separatorChar === "/" || separatorChar === "\\";
    const separator: "/" | "\\" =
      separatorChar === "\\" || (!rooted && path.includes("\\")) ? "\\" : "/";
    return {
      prefix: drive[0],
      separator,
      rooted,
      segments: path.slice(drive[0].length).split(/[\\/]/),
      trailingSeparator,
    };
  }

  if (path.startsWith("/")) {
    return {
      prefix: "/",
      separator: "/",
      rooted: true,
      segments: path.slice(1).split(/[\\/]/),
      trailingSeparator,
    };
  }

  return {
    prefix: "",
    separator: path.includes("\\") ? "\\" : "/",
    rooted: false,
    segments: path.split(/[\\/]/),
    trailingSeparator,
  };
}

/** Joins collapsed segments back onto a lexical root, keeping its separator. */
function joinLexicalPath(root: LexicalRoot, segments: readonly string[]): string {
  if (segments.length === 0) {
    if (root.prefix === "/") return "/";
    if (/^[A-Za-z]:$/.test(root.prefix)) {
      return root.rooted ? `${root.prefix}${root.separator}` : root.prefix;
    }
    if (root.prefix.startsWith("\\\\")) return `${root.prefix}\\`;
    return root.prefix.length > 0 ? root.prefix : ".";
  }

  const body = segments.join(root.separator);
  const prefixIncludesSeparator =
    root.prefix === "/" || root.prefix.endsWith("/") || root.prefix.endsWith("\\");
  const joined =
    root.prefix.length === 0
      ? body
      : root.rooted && !prefixIncludesSeparator
        ? `${root.prefix}${root.separator}${body}`
        : `${root.prefix}${body}`;
  return root.trailingSeparator ? `${joined}${root.separator}` : joined;
}
