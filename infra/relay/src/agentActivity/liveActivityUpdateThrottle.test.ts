import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";

import { shouldUpdateLiveActivity } from "./liveActivityUpdateThrottle.ts";

// Distinct pairs that encode to the same `environmentId + "\0" + threadId` string.
const left = {
  environmentId: EnvironmentId.make("a"),
  threadId: ThreadId.make("b\0c"),
};
const right = {
  environmentId: EnvironmentId.make("a\0b"),
  threadId: ThreadId.make("c"),
};

function ambiguousKey(environmentId: string, threadId: string): string {
  return `${environmentId}\0${threadId}`;
}

function activity(
  identity: typeof left,
  phase: RelayAgentActivityAggregateRow["phase"],
): RelayAgentActivityAggregateRow {
  return {
    environmentId: identity.environmentId,
    threadId: identity.threadId,
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "Model",
    phase,
    status: "Working",
    updatedAt: "1970-01-01T00:00:00.000Z",
    deepLink: "/",
  };
}

function aggregate(
  activities: ReadonlyArray<RelayAgentActivityAggregateRow>,
  updatedAt = "1970-01-01T00:00:04.000Z",
): RelayAgentActivityAggregateState {
  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activities.length,
    updatedAt,
    activities,
  };
}

const insideThrottle = {
  lastDeliveryAt: "1970-01-01T00:00:04.000Z",
  nowMs: 5_000,
} as const;

describe("live activity row keys", () => {
  it("treats waiting threads that collide under NUL concatenation as different", () => {
    expect(ambiguousKey(left.environmentId, left.threadId)).toBe(
      ambiguousKey(right.environmentId, right.threadId),
    );

    expect(
      shouldUpdateLiveActivity({
        previousAggregate: aggregate(
          [activity(left, "waiting_for_input")],
          "1970-01-01T00:00:00.000Z",
        ),
        nextAggregate: aggregate([activity(right, "waiting_for_input")]),
        ...insideThrottle,
      }),
    ).toBe(true);
  });

  it("sees a phase change when another row collides under NUL concatenation", () => {
    expect(ambiguousKey(left.environmentId, left.threadId)).toBe(
      ambiguousKey(right.environmentId, right.threadId),
    );

    expect(
      shouldUpdateLiveActivity({
        previousAggregate: aggregate(
          [activity(left, "starting"), activity(right, "running")],
          "1970-01-01T00:00:00.000Z",
        ),
        nextAggregate: aggregate([
          { ...activity(left, "running"), updatedAt: "1970-01-01T00:00:04.000Z" },
          activity(right, "running"),
        ]),
        ...insideThrottle,
      }),
    ).toBe(true);
  });
});
