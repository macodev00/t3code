/** Detects whether an OpenCode instance runs 1.x or 2.x, so the driver can pick its runtime. */
import { parseSemver } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

export interface ProbedOpenCode {
  readonly generation: "v1" | "v2";
  readonly version: string;
}

const OPENCODE_SERVER_PROBE_TIMEOUT = "5 seconds";
// 2.x's own CLI decodes `{version, pid}` from `/api/info`; requiring both keeps unrelated JSON out.
const decodeApiInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Int })),
);
const decodeGlobalHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ healthy: Schema.Literal(true), version: Schema.String })),
);

/**
 * Product default from #8750. It stays 4 seconds so a hung `--version` is
 * still killed quickly. Slow hosts opt in with
 * `T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT` instead of changing it.
 */
const DEFAULT_OPENCODE_VERSION_PROBE_TIMEOUT = Duration.seconds(4);
const MIN_OPENCODE_VERSION_PROBE_TIMEOUT = Duration.seconds(1);
const MAX_OPENCODE_VERSION_PROBE_TIMEOUT = Duration.seconds(60);
/** Environment variable that overrides the 4 second `--version` cap. */
export const OPENCODE_VERSION_PROBE_TIMEOUT_ENV = "T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT";
const OPENCODE_VERSION_PROBE_TIMEOUT_SHORTHAND = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>ms|s|m|h)$/i;
const OPENCODE_VERSION_PROBE_TIMEOUT_UNITS = {
  ms: "millis",
  s: "seconds",
  m: "minutes",
  h: "hours",
} as const;
const OPENCODE_CLI_HEALTH_CHECK_FAILURE = "Failed to execute OpenCode CLI health check";
const OPENCODE_VERSION_PROBE_TIMEOUT_MESSAGE_PREFIX = `${OPENCODE_CLI_HEALTH_CHECK_FAILURE}: OpenCode CLI version probe timed out after `;
// Labels `formatOpenCodeVersionProbeTimeout` emits: "1 second", "N seconds", or integer millis.
const OPENCODE_VERSION_PROBE_TIMEOUT_LABEL = /^(?:1 second|[1-9]\d* seconds|[1-9]\d* millis)$/;

/**
 * Duration label in the `--version` timeout message. Whole seconds render as
 * "1 second" or "N seconds"; every other duration renders as integer millis.
 */
