/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGeneration service contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  TextGenerationError,
  type ClaudeSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as TextGeneration from "./TextGeneration.ts";
import {
  customModelForBrokenTextGenerationFallback,
  isBrokenProductTextGenerationFallback,
} from "./TextGenerationModelFallback.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_PRODUCT_TEXT_GENERATION_MODEL =
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")];

function claudeCliFailureDetail(exitCode: number, stdout: string, stderr: string): string {
  const stderrDetail = stderr.trim();
  const stdoutDetail = stdout.trim();
  const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
  return detail.length > 0
    ? `Claude CLI command failed: ${detail}`
    : `Claude CLI command failed with code ${exitCode}.`;
}

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * Verbose mode wraps the result in an array of conversation messages.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const catalog = yield* scopedModelCatalog;
    const requestedModel = resolveClaudeModelSlug(catalog, modelSelection.model);
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      selection: ModelSelection,
    ) {
      const resolvedSelection = {
        ...selection,
        model: resolveClaudeModelSlug(catalog, selection.model),
      };
      const caps = getClaudeCatalogModelCapabilities(catalog, resolvedSelection.model);
      const descriptors = getProviderOptionDescriptors({
        caps,
        selections: resolvedSelection.options,
      });
      const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
      const rawEffortSelection = getModelSelectionStringOptionValue(resolvedSelection, "effort");
      const resolvedEffort = resolveClaudeCatalogEffort(
        catalog,
        resolvedSelection.model,
        rawEffortSelection,
      );
      const cliEffort = normalizeClaudeCatalogEffort(
        catalog,
        resolvedEffort,
        resolvedSelection.model,
      );
      const ultracode = isClaudeCatalogUltracodeEffort(resolvedEffort);
      const thinkingDescriptor = findDescriptor("thinking");
      const fastModeDescriptor = findDescriptor("fastMode");
      const thinking =
        thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
      const fastMode =
        fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
      const settings = {
        disableAllHooks: true,
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
      };
      const settingsJson = yield* encodeJsonForOperation(
        operation,
        settings,
        "Failed to encode Claude CLI settings.",
      );
      // Titles need only the supplied prompt, not configuration from the checkout.
      const workingDirectory =
        operation === "generateThreadTitle"
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "t3code-claude-title-" })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError("claude", operation, cause, "Failed to create title directory"),
                ),
              )
          : cwd;
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          // Metadata prompts need no executable capabilities, even when they contain a skill name.
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode };
    });

    const runOnce = (selection: ModelSelection) =>
      runClaudeCommand(selection).pipe(Effect.scoped, Effect.timeoutOption(CLAUDE_TIMEOUT_MS));

    const first = yield* runOnce(modelSelection);
    if (Option.isNone(first)) {
      return yield* new TextGenerationError({ operation, detail: "Claude CLI request timed out." });
    }

    let outcome = first.value;
    if (outcome.exitCode !== 0 && CLAUDE_PRODUCT_TEXT_GENERATION_MODEL !== undefined) {
      const customModel = customModelForBrokenTextGenerationFallback(
        claudeSettings.customModels,
        CLAUDE_PRODUCT_TEXT_GENERATION_MODEL,
      );
      // The product slug was just attempted. A custom model is used only when
      // that attempt reports the model is unavailable.
      if (
        customModel !== null &&
        isBrokenProductTextGenerationFallback({
          productModel: CLAUDE_PRODUCT_TEXT_GENERATION_MODEL,
          requestedModel,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
        })
      ) {
        yield* Effect.logInfo(
          "Retrying one-shot text generation with a configured custom model after the product model was unavailable",
          {
            operation,
            productModel: CLAUDE_PRODUCT_TEXT_GENERATION_MODEL,
            customModel,
          },
        );
        const second = yield* runOnce({
          instanceId: modelSelection.instanceId,
          model: customModel,
        });
        if (Option.isNone(second)) {
          return yield* new TextGenerationError({
            operation,
            detail: "Claude CLI request timed out.",
          });
        }
        outcome = second.value;
      }
    }

    if (outcome.exitCode !== 0) {
      return yield* new TextGenerationError({
        operation,
        detail: claudeCliFailureDetail(outcome.exitCode, outcome.stdout, outcome.stderr),
      });
    }

    const rawStdout = outcome.stdout;

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ClaudeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runClaudeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("ClaudeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runClaudeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("ClaudeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("ClaudeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
