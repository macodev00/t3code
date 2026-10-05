import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeCodexMcpStartupGate } from "./CodexMcpCatalog.ts";

type StartupStatus = "starting" | "ready" | "failed" | "cancelled";

/** Record one startup phase on a gate under test. */
const note = (
  gate: Effect.Success<ReturnType<typeof makeCodexMcpStartupGate>>,
  threadId: string | null,
  name: string,
  status: StartupStatus,
) => gate.note({ threadId, name, status });

describe("Codex MCP catalog startup", () => {
  it.effect("holds the turn while any server in a partial catalog is still starting", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      yield* note(gate, "thread-1", "alpha", "ready");
      yield* note(gate, "thread-1", "beta", "starting");

      assert.equal(yield* gate.wait("thread-2"), "idle");

      const fiber = yield* gate.wait("thread-1").pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(fiber.pollUnsafe(), undefined);

      yield* note(gate, "thread-1", "beta", "ready");
      assert.equal(yield* Fiber.join(fiber), "settled");
    }),
  );

  it.effect("keeps waiting through a spurious cancelled status until ready", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      yield* note(gate, "thread-1", "alpha", "ready");
      yield* note(gate, "thread-1", "beta", "cancelled");

      const fiber = yield* gate.wait("thread-1").pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(fiber.pollUnsafe(), undefined);

      yield* note(gate, "thread-1", "beta", "ready");
      assert.equal(yield* Fiber.join(fiber), "settled");

      yield* note(gate, "thread-1", "beta", "cancelled");
      assert.equal(yield* gate.wait("thread-1"), "settled");
    }),
  );

  it.effect("does not delay a turn when no MCP server has reported startup", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      assert.equal(yield* gate.wait("thread-1"), "idle");
    }),
  );

  it.effect("treats a failed server as settled alongside servers that are ready", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      yield* note(gate, "thread-1", "alpha", "ready");
      yield* note(gate, "thread-1", "broken", "failed");
      assert.equal(yield* gate.wait("thread-1"), "settled");
    }),
  );

  it.effect("a timed-out threadless startup does not mask a later global notification", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      yield* note(gate, null, "shared", "starting");

      const timedOut = yield* gate
        .wait("thread-1")
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(timedOut.pollUnsafe(), undefined);
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Fiber.join(timedOut), "timedOut");

      assert.equal(yield* gate.wait("thread-1"), "settled");
      const otherThread = yield* gate
        .wait("thread-2")
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(otherThread.pollUnsafe(), undefined);

      yield* note(gate, null, "shared", "ready");
      assert.equal(yield* Fiber.join(otherThread), "settled");
      assert.equal(yield* gate.wait("thread-1"), "settled");

      yield* note(gate, null, "shared", "starting");
      const again = yield* gate.wait("thread-1").pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(again.pollUnsafe(), undefined);
      yield* note(gate, null, "shared", "ready");
      assert.equal(yield* Fiber.join(again), "settled");
    }),
  );

  it.effect("clears a timeout skip without replacing an ordinary thread-specific status", () =>
    Effect.gen(function* () {
      const gate = yield* makeCodexMcpStartupGate();
      yield* note(gate, "thread-1", "local", "failed");
      yield* note(gate, null, "local", "starting");
      yield* note(gate, null, "shared", "starting");

      const timedOut = yield* gate
        .wait("thread-1")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Fiber.join(timedOut), "timedOut");

      yield* note(gate, null, "local", "starting");
      assert.equal(yield* gate.wait("thread-1"), "settled");

      yield* note(gate, null, "shared", "starting");
      const blocked = yield* gate
        .wait("thread-1")
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(blocked.pollUnsafe(), undefined);
      yield* note(gate, null, "shared", "ready");
      assert.equal(yield* Fiber.join(blocked), "settled");

      yield* note(gate, "thread-1", "local", "ready");
      yield* note(gate, null, "local", "cancelled");
      assert.equal(yield* gate.wait("thread-1"), "settled");
    }),
  );
});
