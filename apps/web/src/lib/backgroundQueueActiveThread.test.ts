import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { activeQueueThreadKey } from "./backgroundQueueActiveThread";

describe("activeQueueThreadKey", () => {
  it("uses the promoted server thread while the route is still a draft", () => {
    const promotedTo = scopeThreadRef("env-2" as never, ThreadId.make("server-thread"));

    expect(
      activeQueueThreadKey(resolveThreadRouteTarget({ draftId: DraftId.make("draft-1") }), {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo,
      }),
    ).toBe("env-2:server-thread");
  });

  it("leaves an unpromoted draft to the chat view", () => {
    expect(
      activeQueueThreadKey(resolveThreadRouteTarget({ draftId: DraftId.make("draft-1") }), {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });
});
