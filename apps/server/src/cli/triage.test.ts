// @effect-diagnostics nodeBuiltinImport:off - the probe test stands up a local HTTP server.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
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
  capabilities: { repositoryIdentity: true },
};

const stateFor = (origin: string, pid: number): PersistedServerRuntimeState => ({
  version: 1,
  pid,
  port: Number(new URL(origin).port),
  origin,
  startedAt: "2026-09-24T00:08:56.777Z",
});

const withServer = <A, E, R>(
  statusCode: number,
  body: string,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("triage version", () => {
  it("formats a prerelease tag with the clone-main caveat", () => {
    assert.equal(
      triageReleaseTag(nightly),
      `v${nightly} (prerelease build; if this tag does not exist, clone main)`,
    );
    assert.equal(triageReleaseTag("0.0.42"), "v0.0.42");
  });

  it.effect("reads serverVersion from the live server, not the triage CLI", () =>
    withServer(200, JSON.stringify(descriptor), (origin) =>
      Effect.gen(function* () {
        const probed = yield* readLocalServerVersion(Option.some(stateFor(origin, process.pid)));
        assert.deepEqual(probed, { status: "probed", version: nightly });
      }),
    ),
  );

  it.effect("does not probe a dead pid", () =>
    Effect.gen(function* () {
      const probed = yield* readLocalServerVersion(
        Option.some(stateFor("http://127.0.0.1:9", 2_147_483_646)),
      );
      assert.deepEqual(probed, { status: "not-running" });
    }),
  );

  it.effect("reports unavailable when the live server is not a T3 environment", () =>
    withServer(200, JSON.stringify({ ok: true }), (origin) =>
      Effect.gen(function* () {
        const probed = yield* readLocalServerVersion(Option.some(stateFor(origin, process.pid)));
        assert.deepEqual(probed, { status: "unavailable" });
      }),
    ),
  );
});
