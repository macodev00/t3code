import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

/** Stable titles derived from provider tool-call payloads. */
function describeToolActivity() {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  /** Local code search is titled Searched files and keeps the query. */
  function labelsAcpCodeSearchAsFileSearch() {
    expect(
      deriveToolActivityPresentation({
        itemType: "code_search",
        title: "found 4 matches",
        detail: "found 4 matches",
        data: {
          kind: "search",
          rawInput: { variant: "Grep", pattern: "canonicalItemType" },
        },
        fallbackSummary: "found 4 matches",
      }),
    ).toEqual({
      summary: "Searched files",
      detail: "canonicalItemType",
    });
  }

  it(
    "labels ACP code search as file search and keeps the pattern",
    labelsAcpCodeSearchAsFileSearch,
  );

  /** ACP fetch keeps the provider title instead of Searched files. */
  function keepsNetworkSearchTitle() {
    expect(
      deriveToolActivityPresentation({
        itemType: "web_search",
        title: "Web search",
        detail: "https://example.com",
        data: {
          kind: "fetch",
          rawInput: { url: "https://example.com" },
        },
        fallbackSummary: "Web search",
      }),
    ).toEqual({
      summary: "Web search",
      detail: "https://example.com",
    });
  }

  it("does not rewrite network search as file search", keepsNetworkSearchTitle);

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
}

describe("toolActivity", describeToolActivity);
