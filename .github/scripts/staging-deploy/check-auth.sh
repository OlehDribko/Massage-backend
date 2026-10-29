#!/usr/bin/env bash
# Evaluates an unauthenticated GET /api/me response.
#
#   check-auth.sh <http-status> <body-file> <www-authenticate-header>
#
# Exit 0 only for 401 with code AUTH_REQUIRED and a Bearer challenge: the
# profile routes are mounted (Firebase configured) and require a token. The
# request carries no token, so the service makes no call to Firebase.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 3 ] || fail "usage: $0 <http-status> <body-file> <www-authenticate-header>"
http_status="$1" body="$2" challenge="$3"

[ "$http_status" = "401" ] || fail "GET /api/me without a token returned HTTP ${http_status}, expected 401 (is Firebase configured?)"
code="$(jq -r '.code // empty' "$body" 2>/dev/null || true)"
[ "$code" = "AUTH_REQUIRED" ] || fail "GET /api/me returned code '${code}', expected 'AUTH_REQUIRED'"
case "$challenge" in
  Bearer*) ;;
  *) fail "GET /api/me did not send a Bearer challenge" ;;
esac
echo "authentication enforced on /api/me"
