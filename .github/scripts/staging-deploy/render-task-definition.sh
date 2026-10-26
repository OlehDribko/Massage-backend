#!/usr/bin/env bash
# Builds a new task definition revision from the latest one of a family.
#
#   render-task-definition.sh <describe-task-definition.json> <container> <image> [app-version]
#
# Input: output of `aws ecs describe-task-definition` (Terraform owns its
# shape). Output (stdout): JSON for `aws ecs register-task-definition
# --cli-input-json`, identical except for the container image and, if given,
# the APP_VERSION environment variable. Read-only fields of the described
# revision (ARN, revision, status, ...) are dropped; tags are not copied.
# Refuses anything but exactly one container with the expected name and an
# image pinned by digest.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || fail "usage: $0 <task-definition.json> <container> <image> [app-version]"
input="$1" container="$2" image="$3" app_version="${4:-}"

[[ "$image" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || fail "image must be an ECR image pinned by digest"
if [ -n "$app_version" ]; then
  require_sha "$app_version" "app-version"
fi

count="$(jq '.taskDefinition.containerDefinitions | length' "$input")"
[ "$count" = "1" ] || fail "expected exactly one container definition, found $count"
name="$(jq -r '.taskDefinition.containerDefinitions[0].name' "$input")"
[ "$name" = "$container" ] || fail "expected container '$container', found '$name'"

jq --arg image "$image" --arg version "$app_version" '
  .taskDefinition
  | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
     volumes, placementConstraints, requiresCompatibilities, cpu, memory,
     runtimePlatform, ephemeralStorage, pidMode, ipcMode, proxyConfiguration}
  | with_entries(select(.value != null))
  | .containerDefinitions[0].image = $image
  | if $version == "" then .
    else .containerDefinitions[0].environment =
      ([(.containerDefinitions[0].environment // [])[] | select(.name != "APP_VERSION")]
       + [{name: "APP_VERSION", value: $version}])
    end
' "$input"
