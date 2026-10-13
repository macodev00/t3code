/**
 * Host setup the shared headless browser needs, and the one command that does
 * it. Sandbox and library failures name that command, so the server log, an
 * agent's tool error, and the viewer all offer the same fix: `sudo t3 browser setup`.
 *
 * Running as root is a different failure. Chrome refuses to start its sandbox
 * as uid 0, and setup cannot change that. That error names a nonroot `User=`
 * or `T3CODE_SERVER_BROWSER_SANDBOX=0` instead of the AppArmor command.
 *
 * T3 never turns Chrome's sandbox off by itself. A host that cannot give it one
 * gets the command instead, and only the operator's explicit
 * `T3CODE_SERVER_BROWSER_SANDBOX=0` launches without it.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The subcommand that sets the host up; callers render it, with `sudo`, for how T3 was launched. */
export const SETUP_SUBCOMMAND = "browser setup";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

/** Whether an operator explicitly allowed Chrome to run without its sandbox. */
export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

/**
 * Chrome will not start its sandbox for a process whose uid is 0
 * (crbug.com/638180). Playwright rewrites that abort to "Chromium sandboxing
 * failed!", which otherwise looks like the AppArmor failure below.
 */
export const sandboxRefusedAsRoot = (input: {
  readonly uid: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => input.uid === 0 && !sandboxDisabled(input.env);

/**
 * `t3 browser setup` is often `sudo` for a normal user, so the setup process
 * is uid 0 even when the server is not. A root shell or a root service has no
 * non-root `SUDO_UID` / `SUDO_USER`.
 */
export const setupWarnsAboutRoot = (input: {
  readonly uid: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => {
  const sudoUid = input.env.SUDO_UID?.trim();
  const sudoUser = input.env.SUDO_USER?.trim();
  const sudoFromNonRoot =
    (sudoUid !== undefined && sudoUid !== "" && sudoUid !== "0") ||
    (sudoUser !== undefined && sudoUser !== "" && sudoUser !== "root");
  return sandboxRefusedAsRoot(input) && !sudoFromNonRoot;
};

/** What a launch or setup reports when Chrome will not sandbox uid 0. */
export const ROOT_SANDBOX_MESSAGE =
  "T3 is running as root, and Chrome refuses to start its sandbox as root. Run the service as a nonroot `User=`, or set `T3CODE_SERVER_BROWSER_SANDBOX=0` to run the browser without its sandbox.";

/** Chrome's own abort when it is asked to sandbox uid 0. Playwright may hide this line. */
const CHROME_ROOT_REFUSAL = /running as root without --no-sandbox|crbug\.com\/638180/i;

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome-headless-shell";

/**
 * Lets T3's headless browser, in any T3 home and at any pinned version, create
 * the user namespace Chrome's sandbox runs in. Modelled on the profile Ubuntu
 * ships for Google Chrome; `unconfined` adds nothing beyond `userns`.
 */
export const APPARMOR_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`;

/**
 * Chrome's Debian dependencies that minimal images leave out, from the headless
 * shell's deb.deps. Ubuntu 24.04 and Debian 13 renamed some with a `t64`
 * suffix; setup installs whichever name the host's apt offers.
 */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
];

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries T3's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

export class PreviewBrowserRootError extends Schema.TaggedError<PreviewBrowserRootError>()(
  "PreviewBrowserRootError",
  {},
) {
  override get message(): string {
    return ROOT_SANDBOX_MESSAGE;
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserRootError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
/** glibc's loader abort, naming the first library it could not load. */
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

/**
 * After a launch fails, names the host setup it is missing: the sandbox, from
 * Chrome's own abort message, or shared libraries the loader refuses. A sandbox
 * failure while this process is root is Chrome refusing uid 0, not AppArmor.
 * Undefined when none of these explain it. The library check is Linux only.
 */
export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    const sandboxFailure =
      input.output.includes(NO_SANDBOX_SIGNATURE) || CHROME_ROOT_REFUSAL.test(input.output);
    if (
      sandboxFailure &&
      sandboxRefusedAsRoot({
        uid: yield* HostProcess.UserId,
        env: yield* HostProcess.Environment,
      })
    ) {
      return new PreviewBrowserRootError();
    }
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      return new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);

/**
 * Shared libraries the loader cannot find for `executable`. The browser's own
 * `--version` decides whether any are missing; `ldd` only lists them after the
 * real loader fails, because it can report libraries a host provides another
 * way (NixOS's nix-ld).
 */
export const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore" }), { includeStderr: true })
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => ""),
      );
  const loaderError = LOADER_ERROR.exec(yield* run(executable, ["--version"]))?.[1];
  if (loaderError === undefined) return [];
  const listed = [...(yield* run("ldd", [executable])).matchAll(MISSING_LIBRARY)].map(
    (match) => match[1]!,
  );
  return listed.length > 0 ? listed : [loaderError];
});

/**
 * Whether Chrome's sandbox will be blocked here: the host restricts user
 * namespaces and T3's AppArmor profile is not installed. Readable without
 * root, so the server checks it at startup.
 */
export const sandboxBlocked = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  if (!restricted) return false;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));
