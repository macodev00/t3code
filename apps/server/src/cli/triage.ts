/**
 * `t3 triage` - hand a misbehaving install to the user's own coding agent.
 *
 * The command is deliberately thin: it writes a `context.md` with machine facts
 * (version, paths, server liveness), then launches claude or codex
 * interactively, seeded with the playbook from `triagePrompt.ts`. The agent
 * asks the user what went wrong, investigates, and files the issue; the
 * harness's own permission prompts gate anything it wants to run. With no
 * agent CLI installed, the prompt and context are written to disk for the user
 * to paste into whatever agent they do have.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeReadlinePromises from "node:readline/promises";

import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";
import { resolveCliCommand } from "./invocation.ts";
import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
} from "./triagePrompt.ts";

interface TriageAgent {
  readonly id: "claude" | "codex";
  readonly command: string;
  readonly label: string;
}

const TRIAGE_AGENTS: ReadonlyArray<TriageAgent> = [
  { id: "claude", command: "claude", label: "Claude Code" },
  { id: "codex", command: "codex", label: "Codex" },
];

export class TriageAgentUnavailableError extends Schema.TaggedError<TriageAgentUnavailableError>()(
  "TriageAgentUnavailableError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `\`${this.agent}\` is not installed or was not found on PATH.`;
  }
}

export class TriageAgentChoiceRequiredError extends Schema.TaggedError<TriageAgentChoiceRequiredError>()(
  "TriageAgentChoiceRequiredError",
  {},
) {
  override get message(): string {
    return "Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.";
  }
}

export class TriageAgentSpawnError extends Schema.TaggedError<TriageAgentSpawnError>()(
  "TriageAgentSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not start \`${this.command}\`.`;
  }
}

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const SERVER_VERSION_PROBE_TIMEOUT = Duration.millis(2_500);
const PROCESS_START_SKEW_MS = 5_000;
const LOCAL_SERVER_VERSION_UNAVAILABLE =
  "unavailable (server process is up, but /.well-known/t3/environment did not return serverVersion)";

/** Release tag the playbook clones. Nightlies often have no published tag. */
export const triageReleaseTag = (version: string) =>
  /^[^-+]+-(?:nightly|preview)\./.test(version)
    ? `v${version} (prerelease build; if this tag does not exist, clone main)`
    : `v${version}`;

/**
 * Start time of `pid`, in epoch ms. Linux reads `/proc/<pid>` (directory mtime
 * is process start). Other platforms ask the OS. Unreadable means unknown.
 */
const readProcessStartedAtMs = (pid: number): number | undefined => {
  try {
    if (NodeOS.platform() === "linux") {
      return NodeFS.statSync(`/proc/${pid}`).mtimeMs;
    }
    if (NodeOS.platform() === "darwin") {
      const stdout = NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C" },
      });
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (NodeOS.platform() === "win32") {
      const stdout = NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
      );
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * True when `pid` is still the process that wrote `startedAt`. The state file
 * is written after that process starts, so a reused pid (started later) is not
 * a match. Unknown start time is not a match: do not probe a stranger.
 */
const recordedServerStillOwnsPid = (state: PersistedServerRuntimeState): boolean => {
  const startedAtMs = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }
  const processStartedAtMs = readProcessStartedAtMs(state.pid);
  if (processStartedAtMs === undefined) {
    return false;
  }
  return processStartedAtMs <= startedAtMs + PROCESS_START_SKEW_MS;
};

/** One human-readable line about the local server, for `context.md`. */
const describeServerProcess = (state: Option.Option<PersistedServerRuntimeState>): string => {
  if (Option.isNone(state)) {
    return "not running (no server-runtime.json; the server may never have started here)";
  }
  if (!isProcessAlive(state.value.pid)) {
    return `not running (state file is stale: pid ${String(state.value.pid)} is dead; last origin ${state.value.origin})`;
  }
  if (!recordedServerStillOwnsPid(state.value)) {
    return `not running (state file is stale: pid ${String(state.value.pid)} is not the server that wrote it; last origin ${state.value.origin})`;
  }
  return `running (pid ${String(state.value.pid)}, ${state.value.origin})`;
};

