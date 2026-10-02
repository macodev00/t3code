import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it("detects a multi-word slash command and leaves /model arguments as model search", () => {
    expect(detectComposerTrigger("/goal clear", "/goal clear".length)).toEqual({
      kind: "slash-command",
      query: "goal clear",
      rangeStart: 0,
      rangeEnd: "/goal clear".length,
    });
    expect(detectComposerTrigger("/goal clear ", "/goal clear ".length)).toBeNull();
    expect(detectComposerTrigger("/model spark", "/model spark".length)).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: "/model spark".length,
    });
  });

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
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
