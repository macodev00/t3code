import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestConsole from "effect/testing/TestConsole";

import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { runBrowserSetup } from "./browser.ts";

const EXECUTABLE = "/data/t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell";

const versionSpawner = ChildProcessSpawner.make(() =>
  Effect.sync(() =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.make(new TextEncoder().encode("Google Chrome for Testing 154.0.8037.92\n")),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

const fileSystemFor = (browserInstalled: boolean) => {
  const directories: Record<string, ReadonlyArray<string>> = browserInstalled
    ? {
        "/data/t3/tools/chrome-headless-shell": ["linux64"],
        "/data/t3/tools/chrome-headless-shell/linux64": ["154"],
      }
    : {};
  return FileSystem.layerNoop({
    readDirectory: (path) => Effect.succeed([...(directories[path] ?? [])]),
    exists: (path) => Effect.succeed(browserInstalled && path === EXECUTABLE),
  });
};

const setupOutput = (input: {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly browserInstalled?: boolean;
}) =>
  Effect.gen(function* () {
    yield* runBrowserSetup(Option.some("/data/t3"));
    return (yield* TestConsole.logLines)
      .filter((line): line is string => typeof line === "string")
      .join("\n");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestConsole.layer,
        fileSystemFor(input.browserInstalled ?? true),
        NodePath.layerPosix,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, versionSpawner),
      ),
    ),
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.UserId, input.uid ?? 1000),
    Effect.provideService(HostProcess.Environment, input.env ?? {}),
  );

describe("t3 browser setup", () => {
  it.effect("warns that a root service cannot sandbox Chrome instead of saying ready", () =>
    Effect.gen(function* () {
      const output = yield* setupOutput({ uid: 0 });
      expect(output).toBe(PreviewBrowserHost.ROOT_SANDBOX_MESSAGE);
      expect(output).toContain("nonroot `User=`");
      expect(output).toContain("T3CODE_SERVER_BROWSER_SANDBOX=0");
      expect(output).not.toContain("ready");
      expect(output).not.toContain("AppArmor");
      expect(output).not.toContain("browser setup");
    }),
  );

  it.effect("still says ready for a non-root user", () =>
    Effect.gen(function* () {
      const output = yield* setupOutput({ uid: 1000 });
      expect(output).toBe("This host is ready for T3's browser.");
    }),
  );

  it.effect("still says ready when sudo is only elevating setup for a non-root user", () =>
    Effect.gen(function* () {
      const output = yield* setupOutput({
        uid: 0,
        env: { SUDO_UID: "1000", SUDO_USER: "ada" },
      });
      expect(output).toBe("This host is ready for T3's browser.");
    }),
  );

  it.effect("says ready when a root service has turned the sandbox off", () =>
    Effect.gen(function* () {
      const output = yield* setupOutput({
        uid: 0,
        env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
      });
      expect(output).toBe("This host is ready for T3's browser.");
    }),
  );

  it.effect(
    "does not claim the sandbox is allowed for a root service before the browser is installed",
    () =>
      Effect.gen(function* () {
        const output = yield* setupOutput({ uid: 0, browserInstalled: false });
        expect(output).toBe(PreviewBrowserHost.ROOT_SANDBOX_MESSAGE);
        expect(output).not.toContain("allowed here");
      }),
  );

  it.effect("leaves other systems alone", () =>
    Effect.gen(function* () {
      const output = yield* setupOutput({ platform: "darwin", uid: 0 });
      expect(output).toBe("Nothing to set up: T3's browser runs as is on this system.");
    }),
  );
});
