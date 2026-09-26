#!/usr/bin/env bash
# Publish the site to the machine that serves sifter.z10.dev. It moved on
# 2026-09-19; the previous host still accepts uploads, which is how a deploy
# can report success and change nothing. The check at the end reads the
# public site, not the upload target, for that reason.
#
#   sifter export && tools/deploy-site.sh
#
# Away from the home LAN, `ssh homelab` does not resolve; use
# SIFTER_SITE_HOST=homelab-cf.
#
# Uploads only what changed. The site carries about a gigabyte of video that
# is the same from one deploy to the next, so shipping the whole directory
# each time is not an option, and the host has no rsync. Instead: the new
# version starts as a hard-linked copy of the live one (instant, no extra
# space), the page files are always re-sent, and media under s/ and v/ is
# sent only when no file of that path and size is already there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${SIFTER_SITE_HOST:-homelab}"
DEST="${SIFTER_SITE_DIR:-/srv/data/static/sifter}"
PAGE=(index.html app.js search.mjs lexicon.mjs analytics.mjs wall.json videos.html)
export LC_ALL=C   # comm needs both lists sorted the same way

node "$ROOT/tools/build-site.mjs"
cd "$ROOT/site"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

find s v -type f ! -name '._*' -exec stat -f '%z %N' {} + | sort > "$tmp/local"
ssh "$HOST" "cd '$DEST' 2>/dev/null && find s v -type f -printf '%s %p\n' 2>/dev/null | sort || true" > "$tmp/remote"

comm -23 "$tmp/local" "$tmp/remote" | cut -d' ' -f2- > "$tmp/send"
cut -d' ' -f2- "$tmp/local" | sort > "$tmp/keep"
cut -d' ' -f2- "$tmp/remote" | sort | comm -23 - "$tmp/keep" > "$tmp/drop"
printf '%s\n' "${PAGE[@]}" >> "$tmp/send"

bytes=$(tr '\n' '\0' < "$tmp/send" | xargs -0 stat -f '%z' | awk '{s+=$1} END {print s}')
echo "sending $(wc -l < "$tmp/send" | tr -d ' ') files ($((bytes / 1048576)) MB), dropping $(wc -l < "$tmp/drop" | tr -d ' ')"

# Stage beside the live directory and swap it in whole, so a visitor never
# sees half a deploy; the previous version stays at $DEST.prev for rollback.
# --unlink-first matters: without it, extracting over a hard-linked file
# would rewrite the live copy in place.
ssh "$HOST" "set -e; rm -rf '$DEST.new'
  if [ -d '$DEST' ]; then cp -al '$DEST' '$DEST.new'; else mkdir -p '$DEST.new'; fi
  find '$DEST.new' -maxdepth 1 -type f -delete"
if [ -s "$tmp/drop" ]; then
  ssh "$HOST" "cd '$DEST.new' && xargs -d '\n' rm -f" < "$tmp/drop"
fi
# COPYFILE_DISABLE stops macOS tar from shipping ._* AppleDouble files, which
# otherwise land in the web root and get served as 163-byte garbage.
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -T "$tmp/send" \
  | ssh "$HOST" "set -e; tar -C '$DEST.new' --unlink-first -xf - && find '$DEST.new' -name '._*' -delete
      find '$DEST.new' -type d -empty -delete
      rm -rf '$DEST.prev' && { [ ! -d '$DEST' ] || mv '$DEST' '$DEST.prev'; } && mv '$DEST.new' '$DEST'"

echo
echo "verifying the public site:"
clip=$(ls v/*.mp4 | head -1)
for p in / /app.js /wall.json /videos.html "/$clip"; do
  printf "  %-34s %s\n" "$p" "$(curl -sS -o /dev/null -m 20 -w '%{http_code} %{content_type}' "https://sifter.z10.dev$p")"
done
