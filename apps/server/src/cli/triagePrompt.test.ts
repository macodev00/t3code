// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { readEnvironmentBody } from "./triage.ts";
import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PLAYBOOK,
} from "./triagePrompt.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Old releases fetch the repo copy from `main` and follow it when it differs
  // from their bundled playbook. The two must say the same thing at HEAD, or a
  // playbook edit silently changes behavior only for old (or only for new)
  // installs. Edit both files together.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("seed prompt names the context file and embeds the playbook", () => {
  const prompt = buildTriageSeedPrompt("/tmp/triage-run/context.md");
  assert.include(prompt, "/tmp/triage-run/context.md");
  assert.include(prompt, TRIAGE_PLAYBOOK);
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file carries every path the playbook depends on", () => {
  const context = buildTriageContext({
    generatedAt: "2026-08-13T00:00:00.000Z",
    cliVersion: "0.0.33",
    cliReleaseTag: "v0.0.33",
    localServerVersion: "0.0.43-nightly.20260923.2173",
    localServerReleaseTag:
      "v0.0.43-nightly.20260923.2173 (prerelease build; if this tag does not exist, clone main)",
    os: "linux x64 (7.0.0)",
    nodeVersion: "v24.0.0",
    launchedAs: "npx t3 triage",
    server: "running (pid 42, http://127.0.0.1:4501)",
    paths: {
      stateDir: "/home/u/.t3/userdata",
      dbPath: "/home/u/.t3/userdata/state.sqlite",
      settingsPath: "/home/u/.t3/userdata/settings.json",
      logsDir: "/home/u/.t3/userdata/logs",
      serverLogPath: "/home/u/.t3/userdata/logs/server.log",
      serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.t3/caches",
      secretsDir: "/home/u/.t3/userdata/secrets",
      sourceCacheDir: "/home/u/.t3/source",
    },
  });
  assert.include(context, "/home/u/.t3/userdata/state.sqlite");
  assert.include(context, "/home/u/.t3/userdata/logs/server.trace.ndjson");
  assert.include(context, "/home/u/.t3/userdata/logs/provider/events.log");
  assert.include(context, "/home/u/.t3/userdata/secrets");
  assert.include(context, "/home/u/.t3/source");
  assert.include(context, "npx t3 triage");
  assert.include(context, "Triage CLI version: 0.0.33");
  assert.include(context, "Release tag for the triage CLI: v0.0.33");
  assert.include(context, "Local server version: 0.0.43-nightly.20260923.2173");
  assert.include(
    context,
    "Release tag for the local server: v0.0.43-nightly.20260923.2173 (prerelease build; if this tag does not exist, clone main)",
  );
  assert.notInclude(context, "Installed version:");
  assert.include(TRIAGE_PLAYBOOK, "ask which version, device, and surface the bug happened on");
  assert.include(TRIAGE_PLAYBOOK, "check against the user's answer");
});

it("omits a local-server release tag when no server version was probed", () => {
  const context = buildTriageContext({
    generatedAt: "2026-08-13T00:00:00.000Z",
    cliVersion: "0.0.42",
    cliReleaseTag: "v0.0.42",
    localServerVersion: "not running",
    os: "linux x64 (7.0.0)",
    nodeVersion: "v24.0.0",
    launchedAs: "npx t3 triage",
    server: "not running (no server-runtime.json; the server may never have started here)",
    paths: {
      stateDir: "/home/u/.t3/userdata",
      dbPath: "/home/u/.t3/userdata/state.sqlite",
      settingsPath: "/home/u/.t3/userdata/settings.json",
      logsDir: "/home/u/.t3/userdata/logs",
      serverLogPath: "/home/u/.t3/userdata/logs/server.log",
      serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.t3/caches",
      secretsDir: "/home/u/.t3/userdata/secrets",
      sourceCacheDir: "/home/u/.t3/source",
    },
  });
  assert.include(context, "Local server version: not running");
  assert.notInclude(context, "Release tag for the local server");
});

const withOpenPort = <A, E, R>(
  respond: (response: NodeHttp.ServerResponse) => void,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        respond(response);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die("Expected a TCP address");
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

it.effect("environment read fails on a closed port instead of hanging", () =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(readEnvironmentBody("http://127.0.0.1:1", "1 second"));
    assert.equal(exit._tag, "Failure");
    assert.isBelow((yield* Clock.currentTimeMillis) - started, 2_000);
  }),
);

it.effect("environment read gives up when the response body never finishes", () =>
  withOpenPort(
    (response) => {
      response.writeHead(200, { "content-type": "application/json" });
    },
    (origin) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(
          readEnvironmentBody(`${origin}/.well-known/t3/environment`, "200 millis"),
        );
        assert.equal(exit._tag, "Failure");
        assert.isBelow((yield* Clock.currentTimeMillis) - started, 2_000);
      }),
  ),
);
