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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${SIFTER_SITE_HOST:-homelab}"
DEST="${SIFTER_SITE_DIR:-/srv/data/static/sifter}"

node "$ROOT/tools/build-site.mjs"

cd "$ROOT/site"
# COPYFILE_DISABLE stops macOS tar from shipping ._* AppleDouble files, which
# otherwise land in the web root and get served as 163-byte garbage.
# Unpacked beside the live directory and swapped in whole, so a visitor never
# sees half a deploy; the previous version stays at $DEST.prev for rollback.
COPYFILE_DISABLE=1 tar --no-xattrs -czf - index.html app.js search.mjs lexicon.mjs analytics.mjs resources.json \
    videos.html videos.js videos.json v \
  | ssh "$HOST" "set -e; rm -rf '$DEST.new' && mkdir -p '$DEST.new' \
      && tar -C '$DEST.new' -xzf - && find '$DEST.new' -name '._*' -delete \
      && rm -rf '$DEST.prev' && { [ ! -d '$DEST' ] || mv '$DEST' '$DEST.prev'; } && mv '$DEST.new' '$DEST'"

echo
echo "verifying the public site:"
for p in / /search.mjs /videos.html /videos.json; do
  printf "  %-14s %s\n" "$p" "$(curl -sS -o /dev/null -m 15 -w '%{http_code} %{content_type}' "https://sifter.z10.dev$p")"
done
