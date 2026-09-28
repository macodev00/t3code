import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";

import * as ServerSettingsService from "../serverSettings.ts";
import {
  projectIdForCwd,
  resolveVersionControlEnabled,
  type VersionControlRoot,
} from "./VersionControlPolicy.ts";
import * as VersionControlPolicy from "./VersionControlPolicy.ts";

const project = ProjectId.make("project");
const nested = ProjectId.make("nested");

const roots: ReadonlyArray<VersionControlRoot> = [
  { projectId: project, path: "/repo" },
  { projectId: nested, path: "/repo/app" },
];

const settingsWithProjectOff: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  enableVersionControl: true,
  projectSettingsOverrides: {
    [project]: { enableVersionControl: false },
  },
};

it.effect("projectIdForCwd picks the longest root and keeps dot-dot names inside it", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.strictEqual(projectIdForCwd(path, "/repo/src", roots), project);
    assert.strictEqual(projectIdForCwd(path, "/repo/app/src", roots), nested);
    assert.strictEqual(projectIdForCwd(path, "/repo/..hidden", roots), project);
    assert.strictEqual(projectIdForCwd(path, "/repo-other", roots), null);
    assert.strictEqual(projectIdForCwd(path, "/elsewhere", roots), null);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resolveVersionControlEnabled stays off when project roots cannot be loaded", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.strictEqual(
      resolveVersionControlEnabled(path, "/repo/src", settingsWithProjectOff, Option.none()),
      false,
    );
    assert.strictEqual(
      resolveVersionControlEnabled(path, "/elsewhere", settingsWithProjectOff, Option.none()),
      false,
    );
    assert.strictEqual(
      resolveVersionControlEnabled(
        path,
        "/repo/..hidden",
        settingsWithProjectOff,
        Option.some(roots),
      ),
      false,
    );
    assert.strictEqual(
      resolveVersionControlEnabled(path, "/elsewhere", settingsWithProjectOff, Option.some(roots)),
      true,
    );
    assert.strictEqual(
      resolveVersionControlEnabled(path, "/repo/src", DEFAULT_SERVER_SETTINGS, Option.none()),
      true,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const databaseUnavailable = new SqlError({
  reason: new ConnectionError({ cause: "database unavailable" }),
});

const sqlFrom = (
  handler: (query: string) => Effect.Effect<ReadonlyArray<unknown>, SqlError>,
): SqlClient.SqlClient =>
  ((strings: TemplateStringsArray) => handler(strings.join(" "))) as unknown as SqlClient.SqlClient;

const policyLayer = (sql: SqlClient.SqlClient) =>
  VersionControlPolicy.layer.pipe(
    Layer.provide(
      ServerSettingsService.layerTest({
        enableVersionControl: true,
        projectSettingsOverrides: {
          [project]: { enableVersionControl: false },
        },
      }),
    ),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    Layer.provide(NodeServices.layer),
  );

it.effect("isEnabled keeps a project opt-out when root lookup fails", () => {
  const failingSql = sqlFrom(() => Effect.fail(databaseUnavailable));
  return Effect.gen(function* () {
    const policy = yield* VersionControlPolicy.VersionControlPolicy;
    assert.strictEqual(yield* policy.isEnabled("/repo/src"), false);
    assert.strictEqual(yield* policy.isEnabled("/elsewhere"), false);
  }).pipe(Effect.provide(policyLayer(failingSql)));
});

it.effect("isEnabled applies a project opt-out for a dot-dot directory name", () => {
  const sql = sqlFrom((query) =>
    Effect.succeed(
      query.includes("projection_projects") ? [{ projectId: project, workspaceRoot: "/repo" }] : [],
    ),
  );
  return Effect.gen(function* () {
    const policy = yield* VersionControlPolicy.VersionControlPolicy;
    assert.strictEqual(yield* policy.isEnabled("/repo/..hidden"), false);
    assert.strictEqual(yield* policy.isEnabled("/elsewhere"), true);
  }).pipe(Effect.provide(policyLayer(sql)));
});
