import { describe, expect, it } from "@effect/vitest";

import { upstreamStatusAttentionMessage } from "./gitActions.ts";

describe("upstreamStatusAttentionMessage", () => {
  it("stays quiet while background refresh is still running", () => {
    expect(upstreamStatusAttentionMessage(null)).toBeNull();
    expect(upstreamStatusAttentionMessage(undefined)).toBeNull();
    expect(upstreamStatusAttentionMessage({})).toBeNull();
    expect(upstreamStatusAttentionMessage({ upstreamNeedsAttention: false })).toBeNull();
  });

  it("tells the user to pull once upstream status needs attention", () => {
    expect(upstreamStatusAttentionMessage({ upstreamNeedsAttention: true })).toBe(
      "Upstream status needs attention. Pull to refresh it.",
    );
  });
});
