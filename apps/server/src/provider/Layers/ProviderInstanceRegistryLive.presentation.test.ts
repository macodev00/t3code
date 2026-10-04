/**
 * Presentation edits must not rebuild a live provider instance.
 *
 * Renaming or recoloring, including the first rename that lifts a legacy
 * `config.enabled` flag onto the envelope, keeps the same instance object,
 * scope, and in-flight fiber. Deleting the instance or changing runtime
 * settings still closes that scope.
 */
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const driverKind = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

const makeSnapshot = (
  input: Pick<ProviderInstance, "instanceId" | "displayName" | "accentColor" | "enabled">,
): ServerProvider =>
  ({
    instanceId: input.instanceId,
    driver: driverKind,
    ...(input.displayName ? { displayName: input.displayName } : { displayName: "Stamped" }),
    ...(input.accentColor ? { accentColor: input.accentColor } : { accentColor: "#000000" }),
    enabled: input.enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as ServerProvider;

const makeDriver = (fibers: Array<Fiber.Fiber<never>>) => {
  let closed = 0;
  const driver = {
    driverKind,
    metadata: { displayName: "Codex" },
    configSchema: Schema.Unknown as ProviderDriver<unknown>["configSchema"],
    defaultConfig: () => ({}),
    create: (input) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.never.pipe(Effect.forkScoped);
        fibers.push(fiber);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed += 1;
          }),
        );
        const snapshot = makeSnapshot(input);
        const instance: ProviderInstance = {
          instanceId: input.instanceId,
          driverKind,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind,
            instanceId: input.instanceId,
          }),
          displayName: input.displayName,
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          enabled: input.enabled,
          snapshot: {
            resolveMaintenance: () => Effect.die("unused"),
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.succeed(snapshot),
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Effect.succeed(snapshot),
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        };
        return instance;
      }),
  } satisfies ProviderDriver<unknown>;
  return {
    driver,
    closed: () => closed,
  };
};

/**
 * `undefined` while the fiber is still running. Effect 4 exposes that as
 * `pollUnsafe` rather than an effectful poll.
 */
const fiberExit = (fiber: Fiber.Fiber<never>) => Effect.sync(() => fiber.pollUnsafe());

describe("ProviderInstanceRegistryLive presentation", () => {
  it.effect("keeps the live scope across a rename and closes it for runtime edits", () =>
    Effect.gen(function* () {
      const fibers: Array<Fiber.Fiber<never>> = [];
      const { driver, closed } = makeDriver(fibers);
      const entry = {
        driver: driverKind,
        displayName: "Personal",
        accentColor: "#123456",
        enabled: true,
        environment: [{ name: "CODEX_HOME", value: "personal", sensitive: false }],
        config: { binaryPath: "codex" },
      };
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: { [instanceId]: entry },
      });
      const original = yield* registry.getInstance(instanceId);
      expect(original).toBeDefined();
      yield* mutator.reconcile({ [instanceId]: { ...entry } });
      expect(yield* registry.getInstance(instanceId)).toBe(original);
      expect(closed()).toBe(0);
      expect(yield* fiberExit(fibers[0]!)).toBeUndefined();
      const changes = yield* registry.subscribeChanges;

      yield* mutator.reconcile({
        [instanceId]: { ...entry, displayName: "Work", accentColor: "#654321" },
      });
      const renamed = yield* registry.getInstance(instanceId);
      expect(renamed).toBe(original);
      expect(renamed?.orchestrationAdapter).toBe(original?.orchestrationAdapter);
      expect(renamed?.displayName).toBe("Work");
      expect(renamed?.accentColor).toBe("#654321");
      expect(closed()).toBe(0);
      expect(yield* fiberExit(fibers[0]!)).toBeUndefined();
      for (const snapshot of yield* Effect.all([
        renamed!.snapshot.getSnapshot,
        renamed!.snapshot.refresh,
        renamed!.snapshotForCwd!("/work"),
      ])) {
        expect(snapshot.displayName).toBe("Work");
        expect(snapshot.accentColor).toBe("#654321");
      }
      expect(yield* fiberExit(fibers[0]!)).toBeUndefined();
      yield* PubSub.take(changes);

      yield* mutator.reconcile({
        [instanceId]: {
          driver: driverKind,
          enabled: true,
          environment: entry.environment,
          config: { binaryPath: "codex" },
        },
      });
      const cleared = yield* registry.getInstance(instanceId);
      expect(cleared).toBe(original);
      expect(cleared?.displayName).toBeUndefined();
      expect(cleared?.accentColor).toBeUndefined();
      expect((yield* cleared!.snapshot.getSnapshot).displayName).toBeUndefined();
      expect((yield* cleared!.snapshot.getSnapshot).accentColor).toBeUndefined();
      expect(closed()).toBe(0);

      yield* mutator.reconcile({
        [instanceId]: {
          ...entry,
          displayName: "Work",
          environment: [{ name: "CODEX_HOME", value: "work", sensitive: false }],
        },
      });
      const replaced = yield* registry.getInstance(instanceId);
      expect(replaced).not.toBe(original);
      expect(replaced?.orchestrationAdapter).not.toBe(original?.orchestrationAdapter);
      expect(closed()).toBe(1);
      const replacedExit = yield* fiberExit(fibers[0]!);
      expect(replacedExit !== undefined && Exit.hasInterrupts(replacedExit)).toBe(true);
      expect(yield* fiberExit(fibers[1]!)).toBeUndefined();

      yield* mutator.reconcile({});
      expect(yield* registry.listInstances).toEqual([]);
      expect(closed()).toBe(2);
      const deletedExit = yield* fiberExit(fibers[1]!);
      expect(deletedExit !== undefined && Exit.hasInterrupts(deletedExit)).toBe(true);
    }),
  );

  it.effect("keeps a default instance alive when its first rename lifts config.enabled", () =>
    Effect.gen(function* () {
      const fibers: Array<Fiber.Fiber<never>> = [];
      const { driver, closed } = makeDriver(fibers);
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: {
          [instanceId]: {
            driver: driverKind,
            config: { enabled: true, binaryPath: "codex", launchArgs: "" },
          },
        },
      });
      const original = yield* registry.getInstance(instanceId);
      yield* mutator.reconcile({
        [instanceId]: {
          driver: driverKind,
          enabled: true,
          displayName: "Personal",
          config: { binaryPath: "codex", launchArgs: "" },
        },
      });
      const renamed = yield* registry.getInstance(instanceId);
      expect(renamed).toBe(original);
      expect(renamed?.displayName).toBe("Personal");
      expect(closed()).toBe(0);
      expect(yield* fiberExit(fibers[0]!)).toBeUndefined();
      expect((yield* renamed!.snapshot.getSnapshot).displayName).toBe("Personal");
    }),
  );
});
