import { describe, expect, it } from "vite-plus/test";

import {
  normalizeAntigravityReleaseArch,
  resolveAntigravityReleaseAsset,
} from "./antigravityRelease.ts";

describe("antigravityRelease", () => {
  it("maps Linux aarch64 onto the published linux-arm64 runtime", () => {
    expect(normalizeAntigravityReleaseArch("aarch64")).toBe("arm64");
    expect(resolveAntigravityReleaseAsset("linux", "aarch64")).toEqual(
      resolveAntigravityReleaseAsset("linux", "arm64"),
    );
    expect(resolveAntigravityReleaseAsset("linux", "aarch64")?.url).toContain("linux-arm64");
  });

  it("keeps Node architecture names unchanged", () => {
    expect(normalizeAntigravityReleaseArch("arm64")).toBe("arm64");
    expect(normalizeAntigravityReleaseArch("x64")).toBe("x64");
    expect(resolveAntigravityReleaseAsset("linux", "x86_64")).toEqual(
      resolveAntigravityReleaseAsset("linux", "x64"),
    );
  });
});
