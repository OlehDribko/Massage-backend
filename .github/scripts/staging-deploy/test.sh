#!/usr/bin/env bash
# Tests of the staging deploy scripts (no AWS, no network). Run by CI:
#   bash .github/scripts/staging-deploy/test.sh
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0

# expect <exit-code> <description> <command...>
expect() {
  local want="$1" description="$2" got=0
  shift 2
  "$@" >"$work/out" 2>&1 || got=$?
  if [ "$got" = "$want" ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: ${description} (exit ${got}, expected ${want})"
    sed 's/^/  | /' "$work/out"
  fi
}

# expect_output <description> <expected> <actual>
expect_equal() {
  if [ "$2" = "$3" ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    echo "FAIL: $1"
    echo "  expected: $2"
    echo "  actual:   $3"
  fi
}

sha=0e93e68ff7f2418eefe8c762b55588973034b32a
old_sha=4930a5f0000000000000000000000000000000aa
api_digest="sha256:$(printf 'a%.0s' {1..64})"
migrate_digest="sha256:$(printf 'b%.0s' {1..64})"
registry=849110175854.dkr.ecr.eu-west-3.amazonaws.com
api_image="${registry}/massage/booking-api@${api_digest}"

# --- render-task-definition.sh -------------------------------------------
cat >"$work/taskdef.json" <<JSON
{
  "taskDefinition": {
    "taskDefinitionArn": "arn:aws:ecs:eu-west-3:849110175854:task-definition/massage-staging-booking-api:3",
    "revision": 3,
    "status": "ACTIVE",
    "family": "massage-staging-booking-api",
    "taskRoleArn": "arn:aws:iam::849110175854:role/massage-staging-booking-api-task",
    "executionRoleArn": "arn:aws:iam::849110175854:role/massage-staging-booking-api-execution",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "compatibilities": ["EC2", "FARGATE"],
    "requiresAttributes": [{"name": "com.amazonaws.ecs.capability.logging-driver.awslogs"}],
    "cpu": "256",
    "memory": "512",
    "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
    "registeredAt": "2026-10-21T19:00:00.000Z",
    "registeredBy": "arn:aws:iam::849110175854:user/oleg-admin",
    "volumes": [],
    "placementConstraints": [],
    "containerDefinitions": [{
      "name": "booking-api",
      "image": "${registry}/massage/booking-api@sha256:$(printf 'c%.0s' {1..64})",
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "APP_VERSION", "value": "${old_sha}"}
      ],
      "secrets": [{"name": "DATABASE_URL", "valueFrom": "arn:aws:ssm:eu-west-3:849110175854:parameter/massage-staging/booking/database-url"}]
    }]
  }
}
JSON

render="$dir/render-task-definition.sh"
expect 0 "render: valid input" "$render" "$work/taskdef.json" booking-api "$api_image" "$sha"
"$render" "$work/taskdef.json" booking-api "$api_image" "$sha" >"$work/rendered.json"
expect_equal "render: image replaced" "$api_image" "$(jq -r '.containerDefinitions[0].image' "$work/rendered.json")"
expect_equal "render: APP_VERSION replaced once" "$sha" \
  "$(jq -r '[.containerDefinitions[0].environment[] | select(.name == "APP_VERSION") | .value] | join(",")' "$work/rendered.json")"
expect_equal "render: other environment kept" "production" \
  "$(jq -r '.containerDefinitions[0].environment[] | select(.name == "NODE_ENV") | .value' "$work/rendered.json")"
expect_equal "render: secrets kept by ARN" "arn:aws:ssm:eu-west-3:849110175854:parameter/massage-staging/booking/database-url" \
  "$(jq -r '.containerDefinitions[0].secrets[0].valueFrom' "$work/rendered.json")"
