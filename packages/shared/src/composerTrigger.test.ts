import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  rememberComposerPathSearch,
  serializeComposerFileLink,
  type ComposerPathSearch,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it("keeps an open @ search across spaces without rediscovering one from prose", () => {
    let search: ComposerPathSearch | null = null;
    let trigger: ReturnType<typeof detectComposerTrigger> = null;
    for (const text of ["@Foreign", "@Foreign ", "@Foreign Subsidiaries"]) {
      trigger = detectComposerTrigger(text, text.length, undefined, search);
      search = rememberComposerPathSearch(text, trigger, search);
    }
    expect(trigger?.query).toBe("Foreign Subsidiaries");

    const full = "@Foreign Subsidiaries";
    const moved = detectComposerTrigger(full, "@Foreign ".length, undefined, search);
    search = rememberComposerPathSearch(full, moved, search);
    expect(detectComposerTrigger(full, full.length, undefined, search)?.query).toBe(full.slice(1));
    expect(detectComposerTrigger("See @README and explain", 23)).toBeNull();
    expect(detectComposerTrigger("@Foreign\nNext", 13, undefined, search)).toBeNull();
    expect(detectComposerTrigger("@Foreign @src", 13, undefined, search)?.query).toBe("src");
    expect(detectComposerTrigger("$review notes", 13)).toBeNull();
    expect(detectComposerTrigger("#12 notes", 9)).toBeNull();
  });

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
