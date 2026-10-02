import { describe, expect, it } from "vite-plus/test";

import {
  boundedCliApiErrorStatus,
  customModelForBrokenTextGenerationFallback,
  isBrokenProductTextGenerationFallback,
  textGenerationCliFailureCategory,
} from "./TextGenerationModelFallback.ts";

const PRODUCT_MODEL = "claude-haiku-4-5";
const CUSTOM_MODEL = "z-ai/glm-5.3-flash";
const WRAPPER_STDERR =
  "Using the OpenRouter credential from the global credential ~/.ori/credentials.json.";
const MODEL_BLOCKED_STDOUT = JSON.stringify({
  api_error_status: 400,
  is_error: true,
  result:
    "API Error: 400 0 endpoints out of 4 requested are available matching your guardrail restrictions and data policy. Model blocked by guardrail: 4 endpoints excluded",
});
const CONTENT_GUARDRAIL_STDOUT = JSON.stringify({
  api_error_status: 400,
  is_error: true,
  result: "API Error: 400 Request blocked by a content guardrail. The prompt violates policy.",
});
const PROMPT_GUARDRAIL_STDERR = "guardrail violation: disallowed prompt content";

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

  it("treats a model-blocked product slug as a broken fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: MODEL_BLOCKED_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(true);
  });

  it("treats an endpoint exclusion block as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "0 endpoints out of 4 requested are available. 4 endpoints excluded",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("does not treat a content guardrail as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: CONTENT_GUARDRAIL_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(false);
  });

  it("does not treat a prompt guardrail as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "",
        stderr: PROMPT_GUARDRAIL_STDERR,
      }),
    ).toBe(false);
  });

  it("does not treat the word guardrail alone as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "Your request triggered a guardrail.",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("does not treat a model that blocked prompt content as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "The model blocked this prompt under the content guardrail.",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("does not treat invalid model output as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "invalid model output",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("does not treat one endpoint phrase alone as a broken product fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "4 endpoints excluded",
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: "0 endpoints out of 4",
        stderr: "",
      }),
    ).toBe(false);
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
        stdout: MODEL_BLOCKED_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe(false);
  });

  it("treats an unknown product model as a broken fallback", () => {
    expect(
      isBrokenProductTextGenerationFallback({
        productModel: PRODUCT_MODEL,
        requestedModel: PRODUCT_MODEL,
        stdout: `unknown model: ${PRODUCT_MODEL}`,
        stderr: "",
      }),
    ).toBe(true);
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

describe("textGenerationCliFailureCategory", () => {
  it("labels a model block without copying the CLI payload", () => {
    expect(
      textGenerationCliFailureCategory({
        stdout: MODEL_BLOCKED_STDOUT,
        stderr: WRAPPER_STDERR,
      }),
    ).toBe("model_unavailable");
  });

  it("labels a content guardrail as a generic CLI failure", () => {
    expect(
      textGenerationCliFailureCategory({
        stdout: CONTENT_GUARDRAIL_STDOUT,
        stderr: PROMPT_GUARDRAIL_STDERR,
      }),
    ).toBe("cli_failed");
  });

  it("labels empty output as a generic CLI failure", () => {
    expect(textGenerationCliFailureCategory({ stdout: "", stderr: "" })).toBe("cli_failed");
  });
});

describe("boundedCliApiErrorStatus", () => {
  it("reads an HTTP status from the JSON envelope", () => {
    expect(boundedCliApiErrorStatus(MODEL_BLOCKED_STDOUT)).toBe(400);
  });

  it("drops non-JSON output and statuses outside the HTTP range", () => {
    expect(boundedCliApiErrorStatus(WRAPPER_STDERR)).toBeUndefined();
    expect(boundedCliApiErrorStatus(JSON.stringify({ api_error_status: 99 }))).toBeUndefined();
    expect(boundedCliApiErrorStatus(JSON.stringify({ api_error_status: 600 }))).toBeUndefined();
    expect(boundedCliApiErrorStatus(JSON.stringify({ api_error_status: 400.5 }))).toBeUndefined();
    expect(boundedCliApiErrorStatus(JSON.stringify({ api_error_status: "400" }))).toBeUndefined();
  });
});
