import { describe, expect, it } from "vite-plus/test";

import {
  ANDROID_TRANSCRIPT_CODE_LINE_BUDGET,
  ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET,
  ANDROID_TRANSCRIPT_SLICE_GAP,
  androidTranscriptItemType,
  assistantSliceGap,
  assistantSliceMarkdown,
  expandAndroidAssistantTranscriptRows,
  fencedCodeMarkdown,
  splitAssistantTranscriptSlices,
  type AndroidTranscriptSlice,
} from "./androidTranscriptSlices";

/** Minimal feed message for slice tests. */
function message(id: string, role: "assistant" | "user", text: string) {
  return {
    type: "message" as const,
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    message: { role, text },
  };
}

/** Assistant message fixture. */
function assistantMessage(id: string, text: string) {
  return message(id, "assistant", text);
}

/** Fenced block with a numbered line per row, so windows are easy to count. */
function codeFence(language: string, lineCount: number): string {
  const body = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/** Compact kind/part/line-count label for slice assertions. */
function sliceKinds(slices: readonly AndroidTranscriptSlice[]): string[] {
  return slices.map((slice) =>
    slice.kind === "code" ? `code:${slice.codePart}:${slice.text.split("\n").length}` : "markdown",
  );
}

describe("splitAssistantTranscriptSlices", () => {
  it("leaves a short message with one fence as a single row", () => {
    const markdown = `See this.\n\n${codeFence("ts", 4)}`;
    expect(splitAssistantTranscriptSlices(markdown)).toBeNull();
  });

  it("splits prose that would mount as one oversized selectable text", () => {
    const paragraph = "word ".repeat(200).trim();
    const markdown = `${paragraph}\n\n${paragraph}`;
    const slices = splitAssistantTranscriptSlices(markdown);
    expect(slices).not.toBeNull();
    expect(slices!.every((slice) => slice.kind === "markdown")).toBe(true);
    for (const slice of slices!) {
      expect(slice.text.length).toBeLessThanOrEqual(ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET);
    }
    const words = (value: string) => value.replaceAll(/\s+/g, " ").trim();
    expect(words(slices!.map((slice) => slice.text).join(" "))).toBe(words(markdown));
  });

  it("puts each fence on its own row when a message has more than one", () => {
    const markdown = `${codeFence("ts", 3)}\n\nBetween.\n\n${codeFence("go", 2)}`;
    const slices = splitAssistantTranscriptSlices(markdown);
    expect(sliceKinds(slices!)).toEqual(["code:only:3", "markdown", "code:only:2"]);
    expect(assistantSliceMarkdown(slices![0]!)).toContain("```ts");
    expect(assistantSliceMarkdown(slices![2]!)).toContain("```go");
  });

  it("windows a long fence and keeps earlier windows stable as it grows", () => {
    const before = codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET + 1);
    const after = codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET * 2 + 3);
    const first = splitAssistantTranscriptSlices(before);
    const grown = splitAssistantTranscriptSlices(after);
    expect(sliceKinds(first!)).toEqual([
      `code:start:${ANDROID_TRANSCRIPT_CODE_LINE_BUDGET}`,
      "code:end:1",
    ]);
    expect(sliceKinds(grown!)).toEqual([
      `code:start:${ANDROID_TRANSCRIPT_CODE_LINE_BUDGET}`,
      `code:middle:${ANDROID_TRANSCRIPT_CODE_LINE_BUDGET}`,
      "code:end:3",
    ]);
    const grownHead = grown![0]!;
    const firstHead = first![0]!;
    const grownNext = grown![1]!;
    const firstNext = first![1]!;
    expect(grownHead).toMatchObject({
      key: firstHead.key,
      text: firstHead.text,
    });
    expect(grownNext.key).toBe(firstNext.key);
    expect(grownHead.kind === "code" && grownHead.text.startsWith("line 1")).toBe(true);
    expect(grownHead.kind === "code" && grownHead.text.includes("line 17")).toBe(false);
    expect(assistantSliceMarkdown(grown![0]!)).toBeNull();
    expect(
      grown!.every(
        (slice) =>
          slice.kind !== "code" ||
          slice.fullCode.split("\n").length === ANDROID_TRANSCRIPT_CODE_LINE_BUDGET * 2 + 3,
      ),
    ).toBe(true);
  });

  it("treats an unclosed streaming fence as code and does not renumber finished windows", () => {
    const opened = `Intro.\n\n\`\`\`ts\n${Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")}`;
    const longer = `${opened}\n${Array.from({ length: 12 }, (_, index) => `line ${index + 11}`).join("\n")}`;
    const before = splitAssistantTranscriptSlices(opened);
    const after = splitAssistantTranscriptSlices(longer);
    expect(before).toBeNull();
    const intro = after![0]!;
    const codeHead = after![1]!;
    expect(intro).toMatchObject({ kind: "markdown", text: "Intro." });
    expect(codeHead).toMatchObject({ kind: "code", codePart: "start" });
    expect(codeHead.kind === "code" && codeHead.text.split("\n")).toHaveLength(
      ANDROID_TRANSCRIPT_CODE_LINE_BUDGET,
    );
  });

  it("keeps a GFM table intact when the surrounding message is split", () => {
    const cell = "c".repeat(80);
    const row = `| ${cell} | ${cell} |`;
    const table = [row, "| --- | --- |", row, row].join("\n");
    const slices = splitAssistantTranscriptSlices(`${table}\n\n${"word ".repeat(200).trim()}`);
    const tableSlices = slices!.filter((slice) => slice.text.includes("| --- |"));
    expect(tableSlices).toHaveLength(1);
    expect(tableSlices[0]!.text).toBe(table);
  });

  it("ignores a four-space indented fence and still splits long prose", () => {
    const indented = `    \`\`\`\n${"x".repeat(ANDROID_TRANSCRIPT_MARKDOWN_CHAR_BUDGET + 40)}`;
    const slices = splitAssistantTranscriptSlices(indented);
    expect(slices!.every((slice) => slice.kind === "markdown")).toBe(true);
  });
});

