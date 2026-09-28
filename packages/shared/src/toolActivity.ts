import type { ToolLifecycleItemType } from "@t3tools/contracts";

/**
 * Narrows an unknown value to a plain object.
 *
 * `null`, arrays, and other non-objects are rejected so callers can read
 * fields without treating those values as dictionaries. The AskUserQuestion
 * projection uses this for `item`, nested `input` / `params`, and each
 * question entry.
 *
 * @param value Candidate payload value.
 * @returns The object when `value` is a non-null, non-array object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Trims a string and treats blank text as missing.
 *
 * Non-strings and whitespace-only strings return `undefined`. The
 * AskUserQuestion projection uses that so `"  "` does not become a question
 * label.
 *
 * @param value Candidate text.
 * @returns The trimmed string when `value` is a non-empty string.
 */
function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}

/**
 * Leaf name used to recognize an AskUserQuestion-style tool.
 *
 * Providers prefix the name (`mcp__server__AskUserQuestion`,
 * `functions.AskQuestion`). Only the last segment is compared, with
 * underscores and spaces removed.
 *
 * @param toolName Raw tool name from the payload or the activity title.
 * @returns Lowercased leaf name, or `undefined` when the name has no leaf segment.
 */
function questionToolLeafName(toolName: string): string | undefined {
  return toolName
    .split(/__|[./]/)
    .at(-1)
    ?.replace(/[_\s]/g, "")
    .toLowerCase();
}

/**
 * Whether `name` is an AskUserQuestion-style tool after {@link questionToolLeafName}.
 *
 * Recognizes AskUserQuestion, request user input (including the async form),
 * AskQuestion, and Question.
 *
 * @param name Lowercased leaf name.
 * @returns `true` when the projection should keep this tool's questions.
 */
function isQuestionToolName(name: string): boolean {
  return /^(askuserquestion|requestuserinput(?:async)?|askquestion|question)$/.test(name);
}

/**
 * Reads the question text clients match against a native user-input activity.
 *
 * The first non-empty value among `question`, `question_text`, `prompt`, and
 * `title` wins. Header, options, and answers are ignored. Whitespace-only
 * text is missing text.
 *
 * @param value One entry from a question tool's `questions` array.
 * @returns Trimmed question text, or `undefined` when the entry has none yet.
 */
function readQuestionText(value: unknown): string | undefined {
  const question = asRecord(value);
  return asTrimmedString(
    question?.question ?? question?.question_text ?? question?.prompt ?? question?.title,
  );
}

/**
 * Projects one AskUserQuestion entry down to question text.
 *
 * An entry can arrive with a header and options, or as `{}` mid-stream, before
 * any question text. `{ question: undefined }` is not valid JSON, and
 * `Schema.Unknown` rejects the whole thread snapshot, so missing text is
 * projected as `{}` and the key is left out.
 *
 * @param value One entry from a question tool's `questions` array.
 * @returns `{ question }` when trimmed text exists; otherwise `{}`.
 */
function projectQuestionEntry(value: unknown) {
  const text = readQuestionText(value);
  return text === undefined ? {} : { question: text };
}

/**
 * Projects an AskUserQuestion-style tool call down to the question text clients
 * match against the native user-input activity.
 *
 * Header, options, and answers stay off this payload; they already live on
 * that activity. Each entry is reduced with {@link projectQuestionEntry}.
 * Returns `{}` when the tool name is missing, the tool is not a recognized
 * question tool, or `questions` is not an array.
 *
 * @param data Activity payload. Tool name and input are read from `toolName`,
 * `tool`, `item`, `input`, `rawInput`, or `state`.
 * @param title Fallback tool name, used only when the payload has none.
 * @returns `{ toolName, input: { questions } }` for a recognized question
 * tool, or `{}` when the payload should not be projected.
 */
export function projectQuestionToolInput(data: Record<string, unknown>, title: unknown) {
  const item = asRecord(data.item);
  const toolName = data.toolName ?? data.tool ?? item?.tool ?? title;
  if (typeof toolName !== "string") return {};
  const name = questionToolLeafName(toolName);
  if (!name || !isQuestionToolName(name)) return {};
  const input = asRecord(
    data.input ?? data.rawInput ?? asRecord(data.state)?.input ?? item?.arguments,
  );
  const questions = input?.questions ?? asRecord(input?.params)?.questions;
  if (!Array.isArray(questions)) return {};
  // Clients match native tools to the canonical question; choices and answers
  // already live on the user-input activities and need not cross the wire twice.
  return {
    toolName,
    input: {
      questions: questions.map(projectQuestionEntry),
    },
  };
}
