# Clone file-manager evidence

Headless Chromium (Google Chrome) against `vp run dev` on an isolated home
(`/tmp/t3-clone-e2e-home`, web http://localhost:5733). The desktop bridge was
stubbed in the page after the app connected. `pickFolder` returned a real
empty directory. The clone URL was `https://github.com/octocat/Hello-World.git`.

The native OS folder picker was not opened. The stub stands in for it.

## Before (upstream main, unfixed handler)

- Picker returned `/tmp/t3-clone-proof/before/parent/picked`.
- That directory stayed empty. No `Hello-World/` and no `.git`.
- `projection_projects` row: title `picked`, workspace_root `/tmp/t3-clone-proof/before/parent/picked`.
- UI: project `picked`, "Initialize Git". The repository was not cloned.
- Server log probed Codex skills for `/tmp/t3-clone-proof/before/parent/picked`.

## After (this fix)

- Picker returned `/tmp/t3-clone-proof/after/parent/picked`.
- Clone landed at `/tmp/t3-clone-proof/after/parent/picked/Hello-World` (not `picked/picked`).
- `.git` present, `README` is "Hello World!".
- HEAD `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` (`7fd1a60 Merge pull request #6 from Spaceghost/patch-1`).
- origin host/path `github.com/octocat/Hello-World.git`.
- `projection_projects` row: title `Hello-World`, workspace_root `/tmp/t3-clone-proof/after/parent/picked/Hello-World`.
- UI: project `Hello-World`, branch `master`, not "Initialize Git".
- Server log probed Codex skills for `/tmp/t3-clone-proof/after/parent/picked/Hello-World`.

## Files

- before-destination.png — clone step with Open in Files
- before-result.png — empty project `picked` and Initialize Git
- after-destination.png — same step on the fix
- after-cloning.png — project opens as Hello-World
- after-result.png — Hello-World on master
- disk-and-projects.txt
- server-log-excerpt.txt
- picker-calls.txt
