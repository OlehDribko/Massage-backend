#!/usr/bin/env bash
# Evaluates the API service rollout from `aws ecs describe-services` output.
#
#   check-service-deployment.sh <describe-services.json> <task-definition-arn>
#
# Exit 0: the expected revision is the only deployment, its rollout is
#         COMPLETED and all desired tasks run.
# Exit 2: the rollout of the expected revision is still in progress.
# Exit 1: the rollout failed, or the service runs another revision (e.g. the
#         circuit breaker rolled back to the previous one).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 2 ] || fail "usage: $0 <describe-services.json> <task-definition-arn>"
input="$1" expected="$2"

[ "$(jq '.services | length' "$input")" = "1" ] || fail "expected exactly one service"
primary="$(jq -c '[.services[0].deployments[] | select(.status == "PRIMARY")][0] // empty' "$input")"
[ -n "$primary" ] || fail "service has no primary deployment"

taskdef="$(jq -r '.taskDefinition' <<<"$primary")"
rollout="$(jq -r '.rolloutState // "UNKNOWN"' <<<"$primary")"
desired="$(jq -r '.desiredCount' <<<"$primary")"
running="$(jq -r '.runningCount' <<<"$primary")"
deployments="$(jq '.services[0].deployments | length' "$input")"

if [ "$taskdef" != "$expected" ]; then
  fail "service runs ${taskdef}, not ${expected} (rolled back or changed concurrently)"
fi
case "$rollout" in
  FAILED)
    fail "rollout of ${expected} failed: $(jq -r '.rolloutStateReason // ""' <<<"$primary")"
    ;;
  COMPLETED)
    if [ "$deployments" = "1" ] && [ "$desired" -ge 1 ] && [ "$running" = "$desired" ]; then
      echo "rollout completed: ${running}/${desired} tasks of ${expected}"
      exit 0
    fi
    ;;
esac
echo "rollout ${rollout}: ${running}/${desired} running, ${deployments} deployment(s)"
exit 2
