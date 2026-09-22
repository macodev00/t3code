import { describe, expect, it } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";

describe("threadNotificationTag", () => {
  it("stays under the Windows renderer tag limit for production UUID pairs", () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    const threadId = "22222222-2222-4222-8222-222222222222";
    expect(`${environmentId}:${threadId}`).toHaveLength(73);
    const tag = threadNotificationTag(environmentId, threadId);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tag.length).toBeLessThanOrEqual(32);
    expect(tag).toBe(threadNotificationTag(environmentId, threadId));
  });

  it("keeps environment and thread uniqueness", () => {
    const sameThread = threadNotificationTag("env-1", "thread-1");
    expect(sameThread).not.toBe(threadNotificationTag("env-2", "thread-1"));
    expect(sameThread).not.toBe(threadNotificationTag("env-1", "thread-2"));
  });
});
