#!/usr/bin/env bash
# Fetch each published video once and cut the two files the site plays:
#
#   data/videos/clip/<id>.mp4  a 4 s muted loop, what the wall autoplays
#   data/videos/clip/<id>.webp its first frame, shown until the loop plays,
#                              so the picture does not jump when it starts
#   data/videos/full/<id>.mp4  the whole video with sound, what a click opens
#
# Both are self-hosted for the same reason the posters are: video.twimg.com
# does not load from mainland China, and most people this page is shared
# with are there. Existing files are skipped, so a rerun only fetches what
# is new.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V="$ROOT/data/videos"
mkdir -p "$V/clip" "$V/full"

python3 - "$V" <<'EOF' | while IFS=$'\t' read -r id url post; do
import json, sys
v = sys.argv[1]
likes = {x['id']: x for x in json.load(open(f'{v}/likes.json'))}
for x in json.load(open(f'{v}/videos.json')):
    if x.get('hide'):
        continue
    mp4 = [u for u in likes[x['id']]['media_urls'] if 'video.twimg.com' in u]
    if mp4:
        print(f"{x['id']}\t{mp4[0]}\t{x['url']}")
EOF
  full="$V/full/$id.mp4"
  clip="$V/clip/$id.mp4"
  if [ ! -s "$full" ]; then
    # The media URL in likes.json is the 270p variant, which turns to mush on
    # a retina card. yt-dlp lists every variant; take the progressive mp4
    # whose short side is at most 720, and fall back to the 270p link only
    # if the post will not resolve.
    yt-dlp -q --no-warnings --playlist-items 1 -S res:720 -f 'b[protocol=https]/b' \
        -o "$V/full/$id.dl.%(ext)s" --remux-video mp4 "$post" && mv "$V/full/$id.dl.mp4" "$full" \
      || curl -sSfL --retry 2 -m 120 -o "$full" "$url" \
      || { echo "fetch failed: $id" >&2; rm -f "$full" "$V/full/$id.dl."*; continue; }
  fi
  if [ ! -s "$clip" ]; then
    dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$full")
    # Skip the first stretch of longer videos, where title cards usually sit.
    start=$(python3 -c "d=float('$dur'); print(round(min(max(d*0.15,0), max(d-4,0)),2))")
    ffmpeg -nostdin -v error -y -ss "$start" -i "$full" -t 4 -an \
      -vf "scale='min(640,iw)':-2,fps=24" -c:v libx264 -preset slow -crf 30 \
      -pix_fmt yuv420p -movflags +faststart "$clip" \
      || { echo "cut failed: $id" >&2; rm -f "$clip"; continue; }
  fi
  if [ ! -s "${clip%.mp4}.webp" ]; then
    # Homebrew's ffmpeg has no webp encoder, so the frame goes through cwebp.
    ffmpeg -nostdin -v error -y -i "$clip" -frames:v 1 "${clip%.mp4}.png" \
      && cwebp -quiet -q 72 "${clip%.mp4}.png" -o "${clip%.mp4}.webp" \
      || echo "poster failed: $id" >&2
    rm -f "${clip%.mp4}.png"
  fi
  printf '%s  full %6s  clip %6s\n' "$id" "$(du -k "$full" | cut -f1)k" "$(du -k "$clip" | cut -f1)k"
done
