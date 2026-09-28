import { describe, expect, it } from "vite-plus/test";

import { offersUpstreamAttentionPull, upstreamStatusAttentionMessage } from "./gitActions.ts";

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

describe("offersUpstreamAttentionPull", () => {
  it("offers pull when refresh has stopped and the cached branch is not behind", () => {
    expect(
      offersUpstreamAttentionPull({
        upstreamNeedsAttention: true,
        hasUpstream: true,
        behindCount: 0,
      }),
    ).toBe(true);
  });

  it("leaves pull to the existing behind action", () => {
    expect(
      offersUpstreamAttentionPull({
        upstreamNeedsAttention: true,
        hasUpstream: true,
        behindCount: 2,
      }),
    ).toBe(false);
    expect(
      offersUpstreamAttentionPull({
        upstreamNeedsAttention: false,
        hasUpstream: true,
        behindCount: 0,
      }),
    ).toBe(false);
    expect(offersUpstreamAttentionPull(null)).toBe(false);
  });
});