expect_equal "render: roles kept" "arn:aws:iam::849110175854:role/massage-staging-booking-api-execution|arn:aws:iam::849110175854:role/massage-staging-booking-api-task" \
  "$(jq -r '"\(.executionRoleArn)|\(.taskRoleArn)"' "$work/rendered.json")"
expect_equal "render: read-only fields dropped" "" \
  "$(jq -r '[keys[] | select(IN("taskDefinitionArn", "revision", "status", "compatibilities", "requiresAttributes", "registeredAt", "registeredBy"))] | join(",")' "$work/rendered.json")"
"$render" "$work/taskdef.json" booking-api "$api_image" >"$work/rendered-noversion.json"
expect_equal "render: APP_VERSION untouched without version" "$old_sha" \
  "$(jq -r '.containerDefinitions[0].environment[] | select(.name == "APP_VERSION") | .value' "$work/rendered-noversion.json")"
expect 1 "render: image by tag rejected" "$render" "$work/taskdef.json" booking-api "${registry}/massage/booking-api:${sha}"
expect 1 "render: non-ECR image rejected" "$render" "$work/taskdef.json" booking-api "docker.io/library/node@${api_digest}"
expect 1 "render: wrong container name rejected" "$render" "$work/taskdef.json" booking-migrate "$api_image"
expect 1 "render: short version rejected" "$render" "$work/taskdef.json" booking-api "$api_image" 0e93e68
jq '.taskDefinition.containerDefinitions += [{"name": "sidecar", "image": "x"}]' "$work/taskdef.json" >"$work/two.json"
expect 1 "render: second container rejected" "$render" "$work/two.json" booking-api "$api_image"

# --- verify-publish-result.sh ---------------------------------------------
publish_result() {
  jq -n --arg sha "$1" --arg api "$2" --arg migrate "$3" --arg registry "$registry" '{
    commit_sha: $sha, region: "eu-west-3", run_id: "1",
    images: {
      booking_api: {repository: "massage/booking-api", tag: $sha, digest: $api,
                    image_uri: "\($registry)/massage/booking-api@\($api)", result: "published"},
      booking_migrate: {repository: "massage/booking-migrate", tag: $sha, digest: $migrate,
                        image_uri: "\($registry)/massage/booking-migrate@\($migrate)", result: "already-published"}
    }}'
}
verify="$dir/verify-publish-result.sh"
publish_result "$sha" "$api_digest" "$migrate_digest" >"$work/publish.json"
expect 0 "publish: matching result" "$verify" "$work/publish.json" "$sha" "$api_digest" "$migrate_digest" "$registry"
expect 1 "publish: other commit" "$verify" "$work/publish.json" "$old_sha" "$api_digest" "$migrate_digest" "$registry"
expect 1 "publish: swapped digests" "$verify" "$work/publish.json" "$sha" "$migrate_digest" "$api_digest" "$registry"
expect 1 "publish: other registry" "$verify" "$work/publish.json" "$sha" "$api_digest" "$migrate_digest" "000000000000.dkr.ecr.eu-west-3.amazonaws.com"
expect 1 "publish: malformed digest input" "$verify" "$work/publish.json" "$sha" "sha256:abc" "$migrate_digest" "$registry"
jq 'del(.images.booking_migrate)' "$work/publish.json" >"$work/publish-partial.json"
expect 1 "publish: missing image" "$verify" "$work/publish-partial.json" "$sha" "$api_digest" "$migrate_digest" "$registry"

