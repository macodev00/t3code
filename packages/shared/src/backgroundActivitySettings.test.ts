import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  DEFAULT_SERVER_SETTINGS,
  MIN_PROVIDER_HEALTH_REFRESH_INTERVAL,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  floorProviderHealthRefreshInterval,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

describe("floorProviderHealthRefreshInterval", () => {
  it("keeps a disabled interval disabled", () => {
    expect(Duration.toMillis(floorProviderHealthRefreshInterval(Duration.zero))).toBe(0);
    expect(Duration.toMillis(floorProviderHealthRefreshInterval(Duration.millis(-1)))).toBe(0);
  });

  it("raises a short persisted override and the performance preset to the health-check timeout", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    });

    expect(Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL)).toBe(
      Duration.toMillis(Duration.fromInputUnsafe("90 seconds")),
    );
    expect(
      Duration.toMillis(floorProviderHealthRefreshInterval(resolved.providerHealthRefreshInterval)),
    ).toBe(Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL));
    expect(Duration.toMillis(floorProviderHealthRefreshInterval(Duration.seconds(30)))).toBe(
      Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL),
    );
    expect(
      Duration.toMillis(
        floorProviderHealthRefreshInterval(
          getBackgroundActivityPresetSettings("performance").providerHealthRefreshInterval,
        ),
      ),
    ).toBe(Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL));
    expect(
      Duration.toMillis(floorProviderHealthRefreshInterval(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ).toBe(Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL));
  });

  it("leaves intervals that are already long enough unchanged", () => {
    expect(
      Duration.toMillis(
        floorProviderHealthRefreshInterval(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
      ),
    ).toBe(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL));
    expect(
      Duration.toMillis(
        floorProviderHealthRefreshInterval(
          getBackgroundActivityPresetSettings("battery-saver").providerHealthRefreshInterval,
        ),
      ),
    ).toBe(Duration.toMillis(Duration.minutes(15)));
  });
});