function formatOpenCodeVersionProbeTimeout(duration: Duration.Duration): string {
  const millis = Math.round(Duration.toMillis(duration));
  if (millis % 1000 === 0) {
    const seconds = millis / 1000;
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${millis} millis`;
}

/**
 * Detail text for a `--version` probe that reached its cap. Snapshot merging
 * recognizes this only after the health-check prefix is added.
 */
export function openCodeVersionProbeTimeoutDetail(duration: Duration.Duration): string {
  return `OpenCode CLI version probe timed out after ${formatOpenCodeVersionProbeTimeout(duration)}.`;
}

/**
 * True when `message` is the exact provider text for a local `--version`
 * timeout. A launch error that only contains that phrase does not match.
 */
export function isOpenCodeVersionProbeTimeoutMessage(message: string | undefined): boolean {
  if (
    message === undefined ||
    !message.startsWith(OPENCODE_VERSION_PROBE_TIMEOUT_MESSAGE_PREFIX) ||
    !message.endsWith(".")
  ) {
    return false;
  }
  const label = message.slice(OPENCODE_VERSION_PROBE_TIMEOUT_MESSAGE_PREFIX.length, -1);
  if (!OPENCODE_VERSION_PROBE_TIMEOUT_LABEL.test(label)) {
    return false;
  }
  return message === `${OPENCODE_VERSION_PROBE_TIMEOUT_MESSAGE_PREFIX}${label}.`;
}

/**
 * Parses `T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT`. Empty or unparseable text
 * returns undefined so the 4 second default stands. `ms`, `s`, `m`, and `h`
 * shorthand is accepted. Finite values clamp to 1-60 seconds; non-positive
 * values are ignored and an infinite value uses the 60 second cap.
 */
function parseOpenCodeVersionProbeTimeout(raw: string | undefined): Duration.Duration | undefined {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return undefined;
  }

  const shorthand = OPENCODE_VERSION_PROBE_TIMEOUT_SHORTHAND.exec(trimmed);
  const shorthandAmount = shorthand?.groups?.amount;
  const shorthandUnit = shorthand?.groups?.unit?.toLowerCase();
  const normalized =
    shorthandAmount !== undefined &&
    shorthandUnit !== undefined &&
    shorthandUnit in OPENCODE_VERSION_PROBE_TIMEOUT_UNITS
      ? `${shorthandAmount} ${OPENCODE_VERSION_PROBE_TIMEOUT_UNITS[shorthandUnit as keyof typeof OPENCODE_VERSION_PROBE_TIMEOUT_UNITS]}`
      : trimmed;
  const decoded = Duration.fromInput(normalized as Duration.Input);
  if (Option.isNone(decoded)) {
    return undefined;
  }

  const millis = Duration.toMillis(decoded.value);
  if (!Number.isFinite(millis) || millis <= 0) {
    return millis > 0 ? MAX_OPENCODE_VERSION_PROBE_TIMEOUT : undefined;
  }
  if (millis < Duration.toMillis(MIN_OPENCODE_VERSION_PROBE_TIMEOUT)) {
    return MIN_OPENCODE_VERSION_PROBE_TIMEOUT;
  }
  if (millis > Duration.toMillis(MAX_OPENCODE_VERSION_PROBE_TIMEOUT)) {
    return MAX_OPENCODE_VERSION_PROBE_TIMEOUT;
  }
  return decoded.value;
}

/**
 * `T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT` overrides the 4 second default.
 * Invalid text is ignored. Accepted values are clamped to 1-60 seconds and
 * rounded to whole milliseconds so the timeout message stays exact.
 */
export function resolveOpenCodeVersionProbeTimeout(
  environment?: NodeJS.ProcessEnv,
): Duration.Duration {
  const parsed =
    parseOpenCodeVersionProbeTimeout(environment?.[OPENCODE_VERSION_PROBE_TIMEOUT_ENV]) ??
    DEFAULT_OPENCODE_VERSION_PROBE_TIMEOUT;
  return Duration.millis(Math.round(Duration.toMillis(parsed)));
}

/** Returns the OpenCode generation for a parsed CLI or server version. */
function probed(version: string | null | undefined): ProbedOpenCode | undefined {
  const major = parseSemver(version ?? "")?.major;
  if (!version || major === undefined) return undefined;
  return { generation: major >= 2 ? "v2" : "v1", version };
}

/** `opencode --version` prints `1.18.32` on 1.x and `opencode v2.0.18` on 2.x. */
export const classifyOpenCodeCliVersion = (output: string) =>
  probed(parseGenericCliVersion(output));

/**
 * 2.x answers `/api/info` and 1.x answers `/global/health`. Each serves its web UI's HTML with a
 * 200 on the other's path, so only a JSON body counts. Both versions answer a wrong password with
 * a 401 on either path, so a 401 says nothing about the version.
 */
function classifyOpenCodeProbeResponse(
  path: "/api/info" | "/global/health",
  response: {
    readonly status: number;
    readonly contentType: string | undefined;
    readonly body: string;
  },
): ProbedOpenCode | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized";
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  if (response.status !== 200 || mediaType !== "application/json") return undefined;
  const version: Option.Option<string> =
    path === "/api/info"
      ? Option.map(decodeApiInfo(response.body), (info) => info.version)
      : Option.map(decodeGlobalHealth(response.body), (health) => health.version);
  return probed(Option.getOrUndefined(version));
}

/**
 * Local `opencode --version`. The 4 second default is unchanged;
 * `T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT` can raise the cap.
 */
const probeOpenCodeBinary = Effect.fn("probeOpenCodeBinary")(
  /**
   * Local `opencode --version`. The 4 second default is unchanged;
   * `T3CODE_OPENCODE_VERSION_PROBE_TIMEOUT` can raise the cap.
   */
  function* (binaryPath: string, environment: NodeJS.ProcessEnv | undefined) {
    const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
    const timeout = resolveOpenCodeVersionProbeTimeout(environment ?? process.env);
    /**
     * Fails this `--version` probe with the exact timeout detail for its cap.
     */
    function failTimedOutProbe() {
      return Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "probeOpenCodeBinary",
          detail: openCodeVersionProbeTimeoutDetail(timeout),
        }),
      );
    }
    const { stdout } = yield* runtime
      .runOpenCodeCommand({
        binaryPath,
        args: ["--version"],
        ...(environment === undefined ? {} : { environment }),
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: failTimedOutProbe,
        }),
      );
    const result = classifyOpenCodeCliVersion(stdout);
    if (result) return result;
    return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "probeOpenCodeBinary",
      detail: `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  },
);

