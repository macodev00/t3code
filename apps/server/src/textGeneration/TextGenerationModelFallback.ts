/**
 * Decide when one-shot text generation may leave the product model.
 *
 * Commit, PR, branch, and title generation keep the product slug whenever
 * that attempt can run. A configured custom model is a substitute only after
 * the product slug was the model just tried and the CLI reported that this
 * model is unavailable. Prompt and content guardrail failures are not that
 * case.
 */
import type { CustomModelSetting } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Phrases that name the model as missing or unusable.
 *
 * A bare `/guardrail/i` match is intentionally absent. Prompt and content
 * guardrails use that word without saying the requested model is unavailable.
 * `model blocked by guardrail` stays, because that phrase is the model block
 * reported for a refused product slug.
 */
const EXPLICIT_MODEL_UNAVAILABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bunknown model\b/i,
  /\bmodel not found\b/i,
  /\bno such model\b/i,
  /\bunsupported model\b/i,
  /\binvalid model(?:\s+(?:id|name|slug))?\b(?!\s+output)/i,
  /\bmodel(?:\s+(?:id|name|slug))? is not available\b/i,
  /\bmodel blocked by guardrail\b/i,
];

/**
 * OpenRouter refuses a model by reporting that none of its endpoints remain.
 * Either half alone is not specific enough to retry.
 */
const OPENROUTER_ENDPOINT_COUNT_PATTERN = /\b\d+\s+endpoints?\s+out of\s+\d+\b/i;
const OPENROUTER_ENDPOINTS_EXCLUDED_PATTERN = /\bendpoints? excluded\b/i;

const CLI_FAILURE_CATEGORIES = ["model_unavailable", "cli_failed"] as const;

/** Bounded label for a finished CLI attempt. Never includes process output. */
export type TextGenerationCliFailureCategory = (typeof CLI_FAILURE_CATEGORIES)[number];

const ClaudeApiErrorStatusEnvelope = Schema.Struct({
  api_error_status: Schema.optionalKey(Schema.Number),
});
const decodeClaudeApiErrorStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeApiErrorStatusEnvelope),
);

/**
 * Report whether CLI output says the model that was just requested cannot be
 * used. Content and prompt guardrail text does not match.
 */
function isModelUnavailableCliOutput(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`;
  if (EXPLICIT_MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return (
    OPENROUTER_ENDPOINT_COUNT_PATTERN.test(text) && OPENROUTER_ENDPOINTS_EXCLUDED_PATTERN.test(text)
  );
}

/**
 * Report whether a failed product-model attempt may be retried with a
 * configured custom model.
 *
 * True only when `requestedModel` is the product slug and the CLI output says
 * that model is unavailable. Callers use this to decide a single retry; a
 * content or prompt guardrail stays on the original failure.
 */
export function isBrokenProductTextGenerationFallback(input: {
  readonly productModel: string;
  readonly requestedModel: string;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  if (input.requestedModel.trim() !== input.productModel.trim()) {
    return false;
  }
  return isModelUnavailableCliOutput(input.stdout, input.stderr);
}

/**
 * Return the first configured custom slug other than the product model.
 * Returns null when there is no distinct custom model to substitute.
 */
export function customModelForBrokenTextGenerationFallback(
  customModels: ReadonlyArray<CustomModelSetting>,
  productModel: string,
): string | null {
  return (
    readCustomModelEntries(customModels).find((entry) => entry.slug !== productModel)?.slug ?? null
  );
}

/**
 * Classify CLI output for a caller-facing error.
 * The result is a fixed label. Stdout and stderr are not returned.
 */
export function textGenerationCliFailureCategory(input: {
  readonly stdout: string;
  readonly stderr: string;
}): TextGenerationCliFailureCategory {
  return isModelUnavailableCliOutput(input.stdout, input.stderr)
    ? "model_unavailable"
    : "cli_failed";
}

/**
 * Read an HTTP status from a Claude JSON error envelope, when one is present.
 * Non-integers and values outside 100–599 are dropped so the result stays bounded.
 */
export function boundedCliApiErrorStatus(stdout: string): number | undefined {
  const decoded = decodeClaudeApiErrorStatus(stdout);
  if (Option.isNone(decoded) || decoded.value.api_error_status === undefined) {
    return undefined;
  }
  const status = decoded.value.api_error_status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status;
}