describe("expandAndroidAssistantTranscriptRows", () => {
  it("returns the same array off Android and for rows that are already small", () => {
    const feed = [
      message("user-1", "user", "hello"),
      { type: "thinking" as const, id: "thinking" },
      assistantMessage("short", `ok\n\n${codeFence("ts", 2)}`),
    ];
    expect(expandAndroidAssistantTranscriptRows(feed, "ios")).toBe(feed);
    expect(expandAndroidAssistantTranscriptRows(feed, "android")).toBe(feed);
  });

  it("keeps the message id on the first slice and appends the rest", () => {
    const fence = codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET + 2);
    const feed = [
      message("user-1", "user", "ship it"),
      { type: "work-toggle" as const, id: "work-1" },
      assistantMessage("assistant-1", fence),
    ];
    const rows = expandAndroidAssistantTranscriptRows(feed, "android");
    expect(rows.map((row) => row.type)).toEqual([
      "message",
      "work-toggle",
      "assistant-slice",
      "assistant-slice",
    ]);
    expect(rows[0]).toBe(feed[0]);
    expect(rows[1]).toBe(feed[1]);
    const head = rows[2];
    const tail = rows[3];
    if (head?.type !== "assistant-slice" || tail?.type !== "assistant-slice") {
      throw new Error("expected assistant slices");
    }
    expect(head.id).toBe("assistant-1");
    expect(head.isFirst).toBe(true);
    expect(head.isLast).toBe(false);
    expect(tail.id).toBe(`assistant-1:${tail.slice.key}`);
    expect(tail.isLast).toBe(true);
    expect(tail.source).toBe(feed[2]);
    expect(androidTranscriptItemType(head)).toBe("assistant-code-head");
    expect(androidTranscriptItemType(tail)).toBe("assistant-code-body");
    expect(androidTranscriptItemType(feed[0]!)).toBeNull();
  });

  it("keeps earlier slice ids when the settled message later grows at the end", () => {
    const before = expandAndroidAssistantTranscriptRows(
      [assistantMessage("assistant-1", codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET + 1))],
      "android",
    );
    const after = expandAndroidAssistantTranscriptRows(
      [assistantMessage("assistant-1", codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET + 4))],
      "android",
    );
    expect(before.map((row) => row.id)).toEqual([after[0]!.id, after[1]!.id]);
    expect(after).toHaveLength(2);
  });
});

describe("assistant slice presentation", () => {
  it("closes a fence that contains backticks and leaves plain windows without markdown", () => {
    const fenced = fencedCodeMarkdown("ts", "const tick = ```;");
    expect(fenced.startsWith("````")).toBe(true);
    expect(fenced).toContain("const tick = ```;");
    expect(fenced.trimEnd().endsWith("````")).toBe(true);
  });

  it("does not gap code windows that belong to the same fence", () => {
    const slices = splitAssistantTranscriptSlices(
      codeFence("ts", ANDROID_TRANSCRIPT_CODE_LINE_BUDGET * 2 + 1),
    )!;
    expect(assistantSliceGap(slices[0]!, false)).toBe(0);
    expect(assistantSliceGap(slices[1]!, false)).toBe(0);
    expect(assistantSliceGap(slices[2]!, true)).toBe(0);
    const prose = splitAssistantTranscriptSlices(
      `${"word ".repeat(200).trim()}\n\n${"word ".repeat(200).trim()}`,
    )!;
    expect(assistantSliceGap(prose[0]!, false)).toBe(ANDROID_TRANSCRIPT_SLICE_GAP);
    expect(assistantSliceGap(prose[0]!, true)).toBe(0);
  });
});
