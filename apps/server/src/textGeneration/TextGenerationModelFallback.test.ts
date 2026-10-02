import { describe, expect, it } from "vite-plus/test";

import {
  customModelForBrokenTextGenerationFallback,
  isBrokenProductTextGenerationFallback,
} from "./TextGenerationModelFallback.ts";

const PRODUCT_MODEL = "claude-haiku-4-5";
const CUSTOM_MODEL = "z-ai/glm-5.3-flash";
const WRAPPER_STDERR =
  "Using the OpenRouter credential from the global credential ~/.ori/credentials.json.";
const GUARDRAIL_STDOUT = JSON.stringify({
  api_error_status: 400,
  is_error: true,
  result:
    "API Error: 400 0 endpoints out of 4 requested are available matching your guardrail restrictions and data policy. Model blocked by guardrail: 4 endpoints excluded",
});

describe("isBrokenProductTextGenerationFallback", () => {
  it("keeps a healthy product-model response on the product slug", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: JSON.stringify({ structured_output: { subject: "Keep the product model" } }),
        stderr: "",
      }),
    ).toBe(false);
  });

  it("treats a guardrail rejection of the product slug as a broken fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: GUARDRAIL_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(true);
  });

  it("does not treat wrapper stderr alone as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "",
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(false);
  });

  it("does not treat a rejected non-product model as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: "claude-opus-4-6",
        stdout: GUARDRAIL_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(false);
  });
});

describe("customModelForBrokenTextGenerationFallback", () => {
  it("uses the first configured custom model", () => {
    expect(customModelForBrokenTextGenerationFallback([CUSTOM_MODEL], PRODUCT_MODEL)).toBe(
      CUSTOM_MODEL,
    );
  });

  it("returns null when no custom model is configured", () => {
    expect(customModelForBrokenTextGenerationFallback([], PRODUCT_MODEL)).toBeNull();
  });

  it("returns null when the only custom slug is the product model", () => {
    expect(customModelForBrokenTextGenerationFallback([PRODUCT_MODEL], PRODUCT_MODEL)).toBeNull();
  });

  it("skips the product slug and uses the next custom model", () => {
    expect(
      customModelForBrokenTextGenerationFallback([PRODUCT_MODEL, CUSTOM_MODEL], PRODUCT_MODEL),
    ).toBe(CUSTOM_MODEL);
  });
});
