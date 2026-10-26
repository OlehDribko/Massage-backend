#!/usr/bin/env bash
# Shared helpers of the staging deploy scripts. Sourced, not executed.

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "$2 must be a full 40-character lowercase commit SHA"
}

require_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "$2 must be sha256:<64 lowercase hex>"
}
