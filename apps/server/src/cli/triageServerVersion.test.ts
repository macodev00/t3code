import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { readLocalServerVersion, triageReleaseTag } from "./triageServerVersion.ts";

const nightly = "0.0.43-nightly.20260923.2173";

const descriptor = {
  environmentId: "env_triage_test",
  label: "T3 Code",
  platform: { os: "linux", arch: "x64" },
  serverVersion: nightly,
  capabilities: {},
};

const OWNED_STARTED_AT = "2099-01-01T00:00:00.000Z";
const OWNED_PROCESS_START_MS = Date.parse(OWNED_STARTED_AT) - 1_000;

const stateFor = (
  origin: string,
  pid: number,
  startedAt = OWNED_STARTED_AT,
): PersistedServerRuntimeState => ({
  version: 1,
  pid,
  port: 1,
  origin,
  startedAt,
});

const ownedProbe = (readText: (url: string) => Effect.Effect<string, unknown>) => {
  const hits = { count: 0 };
  return {
    hits,
    probe: {
      isAlive: () => true,
      processStartedAtMs: () => OWNED_PROCESS_START_MS,
      readText: (url: string) => {
        hits.count += 1;
        return readText(url);
      },
    },
  };
};

describe("triage version", () => {
  it("formats a prerelease tag with the clone-main caveat", () => {
    assert.equal(
      triageReleaseTag(nightly),
      `v${nightly} (prerelease build; if this tag does not exist, clone main)`,
    );
    assert.equal(triageReleaseTag("0.0.42"), "v0.0.42");
  });

  it.effect("reads serverVersion from the descriptor body", () =>
    Effect.gen(function* () {
      const { probe } = ownedProbe(() => Effect.succeed(JSON.stringify(descriptor)));
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:3773", 42)),
        probe,
      );
      assert.deepEqual(probed, { status: "probed", version: nightly });
    }),
  );

  it.effect("does not probe a dead pid", () =>
    Effect.gen(function* () {
      const { hits, probe } = ownedProbe(() => Effect.die("should not probe"));
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:9", 2_147_483_646, "2026-09-24T00:08:56.777Z")),
        { ...probe, isAlive: () => false },
      );
      assert.deepEqual(probed, { status: "not-running" });
      assert.equal(hits.count, 0);
    }),
  );

  it.effect("does not probe a reused pid that is not the recorded server", () =>
    Effect.gen(function* () {
      const { hits, probe } = ownedProbe(() => Effect.die("should not probe"));
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:3773", 42, "2000-01-01T00:00:00.000Z")),
        {
          ...probe,
          processStartedAtMs: () => Date.parse("2026-09-24T00:08:56.777Z"),
        },
      );
      assert.deepEqual(probed, { status: "not-running" });
      assert.equal(hits.count, 0);
    }),
  );

  it.effect("does not probe when the process start time is unknown", () =>
    Effect.gen(function* () {
      const { hits, probe } = ownedProbe(() => Effect.die("should not probe"));
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:3773", 42)),
        { ...probe, processStartedAtMs: () => undefined },
      );
      assert.deepEqual(probed, { status: "not-running" });
      assert.equal(hits.count, 0);
    }),
  );

  it.effect("reports unavailable when the origin is not a URL", () =>
    Effect.gen(function* () {
      const { hits, probe } = ownedProbe(() => Effect.die("should not probe"));
      const probed = yield* readLocalServerVersion(Option.some(stateFor("not a url", 42)), probe);
      assert.deepEqual(probed, { status: "unavailable" });
      assert.equal(hits.count, 0);
    }),
  );

  it.effect("reports unavailable when the body never finishes", () =>
    Effect.gen(function* () {
      const { probe } = ownedProbe(() => Effect.never);
      const fiber = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:3773", 42)),
        probe,
        "200 millis",
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Fiber.join(fiber), { status: "unavailable" });
    }),
  );

  it.effect("reports unavailable when the body is not a T3 environment", () =>
    Effect.gen(function* () {
      const { probe } = ownedProbe(() => Effect.succeed(JSON.stringify({ ok: true })));
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:3773", 42)),
        probe,
      );
      assert.deepEqual(probed, { status: "unavailable" });
    }),
  );
});
