#!/usr/bin/env bash
# Publish the site to ls. hk only reverse-proxies; per the fleet policy no
# static files live there.
#
#   sifter export && tools/deploy-site.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${SIFTER_SITE_HOST:-ls}"
DEST="${SIFTER_SITE_DIR:-/srv/www/sifter.z10.dev}"

node "$ROOT/tools/build-site.mjs"

cd "$ROOT/site"
# COPYFILE_DISABLE stops macOS tar from shipping ._* AppleDouble files, which
# otherwise land in the web root and get served as 163-byte garbage.
COPYFILE_DISABLE=1 tar czf - index.html app.js search.mjs lexicon.mjs resources.json \
  | ssh "$HOST" "sudo tar xzf - -C '$DEST' \
      && sudo chown -R www-data:www-data '$DEST' \
      && sudo rm -f '$DEST'/._*"

echo
echo "verifying from the server side (a local client cannot be trusted here):"
ssh "$HOST" '
  for d in sifter.z10.dev sifter.lab.z10.dev; do
    code=$(curl -sS -o /dev/null -m 15 -w "%{http_code}" "https://$d/")
    ct=$(curl -sSI -m 15 "https://$d/search.mjs" | grep -i "^content-type" | tr -d "\r" | cut -d" " -f2-)
    printf "  %-22s HTTP %s  search.mjs: %s\n" "$d" "$code" "$ct"
  done'