// Server failures reach clients through the provider status, so their details are fixed text:
// the underlying error can carry the configured URL, its credentials, or the password header.
const probeOpenCodeServer = Effect.fn("probeOpenCodeServer")(function* (
  serverUrl: string,
  serverPassword: string,
) {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = URL.parse(serverUrl.trim());
  if (baseUrl?.protocol !== "http:" && baseUrl?.protocol !== "https:") {
    return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "probeOpenCodeServer",
      detail: "The OpenCode server URL is not a valid http:// or https:// URL.",
    });
  }
  // UTF-8, as the 1.x SDK client sends it; `HttpClientRequest.basicAuth` uses Latin-1 `btoa`.
  const authorization = serverPassword
    ? `Basic ${Buffer.from(`opencode:${serverPassword}`, "utf8").toString("base64")}`
    : undefined;
  for (const path of ["/api/info", "/global/health"] as const) {
    // A path prefix and query on the configured URL are kept: `/base/?x=1` → `/base/api/info?x=1`.
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    const request = HttpClientRequest.get(url.href);
    const result = yield* client
      .execute(
        authorization
          ? HttpClientRequest.setHeader(request, "authorization", authorization)
          : request,
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) =>
            classifyOpenCodeProbeResponse(path, {
              status: response.status,
              contentType: response.headers["content-type"],
              body,
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "probeOpenCodeServer",
              detail: "Couldn't reach the OpenCode server.",
              cause,
            }),
        ),
        Effect.timeoutOrElse({
          duration: OPENCODE_SERVER_PROBE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "probeOpenCodeServer",
                detail: "Timed out while checking the OpenCode server version.",
              }),
            ),
        }),
      );
    if (result === "unauthorized") {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "probeOpenCodeServer",
        detail: "401 Unauthorized: the OpenCode server rejected the password.",
      });
    }
    if (result !== undefined) return result;
  }
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation: "probeOpenCodeServer",
    detail: `The server did not identify itself as OpenCode. T3 Code requires OpenCode v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer.`,
  });
});

/** Probes a configured server when `serverUrl` is set, otherwise the local binary. */
export const probeOpenCodeRuntime = (
  settings: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly serverPassword: string;
  },
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  ProbedOpenCode,
  OpenCodeRuntime.OpenCodeRuntimeError,
  HttpClient.HttpClient | OpenCodeRuntime.OpenCodeRuntime
> =>
  settings.serverUrl.trim().length > 0
    ? probeOpenCodeServer(settings.serverUrl, settings.serverPassword)
    : probeOpenCodeBinary(settings.binaryPath, environment);

/**
 * One instance's runtime, remembered after the first successful probe. Settings changes rebuild
 * the driver; `refresh` re-probes (status checks use it, so an in-place upgrade re-routes). A
 * failed probe is never remembered. `lastSuccess` never probes, for calls too hot to wait on one.
 */
export const makeOpenCodeRuntimeProbe = <E>(probe: Effect.Effect<ProbedOpenCode, E>) =>
  Effect.map(
    Cache.makeWith(() => probe, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
    (cache) => ({
      get: Cache.get(cache, undefined),
      refresh: Cache.refresh(cache, undefined),
      lastSuccess: Cache.getSuccess(cache, undefined),
    }),
  );
