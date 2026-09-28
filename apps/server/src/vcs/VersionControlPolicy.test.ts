import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import { projectIdForCwd } from "./VersionControlPolicy.ts";

it.effect("projectIdForCwd picks the longest root that contains the cwd", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const project = ProjectId.make("project");
    const nested = ProjectId.make("nested");
    const worktree = ProjectId.make("worktree");
    const roots = [
      { projectId: project, path: "/repo" },
      { projectId: nested, path: "/repo/app" },
      { projectId: worktree, path: "/tmp/worktrees/feature" },
    ];

    assert.strictEqual(projectIdForCwd(path, "/repo/src", roots), project);
    assert.strictEqual(projectIdForCwd(path, "/repo/app/src", roots), nested);
    assert.strictEqual(projectIdForCwd(path, "/tmp/worktrees/feature/packages", roots), worktree);
    assert.strictEqual(projectIdForCwd(path, "/repo-other", roots), null);
    assert.strictEqual(projectIdForCwd(path, "/elsewhere", roots), null);
  }).pipe(Effect.provide(NodeServices.layer)),
);
