// @effect-diagnostics nodeBuiltinImport:off - the probe test stands up a local HTTP server.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { readLocalServerVersion, triageReleaseTag } from "./triage.ts";

const nightly = "0.0.43-nightly.20260923.2173";

const descriptor = {
  environmentId: "env_triage_test",
  label: "T3 Code",
  platform: { os: "linux", arch: "x64" },
  serverVersion: nightly,
  capabilities: {},
};

// Later than this process's start, so the pid still matches the recorded server.
const OWNED_STARTED_AT = "2099-01-01T00:00:00.000Z";

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

const withServer = <A, E, R>(
  respond: (response: NodeHttp.ServerResponse) => void,
  run: (origin: string, hits: { count: number }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const hits = { count: 0 };
    return yield* Effect.acquireUseRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((_request, response) => {
          hits.count += 1;
          respond(response);
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          return Effect.die(new Error("Expected a TCP address"));
        }
        return run(`http://127.0.0.1:${String(address.port)}`, hits);
      },
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
  });

describe("triage version", () => {
  it("formats a prerelease tag with the clone-main caveat", () => {
    assert.equal(
      triageReleaseTag(nightly),
      `v${nightly} (prerelease build; if this tag does not exist, clone main)`,
    );
    assert.equal(triageReleaseTag("0.0.42"), "v0.0.42");
  });

  it.effect("reads serverVersion from the live server, not the triage CLI", () =>
    withServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(descriptor));
      },
      (origin) =>
        Effect.gen(function* () {
          const probed = yield* readLocalServerVersion(Option.some(stateFor(origin, process.pid)));
          assert.deepEqual(probed, { status: "probed", version: nightly });
        }),
    ),
  );

  it.effect("does not probe a dead pid", () =>
    Effect.gen(function* () {
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:9", 2_147_483_646, "2026-09-24T00:08:56.777Z")),
      );
      assert.deepEqual(probed, { status: "not-running" });
    }),
  );

  it.effect("does not probe a reused pid that is not the recorded server", () =>
    withServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(descriptor));
      },
      (origin, hits) =>
        Effect.gen(function* () {
          const probed = yield* readLocalServerVersion(
            Option.some(stateFor(origin, process.pid, "2000-01-01T00:00:00.000Z")),
          );
          assert.deepEqual(probed, { status: "not-running" });
          assert.equal(hits.count, 0);
        }),
    ),
  );

  it.effect("reports unavailable when the origin is not a URL", () =>
    Effect.gen(function* () {
      const probed = yield* readLocalServerVersion(Option.some(stateFor("not a url", process.pid)));
      assert.deepEqual(probed, { status: "unavailable" });
    }),
  );

  it.effect("reports unavailable when the live server never finishes its body", () =>
    withServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
      },
      (origin) =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const probed = yield* readLocalServerVersion(
            Option.some(stateFor(origin, process.pid)),
            "200 millis",
          );
          assert.deepEqual(probed, { status: "unavailable" });
          assert.isBelow((yield* Clock.currentTimeMillis) - started, 2_000);
        }),
    ),
  );

  it.effect("reports unavailable when the live server is not a T3 environment", () =>
    withServer(
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
      (origin) =>
        Effect.gen(function* () {
          const probed = yield* readLocalServerVersion(Option.some(stateFor(origin, process.pid)));
          assert.deepEqual(probed, { status: "unavailable" });
        }),
    ),
  );
});
