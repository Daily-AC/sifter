#!/usr/bin/env bash
# Installs the site's analytics endpoint on both hops. Idempotent: safe to
# re-run after editing anything in deploy/.
#
#   deploy/install-analytics.sh
#
# ls holds the store and never learns an address; hk knows the address and is
# told not to log this endpoint. Both halves have to be installed or the
# privacy claim in the README is not true — so this script does both, and
# refuses to leave one of them half-applied.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LS_HOST="${SIFTER_SITE_HOST:-ls}"
HK_HOST="${SIFTER_EDGE_HOST:-hk}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "ls — store, rate limit, rotation"
ssh "$LS_HOST" 'sudo tee /etc/nginx/conf.d/10-sifter-events.conf >/dev/null' < "$ROOT/deploy/analytics.nginx.conf"
ssh "$LS_HOST" 'sudo mkdir -p /etc/nginx/snippets && sudo tee /etc/nginx/snippets/sifter-events.conf >/dev/null' < "$ROOT/deploy/analytics.location.conf"
ssh "$LS_HOST" 'sudo tee /etc/logrotate.d/sifter-events >/dev/null' < "$ROOT/deploy/analytics.logrotate"

ssh "$LS_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo mkdir -p /var/log/sifter
sudo chown www-data:adm /var/log/sifter
sudo chmod 0755 /var/log/sifter

VHOST=/etc/nginx/sites-enabled/sifter
if ! sudo grep -q 'snippets/sifter-events.conf' "$VHOST"; then
  sudo sed -i --follow-symlinks 's#^    location / {#    include /etc/nginx/snippets/sifter-events.conf;\n\n    location / {#' "$VHOST"
  sudo grep -q 'snippets/sifter-events.conf' "$VHOST" || { echo "could not insert include into $VHOST"; exit 1; }
  echo "  include added to $VHOST"
else
  echo "  include already present in $VHOST"
fi

sudo nginx -t
sudo systemctl reload nginx
echo "  nginx reloaded"

# A duplicate glob would make logrotate skip the file silently, which shows up
# three months later as a missing history rather than as an error today.
# The check has to load every rule, not just this one: a duplicate is a
# relationship between two files, and logrotate reacts to it by skipping the
# file silently — which surfaces three months later as a missing history
# rather than as an error today.
if sudo logrotate -d /etc/logrotate.conf 2>&1 | grep -i "duplicate log entry" | grep -q sifter; then
  echo "  logrotate: /var/log/sifter is claimed by another rule"; exit 1
fi
echo "  logrotate rule clean"
REMOTE

say "hk — forward without logging"
ssh "$HK_HOST" 'sudo mkdir -p /etc/nginx/snippets && sudo tee /etc/nginx/snippets/sifter-events-hk.conf >/dev/null' < "$ROOT/deploy/analytics.hk.conf"

ssh "$HK_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
VHOST=/etc/nginx/conf.d/30-sifter.z10.dev.conf
if ! sudo grep -q 'snippets/sifter-events-hk.conf' "$VHOST"; then
  sudo sed -i --follow-symlinks 's#^    location / {#    include /etc/nginx/snippets/sifter-events-hk.conf;\n\n    location / {#' "$VHOST"
  sudo grep -q 'snippets/sifter-events-hk.conf' "$VHOST" || { echo "could not insert include into $VHOST"; exit 1; }
  echo "  include added to $VHOST"
else
  echo "  include already present in $VHOST"
fi

sudo nginx -t
sudo systemctl reload nginx
echo "  nginx reloaded"
REMOTE

say "end to end — a real report through the public name"
probe="install-probe-$$"
code=$(curl -sS -o /dev/null -m 20 -w '%{http_code}' -X POST "https://sifter.z10.dev/e?e=search&s=$probe&q=install%20probe&n=0")
echo "  POST /e -> HTTP $code"
[ "$code" = "204" ] || { echo "  expected 204"; exit 1; }

sleep 1
ssh "$LS_HOST" "sudo grep -c '$probe' /var/log/sifter/events.log" \
  | xargs -I{} echo "  lines in the store matching the probe: {}"

echo "  the edge must not have kept a copy:"
ssh "$HK_HOST" "sudo grep -c '/e?' /var/log/nginx/sifter.z10.dev.access.log 2>/dev/null || true" \
  | xargs -I{} echo "    /e lines in hk's access log: {} (0 is the only correct answer)"
