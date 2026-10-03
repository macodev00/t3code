import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/**
 * Removes every per-process runtime temp directory under an instance's root.
 * Call once when the driver starts, before it launches any process, so a
 * previous server that was killed mid-session cannot leave unpacked runtimes
 * behind. Only T3-owned directories are touched. The system temp directory
 * belongs to other programs and Windows does not lock data files, so sweeping
 * it could gut a live extraction.
 */
export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDirectory, { recursive: true, force: true });
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);

/** Markers unique to an Antigravity PyInstaller unpack. Never treat `google3` alone as enough. */
const ANTIGRAVITY_MEI_MARKERS = [
  ["agy_acp_licenses.txt"],
  ["localharness"],
  ["google3", "third_party", "jetski_prod", "localharness"],
] as const;

/** Live unpacks stay recent. Pre-#12008 probe leftovers are days old. */
export const ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Windows host TEMP/TMP only. Empty or duplicate values are dropped. */
export const resolveAntigravityLegacySystemTempDirectories = (
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const value of [environment.TEMP, environment.TMP]) {
    if (value === undefined || value === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    directories.push(value);
  }
  return directories;
};

/**
 * Reclaims T3-created `%TEMP%\_MEI*` leftovers from the pre-#12008 health
 * probe. Call once on driver start with an injected directory. Only stale
 * `_MEI*` dirs that contain Antigravity markers are removed. Unmarked dirs,
 * dirs at or under the two-day cutoff, and dirs a live process still has
 * open are left alone. The real system temp is never listed from tests.
 */
export const cleanOrphanedAntigravitySystemTempDirs = Effect.fn(
  "cleanOrphanedAntigravitySystemTempDirs",
)(
  function* (input: {
    readonly systemTempDirectory: string;
    readonly nowMs?: number;
    readonly minAgeMs?: number;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.systemTempDirectory === "" || !(yield* fs.exists(input.systemTempDirectory))) {
      return;
    }
    const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
    const minAgeMs = input.minAgeMs ?? ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS;
    const entries = yield* fs
      .readDirectory(input.systemTempDirectory)
      .pipe(Effect.orElseSucceed(() => []));
    const candidates: Array<string> = [];
    for (const entry of entries) {
      if (!entry.startsWith("_MEI")) continue;
      const directory = path.join(input.systemTempDirectory, entry);
      const stats = yield* fs.stat(directory).pipe(Effect.option);
      if (Option.isNone(stats) || stats.value.type !== "Directory") continue;
      const modifiedAt = Option.match(stats.value.mtime, {
        onNone: () => Option.getOrUndefined(stats.value.birthtime),
        onSome: (mtime) => mtime,
      });
      if (modifiedAt === undefined || nowMs - modifiedAt.getTime() <= minAgeMs) continue;
      if (!(yield* hasAntigravityMeiMarker(directory))) continue;
      candidates.push(directory);
    }
    if (candidates.length === 0) return;
    // A failed probe must not start deleting. Treating every candidate as
    // referenced skips the sweep instead of guessing that nothing is live.
    const live = yield* probeLiveAntigravityExtracts(candidates).pipe(
      Effect.orElseSucceed((): LiveAntigravityExtractProbe => ({
        paths: candidates,
        protectOpenHandles: true,
        caseInsensitive: false,
      })),
    );
    for (const directory of candidates) {
      if (yield* liveExtractIsReferenced(directory, live)) continue;
      yield* removeUnreferencedAntigravityExtract(directory, live.protectOpenHandles);
    }
  },
  Effect.catch(() => Effect.logWarning("Could not remove leftover Antigravity system temp files.")),
);

const hasAntigravityMeiMarker = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const marker of ANTIGRAVITY_MEI_MARKERS) {
    if (yield* fs.exists(path.join(directory, ...marker))) {
      return true;
    }
  }
  return false;
});

/**
 * What a live PyInstaller process looks like before we delete anything.
 * Recursive removal is the wrong time to discover a lock: Windows unlinks
 * the unlocked data files and only then fails on the loaded executable.
 */
interface LiveAntigravityExtractProbe {
  readonly paths: ReadonlyArray<string>;
  readonly protectOpenHandles: boolean;
  readonly caseInsensitive: boolean;
}

const PATH_BOUNDARY_BEFORE = new Set(["", '"', "'", " ", "=", ","]);
const PATH_BOUNDARY_AFTER = new Set(["", '"', "'", " ", "/"]);

const normalizePathKey = (value: string, caseInsensitive: boolean): string => {
  const slashes = value.replaceAll("\\", "/");
  return caseInsensitive ? slashes.toLowerCase() : slashes;
};

