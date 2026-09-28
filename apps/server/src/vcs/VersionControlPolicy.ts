import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSettingsService from "../serverSettings.ts";

const ROOTS_TTL_MS = 2_000;

export interface VersionControlRoot {
  readonly projectId: ProjectId;
  readonly path: string;
}

interface VersionControlPaths {
  readonly resolve: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (path: string) => boolean;
  readonly sep: string;
}

/**
 * True when `relative` is the parent directory itself or begins with a parent
 * segment. A directory named `..hidden` stays inside the root.
 */
function relativeEscapesParent(path: VersionControlPaths, relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`);
}

/**
 * Longest configured root that contains `cwd`.
 * A nested checkout wins over its parent. Paths such as `/repo/..hidden` stay
 * inside `/repo`; only a real `..` segment escapes.
 */
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
    const inside =
      relative === "" || (!relativeEscapesParent(path, relative) && !path.isAbsolute(relative));
    if (!inside) continue;
    if (best === null || resolved.length > best.length) {
      best = { projectId: root.projectId, length: resolved.length };
    }
  }
  return best?.projectId ?? null;
}

/**
 * True when the environment default or any project override has turned
 * version control off.
 */
function hasVersionControlOptOut(settings: ServerSettings): boolean {
  if (!settings.enableVersionControl) return true;
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    if (entry.enableVersionControl === false) return true;
  }
  return false;
}

/**
 * Whether Git may run for `cwd`.
 * No opt-out stays on without consulting roots. When an opt-out exists, a
 * missing root list stays off so a failed lookup cannot inherit the enabled
 * environment default.
 */
export function resolveVersionControlEnabled(
  path: VersionControlPaths,
  cwd: string,
  settings: ServerSettings,
  roots: Option.Option<ReadonlyArray<VersionControlRoot>>,
): boolean {
  if (!hasVersionControlOptOut(settings)) return true;
  if (Option.isNone(roots)) return false;
  const projectId = projectIdForCwd(path, cwd, roots.value);
  return resolveProjectSettings(settings, projectId).settings.enableVersionControl;
}

export class VersionControlPolicy extends Context.Service<
  VersionControlPolicy,
  {
    /** Whether Git may run for this working directory. */
    readonly isEnabled: (cwd: string) => Effect.Effect<boolean>;
  }
>()("t3/vcs/VersionControlPolicy") {}

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

  /** Canonical path plus the symlink target when they differ. */
  const pathsFor = (value: string) =>
    fileSystem.realPath(value).pipe(
      Effect.map((realPath) => {
        const resolved = path.resolve(value);
        return resolved === realPath ? [resolved] : [resolved, realPath];
      }),
      Effect.orElseSucceed(() => [path.resolve(value)]),
    );

  /**
   * Project workspace roots and thread checkout paths that share a project's
   * version-control switch.
   */
  const readRoots = Effect.gen(function* () {
    const [projects, checkouts] = yield* Effect.all(
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
      ...checkouts.map((row) => ({ projectId: row.projectId, path: row.worktreePath })),
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

  /** Project roots, reused briefly so status checks stay off the database. */
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

  /**
   * Resolves the version-control switch for one working directory.
   * A failed project-root lookup stays disabled whenever any opt-out exists.
   */
  const isEnabled = (cwd: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      if (!hasVersionControlOptOut(settings)) return true;
      const roots = yield* loadRoots.pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<ReadonlyArray<VersionControlRoot>>()),
      );
      return resolveVersionControlEnabled(path, cwd, settings, roots);
    });

  return VersionControlPolicy.of({ isEnabled });
});

/** Live policy. Consumers provide this layer; it has no always-on default. */
export const layer = Layer.effect(VersionControlPolicy, make);

/** Explicit always-on policy for tests that do not load this setting. */
export const layerTest = Layer.succeed(VersionControlPolicy, {
  isEnabled: () => Effect.succeed(true),
});
