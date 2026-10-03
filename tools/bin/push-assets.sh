#!/usr/bin/env bash
# push-assets.sh <issue> <capture-dir-with-before-and-after> [fork-url]
# Commits PNG/GIF/MP4 captures to the orphan `pr-assets` branch of the fork under issue-<N>/, pushes
# (retrying on races), then prints commit-pinned raw URLs and writes <capture-dir>/ui-changes.md.
# Never commit captures to a code branch (CONTRIBUTING: "do not commit PR-only screenshots").
set -euo pipefail
ISSUE=$1; SRC=$(realpath "$2"); FORK=${3:-https://github.com/macodev00/t3code.git}
SLUG=$(echo "$FORK" | sed -E 's#https://github.com/##; s#\.git$##')
WT=$(mktemp -d)
git init -q "$WT"; cd "$WT"
git config user.name macodev00; git config user.email 273427913+macodev00@users.noreply.github.com
if git fetch -q --depth 1 "$FORK" pr-assets 2>/dev/null; then git checkout -q -B pr-assets FETCH_HEAD; else git checkout -q --orphan pr-assets; fi
mkdir -p "issue-$ISSUE"
for phase in before after; do
  [ -d "$SRC/$phase" ] || continue
  rm -rf "issue-$ISSUE/$phase"; mkdir -p "issue-$ISSUE/$phase"
  cp "$SRC/$phase"/*.png "issue-$ISSUE/$phase/" 2>/dev/null || true
  cp "$SRC/$phase"/recording.gif "$SRC/$phase"/recording.mp4 "issue-$ISSUE/$phase/" 2>/dev/null || true
  [ -f "$SRC/$phase/commit.txt" ] && echo "$phase: $(cat "$SRC/$phase/commit.txt")" >> "issue-$ISSUE/CAPTURE.txt.new"
done
[ -f "issue-$ISSUE/CAPTURE.txt.new" ] && mv "issue-$ISSUE/CAPTURE.txt.new" "issue-$ISSUE/CAPTURE.txt"
git add -A
git diff --cached --quiet || git commit -qm "Add captures for #$ISSUE"
for i in 1 2 3 4 5; do
  git push -q "$FORK" HEAD:pr-assets && break
  git fetch -q --depth 1 "$FORK" pr-assets && git rebase -q FETCH_HEAD || { echo "rebase failed" >&2; exit 1; }
  sleep $((i * 2))
done
SHA=$(git rev-parse HEAD); BASE="https://raw.githubusercontent.com/$SLUG/$SHA/issue-$ISSUE"
echo "ASSETS_SHA=$SHA"
MD="$SRC/ui-changes.md"; : > "$MD"
for phase in before after; do
  [ -d "issue-$ISSUE/$phase" ] || continue
  echo "**${phase^}**" >> "$MD"; echo >> "$MD"
  for f in "issue-$ISSUE/$phase"/*.png; do
    [ -e "$f" ] || continue; u="$BASE/$phase/$(basename "$f")"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$u"); echo "URL $code $u"
    echo "<img src=\"$u\" width=\"720\" alt=\"$phase: $(basename "$f" .png)\">" >> "$MD"; echo >> "$MD"
  done
  if [ -f "issue-$ISSUE/$phase/recording.gif" ]; then
    echo "<img src=\"$BASE/$phase/recording.gif\" width=\"720\" alt=\"$phase recording\">" >> "$MD"
    echo "[${phase}.mp4 (download)]($BASE/$phase/recording.mp4)" >> "$MD"; echo >> "$MD"
    echo "URL $(curl -s -o /dev/null -w '%{http_code}' "$BASE/$phase/recording.gif") $BASE/$phase/recording.gif"
  fi
done
echo "UI_MARKDOWN=$MD"
rm -rf "$WT"
