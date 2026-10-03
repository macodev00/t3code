#!/usr/bin/env bash
# fixtures/office-collision.sh <dir>: git repo where main has file `office`, branch fix/office-config
# replaces it with office/config.ts (file -> directory collision, #12887). Leaves the branch checked out.
set -euo pipefail
R=$1; rm -rf "$R"; mkdir -p "$R/src"; cd "$R"
git init -q -b main; git config user.email fixture@example.com; git config user.name fixture
printf 'export const greet = (name: string) => `Hello, ${name}`;\n' > src/index.ts
printf '# Office fixture\n' > README.md
printf 'legacy office settings\nmode=standalone\n' > office
git add -A; git commit -qm "base: office is a file"
git checkout -qb fix/office-config
git rm -q office; mkdir office
printf 'export const officeConfig = {\n  mode: "standalone",\n  seats: 12,\n};\n' > office/config.ts
printf 'export const greet = (name: string) => `Hello, ${name}!`;\n' > src/index.ts
git add -A; git commit -qm "move office into a directory"
