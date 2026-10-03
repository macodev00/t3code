# PR capture tools

Before/after screenshots and recordings of the T3 Code web UI for pull request evidence.
Full instructions: RECIPE.md (kept with the operator; summary below).

1. `fixtures/<scene>.sh <dir>` builds a throwaway git repo that reproduces the UI state.
2. `bin/t3-serve.sh <t3code-checkout> <fixture-dir> <state-dir> [web_port] [server_port]` starts Vite + `t3 start`
   with an isolated data dir and prints `PAIRING_URL=`. No provider credentials needed.
3. `node capture.mjs --pair <PAIRING_URL> --url http://localhost:<web>/ --out <dir>/warmup --scene scenes/<x>.mjs --state <dir>/session.json`
4. `bin/capture-before-after.sh <checkout> <base-ref> <fix-ref> <issue> http://localhost:<web>/ scenes/<x>.mjs <dir>/session.json`
5. `bin/push-assets.sh <issue> pr-captures/<issue>` pushes to this branch and prints commit-pinned raw URLs + ui-changes.md.

Setup: `cd tools && npm i` (playwright-core 1.60.0); `npx playwright-core install chromium` if no system Chrome; ffmpeg.
