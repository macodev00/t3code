import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const backendConfig: DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: false,
  preflightFailure: Option.none(),
};

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      DesktopBackendPool.DesktopBackendPool.pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );

  it.effect("uses Windows for this launch when a wsl-only primary never becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const launches = yield* Queue.unbounded<"wsl" | "windows">();
        const failures = yield* Queue.unbounded<string>();
        const dialogs = yield* Queue.unbounded<{
          readonly title: string;
          readonly content: string;
        }>();
        const ready = yield* Queue.unbounded<string>();
        const launchKind = yield* Ref.make<"wsl" | "windows">("wsl");
        const windowsExit = yield* Deferred.make<void>();
        const wslConfig: DesktopBackendStartConfig = {
          ...backendConfig,
          runningDistro: "Ubuntu-22.04",
          httpBaseUrl: new URL("http://10.0.0.8:3773"),
        };
        const windowsConfig: DesktopBackendStartConfig = {
          ...backendConfig,
          httpBaseUrl: new URL("http://127.0.0.1:3773"),
        };
        const settingsLayer = DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          wslBackendEnabled: true,
          wslOnly: true,
          wslDistro: "Ubuntu-22.04",
        });

        const context = yield* Layer.build(
          DesktopBackendPool.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
                Layer.succeed(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make(() =>
                    Effect.gen(function* () {
                      const scope = yield* Scope.Scope;
                      const kind = yield* Ref.get(launchKind);
                      yield* Queue.offer(launches, kind);
                      const releaseWindows = Deferred.succeed(windowsExit, undefined).pipe(
                        Effect.ignore,
                      );
                      if (kind === "windows") {
                        yield* Scope.addFinalizer(scope, releaseWindows);
                      }
                      return ChildProcessSpawner.makeHandle({
                        pid: ChildProcessSpawner.ProcessId(123),
                        stdout: Stream.empty,
                        stderr: Stream.empty,
                        all: Stream.empty,
                        exitCode:
                          kind === "windows"
                            ? Deferred.await(windowsExit).pipe(
                                Effect.as(ChildProcessSpawner.ExitCode(0)),
                              )
                            : Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                        isRunning: Effect.succeed(false),
                        kill: () => (kind === "windows" ? releaseWindows : Effect.void),
                        stdin: Sink.drain,
                        getInputFd: () => Sink.drain,
                        getOutputFd: () => Stream.empty,
                        unref: Effect.succeed(Effect.void),
                      });
                    }),
                  ),
                ),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    request.url.startsWith("http://127.0.0.1:3773")
                      ? Effect.succeed(
                          HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
                        )
                      : Effect.never,
                  ),
                ),
                Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
                  forInstance: () =>
                    Effect.succeed({
                      beginSession: () => Effect.void,
                      writeOutputChunk: () => Effect.void,
                      persistFailureSnapshot: () => Effect.void,
                      persistFailure: ({ details }) =>
                        Queue.offer(failures, details).pipe(Effect.asVoid),
                      discardSession: Effect.void,
                    } satisfies DesktopObservability.DesktopBackendOutputLogShape),
                } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
                Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
                  latest: Effect.succeedNone,
                  changes: Stream.empty,
                  encoded: Stream.empty,
                  handleControlForSource: () => Effect.void,
                  removeControlSource: () => Effect.void,
                  publishUpdateReport: () => Effect.void,
                  updateRequests: Stream.empty,
                  updateCommits: Stream.empty,
                  updateCancellations: Stream.empty,
                }),
                Layer.effect(
                  DesktopBackendConfiguration.DesktopBackendConfiguration,
                  Effect.gen(function* () {
                    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
                    return {
                      resolvePrimary: appSettings.get.pipe(
                        Effect.tap((settings) =>
                          Ref.set(launchKind, settings.wslOnly ? "wsl" : "windows"),
                        ),
                        Effect.map((settings) => (settings.wslOnly ? wslConfig : windowsConfig)),
                      ),
                      resolvePrimaryLabel: Effect.succeed("WSL (Ubuntu-22.04)"),
                      resolveWsl: () => Effect.die("unexpected WSL config resolve"),
                    } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"];
                  }),
                ),
                DesktopWslEnvironment.layerTest(),
                Layer.succeed(ElectronDialog.ElectronDialog, {
                  pickFolder: () => Effect.die("unexpected folder picker"),
                  pickFiles: () => Effect.die("unexpected file picker"),
                  showMessageBox: () => Effect.die("unexpected message box"),
                  showErrorBox: (title, content) =>
                    Queue.offer(dialogs, { title, content }).pipe(Effect.asVoid),
                } satisfies ElectronDialog.ElectronDialog["Service"]),
                Layer.succeed(DesktopWindow.DesktopWindow, {
                  createMain: Effect.die("unexpected window create"),
                  ensureMain: Effect.die("unexpected window ensure"),
                  revealOrCreateMain: Effect.die("unexpected window reveal"),
                  activate: Effect.die("unexpected window activate"),
                  createMainIfBackendReady: Effect.die("unexpected window create"),
                  showConnectingSplash: Effect.void,
                  handleBackendReady: () => Queue.offer(ready, "ready").pipe(Effect.asVoid),
                  handleBackendNotReady: Effect.void,
                  flushMainWindowBounds: Effect.void,
                  prepareCaptureReveal: Effect.void,
                  dispatchMenuAction: () => Effect.die("unexpected menu action"),
                  dispatchSnapShotEvent: () => Effect.void,
                  zoomMain: () => Effect.die("unexpected zoom"),
                  syncAppearance: Effect.void,
                } satisfies DesktopWindow.DesktopWindow["Service"]),
              ),
            ),
            Layer.provideMerge(settingsLayer),
          ),
        );
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(Effect.provide(context));
        const settings = yield* DesktopAppSettings.DesktopAppSettings.pipe(Effect.provide(context));

        const primary = yield* pool.primary;
        yield* primary.start;
        assert.equal(yield* Queue.take(launches), "wsl");
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");
        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(launches), "wsl");
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(yield* Queue.take(launches), "wsl");
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");

        const dialog = yield* Queue.take(dialogs);
        assert.equal(dialog.title, "WSL backend isn't responding");
        assert.equal(
          dialog.content,
          "The WSL backend (Ubuntu-22.04) exited before it was ready (exit code 1).\n\nT3 Code will use the Windows backend for this launch and retry WSL the next time the app starts.",
        );
        assert.isFalse(dialog.content.includes("http"));
        assert.isFalse(dialog.content.includes("MODULE_NOT_FOUND"));
        assert.equal(yield* Queue.take(launches), "windows");
        assert.equal(yield* Queue.take(ready), "ready");

        const stored = yield* settings.get;
        assert.equal(stored.wslOnly, false);
        assert.equal(stored.wslBackendEnabled, false);
        assert.equal(stored.wslDistro, "Ubuntu-22.04");
        yield* primary.stop();
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