export type LocalServerVersion =
  | { readonly status: "not-running" }
  | { readonly status: "unavailable" }
  | { readonly status: "probed"; readonly version: string };

/** http(s) environment URL. `new URL` throws on a corrupt origin; that stays here. */
const environmentUrl = (origin: string): string | undefined => {
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

/**
 * `response.arrayBuffer()` does not observe Effect interruption, so a timeout
 * has to abort the fetch itself or a stalled body never settles.
 */
const fetchWithDeadline = (timeout: Duration.Input): typeof fetch => {
  const deadline = AbortSignal.timeout(Duration.toMillis(timeout));
  return (input, init) =>
    // @effect-diagnostics-next-line globalFetch:off
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal == null ? deadline : AbortSignal.any([init.signal, deadline]),
    });
};

const probeServerVersion = (url: string, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const descriptor = yield* client
      .execute(HttpClientRequest.get(url))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      );
    return descriptor.serverVersion;
  }).pipe(
    // Covers the status check and the body read, not only the header response.
    Effect.timeout(timeout),
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithDeadline(timeout))),
      ),
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
  );

/**
 * `serverVersion` of the server recorded in `server-runtime.json`.
 * Desktop and service installs publish it on the unauthenticated environment
 * descriptor. A dead or reused pid is not probed.
 */
export const readLocalServerVersion = Effect.fn("triage.readLocalServerVersion")(function* (
  state: Option.Option<PersistedServerRuntimeState>,
  probeTimeout: Duration.Input = SERVER_VERSION_PROBE_TIMEOUT,
): Effect.fn.Return<LocalServerVersion> {
  if (
    Option.isNone(state) ||
    !isProcessAlive(state.value.pid) ||
    !recordedServerStillOwnsPid(state.value)
  ) {
    return { status: "not-running" };
  }
  const url = environmentUrl(state.value.origin);
  if (url === undefined) {
    return { status: "unavailable" };
  }
  const version = yield* probeServerVersion(url, probeTimeout);
  return version === undefined ? { status: "unavailable" } : { status: "probed", version };
});

const formatLocalServerVersion = (probed: LocalServerVersion) => {
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

const pickAgent = (agents: ReadonlyArray<TriageAgent>) =>
  Effect.promise(async () => {
    const readline = NodeReadlinePromises.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const menu = agents
        .map((agent, index) => `  [${String(index + 1)}] ${agent.label}`)
        .join("\n");
      for (;;) {
        const answer = (await readline.question(`Run triage with:\n${menu}\n> `)).trim();
        const byNumber = agents[Number.parseInt(answer, 10) - 1];
        if (byNumber !== undefined) {
          return byNumber;
        }
        const byId = agents.find((agent) => agent.id === answer.toLowerCase());
        if (byId !== undefined) {
          return byId;
        }
      }
    } finally {
      readline.close();
    }
  });

/**
 * Run the agent CLI as a normal interactive session: the user's terminal is
 * the UI, and the harness's own permission prompts gate every action. Resolves
 * with the child's exit code.
 */
const runInteractiveSession = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly cwd: string;
}) =>
  Effect.callback<number, TriageAgentSpawnError>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      stdio: "inherit",
      shell: input.shell,
    });
    child.once("error", (cause) =>
      resume(Effect.fail(new TriageAgentSpawnError({ command: input.command, cause }))),
    );
    // Signal death has no exit code; report failure rather than success.
    child.once("exit", (code, signal) => resume(Effect.succeed(code ?? (signal === null ? 0 : 1))));
  });

const agentFlag = Flag.Literals("agent", ["claude", "codex"]).pipe(
  Flag.withDescription("Agent CLI to use. Default: ask when both are installed."),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Model passed through to the agent CLI. Default: the agent's default."),
  Flag.optional,
);

