import * as NodeAssert from "node:assert/strict";
import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as OpenCodeChildSessionLiveness from "./OpenCodeChildSessionLiveness.ts";

const threadA = ThreadId.make("thread-opencode-child-a");
const threadB = ThreadId.make("thread-opencode-child-b");

const livenessLayer = OpenCodeChildSessionLiveness.layer;

describe("OpenCodeChildSessionLiveness", () => {
  it("maps busy and retry onto running, and idle onto a release", () => {
    NodeAssert.equal(
      OpenCodeChildSessionLiveness.openCodeChildSessionLivenessStatus("busy"),
      "running",
    );
    NodeAssert.equal(
      OpenCodeChildSessionLiveness.openCodeChildSessionLivenessStatus("retry"),
      "running",
    );
    NodeAssert.equal(
      OpenCodeChildSessionLiveness.openCodeChildSessionLivenessStatus("idle"),
      "idle",
    );
    NodeAssert.equal(
      OpenCodeChildSessionLiveness.openCodeChildSessionLivenessStatus("paused"),
      undefined,
    );
  });

  it.effect(
    "holds a thread while any related child is running and releases on idle or delete",
    () =>
      Effect.gen(function* () {
        const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
        yield* liveness.note(threadA, "ses_a", "running");
        yield* liveness.note(threadA, "ses_a", "running");
        yield* liveness.note(threadA, "ses_b", "running");
        yield* liveness.note(threadB, "ses_other", "running");

        NodeAssert.equal(yield* liveness.hasLive(threadA), true);
        NodeAssert.equal(yield* liveness.holdsInactivity("opencode", threadA), true);
        NodeAssert.equal(yield* liveness.holdsInactivity("claudeAgent", threadA), false);
        NodeAssert.equal(yield* liveness.holdsInactivity("codex", threadA), false);
        NodeAssert.equal(
          yield* liveness.holdsInactivity("opencode", ThreadId.make("thread-missing")),
          false,
        );

        yield* liveness.note(threadA, "ses_a", "idle");
        yield* liveness.clearChild(threadA, "ses_missing");
        NodeAssert.equal(yield* liveness.hasLive(threadA), true);
        NodeAssert.equal(yield* liveness.hasLive(threadB), true);

        yield* liveness.clearChild(threadA, "ses_b");
        NodeAssert.equal(yield* liveness.hasLive(threadA), false);
        NodeAssert.equal(yield* liveness.holdsInactivity("opencode", threadA), false);

        yield* liveness.clearThread(threadB);
        NodeAssert.equal(yield* liveness.hasLive(threadB), false);
      }).pipe(Effect.provide(livenessLayer)),
  );

  it.effect("ignores an idle release for a child that was never held", () =>
    Effect.gen(function* () {
      const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
      yield* liveness.note(threadA, "ses_missing", "idle");
      yield* liveness.clearChild(threadA, "ses_missing");
      NodeAssert.equal(yield* liveness.hasLive(threadA), false);
    }).pipe(Effect.provide(livenessLayer)),
  );

  it.effect("shares liveness inside one runtime and not across runtimes", () =>
    Effect.gen(function* () {
      const leftScope = yield* Scope.make("sequential");
      const rightScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(leftScope, Exit.void));
      yield* Effect.addFinalizer(() => Scope.close(rightScope, Exit.void));
      const left = yield* Layer.build(livenessLayer).pipe(Scope.provide(leftScope));
      const right = yield* Layer.build(livenessLayer).pipe(Scope.provide(rightScope));

      const hasLive = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
          return yield* liveness.hasLive(threadId);
        });

      yield* Effect.gen(function* () {
        const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
        yield* liveness.note(threadA, "ses_a", "running");
        const again = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
        NodeAssert.equal(yield* again.hasLive(threadA), true);
      }).pipe(Effect.provide(left));

      NodeAssert.equal(yield* hasLive(threadA).pipe(Effect.provide(left)), true);
      NodeAssert.equal(yield* hasLive(threadA).pipe(Effect.provide(right)), false);
      NodeAssert.equal(
        yield* Effect.gen(function* () {
          const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
          return yield* liveness.holdsInactivity("opencode", threadA);
        }).pipe(Effect.provide(right)),
        false,
      );

      yield* Effect.gen(function* () {
        const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
        yield* liveness.note(threadA, "ses_right", "running");
      }).pipe(Effect.provide(right));
      yield* Effect.gen(function* () {
        const liveness = yield* OpenCodeChildSessionLiveness.OpenCodeChildSessionLiveness;
        yield* liveness.clearThread(threadA);
      }).pipe(Effect.provide(left));

      NodeAssert.equal(yield* hasLive(threadA).pipe(Effect.provide(left)), false);
      NodeAssert.equal(yield* hasLive(threadA).pipe(Effect.provide(right)), true);
    }),
  );
});
