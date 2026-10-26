#!/usr/bin/env bash
# Evaluates a migration task from `aws ecs describe-tasks` output.
#
#   check-migration-task.sh <describe-tasks.json> <container>
#
# Exit 0: the task stopped and the container exited with code 0.
# Exit 2: the task has not stopped yet (keep waiting).
# Exit 1: anything else (non-zero exit code, no exit code, e.g. image pull or
#         secret resolution failure, missing task).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 2 ] || fail "usage: $0 <describe-tasks.json> <container>"
input="$1" container="$2"

[ "$(jq '.tasks | length' "$input")" = "1" ] || fail "expected exactly one migration task"
status="$(jq -r '.tasks[0].lastStatus' "$input")"
if [ "$status" != "STOPPED" ]; then
  echo "migration task status: $status"
  exit 2
fi

exit_code="$(jq -r --arg name "$container" \
  '[.tasks[0].containers[] | select(.name == $name)][0].exitCode // "none"' "$input")"
stop_code="$(jq -r '.tasks[0].stopCode // "unknown"' "$input")"
reason="$(jq -r '.tasks[0].stoppedReason // ""' "$input")"
if [ "$exit_code" = "0" ]; then
  echo "migration task finished with exit code 0"
  exit 0
fi
fail "migration task failed: exit code ${exit_code}, stop code ${stop_code}${reason:+, reason: ${reason}}"