export const triageCommand = Command.make("triage", {
  baseDir: baseDirFlag,
  agent: agentFlag,
  model: modelFlag,
}).pipe(
  Command.withDescription(
    "Investigate a T3 Code problem on this machine with claude or codex, and help file a good issue.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Triage is a user-facing feature: always the userdata state, never dev.
      // --base-dir wins; T3CODE_HOME is its documented env equivalent (same
      // precedence as `t3 pair`).
      const explicitBaseDir = Option.getOrUndefined(flags.baseDir);
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(explicitBaseDir ?? Option.getOrUndefined(envHome));
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

      const now = yield* DateTime.now;
      const scratchDir = path.join(
        paths.stateDir,
        "triage",
        // ISO instant, made safe for Windows paths.
        DateTime.formatIso(now).replaceAll(":", "-").replace(".", "-"),
      );
      yield* fs.makeDirectory(scratchDir, { recursive: true });

      const cliVersion = packageJson.version;
      // A corrupt state file reads as "not running"; the reader swallows that.
      const serverState = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath);
      const localServer = formatLocalServerVersion(yield* readLocalServerVersion(serverState));
      const contextFilePath = path.join(scratchDir, "context.md");
      yield* fs.writeFileString(
        contextFilePath,
        buildTriageContext({
          generatedAt: DateTime.formatIso(now),
          cliVersion,
          cliReleaseTag: triageReleaseTag(cliVersion),
          ...localServer,
          os: `${yield* HostProcessPlatform} ${yield* HostProcessArchitecture} (${NodeOS.release()})`,
          nodeVersion: process.version,
          launchedAs: yield* resolveCliCommand("triage"),
          server: describeServerProcess(serverState),
          paths: {
            stateDir: paths.stateDir,
            dbPath: paths.dbPath,
            settingsPath: paths.settingsPath,
            logsDir: paths.logsDir,
            serverLogPath: paths.serverLogPath,
            serverTracePath: paths.serverTracePath,
            providerEventLogPath: paths.providerEventLogPath,
            terminalLogsDir: paths.terminalLogsDir,
            providerStatusCacheDir: paths.providerStatusCacheDir,
            secretsDir: paths.secretsDir,
            sourceCacheDir: path.join(baseDir, "source"),
          },
        }),
      );

      const installed: Array<TriageAgent> = [];
      for (const agent of TRIAGE_AGENTS) {
        if (yield* isCommandAvailable(agent.command)) {
          installed.push(agent);
        }
      }

      const requested = Option.getOrUndefined(flags.agent);
      let selected: TriageAgent | undefined;
      if (requested !== undefined) {
        selected = installed.find((agent) => agent.id === requested);
        if (selected === undefined) {
          return yield* new TriageAgentUnavailableError({ agent: requested });
        }
      } else if (installed.length === 1) {
        selected = installed[0];
      } else if (installed.length > 1) {
        // Both streams must be terminals: with stdout redirected the picker
        // prompt is invisible and the command would hang waiting on it.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return yield* new TriageAgentChoiceRequiredError();
        }
        selected = yield* pickAgent(installed);
      }

      // The full seed prompt always goes to disk. The agent is launched with a
      // one-line pointer at it: Windows `.cmd` shims run through cmd.exe,
      // which cannot carry the multiline playbook as an argv string, and with
      // no agent installed the same file is the paste-anywhere fallback.
      const promptFilePath = path.join(scratchDir, "prompt.md");
      yield* fs.writeFileString(promptFilePath, buildTriageSeedPrompt(contextFilePath));

      if (selected === undefined) {
        yield* Console.log(
          [
            "No supported agent CLI (claude, codex) was found on this machine.",
            "",
            "The triage prompt and machine context were written to:",
            `  ${promptFilePath}`,
            `  ${contextFilePath}`,
            "",
            "Paste the prompt file into any coding agent to run triage by hand.",
          ].join("\n"),
        );
        return;
      }

      const model = Option.getOrUndefined(flags.model);
      const spawnSpec = yield* resolveSpawnCommand(selected.command, [
        ...(model === undefined ? [] : ["--model", model]),
        buildTriageLaunchPrompt(promptFilePath),
      ]);
      yield* Console.log(`Starting ${selected.label}. It will ask what went wrong.\n`);
      const exitCode = yield* runInteractiveSession({ ...spawnSpec, cwd: scratchDir });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }),
  ),
);
