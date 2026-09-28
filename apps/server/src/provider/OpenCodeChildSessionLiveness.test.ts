import { describe, expect, it, beforeEach } from "vite-plus/test";

import {
  clearOpenCodeChildSession,
  clearOpenCodeThreadChildSessions,
  hasLiveOpenCodeChildSessions,
  noteOpenCodeChildSessionLiveness,
  openCodeChildSessionLivenessStatus,
  openCodeInactivityHeldByChildSession,
  resetOpenCodeChildSessionLiveness,
} from "./OpenCodeChildSessionLiveness.ts";

describe("OpenCodeChildSessionLiveness", () => {
  beforeEach(() => {
    resetOpenCodeChildSessionLiveness();
  });

  it("maps busy and retry onto running, and idle onto a release", () => {
    expect(openCodeChildSessionLivenessStatus("busy")).toBe("running");
    expect(openCodeChildSessionLivenessStatus("retry")).toBe("running");
    expect(openCodeChildSessionLivenessStatus("idle")).toBe("idle");
    expect(openCodeChildSessionLivenessStatus("paused")).toBeUndefined();
  });

  it("holds a thread while any related child is running", () => {
    noteOpenCodeChildSessionLiveness("thread-a", "ses_a", "running");
    noteOpenCodeChildSessionLiveness("thread-a", "ses_a", "running");
    noteOpenCodeChildSessionLiveness("thread-a", "ses_b", "running");
    noteOpenCodeChildSessionLiveness("thread-b", "ses_other", "running");

    expect(hasLiveOpenCodeChildSessions("thread-a")).toBe(true);
    expect(openCodeInactivityHeldByChildSession("opencode", "thread-a")).toBe(true);
    expect(openCodeInactivityHeldByChildSession("claudeAgent", "thread-a")).toBe(false);
    expect(openCodeInactivityHeldByChildSession("opencode", "thread-missing")).toBe(false);

    noteOpenCodeChildSessionLiveness("thread-a", "ses_a", "idle");
    clearOpenCodeChildSession("thread-a", "ses_missing");
    expect(hasLiveOpenCodeChildSessions("thread-a")).toBe(true);
    expect(hasLiveOpenCodeChildSessions("thread-b")).toBe(true);

    noteOpenCodeChildSessionLiveness("thread-a", "ses_b", "idle");
    expect(hasLiveOpenCodeChildSessions("thread-a")).toBe(false);
    expect(openCodeInactivityHeldByChildSession("opencode", "thread-a")).toBe(false);

    clearOpenCodeThreadChildSessions("thread-b");
    expect(hasLiveOpenCodeChildSessions("thread-b")).toBe(false);
  });

  it("ignores an idle release for a child that was never held", () => {
    noteOpenCodeChildSessionLiveness("thread-a", "ses_missing", "idle");
    clearOpenCodeChildSession("thread-a", "ses_missing");
    expect(hasLiveOpenCodeChildSessions("thread-a")).toBe(false);
  });
});