# --- check-migration-task.sh ----------------------------------------------
migration_task() {
  jq -n --arg status "$1" --argjson code "$2" '{tasks: [{
    lastStatus: $status, stopCode: "EssentialContainerExited",
    stoppedReason: "Essential container in task exited",
    containers: [{name: "booking-migrate"} + (if $code == null then {} else {exitCode: $code} end)]}]}'
}
migration="$dir/check-migration-task.sh"
migration_task STOPPED 0 >"$work/m.json"
expect 0 "migration: exit code 0" "$migration" "$work/m.json" booking-migrate
migration_task STOPPED 1 >"$work/m.json"
expect 1 "migration: exit code 1" "$migration" "$work/m.json" booking-migrate
migration_task STOPPED null >"$work/m.json"
expect 1 "migration: no exit code (e.g. image pull failed)" "$migration" "$work/m.json" booking-migrate
migration_task RUNNING null >"$work/m.json"
expect 2 "migration: still running" "$migration" "$work/m.json" booking-migrate
migration_task STOPPED 0 >"$work/m.json"
expect 1 "migration: other container name" "$migration" "$work/m.json" booking-api
echo '{"tasks": [], "failures": [{"reason": "MISSING"}]}' >"$work/m.json"
expect 1 "migration: task missing" "$migration" "$work/m.json" booking-migrate

# --- check-service-deployment.sh ------------------------------------------
new_td=arn:aws:ecs:eu-west-3:849110175854:task-definition/massage-staging-booking-api:4
old_td=arn:aws:ecs:eu-west-3:849110175854:task-definition/massage-staging-booking-api:3
service() {
  # service <primary-taskdef> <rollout> <desired> <running> [extra-active-deployment]
  jq -n --arg td "$1" --arg rollout "$2" --argjson desired "$3" --argjson running "$4" --arg extra "${5:-}" '{services: [{
    deployments: ([{status: "PRIMARY", taskDefinition: $td, rolloutState: $rollout,
                    rolloutStateReason: "reason text", desiredCount: $desired, runningCount: $running}]
                  + (if $extra == "" then [] else [{status: "ACTIVE", taskDefinition: $extra,
                    rolloutState: "COMPLETED", desiredCount: 0, runningCount: 1}] end))}]}'
}
deployment="$dir/check-service-deployment.sh"
service "$new_td" COMPLETED 1 1 >"$work/s.json"
expect 0 "service: completed" "$deployment" "$work/s.json" "$new_td"
service "$new_td" IN_PROGRESS 1 0 "$old_td" >"$work/s.json"
expect 2 "service: in progress" "$deployment" "$work/s.json" "$new_td"
service "$new_td" COMPLETED 1 1 "$old_td" >"$work/s.json"
expect 2 "service: old deployment still draining" "$deployment" "$work/s.json" "$new_td"
service "$new_td" FAILED 1 0 "$old_td" >"$work/s.json"
expect 1 "service: rollout failed" "$deployment" "$work/s.json" "$new_td"
service "$old_td" IN_PROGRESS 1 1 >"$work/s.json"
expect 1 "service: circuit breaker rolled back to the previous revision" "$deployment" "$work/s.json" "$new_td"
service "$new_td" COMPLETED 0 0 >"$work/s.json"
expect 2 "service: completed with zero tasks is not a deployment" "$deployment" "$work/s.json" "$new_td"

# --- check-readiness.sh ---------------------------------------------------
readiness="$dir/check-readiness.sh"
printf '{"status":"ready","version":"%s"}' "$sha" >"$work/r.json"
expect 0 "readiness: ready with expected version" "$readiness" 200 "$work/r.json" "$sha"
printf '{"status":"ready","version":"%s"}' "$old_sha" >"$work/r.json"
expect 1 "readiness: old version still answering" "$readiness" 200 "$work/r.json" "$sha"
printf '{"status":"unavailable","reason":"database_unavailable"}' >"$work/r.json"
expect 1 "readiness: database unavailable (503)" "$readiness" 503 "$work/r.json" "$sha"
printf '{"message":"Service Unavailable"}' >"$work/r.json"
expect 1 "readiness: API Gateway 503" "$readiness" 503 "$work/r.json" "$sha"
printf 'not json' >"$work/r.json"
expect 1 "readiness: non-JSON body" "$readiness" 200 "$work/r.json" "$sha"

echo "passed: ${passed}, failed: ${failed}"
[ "$failed" -eq 0 ]
