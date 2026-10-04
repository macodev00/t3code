import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import {
  codexMcpCatalogSnapshot,
  codexMcpStartupStatusesForThread,
  noteCodexMcpStartup,
  reduceCodexMcpStartupStatus,
  waitForCodexMcpCatalogBeforeTurn,
  type CodexMcpStartupCatalog,
} from "./CodexMcpCatalog.ts";

const emptyCatalog: CodexMcpStartupCatalog = new Map();

/** Record one startup phase in a catalog under test. */
function note(
  catalog: CodexMcpStartupCatalog,
  threadId: string | null,
  name: string,
  status: "starting" | "ready" | "failed" | "cancelled",
) {
  return noteCodexMcpStartup(catalog, { threadId, name, status });
}

describe("Codex MCP catalog startup", () => {
  it("lets a later ready replace a spurious cancelled status", () => {
    const cancelled = reduceCodexMcpStartupStatus(new Map(), {
      name: "slow",
      status: "cancelled",
    });
    const ready = reduceCodexMcpStartupStatus(cancelled, { name: "slow", status: "ready" });
    assert.equal(ready.get("slow"), "ready");

    const afterReady = reduceCodexMcpStartupStatus(ready, { name: "slow", status: "cancelled" });
    assert.equal(afterReady.get("slow"), "ready");
    assert.equal(codexMcpCatalogSnapshot(afterReady), "settled");
  });

  it("keeps a partial catalog pending while any server is still starting", () => {
    const catalog = note(
      note(emptyCatalog, "thread-1", "alpha", "ready"),
      "thread-1",
      "beta",
      "starting",
    );
    assert.equal(
      codexMcpCatalogSnapshot(codexMcpStartupStatusesForThread(catalog, "thread-1")),
      "pending",
    );
    assert.equal(
      codexMcpCatalogSnapshot(codexMcpStartupStatusesForThread(catalog, "thread-2")),
      "idle",
    );
  });

  it.effect("does not delay a turn when no MCP server has reported startup", () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make<CodexMcpStartupCatalog>(emptyCatalog);
      const outcome = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
      });
      assert.equal(outcome, "idle");
    }),
  );

  it.effect("holds the turn until a slower MCP server leaves starting", () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make(
        note(note(emptyCatalog, "thread-1", "alpha", "ready"), "thread-1", "beta", "starting"),
      );
      let turnStarted = false;
      const fiber = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
        timeout: "30 seconds",
        pollInterval: "50 millis",
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            turnStarted = true;
          }),
        ),
        Effect.forkChild,
      );

      yield* TestClock.adjust("2 seconds");
      assert.equal(turnStarted, false);
      assert.equal(fiber.pollUnsafe(), undefined);

      yield* Ref.update(catalog, (current) => note(current, "thread-1", "beta", "ready"));
      yield* TestClock.adjust("50 millis");
      assert.equal(yield* Fiber.join(fiber), "settled");
      assert.equal(turnStarted, true);
    }),
  );

  it.effect("keeps waiting through a spurious cancelled status until ready", () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make(
        note(note(emptyCatalog, "thread-1", "alpha", "ready"), "thread-1", "beta", "cancelled"),
      );
      const fiber = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
        timeout: "30 seconds",
        pollInterval: "50 millis",
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      assert.equal(fiber.pollUnsafe(), undefined);

      yield* Ref.update(catalog, (current) => note(current, "thread-1", "beta", "ready"));
      yield* TestClock.adjust("50 millis");
      assert.equal(yield* Fiber.join(fiber), "settled");
    }),
  );

  it.effect("starts the turn when a server stays starting through the timeout", () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make(note(emptyCatalog, "thread-1", "hung", "starting"));
      const fiber = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
        timeout: "200 millis",
        pollInterval: "50 millis",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("100 millis");
      assert.equal(fiber.pollUnsafe(), undefined);
      yield* TestClock.adjust("100 millis");
      assert.equal(yield* Fiber.join(fiber), "timedOut");

      const again = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
        timeout: "200 millis",
        pollInterval: "50 millis",
      });
      assert.equal(again, "settled");
      assert.equal(
        codexMcpStartupStatusesForThread(yield* Ref.get(catalog), "thread-1").get("hung"),
        "unavailable",
      );
    }),
  );

  it.effect("applies a threadless startup update to the turn's thread", () =>
    Effect.gen(function* () {
      const catalog = yield* Ref.make(note(emptyCatalog, null, "shared", "starting"));
      const fiber = yield* waitForCodexMcpCatalogBeforeTurn({
        catalog,
        threadId: "thread-1",
        timeout: "5 seconds",
        pollInterval: "50 millis",
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("100 millis");
      assert.equal(fiber.pollUnsafe(), undefined);

      yield* Ref.update(catalog, (current) => note(current, null, "shared", "ready"));
      yield* TestClock.adjust("50 millis");
      assert.equal(yield* Fiber.join(fiber), "settled");
    }),
  );

  it("treats a failed server as settled alongside servers that are ready", () => {
    const catalog = note(
      note(emptyCatalog, "thread-1", "alpha", "ready"),
      "thread-1",
      "broken",
      "failed",
    );
    assert.equal(
      codexMcpCatalogSnapshot(codexMcpStartupStatusesForThread(catalog, "thread-1")),
      "settled",
    );
  });
});
