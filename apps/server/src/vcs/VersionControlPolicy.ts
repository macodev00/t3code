import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSettingsService from "../serverSettings.ts";

const ROOTS_TTL_MS = 2_000;

export interface VersionControlRoot {
  readonly projectId: ProjectId;
  readonly path: string;
}

const EMPTY_ROOTS: ReadonlyArray<VersionControlRoot> = [];

interface VersionControlPaths {
  readonly resolve: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (path: string) => boolean;
}

/** Longest configured root that contains `cwd`. A nested checkout wins over its parent. */
export function projectIdForCwd(
  path: VersionControlPaths,
  cwd: string,
  roots: ReadonlyArray<VersionControlRoot>,
): ProjectId | null {
  const candidate = path.resolve(cwd);
  let best: { readonly projectId: ProjectId; readonly length: number } | null = null;
  for (const root of roots) {
    const resolved = path.resolve(root.path);
    const relative = path.relative(resolved, candidate);
    const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (!inside) continue;
    if (best === null || resolved.length > best.length) {
      best = { projectId: root.projectId, length: resolved.length };
    }
  }
  return best?.projectId ?? null;
}

function hasVersionControlOptOut(settings: ServerSettings): boolean {
  if (!settings.enableVersionControl) return true;
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    if (entry.enableVersionControl === false) return true;
  }
  return false;
}

export class VersionControlPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VersionControlPolicy", {
  defaultValue: () => ({
    isEnabled: () => Effect.succeed(true),
  }),
}) {}

interface RootsCache {
  readonly loadedAt: number;
  readonly roots: ReadonlyArray<VersionControlRoot>;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheRef = yield* Ref.make<RootsCache | null>(null);

  const pathsFor = (value: string) =>
    fileSystem.realPath(value).pipe(
      Effect.map((realPath) => {
        const resolved = path.resolve(value);
        return resolved === realPath ? [resolved] : [resolved, realPath];
      }),
      Effect.orElseSucceed(() => [path.resolve(value)]),
    );

  const readRoots = Effect.gen(function* () {
    const [projects, worktrees] = yield* Effect.all(
      [
        sql<{ readonly projectId: string; readonly workspaceRoot: string }>`
          SELECT
            project_id AS "projectId",
            workspace_root AS "workspaceRoot"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `,
        sql<{ readonly projectId: string; readonly worktreePath: string }>`
          SELECT
            project_id AS "projectId",
            worktree_path AS "worktreePath"
          FROM projection_threads
          WHERE deleted_at IS NULL
            AND worktree_path IS NOT NULL
        `,
      ],
      { concurrency: "unbounded" },
    );
    const entries = [
      ...projects.map((row) => ({ projectId: row.projectId, path: row.workspaceRoot })),
      ...worktrees.map((row) => ({ projectId: row.projectId, path: row.worktreePath })),
    ];
    const canonical = yield* Effect.forEach(
      entries,
      (entry) =>
        pathsFor(entry.path).pipe(
          Effect.map((paths) =>
            paths.map(
              (root) =>
                ({
                  projectId: ProjectId.make(entry.projectId),
                  path: root,
                }) satisfies VersionControlRoot,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return canonical.flat();
  });

  const loadRoots = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cacheRef);
    if (cached !== null && now - cached.loadedAt < ROOTS_TTL_MS) {
      return cached.roots;
    }
    const roots = yield* readRoots;
    yield* Ref.set(cacheRef, { loadedAt: now, roots });
    return roots;
  });

  const isEnabled = (cwd: string): Effect.Effect<boolean, never> =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      // The usual case is "Git on everywhere"; don't touch the database then.
      if (!hasVersionControlOptOut(settings)) return true;
      const roots = yield* loadRoots.pipe(Effect.orElseSucceed(() => EMPTY_ROOTS));
      const projectId = projectIdForCwd(path, cwd, roots);
      return resolveProjectSettings(settings, projectId).settings.enableVersionControl;
    });

  return { isEnabled };
});

export const layer = Layer.effect(VersionControlPolicy, make);
