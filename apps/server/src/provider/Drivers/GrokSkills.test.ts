import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  discoverGrokSkillCommands,
  discoverGrokSkills,
  prepareGrokSkillPrompt,
  rewriteGrokSkillPrompt,
} from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

const makeInspectSpawner = (stdout: string, exitCode = 0, spawnCwds?: Array<string | undefined>) =>
  ChildProcessSpawner.make((command) => {
    spawnCwds?.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

describe("discoverGrokSkills", () => {
  it.effect("maps inspect entries onto provider skills, sorted by name", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});

      expect(skills).toEqual([
        {
          name: "deploy",
          description: "Deploy the app.",
          path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
          scope: "plugin",
          enabled: true,
        },
        {
          name: "writing-docs",
          description: "Write user docs.",
          path: "/home/dev/.grok/skills/writing-docs/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            {
              name: "writing-docs",
              description: "Write user docs.",
              source: { type: "user", path: "/home/dev/.grok/skills/writing-docs/SKILL.md" },
              userInvocable: true,
            },
            {
              name: "deploy",
              description: "Deploy the app.",
              source: {
                type: "plugin",
                path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
              },
              userInvocable: true,
            },
          ]),
        ),
      ),
    ),
  );

  it.effect("disables skills the CLI marks as not user-invocable", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});

      expect(skills).toEqual([
        {
          name: "internal-helper",
          path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
          scope: "bundled",
          enabled: false,
        },
      ]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            {
              name: "internal-helper",
              source: {
                type: "bundled",
                path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
              },
              userInvocable: false,
            },
          ]),
        ),
      ),
    ),
  );

  it.effect("skips entries without a name or a filesystem path", () =>
    Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {});
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
            { name: "no-path", source: { type: "user" } },
            { name: "no-source" },
            "not-an-object",
            { name: "kept", source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" } },
          ]),
        ),
      ),
    ),
  );

  it.effect("rejects malformed or unexpected output as a decode failure", () =>
    Effect.gen(function* () {
      for (const stdout of ["not json", "null", '{"skills":"nope"}', "{}"]) {
        const error = yield* discoverGrokSkills({ binaryPath: "grok" }, {}).pipe(
          Effect.flip,
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeInspectSpawner(stdout),
          ),
        );
        expect(error).toMatchObject({ _tag: "GrokSkillsProbeError", stage: "decode" });
      }
    }),
  );

  it.effect("spawns in the configured cwd and rejects a failed probe", () => {
    const spawnCwds: Array<string | undefined> = [];
    const stdout = inspectPayload([
      {
        name: "kept",
        source: { type: "project", path: "/workspaces/demo/.grok/skills/kept/SKILL.md" },
      },
    ]);

    return Effect.gen(function* () {
      const skills = yield* discoverGrokSkills({ binaryPath: "grok" }, {}, "/workspaces/demo").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(stdout, 0, spawnCwds),
        ),
      );

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);

      const failed = yield* discoverGrokSkills({ binaryPath: "grok" }).pipe(
        Effect.result,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(stdout, 1),
        ),
      );
      expect(failed._tag).toBe("Failure");
    });
  });
});

const advertisedCommands = new Map<string, string>([
  ["poteto-mode", "poteto-mode"],
  ["review", "review"],
  ["implement", "implement"],
  ["2spec", "2spec"],
  ["login", "acme:login"],
  ["acme:login", "acme:login"],
]);

describe("rewriteGrokSkillPrompt", () => {
  it("rewrites a leading $skill mention into the slash command Grok expands", () => {
    expect(
      rewriteGrokSkillPrompt("$poteto-mode reply with the single word hi", advertisedCommands),
    ).toBe("/poteto-mode reply with the single word hi");
    expect(rewriteGrokSkillPrompt("  $poteto-mode hi", advertisedCommands)).toBe(
      "  /poteto-mode hi",
    );
  });

  it("moves a mid-message mention to the front and rewrites later ones in place", () => {
    expect(rewriteGrokSkillPrompt("please $poteto-mode reply hi", advertisedCommands)).toBe(
      "/poteto-mode please reply hi",
    );
    expect(
      rewriteGrokSkillPrompt("$review the diff, then $implement the fixes", advertisedCommands),
    ).toBe("/review the diff, then /implement the fixes");
    expect(
      rewriteGrokSkillPrompt(
        "please $review the diff, then $implement the fixes",
        advertisedCommands,
      ),
    ).toBe("/review please the diff, then /implement the fixes");
    expect(rewriteGrokSkillPrompt("line one\nline two $review now", advertisedCommands)).toBe(
      "/review line one\nline two now",
    );
  });

  it("does not hoist over a slash command the user already started", () => {
    expect(rewriteGrokSkillPrompt("/compact and $review the diff", advertisedCommands)).toBe(
      "/compact and /review the diff",
    );
  });

  it("leaves unknown mentions, currency, and glued tokens unchanged", () => {
    expect(rewriteGrokSkillPrompt("echo $HOME then $unknown", advertisedCommands)).toBe(
      "echo $HOME then $unknown",
    );
    expect(rewriteGrokSkillPrompt("cost is 5$review and $20 or $1e6", advertisedCommands)).toBe(
      "cost is 5$review and $20 or $1e6",
    );
    expect(rewriteGrokSkillPrompt("€review here", advertisedCommands)).toBe("/review here");
    expect(rewriteGrokSkillPrompt("use €review here", advertisedCommands)).toBe("/review use here");
    expect(rewriteGrokSkillPrompt("use $2spec here", advertisedCommands)).toBe("/2spec use here");
  });

  it("uses the qualified invocation when the bare name collides", () => {
    expect(rewriteGrokSkillPrompt("$login now", advertisedCommands)).toBe("/acme:login now");
    expect(rewriteGrokSkillPrompt("please $login now", advertisedCommands)).toBe(
      "/acme:login please now",
    );
  });
});

