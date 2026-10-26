#!/usr/bin/env bash
# Evaluates a /health/ready response.
#
#   check-readiness.sh <http-status> <body-file> <expected-version>
#
# Exit 0 only for HTTP 200 with status "ready" and the expected version
# (the deployed commit SHA, set as APP_VERSION).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 3 ] || fail "usage: $0 <http-status> <body-file> <expected-version>"
http_status="$1" body="$2" expected="$3"

[ "$http_status" = "200" ] || fail "readiness returned HTTP ${http_status}"
status="$(jq -r '.status // empty' "$body" 2>/dev/null || true)"
version="$(jq -r '.version // empty' "$body" 2>/dev/null || true)"
[ "$status" = "ready" ] || fail "readiness status is '${status}', expected 'ready'"
[ "$version" = "$expected" ] || fail "readiness reports version '${version}', expected '${expected}'"
echo "ready, version ${version}"
