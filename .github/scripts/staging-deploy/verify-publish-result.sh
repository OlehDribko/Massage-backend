#!/usr/bin/env bash
# Checks that the ECR publish artifact (ecr-publish-result.json) of a
# successful publish run describes exactly the commit and digests to deploy.
#
#   verify-publish-result.sh <ecr-publish-result.json> <sha> <api-digest> <migrate-digest> <registry>
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 5 ] || fail "usage: $0 <result.json> <sha> <api-digest> <migrate-digest> <registry>"
result="$1" sha="$2" api_digest="$3" migrate_digest="$4" registry="$5"
require_sha "$sha" "commit SHA"
require_digest "$api_digest" "API digest"
require_digest "$migrate_digest" "migration digest"

check() {
  local filter="$1" expected="$2" actual
  actual="$(jq -r "$filter // empty" "$result")"
  [ "$actual" = "$expected" ] || fail "publish result: $filter is '$actual', expected '$expected'"
}

check .commit_sha "$sha"
check .images.booking_api.repository "massage/booking-api"
check .images.booking_api.tag "$sha"
check .images.booking_api.digest "$api_digest"
check .images.booking_api.image_uri "${registry}/massage/booking-api@${api_digest}"
check .images.booking_migrate.repository "massage/booking-migrate"
check .images.booking_migrate.tag "$sha"
check .images.booking_migrate.digest "$migrate_digest"
check .images.booking_migrate.image_uri "${registry}/massage/booking-migrate@${migrate_digest}"
echo "publish result matches ${sha}"
