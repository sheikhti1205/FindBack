#!/usr/bin/env bash
# install.sh — fresh install and upgrade install of the proof APK.
#
# Usage:
#   scripts/device-harness/install.sh fresh   --apk <file.apk> [--serial S]
#   scripts/device-harness/install.sh upgrade --apk <file.apk> [--serial S]
#
# fresh:   full uninstall (clears data) + install. Required first step of every
#          DEVICE_<SHA>_<DATE> proof (acceptance matrix: Provenance/fresh install).
# upgrade: install -r over the existing install WITHOUT uninstalling (acceptance
#          matrix: upgrade over release-key build). Fails closed if the package
#          is not already installed.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

mode="${1:-}"
[[ "$mode" == "fresh" || "$mode" == "upgrade" ]] || {
  harness_err "expected fresh|upgrade as first arg"
  exit 1
}
shift

APK=""
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
while (($#)); do
  case "$1" in
    --apk) APK="${2:-}"; shift 2 ;;
    --serial) SERIAL="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done
[[ -n "$APK" && -f "$APK" ]] || {
  harness_err "--apk <existing .apk> required"
  exit 1
}

require_adb
export ANDROID_SERIAL="$SERIAL"

installed() { adb shell pm list packages 2>/dev/null | grep -q "package:${FINDBACK_PACKAGE}$"; }

if [[ "$mode" == "fresh" ]]; then
  harness_log "fresh install: uninstalling ${FINDBACK_PACKAGE} (if present)…"
  if installed; then adb uninstall "$FINDBACK_PACKAGE"; fi
  harness_log "installing $APK…"
  adb install "$APK"
  harness_log "fresh install OK. Verifying package:"
  adb shell dumpsys package "$FINDBACK_PACKAGE" | grep -E "versionName|versionCode|codePath" | head -5
else
  installed || {
    harness_err "upgrade requires ${FINDBACK_PACKAGE} already installed (install the release-key base first)."
    exit 1
  }
  harness_log "upgrade install (-r, data preserved) $APK…"
  adb install -r "$APK"
  harness_log "upgrade install OK. Verifying package:"
  adb shell dumpsys package "$FINDBACK_PACKAGE" | grep -E "versionName|versionCode|codePath" | head -5
fi
