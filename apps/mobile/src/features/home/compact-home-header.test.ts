import { describe, expect, it } from "vite-plus/test";

import { compactHomeNativeHeaderShown } from "./compact-home-header";

describe("compact home native header", () => {
  it("stays hidden on Android when width-driven options are shallow-merged", () => {
    // Static Home options start with the native header shown. The in-flow
    // toolbar hides it once; that hide is not reapplied when only the window
    // width changes, so the reapplied compact options have to keep it hidden.
    const afterToolbarHide = { headerShown: false };
    const afterWidthChange = {
      ...afterToolbarHide,
      headerShown: compactHomeNativeHeaderShown("android"),
    };

    expect(afterWidthChange.headerShown).toBe(false);
  });

  it("restores the native header on iOS after leaving split layout", () => {
    const afterSplit = { headerShown: true };
    const afterCompact = {
      ...afterSplit,
      headerShown: compactHomeNativeHeaderShown("ios"),
    };

    expect(afterCompact.headerShown).toBe(true);
  });
});
