#!/usr/bin/env bash
# device-harness shared helpers (offline; no side effects on source).
# Every harness script sources this file first:
#   SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/common.sh"
set -euo pipefail

# Package under test — single canonical value (see app/build.gradle applicationId).
FINDBACK_PACKAGE="${FINDBACK_PACKAGE:-com.findback.app}"
# Emulator used for lab proofs.
FINDBACK_AVD="${FINDBACK_AVD:-Norfolk_API36}"
FINDBACK_SERIAL="${FINDBACK_SERIAL:-emulator-5554}"

# Evidence root. The orchestrator (run-device-proof.sh) overrides OUT_DIR with
# Communication/DEVICE_<SHA>_<DATE>/; leaf scripts default to a scratch dir.
HARNESS_OUT="${HARNESS_OUT:-/tmp/findback-device-harness}"

harness_log() { printf 'device-harness: %s\n' "$*"; }
harness_err() { printf 'device-harness: ERROR: %s\n' "$*" >&2; }

require_adb() {
  command -v adb >/dev/null 2>&1 || {
    harness_err "adb not found on PATH (Android platform-tools required)."
    return 1
  }
}

# Resolve target serial: explicit ANDROID_SERIAL > FINDBACK_SERIAL env > first
# online device. Prints the serial; never prints secrets.
resolve_serial() {
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then printf '%s\n' "$ANDROID_SERIAL"; return 0; fi
  if [[ -n "${FINDBACK_SERIAL:-}" ]]; then printf '%s\n' "$FINDBACK_SERIAL"; return 0; fi
  adb devices | awk 'NR>1 && $2=="device" {print $1; exit}'
}

# Scrub secret-shaped values from a file in place. Keeps presence labels,
# removes material: sb_secret_*, service_role JWTs, DSN userinfo, client-secret
# pairs, generic token/password assignments. Safe to run twice.
scrub_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  sed -E \
    -e 's/sb_secret_[A-Za-z0-9_.-]+/[SCRUBBED_SB_SECRET]/g' \
    -e 's/(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)/[SCRUBBED_JWT]/g' \
    -e 's#(https://)[^/@:]+@#\1[SCRUBBED]@#g' \
    -e 's/("?(password|passwd|pwd|token|secret|api[_-]?key|client[_-]?secret|publishable[_-]?key|dsn)"?\s*[:=]\s*"?)[^", ]+/\1[SCRUBBED]/gi' \
    -e 's/(apikey:\s*)[A-Za-z0-9_.-]+/\1[SCRUBBED]/gi' \
    "$file" > "$tmp"
  mv "$tmp" "$file"
}

ensure_outdir() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}