/** True when `reference` is the directory or a file/command line inside it. */
const pathReferencesDirectory = (
  directory: string,
  reference: string,
  caseInsensitive: boolean,
): boolean => {
  const parent = normalizePathKey(directory, caseInsensitive);
  const candidate = normalizePathKey(reference, caseInsensitive);
  if (parent.length === 0) return false;
  let from = 0;
  while (from < candidate.length) {
    const index = candidate.indexOf(parent, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : candidate.charAt(index - 1);
    const after = candidate.charAt(index + parent.length);
    if (PATH_BOUNDARY_BEFORE.has(before) && PATH_BOUNDARY_AFTER.has(after)) return true;
    from = index + parent.length;
  }
  return false;
};

const probeLiveAntigravityExtracts = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  // `/proc` is a kernel fact. Driver tests simulate a win32 host on Unix,
  // where renaming a directory does not mean "no open handle".
  const proc = yield* fs.exists("/proc/self/cwd").pipe(Effect.orElseSucceed(() => false));
  const paths = proc
    ? yield* linuxProcExtractReferences()
    : platform === "darwin"
      ? yield* darwinLsofExtractReferences(candidates)
      : platform === "win32"
        ? yield* windowsProcessExtractReferences()
        : [];
  return {
    paths,
    protectOpenHandles: !proc && platform === "win32",
    caseInsensitive: platform === "win32",
  } satisfies LiveAntigravityExtractProbe;
});

const liveExtractIsReferenced = Effect.fnUntraced(function* (
  directory: string,
  live: LiveAntigravityExtractProbe,
) {
  const fs = yield* FileSystem.FileSystem;
  const keys = [directory];
  const real = yield* fs.realPath(directory).pipe(Effect.option);
  if (Option.isSome(real) && real.value !== directory) keys.push(real.value);
  return live.paths.some((reference) =>
    keys.some((key) => pathReferencesDirectory(key, reference, live.caseInsensitive)),
  );
});

const removeUnreferencedAntigravityExtract = Effect.fnUntraced(function* (
  directory: string,
  protectOpenHandles: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!protectOpenHandles) {
    yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
    return;
  }
  // Renaming a Windows directory fails while any file inside is open, and
  // the failure happens before any file is unlinked.
  const staged = `${directory}.${process.pid}.t3-mei-sweep`;
  const moved = yield* fs.rename(directory, staged).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!moved) return;
  const restored = yield* fs.rename(staged, directory).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!restored) {
    yield* fs.remove(staged, { recursive: true, force: true }).pipe(Effect.ignore);
    return;
  }
  yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
});

const pushMeiReference = (references: Array<string>, value: string) => {
  if (value.includes("_MEI")) references.push(value);
};

const collectProcLink = Effect.fnUntraced(function* (references: Array<string>, linkPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* fs.readLink(linkPath).pipe(Effect.option);
  if (Option.isNone(target)) return;
  pushMeiReference(references, target.value);
});

const collectProcMeipass = Effect.fnUntraced(function* (
  references: Array<string>,
  environPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(environPath).pipe(Effect.option);
  if (Option.isNone(bytes)) return;
  // The initial environment only. Later `process.env` writes are invisible here.
  const text = new TextDecoder().decode(bytes.value);
  for (const entry of text.split("\0")) {
    if (!entry.startsWith("_MEIPASS=")) continue;
    pushMeiReference(references, entry.slice("_MEIPASS=".length));
  }
});

const linuxProcExtractReferences = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
  const references: Array<string> = [];
  const self = String(process.pid);
  for (const entry of entries) {
    if (entry === self || !/^[0-9]+$/.test(entry)) continue;
    const base = `/proc/${entry}`;
    yield* collectProcLink(references, `${base}/cwd`);
    yield* collectProcMeipass(references, `${base}/environ`);
    const fds = yield* fs.readDirectory(`${base}/fd`).pipe(Effect.orElseSucceed(() => []));
    for (const fd of fds) {
      yield* collectProcLink(references, `${base}/fd/${fd}`);
    }
  }
  return references;
});

const commandOutputReferences = (output: string, stripLsofPrefix: boolean): Array<string> => {
  const normalized = output.replaceAll("\u0000", "").replaceAll("\uFEFF", "");
  const references: Array<string> = [];
  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();
    const value = stripLsofPrefix && trimmed.startsWith("n") ? trimmed.slice(1) : trimmed;
    pushMeiReference(references, value);
  }
  return references;
};

const darwinLsofExtractReferences = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const references: Array<string> = [];
  for (const directory of candidates) {
    const output = yield* spawner
      .string(
        ChildProcess.make("lsof", ["-n", "-P", "-F", "n", "+D", directory], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.orElseSucceed(() => ""));
    references.push(...commandOutputReferences(output, true));
  }
  return references;
});

const WINDOWS_LIVE_EXTRACT_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  if ($_.ExecutablePath -like '*_MEI*') { Write-Output $_.ExecutablePath }",
  "  if ($_.CommandLine -like '*_MEI*') { Write-Output $_.CommandLine }",
  "}",
  "Get-Process | Where-Object { $_.ProcessName -match 'agy|localharness|antigravity' } | ForEach-Object {",
  "  try {",
  "    foreach ($module in $_.Modules) {",
  "      if ($module.FileName -like '*_MEI*') { Write-Output $module.FileName }",
  "    }",
  "  } catch {}",
  "}",
].join("\n");

const windowsProcessExtractReferences = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIVE_EXTRACT_SCRIPT],
        { stdin: "ignore", stderr: "ignore", windowsHide: true },
      ),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  return commandOutputReferences(output, false);
});
