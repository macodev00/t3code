#!/usr/bin/env bash
# webm2media.sh <in.webm> <out-basename> [start-seconds]  -> <out>.mp4 (H.264, plays in browsers) and <out>.gif (inline in PR bodies)
set -euo pipefail
in=$1; out=$2; ss=${3:-0}
ffmpeg -y -loglevel error -ss "$ss" -i "$in" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "$out.mp4"
ffmpeg -y -loglevel error -ss "$ss" -i "$in" -vf "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" "$out.gif"
ls -la "$out.mp4" "$out.gif"
