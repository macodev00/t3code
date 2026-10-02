import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ClaudeSettings,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform, isHostWindows } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
/** Encode the fake CLI's per-model response map as a JSON environment value. */
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
/**
 * Write a fake `claude` binary that records the `--model` argument and can
 * answer per model.
 */
function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const binDir = path.join(dir, "bin");
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source: [
        "const argv = process.argv.slice(2);",
        'const args = argv.join(" ");',
        'const { appendFileSync, realpathSync } = await import("node:fs");',
        "",
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "",
        'const permissionIndex = argv.indexOf("--permission-mode");',
        'if (permissionIndex === -1 || argv[permissionIndex + 1] !== "dontAsk") {',
        '  fail("text generation must deny permission prompts", 12);',
        "}",
        'const toolsIndex = argv.indexOf("--tools");',
        'if (toolsIndex === -1 || argv[toolsIndex + 1] !== "") {',
        '  fail("text generation must receive an explicit empty tool set", 6);',
        "}",
        'if (argv.includes("--dangerously-skip-permissions")) {',
        '  fail("text generation must not bypass permissions", 7);',
        "}",
        'if (!argv.includes("--disable-slash-commands")) {',
        '  fail("text generation must disable skills", 8);',
        "}",
        'if (!argv.includes("--strict-mcp-config")) {',
        '  fail("text generation must not load configured MCP servers", 9);',
        "}",
        'const settingsIndex = argv.indexOf("--settings");',
        "if (settingsIndex === -1 || JSON.parse(argv[settingsIndex + 1]).disableAllHooks !== true) {",
        '  fail("text generation must disable hooks", 10);',
        "}",
        "const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;",
        "if (cwdMustNotBe && realpathSync(process.cwd()) === realpathSync(cwdMustNotBe)) {",
        '  fail("text generation ran in the project directory", 11);',
        "}",
        "",
        'let stdinContent = "";',
        "if (!process.stdin.isTTY) {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(chunk);",
        "  }",
        '  stdinContent = Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (argsMustContain && !args.includes(argsMustContain)) {",
        '  fail("args missing expected content", 2);',
        "}",
        "",
        "const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (argsMustNotContain && args.includes(argsMustNotContain)) {",
        '  fail("args contained forbidden content", 3);',
        "}",
        "",
        "const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '  fail("stdin missing expected content", 4);',
        "}",
        "",
        "const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;",
        "if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {",
        '  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);',
        "}",
        "",
        'const modelIndex = argv.indexOf("--model");',
        'const model = modelIndex === -1 ? "" : (argv[modelIndex + 1] ?? "");',
        "const modelLog = process.env.T3_FAKE_CLAUDE_MODEL_LOG;",
        'if (modelLog) appendFileSync(modelLog, model + "\\n");',
        "const modelResponsesRaw = process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES;",
        "const modelResponse = modelResponsesRaw ? JSON.parse(modelResponsesRaw)[model] : undefined;",
        "if (modelResponse) {",
        '  if (modelResponse.stderr) process.stderr.write(modelResponse.stderr + "\\n");',
        '  process.stdout.write(modelResponse.stdout ?? "");',
        "  process.exitCode = Number(modelResponse.exitCode ?? 0);",
        "} else {",
        "  const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;",
        "  if (stderrText) {",
        '    process.stderr.write(stderrText + "\\n");',
        "  }",
        '  process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        "  process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);",
        "}",
        "",
      ].join("\n"),
    });
    return binDir;
  });
}

/** Per-model stdout, stderr, and exit code for the fake Claude CLI. */
interface FakeClaudeModelResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * Run `effectFn` against a Claude text-generation service whose `claude`
 * binary is the test stub. Restores the process environment afterwards.
 */