describe("discoverGrokSkillCommands", () => {
  it.effect("maps advertised names and skips skills the CLI will not expand", () =>
    Effect.gen(function* () {
      const commands = yield* discoverGrokSkillCommands({ binaryPath: "grok" }, {});

      expect(commands.get("poteto-mode")).toBe("poteto-mode");
      expect(commands.get("login")).toBe("acme:login");
      expect(commands.get("acme:login")).toBe("acme:login");
      expect(commands.get("local:commit")).toBe("local:commit");
      expect(commands.get("user:commit")).toBe("user:commit");
      expect(commands.has("commit")).toBe(false);
      expect(commands.has("always-approve")).toBe(false);
      expect(commands.has("internal")).toBe(false);
      expect(commands.has("hidden")).toBe(false);
      expect(rewriteGrokSkillPrompt("$commit go", commands)).toBe("$commit go");
      expect(rewriteGrokSkillPrompt("$always-approve go", commands)).toBe("$always-approve go");
      expect(rewriteGrokSkillPrompt("$local:commit go", commands)).toBe("/local:commit go");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeInspectSpawner(
          inspectPayload([
            { name: "poteto-mode", userInvocable: true },
            {
              name: "login",
              userInvocable: true,
              collidesWith: "login",
              invocableAs: "acme:login",
            },
            {
              name: "commit",
              userInvocable: true,
              collidesWith: "commit",
              invocableAs: "local:commit",
            },
            {
              name: "commit",
              userInvocable: true,
              collidesWith: "commit",
              invocableAs: "user:commit",
            },
            { name: "always-approve", userInvocable: true, collidesWith: "always-approve" },
            { name: "internal", userInvocable: false },
            { name: "hidden", userInvocable: true, disabled: true },
          ]),
        ),
      ),
    ),
  );

  it.effect("spawns in the turn cwd and rejects a failed probe", () => {
    const spawnCwds: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const commands = yield* discoverGrokSkillCommands(
        { binaryPath: "grok" },
        {},
        "/workspaces/demo",
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(
            inspectPayload([{ name: "poteto-mode", userInvocable: true }]),
            0,
            spawnCwds,
          ),
        ),
      );
      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(commands.get("poteto-mode")).toBe("poteto-mode");

      const failed = yield* discoverGrokSkillCommands({ binaryPath: "grok" }).pipe(
        Effect.result,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeInspectSpawner(inspectPayload([]), 1),
        ),
      );
      expect(failed._tag).toBe("Failure");
    });
  });
});

describe("prepareGrokSkillPrompt", () => {
  const settings = { binaryPath: "grok" };

  it.effect("does not probe when the prompt has no skill token", () => {
    let spawns = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawns += 1;
      return Effect.die("grok inspect should not run");
    });
    return Effect.gen(function* () {
      const text = yield* prepareGrokSkillPrompt({
        text: "cost is $20 today",
        cwd: "/workspace",
        grokSettings: settings,
        environment: {},
        cache: new Map(),
      });
      expect(text).toBe("cost is $20 today");
      expect(spawns).toBe(0);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });

  it.effect("caches a successful catalog and retries after a failed probe", () => {
    let spawns = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawns += 1;
      const stdout =
        spawns === 1 ? "not json" : inspectPayload([{ name: "poteto-mode", userInvocable: true }]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const cache = new Map<string, ReadonlyMap<string, string>>();
      const input = {
        text: "$poteto-mode reply hi",
        cwd: "/workspace",
        grokSettings: settings,
        environment: {},
        cache,
      };
      expect(yield* prepareGrokSkillPrompt(input)).toBe("$poteto-mode reply hi");
      expect(cache.size).toBe(0);
      expect(yield* prepareGrokSkillPrompt(input)).toBe("/poteto-mode reply hi");
      expect(yield* prepareGrokSkillPrompt(input)).toBe("/poteto-mode reply hi");
      expect(spawns).toBe(2);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });
});
