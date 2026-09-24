/**
 * Local server version for `t3 triage`.
 *
 * `packageJson.version` is the CLI that wrote the context file. The build the
 * user is actually running is `serverVersion` on the unauthenticated
 * environment descriptor, and only when the pid in `server-runtime.json` is
 * still that server.
 */
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

export const SERVER_VERSION_PROBE_TIMEOUT = "2 seconds";

/** State is written just after process start; allow a little clock skew. */
const PROCESS_START_SKEW_MS = 5_000;

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

const LOCAL_SERVER_VERSION_UNAVAILABLE = "unavailable";

const decodeEnvironmentDescriptor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExecutionEnvironmentDescriptor),
);

export const triageReleaseTag = (version: string) =>
  /^[^-+]+-(?:nightly|preview)\./.test(version)
    ? `v${version} (prerelease build; if this tag does not exist, clone main)`
    : `v${version}`;

/**
 * True when `processStartedAtMs` is still the process that wrote `startedAt`.
 * A reused pid starts later. An unknown start time is not a match.
 */
export const recordedServerStillOwnsPid = (
  startedAt: string,
  processStartedAtMs: number | undefined,
): boolean => {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || processStartedAtMs === undefined) {
    return false;
  }
  return processStartedAtMs <= startedAtMs + PROCESS_START_SKEW_MS;
};

/** http(s) environment URL. A corrupt origin stays here and is not probed. */
export const environmentDescriptorUrl = (origin: string): string | undefined => {
  try {
    const base = new URL(origin);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      return undefined;
    }
    return new URL(WELL_KNOWN_ENVIRONMENT_PATH, base).toString();
  } catch {
    return undefined;
  }
};

export type LocalServerVersion =
  | { readonly status: "not-running" }
  | { readonly status: "unavailable" }
  | { readonly status: "probed"; readonly version: string };

export interface ServerVersionProbe {
  readonly isAlive: (pid: number) => boolean;
  readonly processStartedAtMs: (pid: number) => number | undefined;
  /** Must settle when `timeout` elapses, including a body that never ends. */
  readonly readText: (url: string, timeout: Duration.Input) => Effect.Effect<string, unknown>;
}

export const readLocalServerVersion = Effect.fn("triage.readLocalServerVersion")(function* (
  state: Option.Option<PersistedServerRuntimeState>,
  probe: ServerVersionProbe,
  probeTimeout: Duration.Input = SERVER_VERSION_PROBE_TIMEOUT,
) {
  if (
    Option.isNone(state) ||
    !probe.isAlive(state.value.pid) ||
    !recordedServerStillOwnsPid(state.value.startedAt, probe.processStartedAtMs(state.value.pid))
  ) {
    return { status: "not-running" } as const satisfies LocalServerVersion;
  }
  const url = environmentDescriptorUrl(state.value.origin);
  if (url === undefined) {
    return { status: "unavailable" } as const satisfies LocalServerVersion;
  }
  const version = yield* probe.readText(url, probeTimeout).pipe(
    Effect.flatMap(decodeEnvironmentDescriptor),
    Effect.map((descriptor) => descriptor.serverVersion),
    Effect.timeout(probeTimeout),
    Effect.orElseSucceed(() => undefined),
  );
  return (
    version === undefined ? { status: "unavailable" } : { status: "probed", version }
  ) satisfies LocalServerVersion;
});

export const formatLocalServerVersion = (probed: LocalServerVersion) => {
  if (probed.status === "probed") {
    return {
      localServerVersion: probed.version,
      localServerReleaseTag: triageReleaseTag(probed.version),
    };
  }
  return {
    localServerVersion:
      probed.status === "unavailable" ? LOCAL_SERVER_VERSION_UNAVAILABLE : "not running",
  };
};
