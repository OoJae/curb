#!/usr/bin/env bash
# webm (Playwright recordVideo) → H.264 MP4 the renderer and every browser can decode.
#   bash capture/transcode.sh in.webm out.mp4
# Proven settings from the past projects: CRF 18, yuv420p, faststart, constant 30 fps, no audio.
set -euo pipefail
in="${1:?usage: transcode.sh in.webm out.mp4}"
out="${2:?usage: transcode.sh in.webm out.mp4}"
mkdir -p "$(dirname "$out")"
ffmpeg -y -v error -i "$in" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -r 30 -an "$out"
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")"
echo "$out  ${dur}s"