function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
    modelResponses?: Readonly<Record<string, FakeClaudeModelResponse>>;
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    context: { readonly modelLogPath: string },
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const modelLogPath = path.join(tempDir, "claude-models.log");
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* isHostWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
    const previousModelLog = process.env.T3_FAKE_CLAUDE_MODEL_LOG;
    const previousModelResponses = process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }

        process.env.T3_FAKE_CLAUDE_MODEL_LOG = modelLogPath;
        if (input.modelResponses !== undefined) {
          process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES = encodeUnknownJson(input.modelResponses);
        } else {
          delete process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }

          if (previousModelLog === undefined) {
            delete process.env.T3_FAKE_CLAUDE_MODEL_LOG;
          } else {
            process.env.T3_FAKE_CLAUDE_MODEL_LOG = previousModelLog;
          }

          if (previousModelResponses === undefined) {
            delete process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES;
          } else {
            process.env.T3_FAKE_CLAUDE_MODEL_RESPONSES = previousModelResponses;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      undefined,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration, { modelLogPath });
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings without passing unsupported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                SYNTHETIC_CLAUDE_THINKING_MODEL,
                [
                  { id: "thinking", value: false },
                  { id: "effort", value: "high" },
                ],
              ),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("keeps a configured custom alias opaque to the Claude CLI", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Keep custom model",
            body: "",
          },
        }),
        argsMustContain: `--model ${SYNTHETIC_CLAUDE_COLLIDING_ALIAS} --settings`,
        claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/custom-model",
            commitSummary: "Keep custom model",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "expanded" },
              ],
            ),
          });

          expect(generated.title).toBe("Keep custom model");
        }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.branch).toBe("call-script");
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  for (const verbose of [false, true]) {
    it.effect(`unwraps a JSON title in ${verbose ? "verbose" : "normal"} Claude output`, () => {
      const result = {
        type: "result",
        structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
      };
      return withFakeClaudeEnv(
        { output: JSON.stringify(verbose ? [result] : result) },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Refresh ev-stg APP ASG instances",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
          }),
      );
    });
  }

  for (const previousTitle of [undefined, "Old thread title"]) {
    it.effect(
      `reads the result from verbose Claude output when ${previousTitle ? "regenerating" : "generating"} a title`,
      () =>
        withFakeClaudeEnv(
          {
            output: JSON.stringify([
              { type: "system", subtype: "init" },
              { type: "assistant", message: { content: [] } },
              { type: "user", message: { content: [] } },
              { type: "rate_limit_event" },
              {
                type: "result",
                subtype: "success",
                result: '{"title":"Refresh ev-stg APP ASG Instances"}',
                structured_output: { title: "Refresh ev-stg APP ASG Instances" },
              },
            ]),
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Refresh ev-stg APP ASG instances",
                previousTitle,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              });

              expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
            }),
        ),
    );
  }

  for (const [name, output] of [
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const) {
    it.effect(`rejects verbose Claude output with ${name}`, () =>
      withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
        }),
      ),
    );
  }

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  const configuredProductModel =
    DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")];
  if (configuredProductModel === undefined) {
    throw new Error("Claude product text-generation model is not configured");
  }
  const productModel = configuredProductModel;
  const customModel = "z-ai/glm-5.3-flash";
  const wrapperStderr =
    "Using the OpenRouter credential from the global credential ~/.ori/credentials.json.";
  const modelBlockedStdout = JSON.stringify({
    api_error_status: 400,
    is_error: true,
    result:
      "API Error: 400 0 endpoints out of 4 requested are available matching your guardrail restrictions and data policy. Model blocked by guardrail: 4 endpoints excluded",
  });
  const contentGuardrailStdout = JSON.stringify({
    api_error_status: 400,
    is_error: true,
    result: "API Error: 400 Request blocked by a content guardrail. The prompt violates policy.",
  });

  /**
   * Read the models the fake Claude CLI was spawned with, in order.
   */
  const readSpawnedModels = (modelLogPath: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return (yield* fs.readFileString(modelLogPath))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    });

  /**
   * Assert a CLI failure exposes only a bounded category and the process exit.
   */
  const expectBoundedCliFailure = (
    error: { readonly detail: string; readonly cause?: unknown },
    expectedDetail: string,
    forbidden: ReadonlyArray<string>,
  ) => {
    expect(error.detail).toBe(expectedDetail);
    expect(error.cause).toBeInstanceOf(Error);
    if (!(error.cause instanceof Error)) {
      throw new Error("expected a process-exit cause");
    }
    expect(error.cause.message).toBe("Claude CLI process exited with code 1");
    for (const fragment of [error.detail, error.cause.message]) {
      for (const secret of forbidden) {
        expect(fragment).not.toContain(secret);
      }
    }
  };

  it.effect("keeps the product text-generation model when that slug succeeds", () => {
    expect(productModel).toBe("claude-haiku-4-5");
    return withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: { subject: "Keep the product model", body: "" },
        }),
        claudeConfig: { customModels: [customModel] },
      },
      (textGeneration, { modelLogPath }) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: productModel,
            },
          });

          expect(generated.subject).toBe("Keep the product model");
          expect(yield* readSpawnedModels(modelLogPath)).toEqual([productModel]);
        }),
    );
  });

  it.effect("uses a configured custom model only after the product slug is unavailable", () => {
    expect(productModel).toBe("claude-haiku-4-5");
    return withFakeClaudeEnv(
      {
        output: "",
        claudeConfig: { customModels: [customModel] },
        modelResponses: {
          [productModel]: {
            exitCode: 1,
            stderr: wrapperStderr,
            stdout: modelBlockedStdout,
          },
          [customModel]: {
            exitCode: 0,
            stdout: JSON.stringify({
              structured_output: { subject: "Use the configured custom model", body: "" },
            }),
          },
        },
      },
      (textGeneration, { modelLogPath }) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: productModel,
            },
          });

          expect(generated.subject).toBe("Use the configured custom model");
          expect(yield* readSpawnedModels(modelLogPath)).toEqual([productModel, customModel]);
        }),
    );
  });

  it.effect("does not substitute a custom model for a content guardrail", () => {
    expect(productModel).toBe("claude-haiku-4-5");
    return withFakeClaudeEnv(
      {
        output: contentGuardrailStdout,
        exitCode: 1,
        stderr: wrapperStderr,
        claudeConfig: { customModels: [customModel] },
      },
      (textGeneration, { modelLogPath }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "main",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: productModel,
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
          expectBoundedCliFailure(
            error,
            "Claude CLI command failed (cli_failed, exit 1, api_status 400).",
            [wrapperStderr, "content guardrail", "credentials.json", customModel],
          );
          expect(yield* readSpawnedModels(modelLogPath)).toEqual([productModel]);
        }),
    );
  });

  it.effect(
    "does not substitute a custom model when the product slug fails for another reason",
    () => {
      expect(productModel).toBe("claude-haiku-4-5");
      return withFakeClaudeEnv(
        {
          output: "",
          exitCode: 1,
          stderr: wrapperStderr,
          claudeConfig: { customModels: [customModel] },
        },
        (textGeneration, { modelLogPath }) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              textGeneration.generateCommitMessage({
                cwd: process.cwd(),
                branch: "main",
                stagedSummary: "M README.md",
                stagedPatch: "diff --git a/README.md b/README.md",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: productModel,
                },
              }),
            );

            expect(error._tag).toBe("TextGenerationError");
            expectBoundedCliFailure(error, "Claude CLI command failed (cli_failed, exit 1).", [
              wrapperStderr,
              "credentials.json",
              customModel,
            ]);
            expect(yield* readSpawnedModels(modelLogPath)).toEqual([productModel]);
          }),
      );
    },
  );

  it.effect(
    "reports a bounded category when the product model is unavailable and no custom model exists",
    () => {
      expect(productModel).toBe("claude-haiku-4-5");
      return withFakeClaudeEnv(
        {
          output: modelBlockedStdout,
          exitCode: 1,
          stderr: wrapperStderr,
        },
        (textGeneration, { modelLogPath }) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              textGeneration.generateCommitMessage({
                cwd: process.cwd(),
                branch: "main",
                stagedSummary: "M README.md",
                stagedPatch: "diff --git a/README.md b/README.md",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: productModel,
                },
              }),
            );

            expect(error._tag).toBe("TextGenerationError");
            expectBoundedCliFailure(
              error,
              "Claude CLI command failed (model_unavailable, exit 1, api_status 400).",
              [wrapperStderr, "guardrail", "endpoints excluded", "credentials.json"],
            );
            expect(yield* readSpawnedModels(modelLogPath)).toEqual([productModel]);
          }),
      );
    },
  );

  it.effect("does not replace an explicit non-product model when that model is unavailable", () => {
    expect(productModel).toBe("claude-haiku-4-5");
    return withFakeClaudeEnv(
      {
        output: modelBlockedStdout,
        exitCode: 1,
        stderr: wrapperStderr,
        claudeConfig: { customModels: [customModel] },
      },
      (textGeneration, { modelLogPath }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "main",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
          expectBoundedCliFailure(
            error,
            "Claude CLI command failed (model_unavailable, exit 1, api_status 400).",
            [wrapperStderr, customModel],
          );
          const models = yield* readSpawnedModels(modelLogPath);
          expect(models).toHaveLength(1);
          expect(models[0]?.startsWith(SYNTHETIC_CLAUDE_STANDARD_MODEL)).toBe(true);
          expect(models.some((model) => model.includes(customModel))).toBe(false);
        }),
    );
  });
});
