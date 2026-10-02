/**
 * Decide when one-shot text generation may leave the product model.
 *
 * Commit, PR, branch, and title generation keep the product slug whenever
 * that attempt can run. A configured custom model is a substitute only after
 * the product slug was the model just tried and the CLI reported that this
 * model is unavailable.
 */
import type { CustomModelSetting } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";

const UNAVAILABLE_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /model blocked/i,
  /guardrail/i,
  /unknown model/i,
  /model not found/i,
  /invalid model/i,
  /unsupported model/i,
  /no such model/i,
  /model.{0,80}not available/i,
  /not available.{0,80}model/i,
  /endpoints excluded/i,
  /\d+\s+endpoints?\s+out of\s+\d+/i,
];

export function isBrokenProductTextGenerationFallback(input: {
  readonly productModel: string;
  readonly requestedModel: string;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  if (input.requestedModel.trim() !== input.productModel.trim()) {
    return false;
  }
  const text = `${input.stdout}\n${input.stderr}`;
  return UNAVAILABLE_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

/** First configured custom slug other than the product model, if there is one. */
export function customModelForBrokenTextGenerationFallback(
  customModels: ReadonlyArray<CustomModelSetting>,
  productModel: string,
): string | null {
  return (
    readCustomModelEntries(customModels).find((entry) => entry.slug !== productModel)?.slug ?? null
  );
}
