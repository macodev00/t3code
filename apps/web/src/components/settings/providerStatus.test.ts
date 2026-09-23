import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary, isAntigravityUncheckedAuth } from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("treats healthy Antigravity with unchecked Google auth as sign-in required, not attention", () => {
    const message = "Antigravity is installed. Google account access is not checked yet.";
    const antigravity = {
      ...provider,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      status: "warning" as const,
      auth: { status: "unknown" as const },
      message,
    };

    expect(isAntigravityUncheckedAuth(antigravity)).toBe(true);
    expect(getProviderSummary(antigravity)).toEqual({
      headline: "Installed · Sign-in required",
      detail: message,
    });
  });

  it("keeps confirmed Antigravity sign-out and real probe failures as they are", () => {
    const antigravity = {
      ...provider,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
    };

    expect(
      getProviderSummary({
        ...antigravity,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Sign in with Google to use Antigravity.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Sign in with Google to use Antigravity.",
    });
    expect(
      isAntigravityUncheckedAuth({
        ...antigravity,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity could not complete its local health check.",
      }),
    ).toBe(false);
    expect(
      getProviderSummary({
        ...antigravity,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity could not complete its local health check.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "Antigravity could not complete its local health check.",
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        auth: { status: "unknown" },
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});
