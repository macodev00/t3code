#!/usr/bin/env bash
# capture-before-after.sh <t3code-checkout> <base-ref> <after-ref> <issue> <start-url> <scene.mjs> <session.json>
# Needs t3-serve.sh running from <t3code-checkout> and a session from `capture.mjs --pair` (see RECIPE.md).
# Vite hot-reloads web code when the checkout moves. A server-side change needs t3-stop/t3-serve between phases.
# Output: ${OUT_DIR:-./pr-captures}/<issue>/{before,after}/NN-*.png, recording.{webm,mp4,gif}, commit.txt
set -euo pipefail
REPO=$1 BASE=$2 AFTER=$3 ISSUE=$4 URL=$5 SCENE=$(realpath "$6") STATE=$(realpath "$7")
TOOLS=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${OUT_DIR:-./pr-captures}/$ISSUE" && realpath "${OUT_DIR:-./pr-captures}/$ISSUE")
export PATH="$HOME/.local/node24/bin:$PATH"
for phase in before after; do
  ref=$BASE; [ "$phase" = after ] && ref=$AFTER
  git -C "$REPO" checkout -q --detach "$ref"
  echo "== $phase @ $(git -C "$REPO" rev-parse --short HEAD)"
  sleep 8   # let Vite pick up the changed modules
  rm -rf "$OUT/$phase"
  node "$TOOLS/capture.mjs" --url "$URL" --out "$OUT/$phase" --scene "$SCENE" --state "$STATE" --scale "${SCALE:-2}"
  "$TOOLS/bin/webm2media.sh" "$OUT/$phase/recording.webm" "$OUT/$phase/recording" "$(cat "$OUT/$phase/trim-start.txt")"
  git -C "$REPO" rev-parse HEAD > "$OUT/$phase/commit.txt"
done
echo "OUT=$OUT"
