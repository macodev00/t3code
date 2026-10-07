import { describe, expect, it } from "vite-plus/test";

import {
  collapseLexicalDotSegments,
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  isTerminalUrl,
  resolvePathLinkTarget,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("classifies uppercase schemes as URLs at activation time too", () => {
    expect(isTerminalUrl("HTTPS://example.com/docs")).toBe(true);
    expect(isTerminalUrl("Http://example.com")).toBe(true);
    expect(isTerminalUrl("src/components/main.ts")).toBe(false);
    expect(isTerminalUrl("httpsdocs/readme.md")).toBe(false);
  });

  it("finds URLs regardless of scheme casing", () => {
    expect(extractTerminalLinks("open HTTPS://example.com/docs")).toEqual([
      {
        kind: "url",
        text: "HTTPS://example.com/docs",
        start: 5,
        end: 29,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });

  it("keeps a trailing colon on URLs", () => {
    expect(extractTerminalLinks("GET https://example.test/items/foo:")).toEqual([
      { kind: "url", text: "https://example.test/items/foo:", start: 4, end: 35 },
    ]);
  });

  it.each([
    ["./main.go:10:5: undefined: x", "./main.go:10:5"],
    ["/home/dev/app/src/main.c:10:5: error: expected ';'", "/home/dev/app/src/main.c:10:5"],
    ["C:\\dev\\app\\src\\main.c:10:5: error: expected ';'", "C:\\dev\\app\\src\\main.c:10:5"],
    ["wrote ./out/report.txt:", "./out/report.txt"],
  ])("drops the colon that ends a compiler diagnostic location in %s", (line, text) => {
    const start = line.indexOf(text);
    expect(extractTerminalLinks(line)).toEqual([
      { kind: "path", text, start, end: start + text.length },
    ]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it("keeps the line and column of a compiler diagnostic", () => {
    const [link] = extractTerminalLinks("/Users/julius/project/main.c:10:5: error: expected ';'");
    expect(resolvePathLinkTarget(link?.text ?? "", "/Users/julius/project")).toBe(
      "/Users/julius/project/main.c:10:5",
    );
  });
});

describe("collapseLexicalDotSegments", () => {
  it("collapses a parent link that leaves the workspace", () => {
    expect(collapseLexicalDotSegments("/home/me/project/../other/notes.md")).toBe(
      "/home/me/other/notes.md",
    );
  });

  it("collapses an in-workspace parent segment", () => {
    expect(collapseLexicalDotSegments("/home/me/project/docs/guide/../readme.md")).toBe(
      "/home/me/project/docs/readme.md",
    );
    expect(collapseLexicalDotSegments("/home/me/project/docs/./readme.md")).toBe(
      "/home/me/project/docs/readme.md",
    );
  });

  it("keeps a line and column suffix while collapsing the path", () => {
    expect(collapseLexicalDotSegments("/home/me/project/../other/notes.md:12:3")).toBe(
      "/home/me/other/notes.md:12:3",
    );
    expect(collapseLexicalDotSegments("/home/me/project/docs/guide/../readme.md:4")).toBe(
      "/home/me/project/docs/readme.md:4",
    );
  });

  it("keeps a forward-slash UNC share when collapsing parent segments", () => {
    expect(collapseLexicalDotSegments("//server/share/dir/../file.md")).toBe(
      "//server/share/file.md",
    );
    expect(collapseLexicalDotSegments("//server/share/../file.md")).toBe("//server/share/file.md");
    expect(collapseLexicalDotSegments("//server/share/dir/../../file.md")).toBe(
      "//server/share/file.md",
    );
    expect(collapseLexicalDotSegments("//server/share/dir/../file.md:12:3")).toBe(
      "//server/share/file.md:12:3",
    );
  });

  it("keeps a backslash UNC share when collapsing parent segments", () => {
    expect(collapseLexicalDotSegments("\\\\server\\share\\dir\\..\\file.md")).toBe(
      "\\\\server\\share\\file.md",
    );
    expect(collapseLexicalDotSegments("\\\\server\\share\\..\\file.md")).toBe(
      "\\\\server\\share\\file.md",
    );
    expect(collapseLexicalDotSegments("\\\\server\\share\\dir\\..\\..\\file.md")).toBe(
      "\\\\server\\share\\file.md",
    );
  });

  it("does not climb above a POSIX root or a Windows drive root", () => {
    expect(collapseLexicalDotSegments("/../file.md")).toBe("/file.md");
    expect(collapseLexicalDotSegments("/../../file.md")).toBe("/file.md");
    expect(collapseLexicalDotSegments("C:\\foo\\..\\..\\bar.md")).toBe("C:\\bar.md");
    expect(collapseLexicalDotSegments("C:/foo/../../bar.md")).toBe("C:/bar.md");
    expect(collapseLexicalDotSegments("C:\\..\\bar.md")).toBe("C:\\bar.md");
    expect(collapseLexicalDotSegments("C:/../bar.md")).toBe("C:/bar.md");
  });

  it("leaves an incomplete UNC path unchanged", () => {
    expect(collapseLexicalDotSegments("//server/../file.md")).toBe("//server/../file.md");
    expect(collapseLexicalDotSegments("\\\\server\\..\\file.md")).toBe("\\\\server\\..\\file.md");
  });

  it("preserves separators on a path with no dot segment", () => {
    expect(collapseLexicalDotSegments("/tmp/favicons/")).toBe("/tmp/favicons/");
    expect(collapseLexicalDotSegments("//server/share/file.md")).toBe("//server/share/file.md");
    expect(collapseLexicalDotSegments("\\\\server\\share\\file.md")).toBe(
      "\\\\server\\share\\file.md",
    );
    expect(collapseLexicalDotSegments("C:/foo/bar.md:12")).toBe("C:/foo/bar.md:12");
    expect(collapseLexicalDotSegments("C:\\foo\\bar\\")).toBe("C:\\foo\\bar\\");
    expect(collapseLexicalDotSegments("docs/my.file/readme.md")).toBe("docs/my.file/readme.md");
  });

  it("preserves a trailing separator after collapsing", () => {
    expect(collapseLexicalDotSegments("/proj/docs/guide/../")).toBe("/proj/docs/");
    expect(collapseLexicalDotSegments("C:\\foo\\..\\")).toBe("C:\\");
    expect(collapseLexicalDotSegments("//server/share/dir/../")).toBe("//server/share/");
    expect(collapseLexicalDotSegments("\\\\server\\share\\dir\\..\\")).toBe("\\\\server\\share\\");
    expect(collapseLexicalDotSegments("docs/guide/../")).toBe("docs/");
    expect(collapseLexicalDotSegments("foo/../")).toBe("./");
  });

  it("collapses a home-relative path without climbing above ~", () => {
    expect(collapseLexicalDotSegments("~/other/../notes.md:4")).toBe("~/notes.md:4");
    expect(collapseLexicalDotSegments("~\\other\\..\\notes.md")).toBe("~\\notes.md");
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });
});
